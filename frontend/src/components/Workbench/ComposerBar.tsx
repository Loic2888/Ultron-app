import { Bot, ChevronDown, Clock, Plus, Settings2, Shield, Slash } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { Effort, PermissionMode } from '../../lib/claudeApi';
import { type ChatModel, elapsedLabel, prettyModel, runningAgents } from './claudeModel';
import { activeRuleCount } from './customRules';
import RulesDialog from './RulesDialog';
import { useClaude } from './claudeStore';

export const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask first', hint: 'Claude asks before it edits a file or runs a command.' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through; commands still ask.' },
  { value: 'custom', label: 'Custom', hint: 'Like Accept edits, plus the rules you choose (commands, deletions, pull requests…).' },
];

const MODELS: { value: string | null; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

const EFFORTS: { value: Effort | null; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

const QUICK_ACTIONS: { command: string; label: string; hint: string }[] = [
  { command: '/compact', label: 'Compact the conversation', hint: 'Summarise it to free context.' },
  { command: '/context', label: 'Show context usage', hint: 'How full the context is.' },
  { command: '/usage', label: 'Show plan usage', hint: 'Your subscription limits.' },
  { command: '/init', label: 'Create a CLAUDE.md', hint: 'Let Claude describe this repo.' },
];

const effortLabel = (e: Effort | null) => EFFORTS.find((x) => x.value === e)?.label ?? '';

/** A button that opens a small panel above it; closes on outside click or Escape. */
function Menu({
  label,
  title,
  children,
  disabled,
  align = 'left',
  active,
}: {
  label: ReactNode;
  title: string;
  children: (close: () => void) => ReactNode;
  disabled?: boolean;
  align?: 'left' | 'right';
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        className="metal-btn inline-flex items-center gap-1.5 text-xs"
        style={{ padding: '0.2rem 0.55rem', ...(active ? { color: 'var(--color-text)' } : {}) }}
        title={title}
        aria-label={title}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && (
        <div
          className="metal-panel absolute bottom-full z-50 mb-1.5 flex max-h-80 min-w-[14rem] flex-col overflow-y-auto rounded-md p-1 text-xs"
          style={align === 'right' ? { right: 0 } : { left: 0 }}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function Item({
  children,
  hint,
  selected,
  onClick,
}: {
  children: ReactNode;
  hint?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex flex-col items-start rounded px-2 py-1.5 text-left hover:bg-white/5"
      style={{ color: selected ? 'var(--color-accent)' : 'var(--color-text)' }}
      onClick={onClick}
    >
      <span>
        {selected ? '● ' : ''}
        {children}
      </span>
      {hint && (
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
          {hint}
        </span>
      )}
    </button>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <div className="px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
    {children}
  </div>
);

/** Slash commands announced by Claude Code, with a filter. */
function CommandList({ commands, onPick }: { commands: string[]; onPick: (c: string) => void }) {
  const [q, setQ] = useState('');
  const shown = commands.filter((c) => c.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <input
        autoFocus
        className="metal-well mb-1 rounded px-2 py-1 text-xs"
        style={{ color: 'var(--color-text)' }}
        placeholder="Filter commands…"
        aria-label="Filter commands"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {shown.length === 0 && (
        <div className="px-2 py-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
          {commands.length === 0 ? 'Send a first message: Claude Code then lists its commands.' : 'No match.'}
        </div>
      )}
      {shown.map((c) => (
        <Item key={c} onClick={() => onPick(c)}>
          /{c}
        </Item>
      ))}
    </>
  );
}

/**
 * The bar under the message box: quick actions, slash commands, session time,
 * sub-agents, model + effort, permission mode, and the send / stop button.
 */
export default function ComposerBar({
  chatKey,
  model,
  mode,
  modelChoice,
  effort,
  startedAt,
  ready,
  busy,
  locked,
  canSend,
  onInsert,
  onQuick,
  onStop,
}: {
  chatKey: string;
  model: ChatModel;
  mode: PermissionMode;
  modelChoice: string | null;
  effort: Effort | null;
  startedAt: number | null;
  ready: boolean;
  busy: boolean;
  /** Something is waiting for an answer: settings cannot change now. */
  locked: boolean;
  canSend: boolean;
  onInsert: (text: string) => void;
  onQuick: (command: string) => void;
  onStop: () => void;
}) {
  const changeMode = useClaude((s) => s.changeMode);
  const changeSettings = useClaude((s) => s.changeSettings);
  const rules = useClaude((s) => s.rules);
  const setRules = useClaude((s) => s.setRules);
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const frozen = busy || locked;
  const agents = runningAgents(model);
  const modeInfo = MODES.find((m) => m.value === mode);
  const modelLabel = prettyModel(model.model) || MODELS.find((m) => m.value === modelChoice)?.label || 'Model';
  const ruleCount = activeRuleCount(rules);

  const pickMode = (value: PermissionMode, close: () => void) => {
    close();
    void changeMode(chatKey, value);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Menu label={<Plus size={14} />} title="Quick actions" disabled={!ready}>
        {(close) =>
          QUICK_ACTIONS.map((a) => (
            <Item
              key={a.command}
              hint={`${a.command} · ${a.hint}`}
              onClick={() => {
                close();
                onQuick(a.command);
              }}
            >
              {a.label}
            </Item>
          ))
        }
      </Menu>

      <Menu label={<Slash size={14} />} title="Slash commands" disabled={!ready}>
        {(close) => (
          <CommandList
            commands={model.commands}
            onPick={(c) => {
              close();
              onInsert(`/${c} `);
            }}
          />
        )}
      </Menu>

      {startedAt !== null && (
        <span
          className="inline-flex items-center gap-1 px-1.5 text-xs"
          style={{ color: 'var(--color-text-tertiary)' }}
          title="Time since this window started"
        >
          <Clock size={12} />
          {elapsedLabel(startedAt, now)}
        </span>
      )}

      {model.agentTypes.length > 0 && (
        <Menu
          title="Sub-agents"
          label={
            <>
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: agents > 0 ? '#22c55e' : '#6b7280' }}
                aria-hidden
              />
              <Bot size={12} />
              {agents > 0 ? `${agents} agent${agents > 1 ? 's' : ''}` : 'agents'}
            </>
          }
          disabled={!ready}
        >
          {(close) => (
            <>
              <Heading>Ask Claude to use an agent</Heading>
              {model.agentTypes.map((a) => (
                <Item
                  key={a}
                  onClick={() => {
                    close();
                    onInsert(`Use the ${a} agent to `);
                  }}
                >
                  {a}
                </Item>
              ))}
            </>
          )}
        </Menu>
      )}

      <Menu
        title="Model and effort"
        disabled={!ready || frozen}
        label={
          <>
            {modelLabel}
            {effort && <span style={{ color: 'var(--color-text-tertiary)' }}>{effortLabel(effort)}</span>}
            <ChevronDown size={11} />
          </>
        }
      >
        {(close) => (
          <>
            <Heading>Model</Heading>
            {MODELS.map((m) => (
              <Item
                key={m.label}
                selected={modelChoice === m.value}
                onClick={() => {
                  close();
                  void changeSettings(chatKey, m.value, effort);
                }}
              >
                {m.label}
              </Item>
            ))}
            <Heading>Effort</Heading>
            {EFFORTS.map((e) => (
              <Item
                key={e.label}
                selected={effort === e.value}
                onClick={() => {
                  close();
                  void changeSettings(chatKey, modelChoice, e.value);
                }}
              >
                {e.label}
              </Item>
            ))}
          </>
        )}
      </Menu>

      <div className="ml-auto flex items-center gap-1.5">
        <Menu
          align="right"
          title="Permission mode"
          disabled={frozen}
          active={mode === 'custom'}
          label={
            <>
              <Shield size={12} />
              {modeInfo?.label ?? mode}
              {mode === 'custom' && ruleCount > 0 && (
                <span className="rounded-full px-1 text-[10px]" style={{ background: 'var(--color-accent)', color: 'var(--color-bg)' }}>
                  {ruleCount}
                </span>
              )}
              <ChevronDown size={11} />
            </>
          }
        >
          {(close) => (
            <>
              {MODES.map((m) => (
                <Item key={m.value} selected={mode === m.value} hint={m.hint} onClick={() => pickMode(m.value, close)}>
                  {m.label}
                </Item>
              ))}
              <div className="my-1 border-t" style={{ borderColor: 'var(--color-border)' }} />
              <Item
                hint={ruleCount > 0 ? `${ruleCount} rule${ruleCount > 1 ? 's' : ''} on` : 'No rule yet: everything still asks'}
                onClick={() => {
                  close();
                  setEditing(true);
                }}
              >
                <Settings2 size={11} className="mr-1 inline" />
                Edit Custom rules…
              </Item>
            </>
          )}
        </Menu>

        {busy ? (
          <button type="button" className="metal-btn" onClick={onStop} title="Stop Claude" aria-label="Stop">
            ■
          </button>
        ) : (
          <button type="submit" className="metal-btn" disabled={!canSend} title="Send (Enter)" aria-label="Send">
            ↑
          </button>
        )}
      </div>

      {editing && (
        <RulesDialog
          rules={rules}
          onClose={() => setEditing(false)}
          onSave={(r) => {
            void setRules(r);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
