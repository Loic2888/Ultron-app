/**
 * Wire protocol of the browser terminal (see server/terminal_routes.py).
 * Kept free of React and xterm so it can be unit-tested.
 */

export type ServerFrame =
  | { type: 'ready'; pid: number }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

/** ws(s):// URL of the terminal socket for a given API base. */
export function buildTerminalUrl(base: string, pageOrigin: string): string {
  const url = new URL('/v1/terminal/ws', base || pageOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** First message: carries the secret token, never put in the URL. */
export function openMessage(
  token: string,
  cols: number,
  rows: number,
  cwd?: string,
): string {
  return JSON.stringify({ type: 'open', token, cols, rows, ...(cwd ? { cwd } : {}) });
}

export const inputMessage = (data: string): string =>
  JSON.stringify({ type: 'input', data });

export const resizeMessage = (cols: number, rows: number): string =>
  JSON.stringify({ type: 'resize', cols, rows });

/** Parses a frame from the server, or null if it is malformed. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const f = value as Record<string, unknown>;
  switch (f.type) {
    case 'ready':
      return typeof f.pid === 'number' ? { type: 'ready', pid: f.pid } : null;
    case 'output':
      return typeof f.data === 'string' ? { type: 'output', data: f.data } : null;
    case 'exit':
      return typeof f.code === 'number' ? { type: 'exit', code: f.code } : null;
    case 'error':
      return typeof f.message === 'string' ? { type: 'error', message: f.message } : null;
    default:
      return null;
  }
}

/** Human-readable reason when the terminal could not start. */
export function describeFailure(status: number | null): string {
  if (status === 403) {
    return 'Terminals only work when the server runs on this machine (127.0.0.1) and the page comes from a known address.';
  }
  if (status === 401) return 'The server refused the API key.';
  if (status === null) return 'Cannot reach the Ultron server.';
  return `The server answered ${status}.`;
}
