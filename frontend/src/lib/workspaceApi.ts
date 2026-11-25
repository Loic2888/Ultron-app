/**
 * Client for the workspace file endpoints (server/workspace_routes.py).
 * Every call carries the per-process token in `X-Jarvis-Token`.
 */
import { apiFetch } from './api';

export interface RepoInfo {
  path: string;
  name: string;
  is_git: boolean;
  branch: string | null;
}

export interface TreeEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  is_git?: boolean;
}

export interface FileData {
  path: string;
  content: string;
  size: number;
  mtime: string;
}

export class WorkspaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}

let tokenPromise: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const res = await apiFetch('/v1/terminal/token');
  if (!res.ok) throw new WorkspaceError(res.status, describeStatus(res.status));
  return ((await res.json()) as { token: string }).token;
}

function getToken(force = false): Promise<string> {
  if (force || !tokenPromise) {
    tokenPromise = fetchToken().catch((err) => {
      tokenPromise = null; // do not cache a failure
      throw err;
    });
  }
  return tokenPromise;
}

/** Plain-words reason for a failed request. */
export function describeStatus(status: number, detail?: string): string {
  if (detail) return detail;
  if (status === 403) {
    return 'Refused: the workspace only works when the server runs on this machine and the page comes from a known address.';
  }
  if (status === 404) return 'Not found.';
  return `The server answered ${status}.`;
}

/**
 * Fetch with the per-process token. Retries once with a fresh token on 403
 * (the server may have restarted). Network failures become a WorkspaceError.
 */
export async function authedFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getToken();
  let res: Response;
  try {
    res = await apiFetch(path, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), 'X-Jarvis-Token': token },
    });
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new WorkspaceError(0, 'Cannot reach the Jarvis server.');
  }
  if (res.status === 403 && retry) {
    await getToken(true);
    return authedFetch(path, init, false);
  }
  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

const q = (params: Record<string, string | boolean | undefined>): string => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== false) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const getHome = () => request<{ home: string }>('/v1/workspace/home');

export const getRepo = (path: string) =>
  request<RepoInfo>(`/v1/workspace/repo${q({ path })}`);

export const listTree = (path: string, dirsOnly = false) =>
  request<{ path: string; entries: TreeEntry[]; truncated: boolean }>(
    `/v1/workspace/tree${q({ path, dirs_only: dirsOnly })}`,
  );

export const readFile = (path: string) =>
  request<FileData>(`/v1/workspace/file${q({ path })}`);

export const writeFile = (path: string, content: string, expectedMtime?: string) =>
  request<{ path: string; size: number; mtime: string }>('/v1/workspace/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, expected_mtime: expectedMtime }),
  });
