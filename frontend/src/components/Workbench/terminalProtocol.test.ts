import { describe, expect, it } from 'vitest';

import {
  buildTerminalUrl,
  describeFailure,
  inputMessage,
  openMessage,
  parseServerFrame,
  resizeMessage,
} from './terminalProtocol';

describe('buildTerminalUrl', () => {
  it('uses the page origin when no base is configured', () => {
    expect(buildTerminalUrl('', 'http://localhost:5173')).toBe('ws://localhost:5173/v1/terminal/ws');
    expect(buildTerminalUrl('', 'https://jarvis.local')).toBe('wss://jarvis.local/v1/terminal/ws');
  });

  it('uses the configured API base', () => {
    expect(buildTerminalUrl('http://127.0.0.1:8010', 'http://localhost:5173')).toBe(
      'ws://127.0.0.1:8010/v1/terminal/ws',
    );
  });

  it('never puts the token in the URL', () => {
    expect(buildTerminalUrl('', 'http://localhost:5173')).not.toContain('token');
  });
});

describe('client messages', () => {
  it('opens with token and size, cwd only when given', () => {
    expect(JSON.parse(openMessage('tok', 100, 30))).toEqual({
      type: 'open',
      token: 'tok',
      cols: 100,
      rows: 30,
    });
    expect(JSON.parse(openMessage('tok', 100, 30, '/home/x/repo')).cwd).toBe('/home/x/repo');
  });

  it('encodes input and resize', () => {
    expect(JSON.parse(inputMessage('ls\r'))).toEqual({ type: 'input', data: 'ls\r' });
    expect(JSON.parse(resizeMessage(120, 40))).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });
});

describe('parseServerFrame', () => {
  it('parses every frame type', () => {
    expect(parseServerFrame('{"type":"ready","pid":42}')).toEqual({ type: 'ready', pid: 42 });
    expect(parseServerFrame('{"type":"output","data":"hi"}')).toEqual({ type: 'output', data: 'hi' });
    expect(parseServerFrame('{"type":"exit","code":3}')).toEqual({ type: 'exit', code: 3 });
    expect(parseServerFrame('{"type":"error","message":"no"}')).toEqual({ type: 'error', message: 'no' });
  });

  it('rejects malformed or unknown frames', () => {
    expect(parseServerFrame('nope')).toBeNull();
    expect(parseServerFrame('null')).toBeNull();
    expect(parseServerFrame('{"type":"output"}')).toBeNull();
    expect(parseServerFrame('{"type":"exit","code":"3"}')).toBeNull();
    expect(parseServerFrame('{"type":"weird"}')).toBeNull();
    expect(parseServerFrame(new ArrayBuffer(2))).toBeNull();
  });
});

describe('describeFailure', () => {
  it('explains the common failures', () => {
    expect(describeFailure(403)).toMatch(/this machine/);
    expect(describeFailure(401)).toMatch(/API key/);
    expect(describeFailure(null)).toMatch(/Cannot reach/);
    expect(describeFailure(500)).toContain('500');
  });
});
