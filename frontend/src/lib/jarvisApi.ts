/**
 * Client for the screen side of the Jarvis assistant (server/jarvis_routes.py):
 * a stream of commands (open a repo, open a tab...), a claim so that only one
 * open window runs each, and the result sent back.
 */
import { WorkspaceError, authedFetch, describeStatus } from './workspaceApi';
import { follow } from './hub';

export interface ScreenCommand {
  seq: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Parses one stream line; keepalives and garbage give null. */
export function parseCommandLine(line: string): ScreenCommand | null {
  try {
    const v = JSON.parse(line) as Partial<ScreenCommand>;
    if (
      v &&
      typeof v.seq === 'number' &&
      typeof v.id === 'string' &&
      typeof v.name === 'string' &&
      v.args !== null &&
      typeof v.args === 'object'
    ) {
      return v as ScreenCommand;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Reads commands until the stream ends or `signal` aborts (rejects on errors). */
export async function streamCommands(
  after: number,
  onCommands: (commands: ScreenCommand[]) => void,
  signal: AbortSignal,
): Promise<void> {
  await follow(
    'cmd',
    '',
    after,
    {
      onEvents: (events) => {
        const commands = events
          .map((e) => parseCommandLine(JSON.stringify(e)))
          .filter((c): c is ScreenCommand => c !== null);
        if (commands.length > 0) onCommands(commands);
      },
    },
    signal,
  );
}

const post = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new WorkspaceError(res.status, describeStatus(res.status));
  return (await res.json()) as T;
};

export const claimCommand = (id: string) =>
  post<{ claimed: boolean }>(`/v1/jarvis/commands/${id}/claim`);

export const sendResult = (id: string, outcome: { ok: boolean; result?: unknown; error?: string }) =>
  post<{ ok: boolean }>(`/v1/jarvis/commands/${id}/result`, outcome);
