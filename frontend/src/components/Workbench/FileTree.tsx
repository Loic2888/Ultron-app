import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, RefreshCw } from 'lucide-react';

import { WorkspaceError, listTree, type TreeEntry } from '../../lib/workspaceApi';
import { useWorkspace } from './workspaceStore';

const MUTED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'target', 'dist']);

interface NodeProps {
  repo: string;
  path: string;
  depth: number;
  activeFile: string | undefined;
}

/** Content of one folder, loaded when it is first shown. */
function Children({ repo, path, depth, activeFile }: NodeProps) {
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTree(path)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof WorkspaceError ? err.message : 'Could not read this folder.');
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const pad = { paddingLeft: 8 + depth * 12 };
  if (error) {
    return (
      <div role="alert" className="py-1 text-[11px]" style={{ ...pad, color: 'var(--color-error)' }}>
        {error}
      </div>
    );
  }
  if (!entries) {
    return (
      <div className="py-1 text-[11px]" style={{ ...pad, color: 'var(--color-text-tertiary)' }}>
        Loading…
      </div>
    );
  }
  return (
    <>
      {entries.map((e) => (
        <Node key={e.name} repo={repo} entry={e} parent={path} depth={depth} activeFile={activeFile} />
      ))}
      {entries.length === 0 && (
        <div className="py-1 text-[11px]" style={{ ...pad, color: 'var(--color-text-tertiary)' }}>
          Empty
        </div>
      )}
      {truncated && (
        <div className="py-1 text-[11px]" style={{ ...pad, color: 'var(--color-text-tertiary)' }}>
          Too many entries: showing the first part only.
        </div>
      )}
    </>
  );
}

function Node({
  repo,
  entry,
  parent,
  depth,
  activeFile,
}: {
  repo: string;
  entry: TreeEntry;
  parent: string;
  depth: number;
  activeFile: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const full = `${parent.replace(/\/$/, '')}/${entry.name}`;
  const muted = MUTED.has(entry.name);
  const rowStyle = { paddingLeft: 8 + depth * 12, opacity: muted ? 0.55 : 1 };

  if (entry.type === 'dir') {
    return (
      <>
        <button
          type="button"
          className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-white/5"
          style={{ ...rowStyle, color: 'var(--color-text)' }}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={13} style={{ color: 'var(--color-text-tertiary)' }} />
          <span className="truncate">{entry.name}</span>
        </button>
        {open && <Children repo={repo} path={full} depth={depth + 1} activeFile={activeFile} />}
      </>
    );
  }

  const isActive = activeFile === full;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-xs hover:bg-white/5"
      style={{
        ...rowStyle,
        paddingLeft: rowStyle.paddingLeft + 14,
        color: isActive ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        background: isActive ? 'rgba(239, 68, 68, 0.08)' : undefined,
      }}
      aria-current={isActive ? 'true' : undefined}
      onClick={() => useWorkspace.getState().openFile(repo, full)}
      title={full}
    >
      <File size={12} className="shrink-0" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

/** Folder tree of one repo. Stays mounted while hidden so it keeps its open folders. */
export function FileTree({ repo, name }: { repo: string; name: string }) {
  const [version, setVersion] = useState(0);
  const activeFile = useWorkspace((s) => {
    const session = s.sessions[repo];
    const tab = session?.tabs.find((t) => t.id === session.activeTab);
    return tab?.kind === 'editor' ? tab.path : undefined;
  });
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 py-1 text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <span className="metal-title truncate">{name}</span>
        <button
          type="button"
          className="metal-btn ml-auto"
          style={{ padding: '0.1rem 0.3rem' }}
          aria-label="Refresh the file tree"
          title="Refresh"
          onClick={refresh}
        >
          <RefreshCw size={11} />
        </button>
      </div>
      <nav className="flex-1 min-h-0 overflow-y-auto pb-2" aria-label={`Files of ${name}`}>
        <Children key={version} repo={repo} path={repo} depth={0} activeFile={activeFile} />
      </nav>
    </div>
  );
}
