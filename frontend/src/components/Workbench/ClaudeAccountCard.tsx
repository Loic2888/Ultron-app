import { Check, Copy, KeyRound, Loader2, RefreshCw, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { type ClaudeAccount, claudeAccount } from '../../lib/claudeApi';
import { useWorkspace } from './workspaceStore';

const COMMANDS = 'claude auth logout\nclaude auth login';

/** Which Anthropic account the Claude Code chats use, and how to change it. */
export function ClaudeAccountCard() {
  const navigate = useNavigate();
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const activeRepo = useWorkspace((s) => s.activeRepo);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setAccount(await claudeAccount());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cannot read the account.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openTerminal = () => {
    const st = useWorkspace.getState();
    if (!st.activeRepo) return;
    st.addTerminal(st.activeRepo);
    navigate('/workspace');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMANDS);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard refused: the commands are shown anyway
    }
  };

  const row = (label: string, value?: string | null) =>
    value ? (
      <div className="flex gap-3 text-sm">
        <span className="w-28 shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
          {label}
        </span>
        <span style={{ color: 'var(--color-text)' }}>{value}</span>
      </div>
    ) : null;

  return (
    <section className="metal-panel rounded-lg p-5 max-w-2xl" aria-label="Claude account">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound size={16} style={{ color: 'var(--color-accent)' }} />
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Anthropic account used by Claude Code
        </h2>
        <button
          type="button"
          className="metal-btn ml-auto"
          style={{ padding: '0.2rem 0.5rem' }}
          onClick={() => void load()}
          aria-label="Check again"
          title="Check again"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {error && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-error)' }}>
          {error}
        </p>
      )}
      {account && !account.installed && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-warning, #f59e0b)' }}>
          The official <code>claude</code> program is not installed on this machine.
        </p>
      )}
      {account?.installed && !account.logged_in && (
        <p className="text-sm mb-3" style={{ color: 'var(--color-warning, #f59e0b)' }}>
          Not signed in. Use the steps below to sign in.
        </p>
      )}
      {account?.logged_in && (
        <div className="flex flex-col gap-1.5 mb-4">
          {row('Account', account.email)}
          {row('Organisation', account.organization)}
          {row('Plan', account.plan)}
          {row('Sign-in', account.method)}
          {row('Valid until', account.expires_at ? new Date(account.expires_at).toLocaleDateString() : null)}
        </div>
      )}

      <h3 className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        Change account
      </h3>
      <p className="text-xs mb-2" style={{ color: 'var(--color-text-tertiary)' }}>
        Open a terminal and run these two commands (your browser opens to sign in), then press “Check again”.
        Chats already open keep the old account until they restart (after 10 minutes without activity, or when
        you close the tab).
      </p>
      <pre className="metal-well rounded-md p-3 text-xs mb-3 select-all" style={{ color: 'var(--color-text)' }}>
        {COMMANDS}
      </pre>
      <div className="flex gap-2">
        <button
          type="button"
          className="metal-btn text-xs"
          onClick={openTerminal}
          disabled={!activeRepo}
          title={activeRepo ? undefined : 'Open a repository first'}
        >
          <SquareTerminal size={13} /> Open a terminal
        </button>
        <button type="button" className="metal-btn text-xs" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />} Copy commands
        </button>
      </div>
      <p className="text-[11px] mt-3" style={{ color: 'var(--color-text-tertiary)' }}>
        Only your own Claude account: the app never shares a login with anyone else.
      </p>
    </section>
  );
}
