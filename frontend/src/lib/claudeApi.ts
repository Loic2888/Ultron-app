/**
 * Client for the Claude Code chat routes (server/claude_routes.py).
 * Messages travel over plain HTTP: one POST per action, and one
 * shared long request (lib/hub.ts) for everything coming back.
 */
import { follow } from './hub';
import { WorkspaceError, authedFetch, describeStatus } from './workspaceApi';

export type PermissionMode = 'auto' | 'default' | 'acceptEdits' | 'custom' | 'plan';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Rules of the "Custom" mode (see server/custom_rules.py). Everything is off by default. */
export interface CustomRules {
  readonly: boolean;
  build_test: boolean;
  git_pr: boolean;
  install: boolean;
  files: boolean;
  docker: boolean;
  any_command: boolean;
  other_tools: boolean;
  allow_tools: string[];
  allow_commands: string[];
  allow_deletes: string[];
}
export type ChatKind = 'code' | 'jarvis';

export interface PendingApproval {
  request_id: string;
  tool_name?: string | null;
  display_name?: string | null;
  description?: string | null;
  input?: Record<string, unknown> | null;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  kind?: ChatKind;
  permission_mode: PermissionMode;
  model?: string | null;
  effort?: Effort | null;
  rules?: CustomRules;
  created_at?: number;
  claude_session_id: string | null;
  busy: boolean;
  closed: boolean;
  alive: boolean;
  pending: PendingApproval[];
  next_seq: number;
}

/** One line of the event stream: the server adds `seq` to every event. */
export interface ServerEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    let detail: string | undefined;
    try {
      detail = ((await res.json()) as { detail?: string }).detail;
    } catch {
      // not JSON
    }
    throw new WorkspaceError(res.status, describeStatus(res.status, detail));
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const claudeStatus = () => call<{ installed: boolean }>('/v1/claude/status');

export interface SessionOptions {
  model?: string | null;
  effort?: Effort | null;
  rules?: CustomRules;
}

export const createSession = (
  cwd: string,
  mode: PermissionMode,
  resume?: string | null,
  kind: ChatKind = 'code',
  options: SessionOptions = {},
) =>
  post<SessionSummary>('/v1/claude/sessions', {
    cwd,
    permission_mode: mode,
    resume: resume ?? undefined,
    kind,
    model: options.model ?? undefined,
    effort: options.effort ?? undefined,
    rules: options.rules,
  });

export const getSession = (id: string) => call<SessionSummary>(`/v1/claude/sessions/${id}`);

export const sendMessage = (id: string, text: string) =>
  post<{ ok: boolean }>(`/v1/claude/sessions/${id}/message`, { text });

export const decide = (id: string, requestId: string, allow: boolean) =>
  post<{ ok: boolean }>(`/v1/claude/sessions/${id}/decision`, { request_id: requestId, allow });

export const interrupt = (id: string) => post<{ ok: boolean }>(`/v1/claude/sessions/${id}/interrupt`);

export const setMode = (id: string, mode: PermissionMode, rules?: CustomRules) =>
  post<SessionSummary>(`/v1/claude/sessions/${id}/mode`, { permission_mode: mode, rules });

/** Model and effort of a chat (null = the program's default). */
export const setSettings = (id: string, model: string | null, effort: Effort | null) =>
  post<SessionSummary>(`/v1/claude/sessions/${id}/settings`, { model, effort });

export const closeSession = (id: string) =>
  call<{ ok: boolean }>(`/v1/claude/sessions/${id}`, { method: 'DELETE' });

/** Splits a stream of text chunks into complete lines; keeps the unfinished tail. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const text = buffer + chunk;
  const parts = text.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim() !== ''), rest };
}

/** Parses one stream line; keepalives and garbage give null. */
export function parseEventLine(line: string): ServerEvent | null {
  try {
    const v = JSON.parse(line) as unknown;
    if (v && typeof v === 'object' && typeof (v as ServerEvent).seq === 'number') {
      return v as ServerEvent;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Follows a chat's events (through the shared request, see lib/hub.ts) until it
 * ends or `signal` aborts. Rejects on network or HTTP errors.
 */
export async function streamEvents(
  id: string,
  after: number,
  onEvents: (events: ServerEvent[]) => void,
  signal: AbortSignal,
): Promise<void> {
  await follow(
    'chat',
    id,
    after,
    {
      onEvents: (events) => {
        const valid = events.filter((e): e is ServerEvent => typeof (e as ServerEvent).seq === 'number');
        if (valid.length > 0) onEvents(valid);
      },
    },
    signal,
  );
}

export interface ClaudeAccount {
  installed: boolean;
  logged_in: boolean;
  method?: string | null;
  email?: string | null;
  organization?: string | null;
  plan?: string | null;
  expires_at?: string | null;
}

export const claudeAccount = () =>
  call<ClaudeAccount>('/v1/claude/account').catch((e) => {
    // An older server answers with the web page instead of JSON.
    if (e instanceof SyntaxError) throw new Error('This server is too old for this feature: restart jarvis gui.');
    throw e;
  });
