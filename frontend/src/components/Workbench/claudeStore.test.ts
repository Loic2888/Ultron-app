import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppStore } from '../../lib/store';
import { WorkspaceError } from '../../lib/workspaceApi';

vi.mock('../../lib/claudeApi', () => ({
  claudeStatus: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  decide: vi.fn(),
  interrupt: vi.fn(),
  setMode: vi.fn(),
  setSettings: vi.fn(),
  closeSession: vi.fn(),
  streamEvents: vi.fn(),
}));

import * as api from '../../lib/claudeApi';
import { useClaude } from './claudeStore';

const m = vi.mocked(api);

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
});
const summary = (over: Record<string, unknown> = {}) =>
  ({
    id: 's1',
    cwd: '/home/u/a',
    permission_mode: 'default',
    claude_session_id: null,
    busy: false,
    closed: false,
    alive: false,
    pending: [],
    next_seq: 0,
    ...over,
  }) as api.SessionSummary;

/** A stream that delivers `events`, then stays open until aborted. */
const streamWith = (events: unknown[]) =>
  m.streamEvents.mockImplementation(async (_id, _after, on, signal) => {
    on(events as api.ServerEvent[]);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  });

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useClaude.setState({ chats: {} });
  useAppStore.setState({ planUsage: null });
  m.claudeStatus.mockResolvedValue({ installed: true });
  m.createSession.mockResolvedValue(summary());
  streamWith([]);
});

describe('opening a chat', () => {
  it('creates a session in the repo folder and streams its events', async () => {
    streamWith([
      { seq: 0, type: 'system', subtype: 'init', session_id: 'conv-1', model: 'm' },
      { seq: 1, type: 'jarvis', kind: 'user_message', text: 'hello' },
    ]);
    await useClaude.getState().open('k1', '/home/u/a');
    await flush();
    const chat = useClaude.getState().chats.k1;
    expect(m.createSession).toHaveBeenCalledWith('/home/u/a', 'default', null, 'code', {
      model: null,
      effort: null,
      rules: undefined,
    });
    expect(chat.status).toBe('ready');
    expect(chat.sessionId).toBe('s1');
    expect(chat.model.busy).toBe(true);
    expect(chat.model.items[0]).toMatchObject({ kind: 'user', text: 'hello' });
    expect(chat.model.claudeSessionId).toBe('conv-1');
    expect(JSON.parse(localStorage.getItem('openjarvis.workbench.chats') ?? '{}').k1).toMatchObject({
      sessionId: 's1',
      claudeSessionId: 'conv-1',
    });
  });

  it('does nothing twice when opened again while ready', async () => {
    await useClaude.getState().open('k1', '/home/u/a');
    await useClaude.getState().open('k1', '/home/u/a');
    expect(m.createSession).toHaveBeenCalledTimes(1);
  });

  it('says so when the claude program is missing', async () => {
    m.claudeStatus.mockResolvedValue({ installed: false });
    await useClaude.getState().open('k1', '/home/u/a');
    const chat = useClaude.getState().chats.k1;
    expect(chat.status).toBe('error');
    expect(chat.error).toContain('claude login');
    expect(m.createSession).not.toHaveBeenCalled();
  });

  it('shows the server error when the session cannot be created', async () => {
    m.createSession.mockRejectedValue(new WorkspaceError(429, 'At most 6 chats at once'));
    await useClaude.getState().open('k1', '/home/u/a');
    expect(useClaude.getState().chats.k1).toMatchObject({ status: 'error', error: 'At most 6 chats at once' });
  });

  it('re-attaches to a live session after a page reload', async () => {
    localStorage.setItem(
      'openjarvis.workbench.chats',
      JSON.stringify({ k1: { sessionId: 's9', claudeSessionId: 'conv-9', mode: 'plan' } }),
    );
    m.getSession.mockResolvedValue(summary({ id: 's9', permission_mode: 'plan' }));
    await useClaude.getState().open('k1', '/home/u/a');
    expect(m.createSession).not.toHaveBeenCalled();
    expect(useClaude.getState().chats.k1).toMatchObject({ sessionId: 's9', mode: 'plan', status: 'ready' });
    expect(m.streamEvents.mock.calls[0][1]).toBe(-1); // replays everything
  });

  it('starts again with the saved conversation when the server forgot the session', async () => {
    localStorage.setItem(
      'openjarvis.workbench.chats',
      JSON.stringify({ k1: { sessionId: 'gone', claudeSessionId: 'conv-9', mode: 'default' } }),
    );
    m.getSession.mockRejectedValue(new WorkspaceError(404, 'No such session'));
    await useClaude.getState().open('k1', '/home/u/a');
    expect(m.createSession).toHaveBeenCalledWith('/home/u/a', 'default', 'conv-9', 'code', expect.any(Object));
    expect(useClaude.getState().chats.k1.status).toBe('ready');
  });
});

describe('a Jarvis chat', () => {
  it('is created with the jarvis kind and keeps it', async () => {
    await useClaude.getState().open('jarvis', '/home/u', 'jarvis');
    expect(m.createSession).toHaveBeenCalledWith('/home/u', 'default', null, 'jarvis', expect.any(Object));
    expect(useClaude.getState().chats.jarvis.kind).toBe('jarvis');
  });
});

describe('using a chat', () => {
  beforeEach(async () => {
    await useClaude.getState().open('k1', '/home/u/a');
  });

  it('sends a message', async () => {
    await useClaude.getState().send('k1', 'hi');
    expect(m.sendMessage).toHaveBeenCalledWith('s1', 'hi');
    expect(useClaude.getState().chats.k1.sending).toBe(false);
  });

  it('keeps the error and rethrows when sending fails', async () => {
    m.sendMessage.mockRejectedValue(new WorkspaceError(409, 'Claude is still answering'));
    await expect(useClaude.getState().send('k1', 'hi')).rejects.toBeInstanceOf(WorkspaceError);
    expect(useClaude.getState().chats.k1.error).toBe('Claude is still answering');
    expect(useClaude.getState().chats.k1.sending).toBe(false);
  });

  it('sends the answer to an approval', async () => {
    expect(await useClaude.getState().decide('k1', 'r1', true)).toBe(true);
    expect(m.decide).toHaveBeenCalledWith('s1', 'r1', true);
  });

  it('reports a failed answer so the buttons can be used again', async () => {
    m.decide.mockRejectedValueOnce(new Error('offline'));
    expect(await useClaude.getState().decide('k1', 'r1', true)).toBe(false);
    expect(useClaude.getState().chats.k1.error).toBeTruthy();
  });

  it('changes the permission mode and remembers it', async () => {
    m.setMode.mockResolvedValue(summary({ permission_mode: 'acceptEdits' }));
    await useClaude.getState().changeMode('k1', 'acceptEdits');
    expect(useClaude.getState().chats.k1.mode).toBe('acceptEdits');
    expect(JSON.parse(localStorage.getItem('openjarvis.workbench.chats') ?? '{}').k1.mode).toBe('acceptEdits');
  });

  it('changes model and effort, and remembers them', async () => {
    m.setSettings.mockResolvedValue(summary({ model: 'opus', effort: 'high' }));
    await useClaude.getState().changeSettings('k1', 'opus', 'high');
    expect(m.setSettings).toHaveBeenCalledWith('s1', 'opus', 'high');
    expect(useClaude.getState().chats.k1).toMatchObject({ modelChoice: 'opus', effort: 'high' });
    const saved = JSON.parse(localStorage.getItem('openjarvis.workbench.chats') ?? '{}').k1;
    expect(saved).toMatchObject({ modelChoice: 'opus', effort: 'high' });
  });

  it('sends the Custom rules with the mode, and pushes later edits to Custom windows only', async () => {
    const rules = { ...useClaude.getState().rules, readonly: true };
    m.setMode.mockResolvedValue(summary({ permission_mode: 'custom' }));
    await useClaude.getState().changeMode('k1', 'custom');
    expect(m.setMode).toHaveBeenLastCalledWith('s1', 'custom', useClaude.getState().rules);
    await useClaude.getState().setRules(rules);
    expect(m.setMode).toHaveBeenLastCalledWith('s1', 'custom', rules);
    expect(JSON.parse(localStorage.getItem('jarvis.customRules') ?? '{}').readonly).toBe(true);
    m.setMode.mockClear();
    m.setMode.mockResolvedValue(summary({ permission_mode: 'default' }));
    await useClaude.getState().changeMode('k1', 'default');
    expect(m.setMode).toHaveBeenLastCalledWith('s1', 'default', undefined);
    m.setMode.mockClear();
    await useClaude.getState().setRules({ ...rules, build_test: true });
    expect(m.setMode).not.toHaveBeenCalled(); // no window is in Custom mode any more
  });

  it('closing deletes the session and forgets the chat', async () => {
    await useClaude.getState().close('k1');
    expect(m.closeSession).toHaveBeenCalledWith('s1');
    expect(useClaude.getState().chats.k1).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('openjarvis.workbench.chats') ?? '{}').k1).toBeUndefined();
  });
});

describe('plan usage', () => {
  it('feeds the gauges from rate limit events', async () => {
    streamWith([
      {
        seq: 0,
        type: 'rate_limit_event',
        rate_limit_info: {
          unifiedWindows: {
            five_hour: { utilization: 0.12, resetsAt: 1_800_000_000 },
            seven_day: { utilization: 0.3, resetsAt: 1_800_500_000 },
          },
        },
      },
    ]);
    await useClaude.getState().open('k1', '/home/u/a');
    await flush();
    const usage = useAppStore.getState().planUsage;
    expect(usage?.fiveHour?.pct).toBeCloseTo(12);
    expect(usage?.sevenDay?.pct).toBeCloseTo(30);
  });
});
