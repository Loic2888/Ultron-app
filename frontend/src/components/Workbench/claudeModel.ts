/**
 * Turns the event stream of one Claude Code chat into what the screen shows:
 * messages, tool calls with their results, pending approvals and a "busy"
 * flag. Pure functions (no React, no network): `reduceEvent` returns a new
 * model and never mutates its input.
 */
import type { PendingApproval, ServerEvent } from '../../lib/claudeApi';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      /** Raw JSON still arriving while the model writes the tool call. */
      partial?: string;
      result?: { text: string; isError: boolean };
    };

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; blocks: Block[]; streaming: boolean }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string };

export interface ChatModel {
  items: Item[];
  approvals: PendingApproval[];
  busy: boolean;
  claudeSessionId: string | null;
  model: string | null;
  /** Slash commands and sub-agent types announced by Claude Code at start. */
  commands: string[];
  agentTypes: string[];
  /** Last event number applied: where to resume the stream after a drop. */
  lastSeq: number;
  /** Messages already built from partial events (their final copy is skipped). */
  streamed: Record<string, true>;
  /** Message currently being streamed, and block index -> position in it. */
  current: string | null;
  slots: Record<number, number>;
}

export const emptyChat = (): ChatModel => ({
  items: [],
  approvals: [],
  busy: false,
  claudeSessionId: null,
  model: null,
  commands: [],
  agentTypes: [],
  lastSeq: -1,
  streamed: {},
  current: null,
  slots: {},
});

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Text of a tool result, which Claude sends as a string or a list of blocks. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) : isObj(b) && b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

const parseJson = (raw: string): unknown => {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

function updateAssistant(m: ChatModel, id: string, fn: (blocks: Block[]) => Block[], streaming?: boolean): ChatModel {
  const items = m.items.map((it) =>
    it.kind === 'assistant' && it.id === id
      ? { ...it, blocks: fn(it.blocks), streaming: streaming ?? it.streaming }
      : it,
  );
  return { ...m, items };
}

function patchBlock(blocks: Block[], pos: number, fn: (b: Block) => Block): Block[] {
  if (pos < 0 || pos >= blocks.length) return blocks;
  return blocks.map((b, i) => (i === pos ? fn(b) : b));
}

function onStream(m: ChatModel, ev: Json): ChatModel {
  const type = str(ev.type);
  if (type === 'message_start' && isObj(ev.message)) {
    const id = str(ev.message.id) || `m${m.items.length}`;
    return {
      ...m,
      items: [...m.items, { kind: 'assistant', id, blocks: [], streaming: true }],
      streamed: { ...m.streamed, [id]: true },
      current: id,
      slots: {},
    };
  }
  const cur = m.current;
  if (!cur) return m;
  const index = typeof ev.index === 'number' ? ev.index : -1;
  if (type === 'content_block_start' && isObj(ev.content_block)) {
    const cb = ev.content_block;
    const kind = str(cb.type);
    let block: Block;
    if (kind === 'tool_use' || kind === 'server_tool_use') {
      block = { kind: 'tool', id: str(cb.id), name: str(cb.name), input: {}, partial: '' };
    } else if (kind === 'thinking') {
      block = { kind: 'thinking', text: str(cb.thinking) };
    } else {
      block = { kind: 'text', text: str(cb.text) };
    }
    const item = m.items.find((i) => i.kind === 'assistant' && i.id === cur);
    const pos = item && item.kind === 'assistant' ? item.blocks.length : 0;
    const next = updateAssistant(m, cur, (bs) => [...bs, block]);
    return { ...next, slots: { ...m.slots, [index]: pos } };
  }
  if (type === 'content_block_delta' && isObj(ev.delta)) {
    const d = ev.delta;
    const pos = m.slots[index];
    if (pos === undefined) return m;
    const kind = str(d.type);
    return updateAssistant(m, cur, (bs) =>
      patchBlock(bs, pos, (b) => {
        if (kind === 'text_delta' && b.kind === 'text') return { ...b, text: b.text + str(d.text) };
        if (kind === 'thinking_delta' && b.kind === 'thinking') return { ...b, text: b.text + str(d.thinking) };
        if (kind === 'input_json_delta' && b.kind === 'tool') return { ...b, partial: (b.partial ?? '') + str(d.partial_json) };
        return b;
      }),
    );
  }
  if (type === 'content_block_stop') {
    const pos = m.slots[index];
    if (pos === undefined) return m;
    return updateAssistant(m, cur, (bs) =>
      patchBlock(bs, pos, (b) =>
        b.kind === 'tool' && b.partial !== undefined ? { ...b, input: parseJson(b.partial), partial: undefined } : b,
      ),
    );
  }
  if (type === 'message_stop') {
    return { ...updateAssistant(m, cur, (bs) => bs, false), current: null, slots: {} };
  }
  return m;
}

function blocksFromContent(content: unknown): Block[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text') out.push({ kind: 'text', text: str(b.text) });
    else if (b.type === 'thinking') out.push({ kind: 'thinking', text: str(b.thinking) });
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      out.push({ kind: 'tool', id: str(b.id), name: str(b.name), input: b.input ?? {} });
    }
  }
  return out;
}

function attachResults(m: ChatModel, content: unknown[]): ChatModel {
  let items = m.items;
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_result') continue;
    const id = str(b.tool_use_id);
    const result = { text: resultText(b.content), isError: b.is_error === true };
    items = items.map((it) =>
      it.kind === 'assistant' && it.blocks.some((x) => x.kind === 'tool' && x.id === id)
        ? { ...it, blocks: it.blocks.map((x) => (x.kind === 'tool' && x.id === id ? { ...x, result } : x)) }
        : it,
    );
  }
  return items === m.items ? m : { ...m, items };
}

let noticeCounter = 0;
const notice = (level: 'info' | 'error', text: string): Item => ({
  kind: 'notice',
  id: `n${++noticeCounter}`,
  level,
  text,
});

/** Applies one server event. Unknown events are ignored (but advance `lastSeq`). */
export function reduceEvent(model: ChatModel, event: ServerEvent): ChatModel {
  let m: ChatModel = { ...model, lastSeq: Math.max(model.lastSeq, event.seq) };
  const type = event.type;

  if (type === 'jarvis') {
    switch (str(event.kind)) {
      case 'user_message':
        return { ...m, busy: true, items: [...m.items, { kind: 'user', id: `u${event.seq}`, text: str(event.text) }] };
      case 'approval': {
        const approval: PendingApproval = {
          request_id: str(event.request_id),
          tool_name: str(event.tool_name),
          display_name: str(event.display_name),
          description: str(event.description),
          input: isObj(event.input) ? event.input : null,
        };
        if (m.approvals.some((a) => a.request_id === approval.request_id)) return m;
        return { ...m, approvals: [...m.approvals, approval] };
      }
      case 'approval_resolved':
        return { ...m, approvals: m.approvals.filter((a) => a.request_id !== str(event.request_id)) };
      case 'process_exit': {
        const code = typeof event.code === 'number' ? event.code : null;
        const during = event.during_turn === true;
        const next = { ...m, busy: false, approvals: [] };
        if (!during && (code === 0 || code === null)) return next;
        const detail = str(event.stderr).trim();
        return {
          ...next,
          items: [
            ...m.items,
            notice('error', `Claude stopped${code !== null ? ` (code ${code})` : ''}.${detail ? ` ${detail}` : ''}`),
          ],
        };
      }
      case 'closed':
        return { ...m, busy: false, approvals: [], items: [...m.items, notice('info', 'This chat was closed.')] };
      default:
        return m;
    }
  }

  if (type === 'system') {
    if (event.subtype === 'init') {
      const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return {
        ...m,
        claudeSessionId: str(event.session_id) || m.claudeSessionId,
        model: str(event.model) || m.model,
        commands: names(event.slash_commands).length ? names(event.slash_commands) : m.commands,
        agentTypes: names(event.agents).length ? names(event.agents) : m.agentTypes,
      };
    }
    return m;
  }

  // Messages written by sub-agents are not shown (only the main conversation).
  if (event.parent_tool_use_id) return m;

  if (type === 'stream_event' && isObj(event.event)) return onStream(m, event.event);

  if (type === 'assistant' && isObj(event.message)) {
    const id = str(event.message.id) || `a${event.seq}`;
    if (m.streamed[id]) return m;
    const blocks = blocksFromContent(event.message.content);
    if (blocks.length === 0) return m;
    return { ...m, items: [...m.items, { kind: 'assistant', id: `${id}#${event.seq}`, blocks, streaming: false }] };
  }

  if (type === 'user' && isObj(event.message)) {
    const content = event.message.content;
    if (Array.isArray(content)) {
      m = attachResults(m, content);
      if (event.replayed === true) {
        const text = content
          .map((b) => (isObj(b) && b.type === 'text' ? str(b.text) : ''))
          .filter(Boolean)
          .join('\n');
        if (text) return { ...m, items: [...m.items, { kind: 'user', id: `u${event.seq}`, text }] };
      }
      return m;
    }
    if (typeof content === 'string' && content.trim() && event.replayed === true) {
      return { ...m, items: [...m.items, { kind: 'user', id: `u${event.seq}`, text: content }] };
    }
    return m;
  }

  if (type === 'result') {
    const failed = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success');
    const next = { ...m, busy: false, current: null, slots: {} };
    if (!failed) return next;
    // An interruption (the Stop button) ends with this subtype and no text.
    if (event.subtype === 'error_during_execution' && !str(event.result)) {
      return { ...next, items: [...m.items, notice('info', 'Stopped.')] };
    }
    const why = str(event.result) || str(event.subtype) || 'The request failed.';
    return { ...next, items: [...m.items, notice('error', why)] };
  }

  return m;
}

export const reduceEvents = (model: ChatModel, events: ServerEvent[]): ChatModel =>
  events.reduce(reduceEvent, model);

/** One short line describing a tool call (the command, the file, the pattern…). */
export function toolSummary(name: string, input: unknown): string {
  if (!isObj(input)) return '';
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
    return '';
  };
  switch (name) {
    case 'Bash':
      return pick('command');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path');
    case 'Glob':
    case 'Grep':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query');
    case 'mcp__jarvis__mail_send': {
      const to = Array.isArray(input.to) ? input.to.join(', ') : pick('to');
      return `To: ${to} | ${pick('subject')} | ${pick('body').slice(0, 400)}`;
    }
    case 'mcp__jarvis__github_comment':
      return `${pick('repo')} #${String(input.number ?? '')}: ${pick('body').slice(0, 400)}`;
    case 'mcp__jarvis__calendar_create_event': {
      const guests = Array.isArray(input.attendees) && input.attendees.length ? ` | invites ${input.attendees.join(', ')}` : '';
      return `${pick('title')} | ${pick('start')} -> ${pick('end')}${guests}`;
    }
    case 'mcp__jarvis__git_push':
      return `${pick('branch')} (${pick('path').split('/').pop() ?? ''})`;
    case 'mcp__jarvis__github_create_pr':
      return pick('title');
    default:
      return pick('description', 'command', 'file_path', 'path', 'query', 'prompt');
  }
}

const JARVIS_PREFIX = 'mcp__jarvis__';

/** What the owner is asked to allow, for the two Ultron tools that need an approval. */
const JARVIS_ASKS: Record<string, string> = {
  create_repo: 'create a new repository',
  delete_path: 'move to the trash',
  github_comment: 'post this comment on GitHub',
  git_push: 'push this branch to GitHub',
  github_create_pr: 'open this pull request',
  mail_send: 'send this mail',
  calendar_create_event: 'add this event to your calendar',
};

/** `mcp__jarvis__open_repo` -> `open_repo`; other names unchanged. */
export const shortToolName = (name: string): string =>
  name.startsWith(JARVIS_PREFIX) ? name.slice(JARVIS_PREFIX.length) : name;

/** The sentence of an approval card for an Ultron tool, or null for other tools. */
export const jarvisAsk = (name: string): string | null =>
  name.startsWith(JARVIS_PREFIX) ? (JARVIS_ASKS[shortToolName(name)] ?? shortToolName(name)) : null;


/** Sub-agents working right now: `Task`/`Agent` tool calls that have no result yet. */
export function runningAgents(m: ChatModel): number {
  let n = 0;
  for (const it of m.items) {
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) {
      if (b.kind === 'tool' && (b.name === 'Task' || b.name === 'Agent') && !b.result) n += 1;
    }
  }
  return m.busy ? n : 0;
}

/** `claude-opus-5-5` -> `Opus 5.5`; anything else is shown as it is. */
export function prettyModel(id: string | null | undefined): string {
  if (!id) return '';
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/.exec(id);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1);
  return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
}

/** Time since `startedAt` (ms): `45s`, `59m`, `1h 05m`. */
export function elapsedLabel(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}
