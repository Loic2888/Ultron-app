import { create } from 'zustand';

import { logAction, repoName } from '../../lib/journalApi';
import { WorkspaceError, readFile, writeFile } from '../../lib/workspaceApi';
import {
  addClaudeTab,
  addRepo,
  addTerminal,
  closeTab,
  closeTerminal,
  ensureTerminal,
  fromPersisted,
  initialState,
  openFile,
  removeRepo,
  selectRepo,
  selectTab,
  selectTerminal,
  toPersisted,
  type RepoRef,
  type WorkspaceState,
} from './workspaceModel';

const STORAGE_KEY = 'openjarvis.workbench.workspace';

export interface Buffer {
  status: 'loading' | 'ready' | 'error';
  content: string;
  /** Content as last read from / written to disk. */
  saved: string;
  /** Disk modification token of `saved`, used to detect outside changes. */
  mtime: string;
  error?: string;
}

export const isDirty = (b: Buffer | undefined): boolean =>
  !!b && b.status === 'ready' && b.content !== b.saved;

/** Paths with unsaved edits, as one string so a selector stays referentially stable while typing. */
export const dirtyKeyOf = (buffers: Record<string, Buffer>): string =>
  Object.entries(buffers)
    .filter(([, b]) => isDirty(b))
    .map(([p]) => p)
    .sort()
    .join('\n');

export type SaveResult = 'saved' | 'conflict' | 'error' | 'nothing';

interface WorkspaceStore extends WorkspaceState {
  buffers: Record<string, Buffer>;

  addRepo: (repo: RepoRef) => void;
  selectRepo: (path: string) => void;
  removeRepo: (path: string) => void;
  openFile: (repo: string, filePath: string) => void;
  addClaudeTab: (repo: string) => void;
  selectTab: (repo: string, id: number) => void;
  closeTab: (repo: string, id: number) => void;
  addTerminal: (repo: string) => void;
  ensureTerminal: (repo: string) => void;
  selectTerminal: (repo: string, id: number) => void;
  closeTerminal: (repo: string, id: number) => void;

  loadBuffer: (path: string, refresh?: boolean) => Promise<void>;
  setContent: (path: string, content: string) => void;
  /** `force` skips the "changed on disk" check (the user chose to overwrite). */
  saveBuffer: (path: string, force?: boolean) => Promise<SaveResult>;
  dropBuffer: (path: string) => void;
}

function loadInitial(): WorkspaceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? fromPersisted(JSON.parse(raw)) : initialState();
  } catch {
    return initialState();
  }
}

/** Only the model fields, not the actions or buffers. */
const modelOf = (s: WorkspaceStore): WorkspaceState => ({
  repos: s.repos,
  activeRepo: s.activeRepo,
  sessions: s.sessions,
  nextId: s.nextId,
});

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const apply = (fn: (m: WorkspaceState) => WorkspaceState) =>
    set((s) => {
      const model = modelOf(s);
      const next = fn(model);
      return next === model ? s : next;
    });

  return {
    ...loadInitial(),
    buffers: {},

    addRepo: (repo) => apply((m) => addRepo(m, repo)),
    selectRepo: (path) => apply((m) => selectRepo(m, path)),
    removeRepo: (path) => apply((m) => removeRepo(m, path)),
    openFile: (repo, filePath) => apply((m) => openFile(m, repo, filePath)),
    addClaudeTab: (repo) => apply((m) => addClaudeTab(m, repo)),
    selectTab: (repo, id) => apply((m) => selectTab(m, repo, id)),
    closeTab: (repo, id) => apply((m) => closeTab(m, repo, id)),
    addTerminal: (repo) => apply((m) => addTerminal(m, repo)),
    ensureTerminal: (repo) => apply((m) => ensureTerminal(m, repo)),
    selectTerminal: (repo, id) => apply((m) => selectTerminal(m, repo, id)),
    closeTerminal: (repo, id) => apply((m) => closeTerminal(m, repo, id)),

    loadBuffer: async (path, refresh = false) => {
      const current = get().buffers[path];
      if (current?.status === 'loading') return;
      if (current?.status === 'ready' && (!refresh || isDirty(current))) return;
      if (!current || current.status === 'error') {
        set((s) => ({
          buffers: {
            ...s.buffers,
            [path]: { status: 'loading', content: '', saved: '', mtime: '' },
          },
        }));
      }
      try {
        const file = await readFile(path);
        const now = get().buffers[path];
        // The user may have typed while we were reading: keep their text.
        if (now && isDirty(now)) return;
        if (now?.status === 'ready' && now.mtime === file.mtime) return;
        set((s) => ({
          buffers: {
            ...s.buffers,
            [path]: { status: 'ready', content: file.content, saved: file.content, mtime: file.mtime },
          },
        }));
      } catch (err) {
        const message = err instanceof WorkspaceError ? err.message : 'Could not open the file.';
        const now = get().buffers[path];
        if (now?.status === 'ready') return; // keep what is on screen on a failed refresh
        set((s) => ({
          buffers: {
            ...s.buffers,
            [path]: { status: 'error', content: '', saved: '', mtime: '', error: message },
          },
        }));
      }
    },

    setContent: (path, content) =>
      set((s) => {
        const b = s.buffers[path];
        if (!b || b.status !== 'ready' || b.content === content) return s;
        return { buffers: { ...s.buffers, [path]: { ...b, content } } };
      }),

    saveBuffer: async (path, force = false) => {
      const b = get().buffers[path];
      if (!b || b.status !== 'ready' || b.content === b.saved) return 'nothing';
      const sent = b.content;
      try {
        const res = await writeFile(path, sent, force ? undefined : b.mtime);
        set((s) => {
          const cur = s.buffers[path];
          if (!cur) return s;
          return { buffers: { ...s.buffers, [path]: { ...cur, saved: sent, mtime: res.mtime } } };
        });
        return 'saved';
      } catch (err) {
        if (err instanceof WorkspaceError && err.status === 409) return 'conflict';
        const message = err instanceof WorkspaceError ? err.message : 'Could not save the file.';
        set((s) => {
          const cur = s.buffers[path];
          return cur ? { buffers: { ...s.buffers, [path]: { ...cur, error: message } } } : s;
        });
        return 'error';
      }
    },

    dropBuffer: (path) =>
      set((s) => {
        if (!(path in s.buffers)) return s;
        const { [path]: _gone, ...rest } = s.buffers;
        void _gone;
        return { buffers: rest };
      }),
  };
});

// Persist the model (repos, open files) after every change.
useWorkspace.subscribe((s, prev) => {
  if (s.repos === prev.repos && s.activeRepo === prev.activeRepo && s.sessions === prev.sessions) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersisted(modelOf(s))));
  } catch {
    // storage unavailable: the workspace just will not survive a reload
  }
});

// Journal: repo opened / closed / switched (the server logs the rest itself).
useWorkspace.subscribe((s, prev) => {
  if (s.repos === prev.repos && s.activeRepo === prev.activeRepo) return;
  const before = new Set(prev.repos.map((r) => r.path));
  const after = new Set(s.repos.map((r) => r.path));
  for (const r of s.repos) if (!before.has(r.path)) logAction('repo', `Ouverture repo ${r.name}.`, r.path);
  for (const r of prev.repos) if (!after.has(r.path)) logAction('repo', `Fermeture repo ${r.name}.`, r.path);
  if (s.activeRepo && s.activeRepo !== prev.activeRepo && before.has(s.activeRepo))
    logAction('repo', `Changement de repo vers ${repoName(s.activeRepo)}.`, s.activeRepo);
});
