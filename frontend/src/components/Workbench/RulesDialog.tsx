import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CustomRules } from '../../lib/claudeApi';
import { RULE_TOGGLES, TOOL_GROUPS, choiceOn, extraTools, parsePatterns, toggleChoice } from './customRules';

/** The rules of the "Custom" mode: what may run without asking. Everything starts off. */
export default function RulesDialog({
  rules,
  onSave,
  onClose,
}: {
  rules: CustomRules;
  onSave: (rules: CustomRules) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CustomRules>(rules);
  const [tools, setTools] = useState(extraTools(rules.allow_tools).join('\n'));
  const [commands, setCommands] = useState(rules.allow_commands.join('\n'));
  const [deletes, setDeletes] = useState(rules.allow_deletes.join('\n'));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = () =>
    onSave({ ...draft, allow_tools: [...draft.allow_tools.filter((t) => !extraTools([t]).length), ...parsePatterns(tools)], allow_commands: parsePatterns(commands), allow_deletes: parsePatterns(deletes) });

  const area = 'metal-well w-full rounded-md px-2 py-1.5 text-xs font-mono';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-label="Custom mode rules"
        className="metal-panel flex max-h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-lg p-5"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            Custom mode: what runs without asking
          </h2>
          <button type="button" className="metal-btn ml-auto" style={{ padding: '0.2rem 0.4rem' }} onClick={onClose} aria-label="Close">
            <X size={13} />
          </button>
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          Custom works like “Accept edits” (file edits go through). Tick what may also run without asking; anything else
          still shows the Accept / Refuse card. These rules apply to every window in Custom mode. A rule only matches one
          simple command: <code>a && b</code>, <code>a; b</code>, pipes and <code>$(…)</code> always ask.
        </p>

        <Section title="Shell commands (Bash)" />
        {RULE_TOGGLES.map((t) => (
          <label key={t.key} className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={draft[t.key]}
              onChange={(e) => setDraft({ ...draft, [t.key]: e.target.checked })}
            />
            <span>
              <span className="flex items-center gap-1.5" style={{ color: 'var(--color-text)' }}>
                {t.risky && <ShieldAlert size={13} color="var(--color-warning, #f59e0b)" />}
                {t.label}
              </span>
              <span className="block text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                {t.hint}
              </span>
            </span>
          </label>
        ))}

        <Section title="File edits" />
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          Edit, Write, MultiEdit and NotebookEdit are always accepted inside the repo (never in <code>.git</code>) and
          ask anywhere else.
        </p>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.other_tools}
            onChange={(e) => setDraft({ ...draft, other_tools: e.target.checked })}
          />
          <span>
            <span style={{ color: 'var(--color-text)' }}>Read-only tools</span>
            <span className="block text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              Read, Glob, Grep inside the repo, ToolSearch, and MCP tools that only read.
            </span>
          </span>
        </label>
        {TOOL_GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-2">
            <Section title={g.title} />
            {g.items.map((c) => (
              <label key={c.label} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={choiceOn(draft.allow_tools, c)}
                  onChange={(e) => setDraft({ ...draft, allow_tools: toggleChoice(draft.allow_tools, c, e.target.checked) })}
                />
                <span>
                  <span className="flex items-center gap-1.5" style={{ color: 'var(--color-text)' }}>
                    {c.risky && <ShieldAlert size={13} color="var(--color-warning, #f59e0b)" />}
                    {c.label}
                  </span>
                  <span className="block text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
                    {c.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ))}

        <div>
          <div className="mb-1 text-sm" style={{ color: 'var(--color-text)' }}>
            Other tools I always accept (one service, one tool)
          </div>
          <textarea
            className={area}
            rows={3}
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            placeholder={'mcp__claude_ai_Linear__*\nmcp__claude_ai_Linear__save_comment'}
            aria-label="Tools I always accept"
          />
          <p className="mt-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            Tool names, one per line; <code>*</code> matches any ending. Example: all of Linear, including writes.
          </p>
        </div>
        <div>
          <div className="mb-1 text-sm" style={{ color: 'var(--color-text)' }}>
            Commands I always accept
          </div>
          <textarea
            className={area}
            rows={3}
            value={commands}
            onChange={(e) => setCommands(e.target.value)}
            placeholder={'make lint\ndocker compose ps\nnpm run dev *'}
            aria-label="Commands I always accept"
          />
        </div>
        <div>
          <div className="mb-1 text-sm" style={{ color: 'var(--color-text)' }}>
            Deletions I accept
          </div>
          <textarea
            className={area}
            rows={3}
            value={deletes}
            onChange={(e) => setDeletes(e.target.value)}
            placeholder={'rm -rf node_modules\nrm -rf dist\nrm *.pyc'}
            aria-label="Deletions I accept"
          />
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
          One command per line, matched word for word. A final <code>*</code> accepts more arguments (for deletions, only
          paths inside the repo: no <code>/</code>, <code>~</code> or <code>..</code>). Deletions never run unless written
          here. <code>git push</code> to <code>main</code> or with <code>--force</code> is never accepted automatically.
        </p>

        <div className="flex justify-end gap-2">
          <button type="button" className="metal-btn text-xs" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="metal-btn text-xs" onClick={save}>
            Save rules
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div
      className="mt-1 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide"
      style={{ borderColor: 'rgba(255,255,255,0.08)', color: 'var(--color-text-secondary)' }}
    >
      {title}
    </div>
  );
}
