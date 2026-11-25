/**
 * Tells the server this page is open. One never-ending request stays open while
 * the page lives; when the window closes the browser drops it, and a server
 * started by the desktop icon stops itself (server/presence.py).
 */
import { authedFetch } from './workspaceApi';

export interface PresenceDeps {
  open: (signal: AbortSignal) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const defaultDeps: PresenceDeps = {
  open: (signal) => authedFetch('/v1/app/presence', { signal }),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    }),
};

const RETRY_MS = 2000;
const OLD_SERVER_MS = 60_000;

/** Keeps the connection open until `signal` aborts, reconnecting when it drops. */
export async function runPresence(signal: AbortSignal, deps: PresenceDeps = defaultDeps): Promise<void> {
  while (!signal.aborted) {
    let wait = RETRY_MS;
    try {
      const res = await deps.open(signal);
      if (!res.ok || !res.body) {
        // An older server has no such route: nothing to do, look again later.
        wait = res.status === 404 ? OLD_SERVER_MS : RETRY_MS * 5;
      } else {
        const reader = res.body.getReader();
        // Read until the server (or the page) ends it; the lines are only keepalives.
        while (!(await reader.read()).done) {
          /* keepalive */
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await deps.sleep(wait, signal);
  }
}
