import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { WorkspaceError } from '../../lib/workspaceApi';
import { closeShell, openShell, resizeShell, sendInput, streamOutput } from '../../lib/terminalApi';
import { describeFailure } from './terminalProtocol';

type Status = 'connecting' | 'ready' | 'closed' | 'failed';

/**
 * One shell in the browser: xterm.js on the front, a PTY on the server.
 * Stays mounted while hidden so the shell keeps running when you switch tabs.
 */
export function TerminalView({ active, cwd }: { active: boolean; cwd?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Set by the connection below: where typed keys and new sizes go.
  const inputRef = useRef<((data: string) => void) | null>(null);
  const resizeRef = useRef<((cols: number, rows: number) => void) | null>(null);
  const statusRef = useRef<Status>('connecting');
  const [status, setStatusState] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);

  const setStatus = (next: Status) => {
    statusRef.current = next;
    setStatusState(next);
  };

  // The terminal itself: created once, disposed on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 5000,
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', ui-monospace, monospace",
      theme: {
        background: '#07090b',
        foreground: '#ededef',
        cursor: '#ef4444',
        selectionBackground: 'rgba(239, 68, 68, 0.28)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const safeFit = () => {
      // Hidden tabs have no size; fitting them would produce NaN.
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        try {
          fit.fit();
        } catch {
          // the renderer is not ready yet; the next resize retries
        }
      }
    };
    safeFit();

    const data = term.onData((d) => inputRef.current?.(d));
    const size = term.onResize(({ cols, rows }) => resizeRef.current?.(cols, rows));
    const observer = new ResizeObserver(safeFit);
    observer.observe(host);

    return () => {
      observer.disconnect();
      data.dispose();
      size.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // The connection: restarts when the user presses "Reconnect".
  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    let shellId: string | null = null;
    const term = termRef.current;

    const fail = (reason: string) => {
      if (cancelled) return;
      setMessage(reason);
      setStatus('failed');
    };
    const explain = (e: unknown) =>
      e instanceof WorkspaceError ? describeFailure(e.status) + (e.status === 403 ? '' : ` (${e.message})`) : describeFailure(null);

    // Typed keys leave one request at a time and in order; keys typed while a
    // request is in flight travel together in the next one.
    let pending = '';
    let sending = false;
    const flush = async () => {
      if (sending || !shellId) return;
      sending = true;
      while (pending && !cancelled) {
        const chunk = pending;
        pending = '';
        try {
          await sendInput(shellId, chunk);
        } catch (e) {
          if (e instanceof WorkspaceError && (e.status === 404 || e.status === 409)) break;
        }
      }
      sending = false;
    };

    const run = async () => {
      setStatus('connecting');
      setMessage('');
      term?.reset();

      // Starting the shell is one quick request; if the server never answers
      // (stuck proxy, old server), say so instead of "Connecting…" forever.
      const startTimer = window.setTimeout(() => abort.abort(), 45000);
      try {
        shellId = await openShell(cwd, term?.cols ?? 80, term?.rows ?? 24, abort.signal);
      } catch (e) {
        window.clearTimeout(startTimer);
        if (cancelled) return;
        return fail(
          abort.signal.aborted
            ? 'The terminal did not answer within 45 seconds. Press Reconnect; if it keeps happening, restart jarvis gui.'
            : explain(e),
        );
      }
      window.clearTimeout(startTimer);
      if (cancelled) {
        void closeShell(shellId);
        return;
      }
      const id = shellId;
      inputRef.current = (d) => {
        if (statusRef.current !== 'ready') return;
        pending += d;
        void flush();
      };
      resizeRef.current = (cols, rows) => {
        if (statusRef.current === 'ready') void resizeShell(id, cols, rows);
      };

      // Read the output; if the connection drops, resume where it stopped.
      let after = -1;
      let exited = false;
      let failures = 0;
      while (!cancelled && !exited) {
        try {
          await streamOutput(
            id,
            after,
            {
              onOpen: () => {
                failures = 0;
                if (statusRef.current !== 'ready') {
                  setStatus('ready');
                  fitRef.current?.fit();
                }
              },
              onLines: (lines) => {
                const t = termRef.current;
                for (const line of lines) {
                  if ('exit' in line) {
                    exited = true;
                    t?.write(`\r\n\x1b[2m[process exited with code ${line.exit}]\x1b[0m\r\n`);
                    setStatus('closed');
                  } else {
                    after = line.seq;
                    t?.write(line.data);
                  }
                }
              },
            },
            abort.signal,
          );
          if (!exited && !cancelled) await new Promise((r) => window.setTimeout(r, 500));
        } catch (e) {
          if (cancelled) return;
          if (e instanceof WorkspaceError && e.status === 404) {
            return fail('This terminal no longer exists on the server.');
          }
          failures += 1;
          if (failures > 5) return fail(explain(e));
          await new Promise((r) => window.setTimeout(r, Math.min(1000 * failures, 4000)));
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      abort.abort();
      inputRef.current = null;
      resizeRef.current = null;
      if (shellId) void closeShell(shellId);
    };
  }, [attempt, cwd]);

  // Give the keyboard to the terminal that just became visible.
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      const host = hostRef.current;
      if (host && host.clientWidth > 0) {
        try {
          fitRef.current?.fit();
        } catch {
          // ignore: retried on the next resize
        }
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="relative h-full w-full" style={{ background: '#07090b' }}>
      <div ref={hostRef} className="h-full w-full p-2" />
      {status !== 'ready' && (
        <div
          className="absolute right-3 top-3 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
          style={{
            background: 'rgba(5, 6, 7, 0.88)',
            border: '1px solid #000',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
            color: status === 'failed' ? 'var(--color-error)' : 'var(--color-text-secondary)',
            maxWidth: '70%',
          }}
          role="status"
        >
          <span>
            {status === 'connecting' && 'Connecting…'}
            {status === 'closed' && 'Terminal closed'}
            {status === 'failed' && message}
          </span>
          {status !== 'connecting' && (
            <button type="button" className="metal-btn text-xs" onClick={() => setAttempt((a) => a + 1)}>
              Reconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
}
