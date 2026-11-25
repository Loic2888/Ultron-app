import { lazy, Suspense, useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { getHome } from '../../lib/workspaceApi';
import { useJarvisUi } from './jarvisUi';

// After the app is rebuilt, a page that is still open may ask for a file that no
// longer exists: say so (and offer a reload) instead of "Starting Ultron…" forever.
const ClaudeChat = lazy(() =>
  import('./ClaudeChat').catch(() => ({ default: StaleChatNotice as unknown as typeof import('./ClaudeChat').default })),
);

function StaleChatNotice() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs" role="alert">
      <span style={{ color: 'var(--color-error)' }}>Ultron was updated: this page is out of date.</span>
      <button type="button" className="metal-btn" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}

export const JARVIS_CHAT_KEY = 'jarvis';

/** The chat with Ultron, the assistant that drives the app. A drawer on the right. */
export function JarvisPanel() {
  const open = useJarvisUi((s) => s.open);
  const setOpen = useJarvisUi((s) => s.setOpen);
  const [home, setHome] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || home) return;
    getHome()
      .then((h) => setHome(h.home))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Cannot reach the Ultron server.'));
  }, [open, home]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <aside
      role="dialog"
      aria-label="Ultron assistant"
      className="metal-panel fixed bottom-0 right-0 flex flex-col"
      // below the strip that holds the window's own minimize / maximize / close buttons
      style={{ top: 'var(--wb-top)', width: 'min(480px, 94vw)', zIndex: 40, borderLeft: '1px solid #000' }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #000' }}>
        {/* close button on the left: the right corner can be covered by the window's own buttons */}
        <button type="button" className="metal-btn" aria-label="Close Ultron" onClick={() => setOpen(false)}>
          <X size={14} />
        </button>
        <span className="metal-title text-xs">Ultron</span>
      </div>
      <div className="metal-well min-h-0 flex-1">
        {home ? (
          <Suspense fallback={<Note text="Starting Ultron…" />}>
            <ClaudeChat chatKey={JARVIS_CHAT_KEY} cwd={home} kind="jarvis" />
          </Suspense>
        ) : (
          <Note text={error || 'Starting Ultron…'} error={!!error} />
        )}
      </div>
    </aside>
  );
}

function Note({ text, error }: { text: string; error?: boolean }) {
  return (
    <div
      className="flex h-full items-center justify-center px-6 text-center text-xs"
      style={{ color: error ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}
      role={error ? 'alert' : 'status'}
    >
      {text}
    </div>
  );
}
