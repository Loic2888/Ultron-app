import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('../../lib/workspaceApi', () => {
  class WorkspaceError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { ...api, WorkspaceError };
});

import { WorkspaceError } from '../../lib/workspaceApi';
import { isDirty, useWorkspace } from './workspaceStore';

const FILE = '/home/u/a/x.ts';
const file = (content: string, mtime = '1') => ({ path: FILE, content, size: content.length, mtime });
const buf = () => useWorkspace.getState().buffers[FILE];

beforeEach(() => {
  api.readFile.mockReset();
  api.writeFile.mockReset();
  useWorkspace.setState({ buffers: {} });
});

describe('loadBuffer', () => {
  it('reads a file into a clean buffer', async () => {
    api.readFile.mockResolvedValue(file('hello'));
    await useWorkspace.getState().loadBuffer(FILE);
    expect(buf()).toMatchObject({ status: 'ready', content: 'hello', saved: 'hello', mtime: '1' });
    expect(isDirty(buf())).toBe(false);
  });

  it('records a readable error', async () => {
    api.readFile.mockRejectedValue(new WorkspaceError(415, 'Binary file'));
    await useWorkspace.getState().loadBuffer(FILE);
    expect(buf()).toMatchObject({ status: 'error', error: 'Binary file' });
  });

  it('does not read again unless asked to refresh', async () => {
    api.readFile.mockResolvedValue(file('v1'));
    await useWorkspace.getState().loadBuffer(FILE);
    await useWorkspace.getState().loadBuffer(FILE);
    expect(api.readFile).toHaveBeenCalledTimes(1);
  });

  it('refresh picks up a change made outside (a clean buffer)', async () => {
    api.readFile.mockResolvedValueOnce(file('v1', '1')).mockResolvedValueOnce(file('v2', '2'));
    await useWorkspace.getState().loadBuffer(FILE);
    await useWorkspace.getState().loadBuffer(FILE, true);
    expect(buf()).toMatchObject({ content: 'v2', saved: 'v2', mtime: '2' });
  });

  it('refresh never overwrites what the user typed', async () => {
    api.readFile.mockResolvedValueOnce(file('v1', '1')).mockResolvedValueOnce(file('v2', '2'));
    await useWorkspace.getState().loadBuffer(FILE);
    useWorkspace.getState().setContent(FILE, 'my edit');
    await useWorkspace.getState().loadBuffer(FILE, true);
    expect(buf().content).toBe('my edit');
    expect(api.readFile).toHaveBeenCalledTimes(1);
  });

  it('typing during a refresh read is kept', async () => {
    api.readFile.mockResolvedValueOnce(file('v1', '1'));
    await useWorkspace.getState().loadBuffer(FILE);
    let release!: (v: unknown) => void;
    api.readFile.mockReturnValueOnce(new Promise((r) => (release = r)));
    const pending = useWorkspace.getState().loadBuffer(FILE, true);
    useWorkspace.getState().setContent(FILE, 'typed meanwhile');
    release(file('v2', '2'));
    await pending;
    expect(buf().content).toBe('typed meanwhile');
  });

  it('a failed refresh keeps the text on screen', async () => {
    api.readFile.mockResolvedValueOnce(file('v1')).mockRejectedValueOnce(new WorkspaceError(404, 'gone'));
    await useWorkspace.getState().loadBuffer(FILE);
    await useWorkspace.getState().loadBuffer(FILE, true);
    expect(buf()).toMatchObject({ status: 'ready', content: 'v1' });
  });
});

describe('saveBuffer', () => {
  const open = async () => {
    api.readFile.mockResolvedValue(file('v1', '10'));
    await useWorkspace.getState().loadBuffer(FILE);
  };

  it('does nothing when clean', async () => {
    await open();
    expect(await useWorkspace.getState().saveBuffer(FILE)).toBe('nothing');
    expect(api.writeFile).not.toHaveBeenCalled();
  });

  it('writes with the mtime it read and becomes clean', async () => {
    await open();
    api.writeFile.mockResolvedValue({ path: FILE, size: 2, mtime: '11' });
    useWorkspace.getState().setContent(FILE, 'v2');
    expect(isDirty(buf())).toBe(true);
    expect(await useWorkspace.getState().saveBuffer(FILE)).toBe('saved');
    expect(api.writeFile).toHaveBeenCalledWith(FILE, 'v2', '10');
    expect(buf()).toMatchObject({ saved: 'v2', mtime: '11' });
    expect(isDirty(buf())).toBe(false);
  });

  it('reports a conflict and stays dirty', async () => {
    await open();
    api.writeFile.mockRejectedValue(new WorkspaceError(409, 'changed'));
    useWorkspace.getState().setContent(FILE, 'v2');
    expect(await useWorkspace.getState().saveBuffer(FILE)).toBe('conflict');
    expect(isDirty(buf())).toBe(true);
  });

  it('force skips the mtime check', async () => {
    await open();
    api.writeFile.mockResolvedValue({ path: FILE, size: 2, mtime: '12' });
    useWorkspace.getState().setContent(FILE, 'v2');
    await useWorkspace.getState().saveBuffer(FILE, true);
    expect(api.writeFile).toHaveBeenCalledWith(FILE, 'v2', undefined);
  });

  it('edits made while saving stay dirty', async () => {
    await open();
    let release!: (v: unknown) => void;
    api.writeFile.mockReturnValue(new Promise((r) => (release = r)));
    useWorkspace.getState().setContent(FILE, 'v2');
    const saving = useWorkspace.getState().saveBuffer(FILE);
    useWorkspace.getState().setContent(FILE, 'v3');
    release({ path: FILE, size: 2, mtime: '11' });
    await saving;
    expect(buf()).toMatchObject({ content: 'v3', saved: 'v2' });
    expect(isDirty(buf())).toBe(true);
  });

  it('other failures keep the buffer and show the reason', async () => {
    await open();
    api.writeFile.mockRejectedValue(new WorkspaceError(403, 'File is not writable'));
    useWorkspace.getState().setContent(FILE, 'v2');
    expect(await useWorkspace.getState().saveBuffer(FILE)).toBe('error');
    expect(buf()).toMatchObject({ content: 'v2', error: 'File is not writable' });
  });
});

describe('workspace actions', () => {
  it('opening a repo and a file updates the model', () => {
    useWorkspace.setState({ repos: [], activeRepo: null, sessions: {}, nextId: 1 });
    useWorkspace.getState().addRepo({ path: '/home/u/a', name: 'a' });
    useWorkspace.getState().openFile('/home/u/a', FILE);
    const s = useWorkspace.getState();
    expect(s.activeRepo).toBe('/home/u/a');
    expect(s.sessions['/home/u/a'].tabs[0].path).toBe(FILE);
  });

  it('dropBuffer forgets a file', async () => {
    api.readFile.mockResolvedValue(file('v1'));
    await useWorkspace.getState().loadBuffer(FILE);
    useWorkspace.getState().dropBuffer(FILE);
    expect(buf()).toBeUndefined();
  });
});
