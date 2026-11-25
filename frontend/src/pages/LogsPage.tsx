import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Trash2 } from 'lucide-react';

import { clearServerLogs, fetchLogs, formatStamp, type LogItem } from '../lib/journalApi';

const LEVEL_COLORS: Record<string, string> = {
  info: 'var(--color-text)',
  warn: 'var(--color-warning)',
  error: 'var(--color-error)',
};

/** Everything the workbench did, kept on disk by the server: repos, chats, terminals, files. */
export function LogsPage() {
  const [entries, setEntries] = useState<LogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await fetchLogs());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(entries.map((e) => `${formatStamp(e.ts)} ${e.message}`).join('\n'));
  };

  const handleClear = async () => {
    if (!window.confirm('Delete the whole log history?')) return;
    await clearServerLogs();
    await load();
  };

  const btn = {
    background: 'var(--color-bg-secondary)',
    color: 'var(--color-text-secondary)',
    border: '1px solid var(--color-border)',
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-6 py-10">
      <div className="max-w-4xl mx-auto w-full flex flex-col flex-1 overflow-hidden">
        <header className="mb-6 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
              Logs
            </h1>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {entries.length} entries
              </span>
              <button onClick={handleCopy} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer" style={btn}>
                <Copy size={12} /> Copy All
              </button>
              <button onClick={handleClear} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer" style={btn}>
                <Trash2 size={12} /> Clear
              </button>
            </div>
          </div>
          <p className="text-sm mt-2 max-w-2xl" style={{ color: 'var(--color-text-secondary)' }}>
            Every action of the workbench, saved on this machine: repos opened, Claude Code messages and answers,
            approvals, terminals, files saved, Ultron actions.
          </p>
        </header>

        <div
          className="flex-1 overflow-y-auto rounded-xl p-4 font-mono text-xs leading-relaxed"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {error ? (
            <div className="text-center py-12" style={{ color: 'var(--color-error)' }}>
              {error}
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-12" style={{ color: 'var(--color-text-tertiary)' }}>
              No log entries yet. Open a repo or talk to Claude Code and it will appear here.
            </div>
          ) : (
            entries.map((entry, i) => (
              <div key={`${entry.ts}-${i}`} className="py-0.5">
                <span style={{ color: 'var(--color-text-tertiary)' }}>{formatStamp(entry.ts)}</span>{' '}
                <span style={{ color: LEVEL_COLORS[entry.level] || 'var(--color-text)' }}>{entry.message}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
