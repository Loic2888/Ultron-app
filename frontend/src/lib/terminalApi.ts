/**
 * Client for the HTTP terminal (server/terminal_http.py): one POST to start a
 * shell, one long streaming GET (JSON lines) for its output, one POST per
 * batch of typed keys. No WebSocket, which some Windows/WSL setups block.
 */
import { follow } from './hub';
import { WorkspaceError, authedFetch, describeStatus } from './workspaceApi';

export type OutputLine = { seq: number; data: string } | { exit: number };

async function failure(res: Response): Promise<WorkspaceError> {
  let detail: string | undefined;
  try {
    detail = ((await res.json()) as { detail?: string }).detail;
  } catch {
    // not JSON
  }
  return new WorkspaceError(res.status, describeStatus(res.status, detail));
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function openShell(
  cwd: string | undefined,
  cols: number,
  rows: number,
  signal?: AbortSignal,
): Promise<string> {
  const res = await authedFetch('/v1/terminal/sessions', { ...json({ cwd, cols, rows }), signal });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { id: string }).id;
}

export async function sendInput(id: string, data: string): Promise<void> {
  const res = await authedFetch(`/v1/terminal/sessions/${id}/input`, json({ data }));
  if (!res.ok) throw await failure(res);
}

export async function resizeShell(id: string, cols: number, rows: number): Promise<void> {
  await authedFetch(`/v1/terminal/sessions/${id}/resize`, json({ cols, rows })).catch(() => {});
}

export async function closeShell(id: string): Promise<void> {
  await authedFetch(`/v1/terminal/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
}

/** Parses one output line; keepalives and garbage give null. */
export function parseOutputLine(line: string): OutputLine | null {
  try {
    const v = JSON.parse(line) as Record<string, unknown> | null;
    if (v && typeof v.seq === 'number' && typeof v.data === 'string') return { seq: v.seq, data: v.data };
    if (v && typeof v.exit === 'number') return { exit: v.exit };
  } catch {
    // ignore
  }
  return null;
}

/**
 * Follows the shell output (through the shared request, see lib/hub.ts) until
 * it ends or `signal` aborts. Calls `onOpen` once the server has answered. Rejects on network or HTTP errors.
 */
export async function streamOutput(
  id: string,
  after: number,
  handlers: { onOpen: () => void; onLines: (lines: OutputLine[]) => void },
  signal: AbortSignal,
): Promise<void> {
  await follow(
    'term',
    id,
    after,
    {
      onOpen: handlers.onOpen,
      onEvents: (events) => {
        const lines = events
          .map((e) => parseOutputLine(JSON.stringify(e)))
          .filter((l): l is OutputLine => l !== null);
        if (lines.length > 0) handlers.onLines(lines);
      },
    },
    signal,
  );
}
