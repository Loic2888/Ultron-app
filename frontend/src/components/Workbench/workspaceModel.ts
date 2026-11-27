/**
 * Pure state of the workbench: which repos are open and, for each repo, its
 * editor/Claude tabs and its terminals. No React, no network, so it is easy
 * to test. Every function returns a new state and never mutates its input.
 */

export type TabKind = 'claude' | 'editor' | 'terminal';

export interface Tab {
  id: number;
  kind: TabKind;
  title: string;
  /** Absolute file path (editor tabs only). */
  path?: string;
  /** Stable key linking a Claude tab to its conversation (Claude tabs only). */
  chat?: string;
}

export interface RepoRef {
  path: string;
  name: string;
}

export interface RepoSession {
  tabs: Tab[];
  activeTab: number | null;
  terms: Tab[];
  activeTerm: number | null;
  termCounter: number;
  claudeCounter: number;
  /** The first terminal is opened automatically once per repo and per run. */
  termsStarted: boolean;
}

export interface WorkspaceState {
  repos: RepoRef[];
  activeRepo: string | null;
  sessions: Record<string, RepoSession>;
  nextId: number;
}

export const emptySession = (): RepoSession => ({
  tabs: [],
  activeTab: null,
  terms: [],
  activeTerm: null,
  termCounter: 0,
  claudeCounter: 0,
  termsStarted: false,
});

export const initialState = (): WorkspaceState => ({
  repos: [],
  activeRepo: null,
  sessions: {},
  nextId: 1,
});

export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
};

/** Replace one repo's session; unknown repo → state unchanged. */
function withSession(
  s: WorkspaceState,
  repo: string,
  update: (session: RepoSession) => RepoSession,
): WorkspaceState {
  const current = s.sessions[repo];
  if (!current) return s;
  return { ...s, sessions: { ...s.sessions, [repo]: update(current) } };
}

/** After removing a tab, which one becomes active. */
function neighbourAfterRemoval(tabs: Tab[], removedId: number, activeId: number | null): number | null {
  const index = tabs.findIndex((t) => t.id === removedId);
  const rest = tabs.filter((t) => t.id !== removedId);
  if (activeId !== removedId) return activeId;
  if (rest.length === 0) return null;
  return rest[Math.min(index, rest.length - 1)].id;
}

// ---- repositories ---------------------------------------------------------

export function addRepo(s: WorkspaceState, input: RepoRef): WorkspaceState {
  if (s.repos.some((r) => r.path === input.path)) return { ...s, activeRepo: input.path };
  // Always show a folder name, never a path (also for names saved by older versions).
  const repo: RepoRef = { ...input, name: basename(input.name || input.path) };
  return {
    ...s,
    repos: [...s.repos, repo],
    activeRepo: repo.path,
    sessions: { ...s.sessions, [repo.path]: emptySession() },
  };
}

export function selectRepo(s: WorkspaceState, path: string): WorkspaceState {
  return s.repos.some((r) => r.path === path) ? { ...s, activeRepo: path } : s;
}

export function removeRepo(s: WorkspaceState, path: string): WorkspaceState {
  const index = s.repos.findIndex((r) => r.path === path);
  if (index === -1) return s;
  const repos = s.repos.filter((r) => r.path !== path);
  const { [path]: _gone, ...sessions } = s.sessions;
  void _gone;
  let activeRepo = s.activeRepo;
  if (activeRepo === path) {
    activeRepo = repos.length ? repos[Math.min(index, repos.length - 1)].path : null;
  }
  return { ...s, repos, activeRepo, sessions };
}

// ---- editor / claude tabs -------------------------------------------------

export function openFile(s: WorkspaceState, repo: string, filePath: string): WorkspaceState {
  const session = s.sessions[repo];
  if (!session) return s;
  const existing = session.tabs.find((t) => t.kind === 'editor' && t.path === filePath);
  if (existing) return withSession(s, repo, (x) => ({ ...x, activeTab: existing.id }));
  const tab: Tab = { id: s.nextId, kind: 'editor', title: basename(filePath), path: filePath };
  const next = withSession(s, repo, (x) => ({ ...x, tabs: [...x.tabs, tab], activeTab: tab.id }));
  return { ...next, nextId: s.nextId + 1 };
}

export const newChatKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function addClaudeTab(
  s: WorkspaceState,
  repo: string,
  chat: string = newChatKey(),
): WorkspaceState {
  const session = s.sessions[repo];
  if (!session) return s;
  const n = session.claudeCounter + 1;
  const tab: Tab = { id: s.nextId, kind: 'claude', title: `Claude Code ${n}`, chat };
  const next = withSession(s, repo, (x) => ({
    ...x,
    tabs: [...x.tabs, tab],
    activeTab: tab.id,
    claudeCounter: n,
  }));
  return { ...next, nextId: s.nextId + 1 };
}

/**
 * Label shown on a tab. A Claude Code window that is alone in its strip is shown
 * without its number ("Claude Code", not "Claude Code 2"): the number is only
 * there to tell several windows apart. The stored title and the counter are
 * untouched.
 */
export function tabLabel(tab: Tab, tabs: Tab[]): string {
  if (tab.kind !== 'claude') return tab.title;
  if (tabs.filter((t) => t.kind === 'claude').length > 1) return tab.title;
  return tab.title.replace(/ \d+$/, '');
}

export function selectTab(s: WorkspaceState, repo: string, id: number): WorkspaceState {
  return withSession(s, repo, (x) => (x.tabs.some((t) => t.id === id) ? { ...x, activeTab: id } : x));
}

export function closeTab(s: WorkspaceState, repo: string, id: number): WorkspaceState {
  return withSession(s, repo, (x) => ({
    ...x,
    tabs: x.tabs.filter((t) => t.id !== id),
    activeTab: neighbourAfterRemoval(x.tabs, id, x.activeTab),
  }));
}

// ---- terminals ------------------------------------------------------------

export function addTerminal(s: WorkspaceState, repo: string): WorkspaceState {
  const session = s.sessions[repo];
  if (!session) return s;
  const n = session.termCounter + 1;
  const tab: Tab = { id: s.nextId, kind: 'terminal', title: `Terminal ${n}` };
  const next = withSession(s, repo, (x) => ({
    ...x,
    terms: [...x.terms, tab],
    activeTerm: tab.id,
    termCounter: n,
    termsStarted: true,
  }));
  return { ...next, nextId: s.nextId + 1 };
}

/** Opens the repo's first terminal, once. Later calls do nothing. */
export function ensureTerminal(s: WorkspaceState, repo: string): WorkspaceState {
  const session = s.sessions[repo];
  if (!session || session.termsStarted) return s;
  return addTerminal(s, repo);
}

export function selectTerminal(s: WorkspaceState, repo: string, id: number): WorkspaceState {
  return withSession(s, repo, (x) => (x.terms.some((t) => t.id === id) ? { ...x, activeTerm: id } : x));
}

export function closeTerminal(s: WorkspaceState, repo: string, id: number): WorkspaceState {
  return withSession(s, repo, (x) => ({
    ...x,
    terms: x.terms.filter((t) => t.id !== id),
    activeTerm: neighbourAfterRemoval(x.terms, id, x.activeTerm),
  }));
}

// ---- queries --------------------------------------------------------------

/** Every file path open in an editor tab, across all repos. */
export function openEditorPaths(s: WorkspaceState): string[] {
  const out: string[] = [];
  for (const session of Object.values(s.sessions)) {
    for (const t of session.tabs) if (t.kind === 'editor' && t.path) out.push(t.path);
  }
  return out;
}

// ---- persistence ----------------------------------------------------------

/** What survives a page reload: repos and open files (terminals cannot). */
export function toPersisted(s: WorkspaceState): unknown {
  const sessions: Record<string, { tabs: Tab[]; activeTab: number | null }> = {};
  for (const [repo, x] of Object.entries(s.sessions)) {
    const tabs = x.tabs.filter((t) => t.kind === 'editor' || (t.kind === 'claude' && t.chat));
    sessions[repo] = {
      tabs,
      activeTab: tabs.some((t) => t.id === x.activeTab) ? x.activeTab : (tabs[tabs.length - 1]?.id ?? null),
    };
  }
  return { version: 1, repos: s.repos, activeRepo: s.activeRepo, sessions };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Rebuilds a valid state from whatever was stored; garbage gives an empty state. */
export function fromPersisted(raw: unknown): WorkspaceState {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.repos)) return initialState();
  let state = initialState();
  for (const r of raw.repos) {
    if (isRecord(r) && typeof r.path === 'string' && r.path.startsWith('/') && typeof r.name === 'string') {
      state = addRepo(state, { path: r.path, name: r.name });
    }
  }
  const savedSessions = isRecord(raw.sessions) ? raw.sessions : {};
  let maxId = 0;
  for (const repo of state.repos) {
    const saved = savedSessions[repo.path];
    if (!isRecord(saved) || !Array.isArray(saved.tabs)) continue;
    const tabs: Tab[] = [];
    let claudeCount = 0;
    for (const t of saved.tabs) {
      if (
        isRecord(t) &&
        t.kind === 'claude' &&
        typeof t.id === 'number' &&
        Number.isInteger(t.id) &&
        t.id > 0 &&
        typeof t.chat === 'string' &&
        t.chat.length > 0 &&
        t.chat.length <= 80 &&
        typeof t.title === 'string' &&
        !tabs.some((x) => x.id === t.id || (x.kind === 'claude' && x.chat === t.chat))
      ) {
        tabs.push({ id: t.id, kind: 'claude', title: t.title.slice(0, 40), chat: t.chat });
        claudeCount += 1;
        maxId = Math.max(maxId, t.id);
        continue;
      }
      if (
        isRecord(t) &&
        t.kind === 'editor' &&
        typeof t.id === 'number' &&
        Number.isInteger(t.id) &&
        t.id > 0 &&
        typeof t.path === 'string' &&
        t.path.startsWith('/') &&
        !tabs.some((x) => x.id === t.id || (x.kind === 'editor' && x.path === t.path))
      ) {
        tabs.push({ id: t.id, kind: 'editor', title: basename(t.path), path: t.path });
        maxId = Math.max(maxId, t.id);
      }
    }
    const activeTab = tabs.some((t) => t.id === saved.activeTab)
      ? (saved.activeTab as number)
      : (tabs[tabs.length - 1]?.id ?? null);
    state = { ...state, sessions: { ...state.sessions, [repo.path]: { ...emptySession(), tabs, activeTab, claudeCounter: claudeCount } } };
  }
  const active =
    typeof raw.activeRepo === 'string' && state.repos.some((r) => r.path === raw.activeRepo)
      ? raw.activeRepo
      : (state.repos[0]?.path ?? null);
  return { ...state, activeRepo: active, nextId: maxId + 1 };
}
