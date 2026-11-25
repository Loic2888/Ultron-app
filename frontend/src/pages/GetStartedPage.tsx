import { CheckCircle2, CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { CodeBlock } from '../components/Workbench/CodeBlock';
import { type ClaudeAccount, claudeAccount } from '../lib/claudeApi';
import { fetchPhoneStatus, type PhoneStatus } from '../lib/journalApi';

type Check = { state: 'loading' | 'ok' | 'todo'; text: string };

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="metal-panel rounded-lg p-5 flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--color-text)' }}>
        <span
          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px]"
          style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}
        >
          {n}
        </span>
        {title}
      </h2>
      <div className="text-sm flex flex-col gap-2.5" style={{ color: 'var(--color-text-secondary)' }}>
        {children}
      </div>
    </section>
  );
}

function StatusLine({ check }: { check: Check }) {
  const Icon = check.state === 'ok' ? CheckCircle2 : check.state === 'loading' ? Loader2 : CircleAlert;
  const color =
    check.state === 'ok' ? '#22c55e' : check.state === 'loading' ? 'var(--color-text-tertiary)' : 'var(--color-warning, #f59e0b)';
  return (
    <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text)' }}>
      <Icon size={15} color={color} className={check.state === 'loading' ? 'animate-spin' : undefined} />
      {check.text}
    </div>
  );
}

export function describeClaude(account: ClaudeAccount | null, failed: boolean): Check {
  if (failed) return { state: 'todo', text: 'Cannot read the Claude Code status.' };
  if (!account) return { state: 'loading', text: 'Checking Claude Code…' };
  if (!account.installed) return { state: 'todo', text: 'The `claude` program is not installed (step 1).' };
  if (!account.logged_in) return { state: 'todo', text: 'Claude Code is installed but not signed in (step 1).' };
  return { state: 'ok', text: `Claude Code signed in${account.email ? ` as ${account.email}` : ''}.` };
}

export function describePhone(phone: PhoneStatus | null, failed: boolean): Check {
  if (failed) return { state: 'todo', text: 'Cannot read the phone status.' };
  if (!phone) return { state: 'loading', text: 'Checking the phone bot…' };
  if (!phone.configured) return { state: 'todo', text: 'Phone bot off (optional, step 6).' };
  return phone.running
    ? { state: 'ok', text: 'Phone bot running.' }
    : { state: 'todo', text: 'Phone bot configured: restart the server to start it.' };
}

/** Install guide for this app, with live checks of what is already in place. */
export function GetStartedPage() {
  const [account, setAccount] = useState<ClaudeAccount | null>(null);
  const [accountFailed, setAccountFailed] = useState(false);
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [phoneFailed, setPhoneFailed] = useState(false);

  const load = useCallback(async () => {
    setAccountFailed(false);
    setPhoneFailed(false);
    claudeAccount().then(setAccount).catch(() => setAccountFailed(true));
    fetchPhoneStatus().then(setPhone).catch(() => setPhoneFailed(true));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8010';

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="max-w-2xl mx-auto flex flex-col gap-4">
        <header>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Get started
          </h1>
          <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
            Ultron runs on your machine (Ubuntu in WSL) and opens as a desktop window. Nothing is downloaded from
            elsewhere: you build it from this folder.
          </p>
        </header>

        <section className="metal-panel rounded-lg p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              What is ready
            </h2>
            <button
              type="button"
              className="metal-btn ml-auto"
              style={{ padding: '0.2rem 0.5rem' }}
              onClick={() => void load()}
              aria-label="Check again"
              title="Check again"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <StatusLine check={{ state: 'ok', text: `Ultron server running at ${origin}.` }} />
          <StatusLine check={describeClaude(account, accountFailed)} />
          <StatusLine check={describePhone(phone, phoneFailed)} />
        </section>

        <Step n={1} title="Sign in to Claude Code (your subscription)">
          <p>
            Ultron drives the official <code>claude</code> program with <strong>your own</strong> subscription. No API key.
            In a terminal:
          </p>
          <CodeBlock code="claude login" />
        </Step>

        <Step n={2} title="Install and build, once">
          <CodeBlock code={'cd ~/OpenJarvis\nuv sync --inexact\ncd frontend && npm install && npm run build'} />
          <p>
            Needs <code>uv</code>, Node with npm 11.19 or newer, and <code>~/.cargo/bin</code> first in your PATH.
          </p>
        </Step>

        <Step n={3} title="Open Ultron">
          <CodeBlock code="jarvis desktop" />
          <p>
            This starts the server (one light Python process) and opens the window. Closing the window leaves the server
            running; stop it with:
          </p>
          <CodeBlock code="jarvis stop" />
        </Step>

        <Step n={4} title="Desktop icon (Windows)">
          <p>From WSL, once:</p>
          <CodeBlock code="jarvis desktop --create-shortcut" />
          <p>A double-click on the “Ultron” icon starts the server if needed, then opens the window.</p>
        </Step>

        <Step n={5} title="A window without Edge's title bar">
          <p>
            In a normal Edge tab, open <code>{origin}/workspace</code>, then use the install icon at the right of the address
            bar, or menu <strong>…</strong> → <strong>Apps</strong> → <strong>Install this site as an app</strong>. The installed
            “Ultron” app has no blue band: − ▢ ✕ are drawn inside the app.
          </p>
          <p>
            To make <code>jarvis desktop</code> open that installed app: copy its ID from <code>edge://apps</code> and add{' '}
            <code>export JARVIS_APP_ID=&lt;the ID&gt;</code> to <code>~/.bashrc</code>.
          </p>
        </Step>

        <Step n={6} title="Phone, through a private Telegram bot (optional)">
          <p>
            Create a bot with @BotFather, get your numeric id from @userinfobot, and add to <code>.env.local</code>, then restart
            the server:
          </p>
          <CodeBlock code={'OPENJARVIS_PHONE_BOT_TOKEN=<the token>\nOPENJARVIS_PHONE_OWNER_ID=<your numeric id>'} />
          <p>Only your account is listened to. The details and safeguards are in <code>docs/windows-et-telephone.md</code>.</p>
        </Step>

        <Step n={7} title="First steps">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>
              <strong>Workspace</strong>: pick a repo at the top left; the tree, editors, terminals and Claude Code windows all
              follow the active repo. The <strong>+</strong> opens a new Claude Code window.
            </li>
            <li>
              <strong>Ultron medallion</strong> (top right): the assistant that drives the app. Deleting or creating a repo always
              asks you first.
            </li>
            <li>
              <strong>Memory</strong>: every repo gets its own folder where Claude Code windows note what works and what does not.
            </li>
            <li>
              <strong>Logs</strong>: everything that happened, with the time.
            </li>
          </ul>
        </Step>
      </div>
    </div>
  );
}
