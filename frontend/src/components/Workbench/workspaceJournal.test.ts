import { beforeEach, describe, expect, it, vi } from 'vitest';

const journal = vi.hoisted(() => ({ logAction: vi.fn() }));
vi.mock('../../lib/journalApi', () => ({ ...journal, repoName: (p: string) => p.split('/').pop() }));
vi.mock('../../lib/workspaceApi', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  WorkspaceError: class extends Error {},
}));

import { useWorkspace } from './workspaceStore';

const A = { path: '/home/u/A', name: 'A' };
const B = { path: '/home/u/B', name: 'B' };

beforeEach(() => {
  useWorkspace.setState({ repos: [], activeRepo: null, sessions: {} });
  journal.logAction.mockReset();
});

describe('journal of repo actions', () => {
  it('logs opening, switching and closing a repo', () => {
    useWorkspace.getState().addRepo(A);
    expect(journal.logAction).toHaveBeenCalledWith('repo', 'Ouverture repo A.', A.path);
    useWorkspace.getState().addRepo(B);
    useWorkspace.getState().selectRepo(A.path);
    expect(journal.logAction).toHaveBeenCalledWith('repo', 'Changement de repo vers A.', A.path);
    useWorkspace.getState().removeRepo(B.path);
    expect(journal.logAction).toHaveBeenCalledWith('repo', 'Fermeture repo B.', B.path);
  });

  it('does not log a tab or terminal change', () => {
    useWorkspace.setState({ repos: [A], activeRepo: A.path });
    journal.logAction.mockReset();
    useWorkspace.getState().ensureTerminal(A.path);
    expect(journal.logAction).not.toHaveBeenCalled();
  });
});
