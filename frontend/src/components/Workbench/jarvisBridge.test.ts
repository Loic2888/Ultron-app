import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/workspaceApi', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  WorkspaceError: class extends Error {},
}));

import type { ChatState } from './claudeStore';
import { emptyChat, type ChatModel } from './claudeModel';
import { executeCommand, lastAnswer, type BridgeDeps } from './jarvisBridge';
import { useWorkspace } from './workspaceStore';

const A = { path: '/home/u/a', name: 'a' };
const B = { path: '/home/u/b', name: 'b' };

let chats: Record<string, ChatState>;
let sent: { key: string; text: string }[];
let opened: string[];
let shown: number;
let getRepo: ReturnType<typeof vi.fn>;

const chatState = (over: Omit<Partial<ChatState>, 'model'> & { model?: Partial<ChatModel> } = {}): ChatState => {
  const { model, ...rest } = over;
  return {
    key: 'k',
    cwd: '/home/u/a',
    kind: 'code',
    mode: 'default',
    status: 'ready',
    error: '',
    sessionId: 's',
    modelChoice: null,
    effort: null,
    startedAt: null,
    sending: false,
    model: { ...emptyChat(), ...model },
    ...rest,
  };
};

const deps = (): BridgeDeps => ({
  workspace: () => useWorkspace.getState(),
  claude: () => ({
    chats,
    open: async (key, cwd) => {
      opened.push(key);
      chats[key] ??= chatState({ key, cwd });
    },
    send: async (key, text) => {
      sent.push({ key, text });
    },
  }),
  getRepo: getRepo as unknown as BridgeDeps['getRepo'],
  showWorkspace: () => {
    shown += 1;
  },
  sleep: async () => {},
});

const run = (name: string, args: Record<string, unknown> = {}) => executeCommand(name, args, deps());

beforeEach(() => {
  chats = {};
  sent = [];
  opened = [];
  shown = 0;
  getRepo = vi.fn(async (path: string) => ({
    path,
    name: path.split('/').pop() as string,
    is_git: true,
    branch: 'main',
  }));
  const s = useWorkspace.getState();
  for (const r of [...s.repos]) s.removeRepo(r.path);
});

describe('open_repo', () => {
  it('opens a folder the server accepts and makes it active', async () => {
    const out = await run('open_repo', { path: '/home/u/a' });
    expect(out).toMatchObject({ path: '/home/u/a', name: 'a', branch: 'main' });
    expect(useWorkspace.getState().activeRepo).toBe('/home/u/a');
    expect(shown).toBe(1);
  });

  it('refuses relative paths without asking the server', async () => {
    await expect(run('open_repo', { path: '../x' })).rejects.toThrow('absolute');
    expect(getRepo).not.toHaveBeenCalled();
  });

  it('passes the server refusal on to Jarvis', async () => {
    getRepo.mockRejectedValue(new Error('Path must stay inside the home folder'));
    await expect(run('open_repo', { path: '/etc' })).rejects.toThrow('inside the home');
    expect(useWorkspace.getState().repos).toEqual([]);
  });

  it('switches to a repo that is already open instead of duplicating it', async () => {
    await run('open_repo', { path: A.path });
    await run('open_repo', { path: B.path });
    await run('open_repo', { path: A.path });
    expect(useWorkspace.getState().repos.map((r) => r.path)).toEqual([A.path, B.path]);
    expect(useWorkspace.getState().activeRepo).toBe(A.path);
  });
});

describe('tabs and terminals', () => {
  beforeEach(async () => {
    await run('open_repo', { path: A.path });
    await run('open_repo', { path: B.path });
  });

  it('opens a Claude Code tab in the active repo', async () => {
    const out = (await run('new_claude_tab')) as { chat: string; repo: string; prompt_sent: boolean };
    expect(out.repo).toBe(B.path);
    expect(out.prompt_sent).toBe(false);
    const tabs = useWorkspace.getState().sessions[B.path].tabs;
    expect(tabs[tabs.length - 1]).toMatchObject({ kind: 'claude', chat: out.chat });
    expect(sent).toEqual([]);
  });

  it('can target another open repo, and sends the first prompt', async () => {
    const out = (await run('new_claude_tab', { repo: A.path, prompt: 'fix the tests' })) as { chat: string };
    expect(useWorkspace.getState().activeRepo).toBe(A.path);
    expect(opened).toEqual([out.chat]);
    expect(sent).toEqual([{ key: out.chat, text: 'fix the tests' }]);
  });

  it('refuses a repo that is not open', async () => {
    await expect(run('new_claude_tab', { repo: '/home/u/zzz' })).rejects.toThrow('open_repo');
    await expect(run('new_terminal', { repo: '/home/u/zzz' })).rejects.toThrow('open_repo');
  });

  it('opens a terminal', async () => {
    const before = useWorkspace.getState().sessions[A.path].terms.length;
    const out = (await run('new_terminal', { repo: A.path })) as { terminals: number };
    expect(out.terminals).toBe(before + 1);
  });

  it('says so when no repo is open at all', async () => {
    const s = useWorkspace.getState();
    s.removeRepo(A.path);
    s.removeRepo(B.path);
    await expect(run('new_terminal')).rejects.toThrow('No repository is open');
  });
});

describe('send_prompt and read_chat', () => {
  let key: string;
  beforeEach(async () => {
    await run('open_repo', { path: A.path });
    key = ((await run('new_claude_tab')) as { chat: string }).chat;
  });

  it('sends the message to the chat', async () => {
    await run('send_prompt', { chat: key, text: 'hello' });
    expect(sent).toEqual([{ key, text: 'hello' }]);
  });

  it('finds a chat by its title in the active repo', async () => {
    await run('send_prompt', { chat: 'claude code 1', text: 'hi' });
    expect(sent[0].key).toBe(key);
  });

  it('refuses unknown chats and empty messages', async () => {
    await expect(run('send_prompt', { chat: 'nope', text: 'x' })).rejects.toThrow('list_workspace');
    await expect(run('send_prompt', { chat: key, text: '  ' })).rejects.toThrow('empty');
  });

  it('does not talk over a chat that is still working', async () => {
    chats[key] = chatState({ key, model: { busy: true } });
    await expect(run('send_prompt', { chat: key, text: 'x' })).rejects.toThrow('still working');
    expect(sent).toEqual([]);
  });

  it('does not bypass a pending approval of the owner', async () => {
    chats[key] = chatState({ key, model: { approvals: [{ request_id: 'r', tool_name: 'Bash' }] } });
    await expect(run('send_prompt', { chat: key, text: 'x' })).rejects.toThrow('approval');
    expect(sent).toEqual([]);
  });

  it('reports a failed start', async () => {
    chats[key] = chatState({ key, status: 'error', error: 'claude not installed' });
    opened = [];
    await expect(run('send_prompt', { chat: key, text: 'x' })).rejects.toThrow('claude not installed');
  });

  it('reads the state and latest answer of a chat', async () => {
    chats[key] = chatState({
      key,
      model: {
        items: [
          { kind: 'user', id: 'u1', text: 'old question' },
          { kind: 'assistant', id: 'a1', streaming: false, blocks: [{ kind: 'text', text: 'old answer' }] },
          { kind: 'user', id: 'u2', text: 'new question' },
          { kind: 'assistant', id: 'a2', streaming: false, blocks: [{ kind: 'text', text: 'the real answer' }] },
        ],
      },
    });
    const out = (await run('read_chat', { chat: key })) as Record<string, unknown>;
    expect(out).toMatchObject({ opened: true, busy: false, last_answer: 'the real answer' });
  });

  it('shows what is waiting for the owner', async () => {
    chats[key] = chatState({
      key,
      model: { busy: true, approvals: [{ request_id: 'r', tool_name: 'Bash', display_name: 'Bash', input: { command: 'rm x' } }] },
    });
    const out = (await run('read_chat', { chat: key })) as { waiting_for_owner_approval: unknown[] };
    expect(out.waiting_for_owner_approval).toEqual([{ tool: 'Bash', what: 'rm x' }]);
  });

  it('waits for the end of a busy chat when asked', async () => {
    chats[key] = chatState({ key, model: { busy: true } });
    let polls = 0;
    const d = deps();
    d.sleep = async () => {
      polls += 1;
      if (polls === 3) chats[key] = chatState({ key, model: { busy: false } });
    };
    const out = (await executeCommand('read_chat', { chat: key, wait_seconds: 30 }, d)) as { busy: boolean };
    expect(out.busy).toBe(false);
    expect(polls).toBe(3);
  });

  it('stops waiting at the limit', async () => {
    chats[key] = chatState({ key, model: { busy: true } });
    const d = deps();
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    d.sleep = async () => {
      now += 20_000;
    };
    const out = (await executeCommand('read_chat', { chat: key, wait_seconds: 30 }, d)) as { busy: boolean };
    vi.restoreAllMocks();
    expect(out.busy).toBe(true);
  });

  it('cuts very long answers', () => {
    const model = {
      ...emptyChat(),
      items: [{ kind: 'assistant', id: 'a', streaming: false, blocks: [{ kind: 'text', text: 'x'.repeat(5000) }] }],
    } as ChatModel;
    expect(lastAnswer(model, 300).length).toBeLessThanOrEqual(301);
  });
});

describe('list_workspace and unknown commands', () => {
  it('lists repos with their chats, files and terminals', async () => {
    await run('open_repo', { path: A.path });
    const chat = ((await run('new_claude_tab')) as { chat: string }).chat;
    await run('new_terminal');
    const out = (await run('list_workspace')) as {
      active_repo: string;
      repos: { path: string; claude_chats: { chat: string }[]; terminals: number }[];
    };
    expect(out.active_repo).toBe(A.path);
    expect(out.repos[0].claude_chats.map((c) => c.chat)).toEqual([chat]);
    expect(out.repos[0].terminals).toBeGreaterThanOrEqual(1);
  });

  it('refuses commands it does not know', async () => {
    await expect(run('delete_everything')).rejects.toThrow('does not know');
  });
});
