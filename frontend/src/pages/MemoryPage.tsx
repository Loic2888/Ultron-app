import { useEffect, useMemo, useState } from 'react';
import { Check, FileEdit, FileText, FolderOpen, TriangleAlert } from 'lucide-react';

import {
  fetchMemory,
  fetchRepoMemories,
  fetchRepoMemoryFile,
  formatStamp,
  repoName,
  type MemoryItem,
  type RepoMemory,
} from '../lib/journalApi';

const FILE_LABELS: Record<string, string> = {
  'INDEX.md': 'Index',
  'notes.md': 'Notes',
  'fonctionne.md': 'Ce qui fonctionne',
  'ne-fonctionne-pas.md': 'Ce qui ne fonctionne pas',
};

/** One folder per repo, kept by the Claude Code windows: notes, what works, what does not. */
function RepoFolders() {
  const [repos, setRepos] = useState<RepoMemory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [file, setFile] = useState('INDEX.md');
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const got = await fetchRepoMemories();
        if (!alive) return;
        setRepos(got);
        setError(null);
        setSlug((cur) => cur || got[0]?.slug || '');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const current = repos.find((r) => r.slug === slug);
  const modified = current?.files.find((f) => f.name === file)?.modified ?? 0;

  useEffect(() => {
    if (!slug || !current?.files.some((f) => f.name === file)) {
      const first = current?.files[0]?.name;
      if (first && file !== first) setFile(first);
      setText(null);
      return;
    }
    let alive = true;
    fetchRepoMemoryFile(slug, file)
      .then((t) => alive && setText(t))
      .catch(() => alive && setText(null));
    return () => {
      alive = false;
    };
  }, [slug, file, modified, current]);

  if (error) {
    return (
      <div className="text-center py-12" style={{ color: 'var(--color-error)' }}>
        {error}
      </div>
    );
  }
  if (repos.length === 0) {
    return (
      <div className="text-center py-12 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
        No folder yet. The first Claude Code window opened on a repo creates its memory folder here.
      </div>
    );
  }
  const chip = (active: boolean) => ({
    background: active ? 'var(--color-accent)' : 'var(--color-bg-secondary)',
    color: active ? 'var(--color-bg)' : 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {repos.map((r) => (
          <button
            key={r.slug}
            title={r.repo}
            className="px-3 py-1 rounded-full text-xs cursor-pointer inline-flex items-center gap-1.5"
            style={chip(slug === r.slug)}
            onClick={() => setSlug(r.slug)}
          >
            <FolderOpen size={12} />
            {r.name}
          </button>
        ))}
      </div>
      {current && (
        <>
          <div className="flex flex-wrap gap-2">
            {current.files.map((f) => (
              <button
                key={f.name}
                className="px-3 py-1 rounded-md text-xs cursor-pointer inline-flex items-center gap-1.5"
                style={chip(file === f.name)}
                onClick={() => setFile(f.name)}
              >
                <FileText size={12} />
                {FILE_LABELS[f.name] ?? f.name.replace(/\.md$/, '')}
              </button>
            ))}
          </div>
          <div className="text-xs font-mono break-all" style={{ color: 'var(--color-text-tertiary)' }}>
            {current.repo}
            {modified ? ` · ${formatStamp(modified)}` : ''}
          </div>
          <pre
            className="rounded-xl p-4 text-xs whitespace-pre-wrap break-words"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              minHeight: 120,
            }}
          >
            {text ?? 'Empty or unreadable.'}
          </pre>
        </>
      )}
    </div>
  );
}

/** Short summary of every task done by the Claude Code windows, grouped by repo. */
function TaskHistory() {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<string>('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const got = await fetchMemory();
        if (alive) {
          setItems(got);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const repos = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.repo, (counts.get(it.repo) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const shown = useMemo(
    () => items.filter((it) => !repo || it.repo === repo).slice().reverse(),
    [items, repo],
  );

  const chip = (active: boolean) => ({
    background: active ? 'var(--color-accent)' : 'var(--color-bg-secondary)',
    color: active ? 'var(--color-bg)' : 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  });

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
        <header className="mb-4 shrink-0">
          <div className="flex flex-wrap gap-2">
            <button className="px-3 py-1 rounded-full text-xs cursor-pointer" style={chip(!repo)} onClick={() => setRepo('')}>
              All repos ({items.length})
            </button>
            {repos.map(([path, n]) => (
              <button
                key={path}
                title={path}
                className="px-3 py-1 rounded-full text-xs cursor-pointer"
                style={chip(repo === path)}
                onClick={() => setRepo(path)}
              >
                {repoName(path)} ({n})
              </button>
            ))}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
          {error ? (
            <div className="text-center py-12" style={{ color: 'var(--color-error)' }}>
              {error}
            </div>
          ) : shown.length === 0 ? (
            <div className="text-center py-12 text-sm" style={{ color: 'var(--color-text-tertiary)' }}>
              Nothing yet. Each finished Claude Code task will be summarised here.
            </div>
          ) : (
            shown.map((it, i) => (
              <article
                key={`${it.ts}-${i}`}
                className="rounded-xl p-3 text-sm"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex items-center gap-2 text-xs mb-1" style={{ color: 'var(--color-text-tertiary)' }}>
                  {it.ok ? <Check size={12} color="#22c55e" /> : <TriangleAlert size={12} color="var(--color-warning)" />}
                  <strong style={{ color: 'var(--color-text)' }} title={it.repo}>
                    {repoName(it.repo)}
                  </strong>
                  <span>{formatStamp(it.ts)}</span>
                  <span>· {it.seconds}s</span>
                </div>
                <div style={{ color: 'var(--color-text)' }}>{it.prompt}</div>
                {it.answer && (
                  <div className="mt-1" style={{ color: 'var(--color-text-secondary)' }}>
                    {it.answer}
                  </div>
                )}
                {it.files.length > 0 && (
                  <div className="flex items-start gap-1.5 mt-2 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    <FileEdit size={12} className="mt-0.5 shrink-0" />
                    <span className="font-mono break-all">{it.files.join(', ')}</span>
                  </div>
                )}
              </article>
            ))
          )}
        </div>
    </div>
  );
}

/** Memory: the notes each repo keeps, and the history of what the windows did. */
export function MemoryPage() {
  const [tab, setTab] = useState<'folders' | 'history'>('folders');
  const tabStyle = (active: boolean) => ({
    color: active ? 'var(--color-text)' : 'var(--color-text-tertiary)',
    borderBottom: `2px solid ${active ? 'var(--color-accent)' : 'transparent'}`,
  });
  return (
    <div className="flex-1 flex flex-col overflow-hidden px-6 py-10">
      <div className="max-w-4xl mx-auto w-full flex flex-col flex-1 overflow-hidden">
        <header className="mb-4 shrink-0">
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Memory
          </h1>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: 'var(--color-text-secondary)' }}>
            Each repo has its own memory folder: every Claude Code window reads it before working and writes in it what works and
            what does not. Later, an agent can turn what works into skills.
          </p>
          <div className="flex gap-5 mt-4 text-sm">
            <button className="pb-1 cursor-pointer" style={tabStyle(tab === 'folders')} onClick={() => setTab('folders')}>
              Repo folders
            </button>
            <button className="pb-1 cursor-pointer" style={tabStyle(tab === 'history')} onClick={() => setTab('history')}>
              Task history
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto pr-1 flex flex-col">
          {tab === 'folders' ? <RepoFolders /> : <TaskHistory />}
        </div>
      </div>
    </div>
  );
}
