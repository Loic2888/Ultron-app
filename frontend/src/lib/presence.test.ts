import { describe, expect, it } from 'vitest';

import { runPresence, type PresenceDeps } from './presence';

const streamOf = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
        c.close();
      },
    }),
    { status: 200 },
  );

describe('presence', () => {
  it('reconnects each time the server ends the stream, until the page is gone', async () => {
    const ctl = new AbortController();
    let opens = 0;
    const waits: number[] = [];
    const deps: PresenceDeps = {
      open: async () => {
        opens += 1;
        if (opens === 3) ctl.abort();
        return streamOf(['{"hello":true}\n', '{"keepalive":true}\n']);
      },
      sleep: async (ms) => void waits.push(ms),
    };
    await runPresence(ctl.signal, deps);
    expect(opens).toBe(3);
    expect(waits).toEqual([2000, 2000, 2000]);
  });

  it('is quiet with an older server and retries after a network error', async () => {
    const ctl = new AbortController();
    const answers: Array<() => Promise<Response>> = [
      async () => new Response('nope', { status: 404 }),
      async () => {
        throw new Error('network down');
      },
      async () => {
        ctl.abort();
        return new Response('x', { status: 404 });
      },
    ];
    const waits: number[] = [];
    await runPresence(ctl.signal, {
      open: () => (answers.shift() as () => Promise<Response>)(),
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([60_000, 2000, 60_000]);
  });

  it('stops at once when aborted during a network error', async () => {
    const ctl = new AbortController();
    await runPresence(ctl.signal, {
      open: async () => {
        ctl.abort();
        throw new Error('aborted');
      },
      sleep: async () => {
        throw new Error('must not sleep');
      },
    });
  });
});
