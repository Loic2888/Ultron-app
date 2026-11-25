import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Loader2, Send, Square, TerminalSquare, X } from 'lucide-react';

import type { ChatKind, PendingApproval } from '../../lib/claudeApi';
import { jarvisAsk, shortToolName, toolSummary, type Block, type Item } from './claudeModel';
import { useClaude } from './claudeStore';
import { rememberFor, withRemembered } from './customRules';
import ComposerBar from './ComposerBar';

const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

/** One Claude Code conversation, for the repo it was opened in. */
export default function ClaudeChat({
  chatKey,
  cwd,
  kind = 'code',
}: {
  chatKey: string;
  cwd: string;
  kind?: ChatKind;
}) {
  const jarvis = kind === 'jarvis';
  const chat = useClaude((s) => s.chats[chatKey]);
  const open = useClaude((s) => s.open);
  const send = useClaude((s) => s.send);
  const decide = useClaude((s) => s.decide);
  const interrupt = useClaude((s) => s.interrupt);
  const reconnect = useClaude((s) => s.reconnect);

  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    void open(chatKey, cwd, kind);
  }, [open, chatKey, cwd, kind]);

  const model = chat?.model;
  const lastItem = model?.items[model.items.length - 1];
  // Keep the newest text in view, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [model?.items.length, lastItem, model?.approvals.length]);

  if (!chat || !model) {
    return <Banner text="Starting Claude Code…" />;
  }
  if (chat.status === 'error') {
    return <Banner text={chat.error} error action={{ label: 'Try again', run: () => void open(chatKey, cwd, kind) }} />;
  }

  const ready = chat.status === 'ready';
  const busy = model.busy;
  const canSend = ready && !busy && !chat.sending && draft.trim().length > 0;

  const submit = async () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    stick.current = true;
    setDraft('');
    try {
      await send(chatKey, text);
    } catch {
      setDraft(text); // give the text back so nothing is lost
    }
  };

  const insert = (text: string) => {
    setDraft((d) => (d && !d.endsWith(' ') && !d.endsWith('\n') ? `${d} ${text}` : d + text));
    input.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex shrink-0 items-center gap-2 px-3 py-1 text-xs"
        // right padding keeps the controls clear of the floating Ultron orb and gauges
        style={{ background: '#0a0c0e', borderBottom: '1px solid #000', color: 'var(--color-text-tertiary)', paddingRight: jarvis ? 12 : 116 }}
      >
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: !ready ? '#6b7280' : busy ? 'var(--color-warning, #f59e0b)' : '#22c55e' }}
          aria-hidden
        />
        <span>{!ready ? 'Connecting…' : busy ? (model.approvals.length > 0 ? 'Waiting for your answer ↓' : 'Working…') : 'Ready'}</span>
        {model.model && <span className="truncate opacity-70">{model.model}</span>}
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {model.items.length === 0 && (
          <p className="mt-10 text-center text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {jarvis ? (
              <>
                Tell Ultron what to do: open a project, start a Claude Code chat in it, send it
                instructions, check on its progress. Ultron asks you before it creates or deletes anything.
              </>
            ) : (
              <>
                Ask Claude anything about this repository. It works in <code>{cwd}</code>.
              </>
            )}
          </p>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {model.items.map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
          {busy && model.approvals.length === 0 && (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
              <Loader2 size={13} className="animate-spin" /> Claude is working…
            </div>
          )}
        </div>
      </div>

      {model.approvals.map((a) => (
        <ApprovalCard
          key={a.request_id}
          approval={a}
          onAnswer={(allow) => decide(chatKey, a.request_id, allow)}
          onAlways={
            !jarvis && chat?.mode === 'custom' && rememberFor(a.tool_name, a.input)
              ? async () => {
                  const add = rememberFor(a.tool_name, a.input);
                  if (add) {
                    const st = useClaude.getState();
                    await st.setRules(withRemembered(st.rules, add));
                  }
                  return decide(chatKey, a.request_id, true);
                }
              : undefined
          }
        />
      ))}

      {chat.error && (
        <div role="alert" className="shrink-0 px-4 py-1.5 text-xs" style={{ color: 'var(--color-error)', background: '#0a0c0e' }}>
          {chat.error}
          {chat.status === 'offline' && (
            <button type="button" className="metal-btn ml-2 text-xs" onClick={() => void reconnect(chatKey)}>
              Reconnect
            </button>
          )}
        </div>
      )}

      <form
        className="flex shrink-0 flex-col gap-1.5 p-2"
        style={{ background: '#0a0c0e', borderTop: '1px solid #000' }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={input}
          className="metal-well w-full resize-none rounded-md px-3 py-2 text-sm"
          style={{ color: 'var(--color-text)', minHeight: 40, maxHeight: 200 }}
          rows={Math.min(8, Math.max(1, draft.split('\n').length))}
          placeholder={ready ? `${jarvis ? 'Ask Ultron' : 'Message Claude Code'}…  (Enter to send, Shift+Enter for a new line)` : 'Connecting…'}
          aria-label={jarvis ? 'Message to Ultron' : 'Message to Claude Code'}
          value={draft}
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {jarvis ? (
          <div className="flex justify-end">
            {busy ? (
              <button type="button" className="metal-btn" onClick={() => void interrupt(chatKey)} title="Stop Claude" aria-label="Stop">
                <Square size={14} /> Stop
              </button>
            ) : (
              <button type="submit" className="metal-btn" disabled={!canSend} title="Send (Enter)" aria-label="Send">
                <Send size={14} /> Send
              </button>
            )}
          </div>
        ) : (
          <ComposerBar
            chatKey={chatKey}
            model={model}
            mode={chat.mode}
            modelChoice={chat.modelChoice}
            effort={chat.effort}
            startedAt={chat.startedAt}
            ready={ready}
            busy={busy}
            locked={model.approvals.length > 0}
            canSend={canSend}
            onInsert={insert}
            onQuick={(command) => void send(chatKey, command)}
            onStop={() => void interrupt(chatKey)}
          />
        )}
      </form>
    </div>
  );
}

const ItemView = memo(function ItemView({ item }: { item: Item }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className="max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
          style={{
            background: 'linear-gradient(180deg, #2a2d33, #1a1c20)',
            border: '1px solid #000',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
            color: 'var(--color-text)',
          }}
        >
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'notice') {
    return (
      <div
        role={item.level === 'error' ? 'alert' : 'status'}
        className="rounded-md px-3 py-2 text-xs"
        style={{
          color: item.level === 'error' ? 'var(--color-error)' : 'var(--color-text-tertiary)',
          border: `1px solid ${item.level === 'error' ? 'var(--color-error)' : '#000'}`,
          background: '#0a0c0e',
        }}
      >
        {item.text}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {item.blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
});

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'text') {
    if (!block.text) return null;
    return (
      <div className="chat-md text-sm leading-relaxed" style={{ color: 'var(--color-text)' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
      </div>
    );
  }
  if (block.kind === 'thinking') {
    if (!block.text.trim()) return null;
    return (
      <details className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        <summary className="cursor-pointer select-none">Thinking</summary>
        <div className="mt-1 whitespace-pre-wrap">{block.text}</div>
      </details>
    );
  }
  const summary = toolSummary(block.name, block.input);
  const running = !block.result;
  return (
    <details
      className="metal-well rounded-md text-xs"
      style={{ borderColor: block.result?.isError ? 'var(--color-error)' : undefined }}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 px-2.5 py-1.5">
        <TerminalSquare size={13} style={{ color: 'var(--color-accent)' }} />
        <span className="font-semibold" style={{ color: 'var(--color-text)' }}>
          {shortToolName(block.name)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono" style={{ color: 'var(--color-text-tertiary)' }} title={summary}>
          {summary}
        </span>
        {running ? (
          <Loader2 size={12} className="animate-spin" aria-label="Running" />
        ) : block.result?.isError ? (
          <X size={13} style={{ color: 'var(--color-error)' }} aria-label="Failed" />
        ) : (
          <Check size={13} style={{ color: 'var(--color-accent)' }} aria-label="Done" />
        )}
      </summary>
      <div className="flex flex-col gap-2 px-2.5 pb-2">
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px]" style={{ color: 'var(--color-text-secondary)' }}>
          {pretty(block.input)}
        </pre>
        {block.result && (
          <pre
            className="max-h-64 overflow-auto whitespace-pre-wrap border-t pt-2 font-mono text-[11px]"
            style={{ borderColor: '#000', color: block.result.isError ? 'var(--color-error)' : 'var(--color-text-secondary)' }}
          >
            {block.result.text.length > 6000 ? `${block.result.text.slice(0, 6000)}\n… (cut)` : block.result.text || '(no output)'}
          </pre>
        )}
      </div>
    </details>
  );
}

function ApprovalCard({
  approval,
  onAnswer,
  onAlways,
}: {
  approval: PendingApproval;
  onAnswer: (allow: boolean) => Promise<boolean>;
  onAlways?: () => Promise<boolean>;
}) {
  const name = shortToolName(approval.display_name || approval.tool_name || 'a tool');
  const ask = jarvisAsk(approval.tool_name ?? '');
  const summary = toolSummary(approval.tool_name ?? '', approval.input);
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    // If the answer did not reach the server, let the user try again.
    void onAnswer(allow).then((sent) => {
      if (!sent) setBusy(false);
    });
  };
  const always = () => {
    if (busy || !onAlways) return;
    setBusy(true);
    void onAlways().then((sent) => {
      if (!sent) setBusy(false);
    });
  };
  return (
    <div
      role="alertdialog"
      aria-label={ask ? `Ultron asks to ${ask}` : `Claude asks to use ${name}`}
      className="metal-panel mx-3 mb-2 shrink-0 rounded-md p-3 text-xs"
      style={{ border: '1px solid var(--color-accent)', boxShadow: '0 0 14px -4px var(--color-accent-glow)' }}
    >
      <div className="mb-1 font-semibold" style={{ color: 'var(--color-text)' }}>
        {ask ? (
          <>
            Ultron asks your permission to <span style={{ color: 'var(--color-accent)' }}>{ask}</span>
          </>
        ) : (
          <>
            Claude wants to use <span style={{ color: 'var(--color-accent)' }}>{name}</span>
          </>
        )}
      </div>
      {approval.description && approval.description !== summary && (
        <div className="mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          {approval.description}
        </div>
      )}
      {summary && (
        <pre
          className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap rounded px-2 py-1 font-mono text-[11px]"
          style={{ background: '#050607', color: 'var(--color-text)' }}
        >
          {summary}
        </pre>
      )}
      <div className="flex gap-2">
        <button type="button" className="metal-btn" disabled={busy} onClick={() => answer(true)}>
          <Check size={13} /> Accept
        </button>
        <button type="button" className="metal-btn" disabled={busy} onClick={() => answer(false)}>
          <X size={13} /> Refuse
        </button>
        {onAlways && (
          <button
            type="button"
            className="metal-btn ml-auto"
            disabled={busy}
            onClick={always}
            title="Accept, and add this to your Custom rules so Claude never asks again"
          >
            <Check size={13} /> Always accept
          </button>
        )}
      </div>
    </div>
  );
}

function Banner({
  text,
  error,
  action,
}: {
  text: string;
  error?: boolean;
  action?: { label: string; run: () => void };
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs"
      style={{ color: error ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}
      role={error ? 'alert' : 'status'}
    >
      <span>{text}</span>
      {action && (
        <button type="button" className="metal-btn text-xs" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
