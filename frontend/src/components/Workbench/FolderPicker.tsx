import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Folder, FolderGit2, X } from 'lucide-react';

import { WorkspaceError, getHome, listTree, type TreeEntry } from '../../lib/workspaceApi';

const LAST_DIR_KEY = 'openjarvis.workbench.lastDir';

const parentOf = (path: string): string => path.replace(/\/[^/]+\/?$/, '') || '/';

/** Modal to browse the folders under your home directory and pick a repo. */
export function FolderPicker({
  onPick,
  onClose,
}: {
  onPick: (path: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [home, setHome] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState('');
  const [opening, setOpening] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Only the latest request may update the list (a slow first load must not
  // overwrite a folder you just typed).
  const latest = useRef(0);
  // The path field was edited by hand: the starting folder must not overwrite it.
  const touched = useRef(false);

  const go = async (path: string) => {
    const mine = ++latest.current;
    touched.current = false;
    setLoading(true);
    setError('');
    try {
      const res = await listTree(path, true);
      if (mine !== latest.current) return;
      setCurrent(res.path);
      setTyped(res.path);
      setEntries(res.entries);
      try {
        localStorage.setItem(LAST_DIR_KEY, res.path);
      } catch {
        // not important
      }
    } catch (err) {
      if (mine !== latest.current) return;
      setError(err instanceof WorkspaceError ? err.message : 'Could not read this folder.');
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };

  // First load: the last folder you used, else your home directory.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await getHome();
        if (cancelled) return;
        setHome(h.home);
        let start = h.home;
        try {
          start = localStorage.getItem(LAST_DIR_KEY) || h.home;
        } catch {
          // ignore
        }
        // If you already typed or clicked a folder while this was loading,
        // that choice wins over the starting folder.
        if (latest.current === 0 && !touched.current) await go(start);
        else setLoading(false);
        if (cancelled) return;
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof WorkspaceError ? err.message : 'Cannot reach the Ultron server.');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = async (path: string) => {
    setOpening(true);
    setError('');
    try {
      await onPick(path);
    } catch (err) {
      setError(err instanceof WorkspaceError ? err.message : 'Could not open this folder.');
      setOpening(false);
    }
  };

  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.'));
  const atHome = !!home && current === home;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Open a repository"
        className="metal-panel flex flex-col rounded-lg outline-none"
        style={{ width: 520, maxWidth: '92vw', height: 480, maxHeight: '86vh' }}
      >
        <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #000' }}>
          <span className="metal-title text-xs">Open a repository</span>
          <button type="button" className="metal-btn ml-auto" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <form
          className="flex gap-2 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void go(typed.trim());
          }}
        >
          <button
            type="button"
            className="metal-btn"
            aria-label="Parent folder"
            title="Parent folder"
            disabled={!current || atHome || loading}
            onClick={() => current && void go(parentOf(current))}
          >
            <ArrowUp size={14} />
          </button>
          <input
            value={typed}
            onChange={(e) => {
              touched.current = true;
              setTyped(e.target.value);
            }}
            aria-label="Folder path"
            spellCheck={false}
            className="metal-well flex-1 rounded-md px-2 text-xs"
            style={{ color: 'var(--color-text)', minWidth: 0 }}
          />
          <button type="submit" className="metal-btn text-xs">
            Go
          </button>
        </form>

        <div className="metal-well flex-1 min-h-0 mx-2 rounded-md overflow-y-auto p-1" aria-busy={loading}>
          {error && (
            <div role="alert" className="p-3 text-xs" style={{ color: 'var(--color-error)' }}>
              {error}
            </div>
          )}
          {!error && !loading && visible.length === 0 && (
            <div className="p-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              No sub-folders here.
            </div>
          )}
          {visible.map((e) => (
            <button
              key={e.name}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-white/5"
              style={{ color: 'var(--color-text)' }}
              onClick={() => current && void go(`${current.replace(/\/$/, '')}/${e.name}`)}
            >
              {e.is_git ? (
                <FolderGit2 size={14} style={{ color: 'var(--color-accent)' }} />
              ) : (
                <Folder size={14} style={{ color: 'var(--color-text-tertiary)' }} />
              )}
              <span className="truncate">{e.name}</span>
              {e.is_git && (
                <span className="ml-auto text-[10px]" style={{ color: 'var(--color-accent)' }}>
                  git
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 p-2">
          <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show hidden folders
          </label>
          <button
            type="button"
            className="metal-btn ml-auto text-xs"
            disabled={!current || opening || loading || !!error}
            onClick={() => current && void open(current)}
          >
            {opening ? 'Opening…' : 'Open this folder'}
          </button>
        </div>
      </div>
    </div>
  );
}
