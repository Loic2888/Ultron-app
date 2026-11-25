import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('./workspaceApi', async () => {
  const actual = await vi.importActual<typeof import('./workspaceApi')>('./workspaceApi');
  return { ...actual, authedFetch: (...args: unknown[]) => fetchMock(...args) };
});

import { follow, resetHub } from './hub';
import { WorkspaceError } from './workspaceApi';

const answer = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

/** A fake server: answers each poll from a queue, else waits until aborted. */
function serve(answers: unknown[]) {
  fetchMock.mockImplementation((_path: string, init: RequestInit) => {
    const next = answers.shift();
    if (next !== undefined) return answer(next);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });
}

const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));

beforeEach(() => {
  resetHub();
  fetchMock.mockReset();
});

describe('hub', () => {
  it('follows a chat and a shell with one request, keeping their own cursors', async () => {
    serve([
      {
        items: [
          { ch: 'chat', id: 'c1', events: [{ seq: 4 }] },
          { ch: 'term', id: 't1', events: [{ seq: 7, data: 'x' }] },
        ],
        ended: [],
      },
    ]);
    const chat = vi.fn();
    const term = vi.fn();
    const ctl = new AbortController();
    void follow('chat', 'c1', 3, { onEvents: chat }, ctl.signal);
    void follow('term', 't1', 6, { onEvents: term }, ctl.signal);
    await vi.waitFor(() => expect(term).toHaveBeenCalledWith([{ seq: 7, data: 'x' }]));
    expect(chat).toHaveBeenCalledWith([{ seq: 4 }]);
    // the next request carries the new cursors, in a single call
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    const last = bodies()[bodies().length - 1];
    expect(last.subs).toEqual(
      expect.arrayContaining([
        { ch: 'chat', id: 'c1', after: 4 },
        { ch: 'term', id: 't1', after: 7 },
      ]),
    );
    ctl.abort();
  });

  it('resolves when the server says the thing ended', async () => {
    serve([{ items: [{ ch: 'chat', id: 'c1', ended: 'closed' }], ended: [] }]);
    const ctl = new AbortController();
    await expect(follow('chat', 'c1', -1, { onEvents: vi.fn() }, ctl.signal)).resolves.toBeUndefined();
  });

  it('rejects with a 404 when the chat no longer exists', async () => {
    serve([{ items: [], ended: [{ ch: 'chat', id: 'gone', ended: 'missing' }] }]);
    const ctl = new AbortController();
    const err = await follow('chat', 'gone', -1, { onEvents: vi.fn() }, ctl.signal).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).status).toBe(404);
  });

  it('does not mistake a server without the hub (404) for a missing chat', async () => {
    fetchMock.mockImplementation(() => answer({}, 404));
    const ctl = new AbortController();
    const err = await follow('chat', 'c1', -1, { onEvents: vi.fn() }, ctl.signal).catch((e) => e);
    expect((err as WorkspaceError).status).not.toBe(404);
  });

  it('calls onOpen once, after the first answer', async () => {
    serve([{ items: [], ended: [] }]);
    const onOpen = vi.fn();
    const ctl = new AbortController();
    void follow('term', 't', -1, { onEvents: vi.fn(), onOpen }, ctl.signal);
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    ctl.abort();
  });

  it('stops following when aborted', async () => {
    serve([]);
    const ctl = new AbortController();
    const done = follow('chat', 'c1', -1, { onEvents: vi.fn() }, ctl.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    ctl.abort();
    await expect(done).resolves.toBeUndefined();
  });
});
