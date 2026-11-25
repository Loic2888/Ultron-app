import { describe, expect, it } from 'vitest';

import { parseOutputLine } from './terminalApi';

describe('parseOutputLine', () => {
  it('reads output and exit lines', () => {
    expect(parseOutputLine('{"seq":3,"data":"hi\\r\\n"}')).toEqual({ seq: 3, data: 'hi\r\n' });
    expect(parseOutputLine('{"exit":0}')).toEqual({ exit: 0 });
  });
  it('ignores keepalives and garbage', () => {
    expect(parseOutputLine('{"keepalive":true}')).toBeNull();
    expect(parseOutputLine('not json')).toBeNull();
    expect(parseOutputLine('{"seq":"x","data":1}')).toBeNull();
  });
});
