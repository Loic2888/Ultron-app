import { describe, expect, it } from 'vitest';

import type { ServerEvent } from '../../lib/claudeApi';
import {
  elapsedLabel,
  emptyChat,
  jarvisAsk,
  prettyModel,
  reduceEvent,
  reduceEvents,
  resultText,
  runningAgents,
  shortToolName,
  toolSummary,
  type Block,
  type ChatModel,
} from './claudeModel';

let seq = 0;
const ev = (e: Record<string, unknown>): ServerEvent => ({ seq: seq++, ...e }) as ServerEvent;
const stream = (e: Record<string, unknown>) => ev({ type: 'stream_event', event: e });

const streamedText = (id: string, text: string): ServerEvent[] => [
  stream({ type: 'message_start', message: { id } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 2) } }),
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(2) } }),
  stream({ type: 'content_block_stop', index: 0 }),
  stream({ type: 'message_stop' }),
];

const run = (events: ServerEvent[], from: ChatModel = emptyChat()) => reduceEvents(from, events);

describe('streaming text', () => {
  it('builds one assistant message from deltas', () => {
    const m = run(streamedText('m1', 'hello'));
    expect(m.items).toHaveLength(1);
    const it = m.items[0];
    expect(it.kind === 'assistant' && it.blocks).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(it.kind === 'assistant' && it.streaming).toBe(false);
  });

  it('shows the text while it is still arriving', () => {
    const events = streamedText('m1', 'hello').slice(0, 3);
    const it = run(events).items[0];
    expect(it.kind === 'assistant' && it.streaming).toBe(true);
    expect(it.kind === 'assistant' && it.blocks[0]).toEqual({ kind: 'text', text: 'he' });
  });

  it('skips the final copy of a message already streamed', () => {
    const m = run([
      ...streamedText('m1', 'hello'),
      ev({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } }),
    ]);
    expect(m.items).toHaveLength(1);
  });

  it('keeps blocks of one message in order (thinking, then text)', () => {
    const m = run([
      stream({ type: 'message_start', message: { id: 'm2' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      stream({ type: 'content_block_stop', index: 0 }),
      stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } }),
    ]);
    const it = m.items[0];
    expect(it.kind === 'assistant' && it.blocks).toEqual([
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'ok' },
    ]);
  });

  it('ignores deltas that arrive before any message', () => {
    const m = run([stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })]);
    expect(m.items).toEqual([]);
  });
});

describe('tool calls', () => {
  const toolEvents = (): ServerEvent[] => [
    stream({ type: 'message_start', message: { id: 'm3' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }),
    stream({ type: 'content_block_stop', index: 0 }),
  ];

  it('assembles the input from partial JSON', () => {
    const it = run(toolEvents()).items[0];
    const b = it.kind === 'assistant' ? it.blocks[0] : null;
    expect(b).toMatchObject({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(b && b.kind === 'tool' && b.partial).toBeUndefined();
  });

  it('survives broken partial JSON', () => {
    const events = toolEvents().slice(0, 3);
    events.push(stream({ type: 'content_block_stop', index: 0 }));
    const it = run(events).items[0];
    expect(it.kind === 'assistant' && it.blocks[0]).toMatchObject({ kind: 'tool', input: {} });
  });

  it('attaches the result to its tool call', () => {
    const m = run([
      ...toolEvents(),
      ev({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file.txt', is_error: false }] },
      }),
    ]);
    const it = m.items[0];
    expect(it.kind === 'assistant' && it.blocks[0]).toMatchObject({ result: { text: 'file.txt', isError: false } });
  });

  it('marks failed results', () => {
    const m = run([
      ...toolEvents(),
      ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'boom' }], is_error: true }] } }),
    ]);
    const it = m.items[0];
    expect(it.kind === 'assistant' && it.blocks[0]).toMatchObject({ result: { text: 'boom', isError: true } });
  });

  it('does not show messages written by sub-agents', () => {
    const m = run([ev({ type: 'assistant', parent_tool_use_id: 'x', message: { id: 's', content: [{ type: 'text', text: 'inner' }] } })]);
    expect(m.items).toEqual([]);
  });

  it('summarises tool calls in one line', () => {
    expect(toolSummary('Bash', { command: 'ls -la' })).toBe('ls -la');
    expect(toolSummary('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(toolSummary('Grep', { pattern: 'foo' })).toBe('foo');
    expect(toolSummary('Mystery', { description: 'does things' })).toBe('does things');
    expect(toolSummary('Bash', null)).toBe('');
  });

  it('reads results given as text blocks', () => {
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(resultText('plain')).toBe('plain');
    expect(resultText(42)).toBe('');
  });
});

describe('turn state', () => {
  it('is busy from the user message to the result', () => {
    let m = reduceEvent(emptyChat(), ev({ type: 'jarvis', kind: 'user_message', text: 'hi' }));
    expect(m.busy).toBe(true);
    expect(m.items[0]).toMatchObject({ kind: 'user', text: 'hi' });
    m = reduceEvent(m, ev({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
    expect(m.busy).toBe(false);
    expect(m.items).toHaveLength(1);
  });

  it('shows an error result', () => {
    const m = run([ev({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit exhausted' })]);
    expect(m.items[0]).toMatchObject({ kind: 'notice', level: 'error', text: 'Credit exhausted' });
  });

  it('shows a plain "Stopped." after the Stop button', () => {
    const m = run([ev({ type: 'result', subtype: 'error_during_execution', is_error: true, result: null })]);
    expect(m.busy).toBe(false);
    expect(m.items[0]).toMatchObject({ kind: 'notice', level: 'info', text: 'Stopped.' });
  });

  it('reports a crash during a turn and stops being busy', () => {
    const m = run([
      ev({ type: 'jarvis', kind: 'user_message', text: 'x' }),
      ev({ type: 'jarvis', kind: 'process_exit', code: 1, during_turn: true, stderr: 'not logged in' }),
    ]);
    expect(m.busy).toBe(false);
    const last = m.items[m.items.length - 1];
    expect(last).toMatchObject({ kind: 'notice', level: 'error' });
    expect(last.kind === 'notice' && last.text).toContain('not logged in');
  });

  it('stays quiet when an idle process exits cleanly', () => {
    const m = run([ev({ type: 'jarvis', kind: 'process_exit', code: 0, during_turn: false })]);
    expect(m.items).toEqual([]);
  });

  it('remembers the conversation id and model', () => {
    const m = run([ev({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-x' })]);
    expect(m.claudeSessionId).toBe('abc');
    expect(m.model).toBe('claude-x');
  });

  it('tracks the last event number even for events it ignores', () => {
    const m = run([ev({ type: 'rate_limit_event' }), ev({ type: 'whatever' })]);
    expect(m.lastSeq).toBe(seq - 1);
  });
});

describe('approvals', () => {
  const ask = (id: string) =>
    ev({ type: 'jarvis', kind: 'approval', request_id: id, tool_name: 'Bash', display_name: 'Bash', input: { command: 'rm x' } });

  it('adds, dedupes and removes approvals', () => {
    let m = reduceEvent(emptyChat(), ask('r1'));
    m = reduceEvent(m, ask('r1'));
    expect(m.approvals).toHaveLength(1);
    expect(m.approvals[0]).toMatchObject({ request_id: 'r1', tool_name: 'Bash', input: { command: 'rm x' } });
    m = reduceEvent(m, ev({ type: 'jarvis', kind: 'approval_resolved', request_id: 'r1', allow: false }));
    expect(m.approvals).toEqual([]);
  });

  it('drops pending approvals when the process dies', () => {
    const m = run([ask('r1'), ev({ type: 'jarvis', kind: 'process_exit', code: 0, during_turn: false })]);
    expect(m.approvals).toEqual([]);
  });
});

describe('replayed history', () => {
  it('rebuilds user and assistant messages from a saved conversation', () => {
    const m = run([
      ev({ type: 'user', replayed: true, message: { role: 'user', content: 'earlier question' } }),
      ev({ type: 'assistant', replayed: true, message: { id: 'h1', content: [{ type: 'text', text: 'earlier answer' }, { type: 'tool_use', id: 'tt', name: 'Read', input: { file_path: '/x' } }] } }),
      ev({ type: 'user', replayed: true, message: { content: [{ type: 'tool_result', tool_use_id: 'tt', content: 'data' }] } }),
    ]);
    expect(m.items[0]).toMatchObject({ kind: 'user', text: 'earlier question' });
    const a = m.items[1];
    expect(a.kind === 'assistant' && a.blocks[1]).toMatchObject({ kind: 'tool', name: 'Read', result: { text: 'data' } });
    expect(m.busy).toBe(false);
  });
});

describe('Jarvis tool names', () => {
  it('shortens the tool names and words the two approvals', () => {
    expect(shortToolName('mcp__jarvis__open_repo')).toBe('open_repo');
    expect(shortToolName('Bash')).toBe('Bash');
    expect(jarvisAsk('mcp__jarvis__delete_path')).toBe('move to the trash');
    expect(jarvisAsk('mcp__jarvis__create_repo')).toBe('create a new repository');
    expect(jarvisAsk('mcp__jarvis__something_else')).toBe('something_else');
    expect(jarvisAsk('Bash')).toBeNull();
  });
});

describe('what the composer bar shows', () => {
  it('keeps the commands and agents Claude Code announces at start', () => {
    const m = run([
      ev({
        type: 'system',
        subtype: 'init',
        session_id: 'c',
        model: 'claude-opus-5-5',
        slash_commands: ['compact', 'context', 7],
        agents: ['Explore', 'Plan'],
      }),
    ]);
    expect(m.commands).toEqual(['compact', 'context']);
    expect(m.agentTypes).toEqual(['Explore', 'Plan']);
    // a later init without the lists keeps what we had
    const again = reduceEvent(m, ev({ type: 'system', subtype: 'init', session_id: 'c' }));
    expect(again.commands).toEqual(['compact', 'context']);
  });

  it('counts sub-agents that are still working', () => {
    const tool = (id: string, name: string, done: boolean): Block => ({
      kind: 'tool',
      id,
      name,
      input: {},
      ...(done ? { result: { text: 'ok', isError: false } } : {}),
    });
    const m: ChatModel = {
      ...emptyChat(),
      busy: true,
      items: [{ kind: 'assistant', id: 'a', streaming: false, blocks: [tool('1', 'Task', false), tool('2', 'Agent', false), tool('3', 'Task', true), tool('4', 'Bash', false)] }],
    };
    expect(runningAgents(m)).toBe(2);
    expect(runningAgents({ ...m, busy: false })).toBe(0);
  });

  it('writes model names and durations for humans', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(prettyModel('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(prettyModel('weird-model')).toBe('weird-model');
    expect(prettyModel(null)).toBe('');
    expect(elapsedLabel(0, 45_000)).toBe('45s');
    expect(elapsedLabel(0, 59 * 60_000)).toBe('59m');
    expect(elapsedLabel(0, 65 * 60_000)).toBe('1h 05m');
    expect(elapsedLabel(10_000, 0)).toBe('0s');
  });
});
