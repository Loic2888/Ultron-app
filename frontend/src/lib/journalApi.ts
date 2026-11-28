/**
 * Client for the journal routes (server/journal.py): the action log, the Claude
 * Code memory and the last known plan usage. Everything stays on this machine.
 */
import { WorkspaceError, authedFetch, describeStatus } from './workspaceApi';

export interface LogItem {
  ts: number;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  repo: string | null;
}

export interface MemoryItem {
  ts: number;
  repo: string;
  chat: string;
  prompt: string;
  files: string[];
  tools: Record<string, number>;
  answer: string;
  ok: boolean;
  seconds: number;
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

export const fetchLogs = (limit = 1000) =>
  call<{ entries: LogItem[] }>(`/v1/journal/logs?limit=${limit}`).then((r) => r.entries);

export const clearServerLogs = () => call<{ ok: boolean }>('/v1/journal/logs', { method: 'DELETE' });

export const fetchMemory = (limit = 500) =>
  call<{ entries: MemoryItem[] }>(`/v1/journal/memory?limit=${limit}`).then((r) => r.entries);

export interface RepoMemory {
  slug: string;
  repo: string;
  name: string;
  files: { name: string; size: number; modified: number }[];
}

/** One memory folder per repo (notes, what works, what does not). */
export const fetchRepoMemories = () =>
  call<{ repos: RepoMemory[] }>('/v1/memory/repos').then((r) => r.repos);

export const fetchRepoMemoryFile = (slug: string, name: string) =>
  call<{ text: string }>(
    `/v1/memory/repos/${encodeURIComponent(slug)}/files/${name.split('/').map(encodeURIComponent).join('/')}`,
  ).then((r) => r.text);

export interface JournalInfo {
  journal_dir: string;
  memory_dir: string;
  log_entries: number;
  task_entries: number;
}

export const fetchJournalInfo = () => call<JournalInfo>('/v1/journal/info');

export interface PhoneStatus {
  configured: boolean;
  running: boolean;
  max_per_hour: number | null;
  max_text: number | null;
  turn_seconds: number | null;
  five_hour_stop: number | null;
  week_stop: number | null;
}

export const fetchPhoneStatus = () => call<PhoneStatus>('/v1/phone/status');

export interface IntegrationsStatus {
  github: { installed: boolean; logged_in: boolean };
  connectors: { claude_installed: boolean; read_only_tools: number };
  mail_send: { configured: boolean };
}

export const fetchIntegrationsStatus = () => call<IntegrationsStatus>('/v1/integrations/status');

/** Fire and forget: a failed log line must never disturb the screen. */
export function logAction(category: string, message: string, repo?: string, level: LogItem['level'] = 'info'): void {
  call('/v1/journal/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, message, repo: repo ?? null, level }),
  }).catch(() => undefined);
}

export interface ServerUsage {
  seen_at: number;
  windows: unknown;
}

export const fetchUsage = () =>
  call<{ usage: ServerUsage | null }>('/v1/claude/usage').then((r) => r.usage);

/** Asks the server to read fresh usage (one tiny `claude` request, throttled). */
export const refreshUsage = () =>
  call<{ usage: ServerUsage | null }>('/v1/claude/usage/refresh', { method: 'POST' }).then((r) => r.usage);

const pad = (n: number) => String(n).padStart(2, '0');

/** "22/11/2026 à 18h52" */
export function formatStamp(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}h${pad(d.getMinutes())}`;
}

export const repoName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
