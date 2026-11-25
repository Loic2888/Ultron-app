/**
 * One long request for everything the page follows live (server/hub_routes.py).
 *
 * A browser keeps at most six connections open to one address. Chats, terminals
 * and the Jarvis screen commands used to hold one never-ending stream each, so a
 * few open tabs used them all and the next request waited forever. Here they
 * share a single request: it lists what is followed and the last sequence number
 * seen for each, and it answers as soon as anything is new. The cursors live on
 * this side, so an interrupted request loses nothing.
 */
import { WorkspaceError, authedFetch, describeStatus } from './workspaceApi';

export type Channel = 'chat' | 'term' | 'cmd';

interface Entry {
  ch: Channel;
  sid: string;
  after: number;
  onEvents: (events: Record<string, unknown>[]) => void;
  onOpen?: () => void;
  opened: boolean;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface PollItem {
  ch: Channel;
  id: string;
  events?: Record<string, unknown>[];
  ended?: string;
}

interface PollAnswer {
  items: PollItem[];
  ended: { ch: Channel; id: string; ended: string }[];
}

const MIN_ROUND_MS = 200; // never spin if the server answers "nothing" at once

const entries = new Set<Entry>();
let running = false;
let inFlight: AbortController | null = null;

const sameThing = (e: Entry, ch: Channel, id: string) => e.ch === ch && e.sid === id;

function finish(entry: Entry, err?: unknown) {
  if (!entries.delete(entry)) return;
  if (err === undefined) entry.resolve();
  else entry.reject(err);
}

function dispatch(answer: PollAnswer) {
  for (const item of answer.items ?? []) {
    for (const entry of [...entries]) {
      if (!sameThing(entry, item.ch, item.id)) continue;
      const events = item.events ?? [];
      if (events.length > 0) {
        for (const ev of events) {
          if (typeof ev.seq === 'number') entry.after = Math.max(entry.after, ev.seq);
        }
        entry.onEvents(events);
      }
      if (item.ended) finish(entry);
    }
  }
  for (const gone of answer.ended ?? []) {
    for (const entry of [...entries]) {
      if (sameThing(entry, gone.ch, gone.id)) finish(entry, new WorkspaceError(404, describeStatus(404)));
    }
  }
}

async function run() {
  running = true;
  try {
    while (entries.size > 0) {
      const snapshot = [...entries];
      const ctl = new AbortController();
      inFlight = ctl;
      const started = Date.now();
      try {
        // The answer can take up to 25 s when nothing happens, so "connected" is
        // announced once the request is on its way, not when it comes back.
        for (const entry of snapshot) {
          if (entries.has(entry) && !entry.opened) {
            entry.opened = true;
            entry.onOpen?.();
          }
        }
        const res = await authedFetch('/v1/hub/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subs: snapshot.map((e) => ({ ch: e.ch, id: e.sid, after: e.after })),
          }),
          signal: ctl.signal,
        });
        if (!res.ok) {
          // A 404 here means an old server without the hub, not "that chat is gone".
          throw new WorkspaceError(res.status === 404 ? 502 : res.status, describeStatus(res.status));
        }
        const answer = (await res.json()) as PollAnswer;
        dispatch(answer);
      } catch (err) {
        if (ctl.signal.aborted) continue; // what is followed changed: ask again
        // Network or server trouble: each follower retries on its own schedule.
        for (const entry of snapshot) finish(entry, err);
      } finally {
        if (inFlight === ctl) inFlight = null;
      }
      const spent = Date.now() - started;
      if (entries.size > 0 && spent < MIN_ROUND_MS) {
        await new Promise((r) => setTimeout(r, MIN_ROUND_MS - spent));
      }
    }
  } finally {
    running = false;
    if (entries.size > 0) void run();
  }
}

/**
 * Follows one chat, terminal or the screen-command queue through the shared
 * request. Resolves when the thing ends (chat closed, shell exited) or when
 * `signal` aborts; rejects with a `WorkspaceError` (404 when it no longer
 * exists) or on network errors.
 */
export function follow(
  ch: Channel,
  sid: string,
  after: number,
  handlers: { onEvents: (events: Record<string, unknown>[]) => void; onOpen?: () => void },
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const entry: Entry = {
      ch,
      sid,
      after,
      onEvents: handlers.onEvents,
      onOpen: handlers.onOpen,
      opened: false,
      resolve,
      reject,
    };
    entries.add(entry);
    signal.addEventListener(
      'abort',
      () => {
        if (entries.delete(entry)) {
          inFlight?.abort();
          resolve();
        }
      },
      { once: true },
    );
    inFlight?.abort(); // include the new one in the next request
    if (!running) void run();
  });
}

/** For tests: forget everything followed. */
export function resetHub() {
  for (const entry of [...entries]) finish(entry);
  inFlight?.abort();
}
