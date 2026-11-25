import { Loader2, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { ClaudeAccountCard } from '../components/Workbench/ClaudeAccountCard';
import {
  clearServerLogs,
  fetchJournalInfo,
  fetchPhoneStatus,
  type JournalInfo,
  type PhoneStatus,
} from '../lib/journalApi';

function Card({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="metal-panel rounded-lg p-5 max-w-2xl flex flex-col gap-2.5">
      <h2 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--color-text)' }}>
        {icon}
        {title}
      </h2>
      <div className="text-sm flex flex-col gap-2" style={{ color: 'var(--color-text-secondary)' }}>
        {children}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-40 shrink-0" style={{ color: 'var(--color-text-tertiary)' }}>
        {label}
      </span>
      <span className="break-all" style={{ color: 'var(--color-text)' }}>
        {value}
      </span>
    </div>
  );
}

const percent = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)} %`);

export function phoneSummary(phone: PhoneStatus | null, failed: boolean): string {
  if (failed) return 'Unknown (cannot read the status)';
  if (!phone) return '…';
  if (!phone.configured) return 'Off (no bot configured)';
  return phone.running ? 'On' : 'Configured: restart the server to start it';
}

/** Only what is really wired in this app: account, safeguards, phone bot, local data. */
export function SettingsPage() {
  const [phone, setPhone] = useState<PhoneStatus | null>(null);
  const [phoneFailed, setPhoneFailed] = useState(false);
  const [info, setInfo] = useState<JournalInfo | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadInfo = () => {
    fetchJournalInfo().then(setInfo).catch(() => setInfo(null));
  };

  useEffect(() => {
    fetchPhoneStatus().then(setPhone).catch(() => setPhoneFailed(true));
    loadInfo();
  }, []);

  const clearLogs = async () => {
    setBusy(true);
    try {
      await clearServerLogs();
    } finally {
      setBusy(false);
      setConfirmClear(false);
      loadInfo();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-10">
      <div className="mx-auto flex flex-col gap-4 max-w-2xl">
        <header>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            Settings
          </h1>
          <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
            Only what is really connected in this app.
          </p>
        </header>

        <ClaudeAccountCard />

        <Card icon={<ShieldCheck size={16} style={{ color: 'var(--color-accent)' }} />} title="Safeguards (enforced by the server)">
          <ul className="list-disc pl-5 flex flex-col gap-1">
            <li>The server only listens on this machine, and every request needs this session's secret token.</li>
            <li>Claude Code windows ask before every action; “bypass permissions” is not offered.</li>
            <li>
              The only thing allowed without asking: a window reading and writing the notes of <em>its own</em> repo in the
              Memory folder.
            </li>
            <li>
              Ultron always asks you before deleting (moved to <code>~/.jarvis-trash</code>, never erased) or creating a repo.
            </li>
            <li>No usage data, identity or e-mail is sent anywhere.</li>
          </ul>
        </Card>

        <Card icon={<Smartphone size={16} style={{ color: 'var(--color-accent)' }} />} title="Phone (Telegram bot)">
          <Row label="State" value={phoneSummary(phone, phoneFailed)} />
          {phone?.configured && (
            <>
              <Row label="Messages per hour" value={phone.max_per_hour ?? '–'} />
              <Row label="Max message size" value={phone.max_text ? `${phone.max_text} characters` : '–'} />
              <Row label="Max time per task" value={phone.turn_seconds ? `${Math.round(phone.turn_seconds / 60)} min` : '–'} />
              <Row
                label="Stops new tasks at"
                value={`${percent(phone.five_hour_stop)} of the 5 h window, ${percent(phone.week_stop)} of the week`}
              />
            </>
          )}
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            Set up in <code>.env.local</code> (see Get Started, step 6). The token is never shown here.
          </p>
        </Card>

        <Card title="Data on this machine">
          <Row label="Journal" value={info?.journal_dir ?? '…'} />
          <Row label="Repo memory" value={info?.memory_dir ?? '…'} />
          <Row label="Log entries" value={info ? info.log_entries : '…'} />
          <Row label="Tasks remembered" value={info ? info.task_entries : '…'} />
          <div className="flex items-center gap-2 pt-1">
            {confirmClear ? (
              <>
                <span className="text-xs">Erase all log entries?</span>
                <button type="button" className="metal-btn text-xs" disabled={busy} onClick={() => void clearLogs()}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Yes, erase
                </button>
                <button type="button" className="metal-btn text-xs" onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="metal-btn text-xs" onClick={() => setConfirmClear(true)}>
                <Trash2 size={13} /> Clear the logs
              </button>
            )}
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            The repo memory notes are never erased from here: they are plain files you can edit or delete yourself.
          </p>
        </Card>
      </div>
    </div>
  );
}
