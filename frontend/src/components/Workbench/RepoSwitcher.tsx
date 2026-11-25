import { useEffect, useRef, useState } from 'react';
import { FolderGit2, Plus, X } from 'lucide-react';

import { getRepo } from '../../lib/workspaceApi';
import { useClaude } from './claudeStore';
import { FolderPicker } from './FolderPicker';
import { basename } from './workspaceModel';
import { dirtyKeyOf, useWorkspace } from './workspaceStore';

/** The repo picker at the top of the left column: open several, switch with a click. */
export function RepoSwitcher() {
  const repos = useWorkspace((s) => s.repos);
  const activeRepo = useWorkspace((s) => s.activeRepo);
  const dirtyKey = useWorkspace((s) => dirtyKeyOf(s.buffers));
  const selectRepo = useWorkspace((s) => s.selectRepo);
  const addRepo = useWorkspace((s) => s.addRepo);
  const removeRepo = useWorkspace((s) => s.removeRepo);
  const dropBuffer = useWorkspace((s) => s.dropBuffer);

  const [picking, setPicking] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const sessions = useWorkspace((s) => s.sessions);
  // Per repo: is a Claude chat working, or does it wait for an answer?
  const chatStates = useClaude((s) => s.chats);
  const repoChats = (repoPath: string): string[] =>
    (sessions[repoPath]?.tabs ?? []).filter((t) => t.kind === 'claude' && t.chat).map((t) => t.chat as string);
  const workingIn = (repoPath: string) => repoChats(repoPath).some((k) => chatStates[k]?.model.busy);
  const workingKey = repos.map((r) => (workingIn(r.path) ? '1' : '0')).join('');
  const prevWorking = useRef<Record<string, boolean>>({});
  // A repo that was working and stopped while it was not on screen: tell the user.
  useEffect(() => {
    const now: Record<string, boolean> = {};
    const finished: string[] = [];
    for (const r of repos) {
      now[r.path] = workingIn(r.path);
      if (prevWorking.current[r.path] && !now[r.path] && r.path !== activeRepo) finished.push(r.path);
    }
    prevWorking.current = now;
    setDone((d) => {
      const next = new Set([...d].filter((p) => p !== activeRepo && repos.some((r) => r.path === p)));
      for (const p of finished) next.add(p);
      return next.size === d.size && [...next].every((p) => d.has(p)) ? d : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingKey, activeRepo, repos]);
  const [branches, setBranches] = useState<Record<string, string | null>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Branch names are read whenever the list of repos changes (they change in terminals).
  useEffect(() => {
    if (repos.length === 0) return;
    let cancelled = false;
    for (const r of repos) {
      getRepo(r.path)
        .then((info) => {
          if (!cancelled) setBranches((b) => (b[r.path] === info.branch ? b : { ...b, [r.path]: info.branch }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [repos]);

  const dirtyPaths = dirtyKey ? dirtyKey.split('\n') : [];
  const unsavedIn = (repoPath: string) => dirtyPaths.filter((p) => p.startsWith(repoPath + '/'));

  const close = (repoPath: string, name: string) => {
    const unsaved = unsavedIn(repoPath);
    if (
      unsaved.length > 0 &&
      !window.confirm(`${name} has ${unsaved.length} unsaved file(s). Close it and lose these changes?`)
    ) {
      return;
    }
    // Closing a repo ends its terminals; say so when it is not obvious.
    const session = useWorkspace.getState().sessions[repoPath];
    if (
      session &&
      session.terms.length > 0 &&
      !window.confirm(`Close ${name}? Its ${session.terms.length} terminal(s) will be stopped.`)
    ) {
      return;
    }
    // Its Claude chats end with it (the programs are stopped).
    const chats = (session?.tabs ?? []).filter((t) => t.kind === 'claude' && t.chat);
    if (
      chats.some((t) => useClaude.getState().chats[t.chat as string]?.model.busy) &&
      !window.confirm(`Claude is still working in ${name}. Close it and stop Claude?`)
    ) {
      return;
    }
    for (const t of chats) void useClaude.getState().close(t.chat as string);
    for (const p of Object.keys(useWorkspace.getState().buffers)) {
      if (p.startsWith(repoPath + '/')) dropBuffer(p);
    }
    removeRepo(repoPath);
  };

  const pick = async (path: string) => {
    const info = await getRepo(path);
    addRepo({ path: info.path, name: info.name || basename(info.path) });
    setPicking(false);
  };

  return (
    <div ref={rootRef} className="p-2" style={{ borderBottom: '1px solid #000' }}>
      <div role="listbox" aria-label="Open repositories" className="flex flex-col gap-0.5">
        {repos.map((r) => {
          const isActive = r.path === activeRepo;
          return (
            <div
              key={r.path}
              className="group flex items-center rounded"
              style={isActive ? { background: 'rgba(255,255,255,0.07)' } : undefined}
            >
              <button
                type="button"
                role="option"
                aria-selected={isActive}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-white/5"
                style={{ color: 'var(--color-text)' }}
                title={r.path}
                onClick={() => selectRepo(r.path)}
              >
                <FolderGit2 size={14} style={{ color: isActive ? 'var(--color-accent)' : undefined }} />
                <span className="max-w-[65%] shrink-0 truncate" style={{ fontWeight: isActive ? 600 : 400 }}>
                  {r.name}
                </span>
                {workingIn(r.path) ? (
                  <span
                    role="status"
                    aria-label="Claude is working"
                    title="Claude is working"
                    className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full"
                    style={{ background: 'var(--color-warning, #f59e0b)' }}
                  />
                ) : done.has(r.path) ? (
                  <span
                    role="status"
                    aria-label="Claude has finished"
                    title="Claude has finished"
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ background: '#22c55e', boxShadow: '0 0 6px #22c55e' }}
                  />
                ) : null}
                {unsavedIn(r.path).length > 0 && (
                  <span aria-label="Unsaved changes" style={{ color: 'var(--color-warning, #f59e0b)' }}>
                    ●
                  </span>
                )}
                {branches[r.path] && (
                  <span
                    className="ml-auto min-w-0 truncate text-[10px]"
                    title={branches[r.path] ?? undefined}
                    style={{ color: 'var(--color-text-tertiary)' }}
                  >
                    {branches[r.path]}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="px-2 py-1.5 opacity-40 hover:opacity-100"
                aria-label={`Close ${r.name}`}
                onClick={() => close(r.path, r.name)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="metal-btn mt-1 w-full justify-start text-xs"
        onClick={() => setPicking(true)}
      >
        <Plus size={13} /> Open a repository…
      </button>

      {picking && <FolderPicker onPick={pick} onClose={() => setPicking(false)} />}
    </div>
  );
}
