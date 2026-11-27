import { describe, expect, it } from 'vitest';

import {
  tabLabel,
  addClaudeTab,
  addRepo,
  addTerminal,
  basename,
  closeTab,
  closeTerminal,
  ensureTerminal,
  fromPersisted,
  initialState,
  openEditorPaths,
  openFile,
  removeRepo,
  selectRepo,
  selectTab,
  toPersisted,
} from './workspaceModel';

const A = { path: '/home/u/a', name: 'a' };
const B = { path: '/home/u/b', name: 'b' };
const two = () => addRepo(addRepo(initialState(), A), B);

describe('repos', () => {
  it('adds and activates', () => {
    const s = two();
    expect(s.repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect(s.activeRepo).toBe(B.path);
    expect(Object.keys(s.sessions)).toEqual([A.path, B.path]);
  });

  it('shows a folder name when the saved name is a path', () => {
    const s = addRepo(initialState(), { path: '/home/u/Projects/erp', name: '/home/u/Projects/erp' });
    expect(s.repos[0].name).toBe('erp');
  });

  it('re-adding only activates', () => {
    const s = addRepo(two(), A);
    expect(s.repos).toHaveLength(2);
    expect(s.activeRepo).toBe(A.path);
  });

  it('selects only known repos', () => {
    expect(selectRepo(two(), A.path).activeRepo).toBe(A.path);
    expect(selectRepo(two(), '/nope').activeRepo).toBe(B.path);
  });

  it('removing the active repo activates a neighbour and drops its session', () => {
    const s = removeRepo(two(), B.path);
    expect(s.activeRepo).toBe(A.path);
    expect(s.sessions[B.path]).toBeUndefined();
    expect(removeRepo(s, A.path).activeRepo).toBeNull();
  });

  it('removing another repo keeps the active one', () => {
    expect(removeRepo(two(), A.path).activeRepo).toBe(B.path);
  });
});

describe('editor and claude tabs are per repo', () => {
  it('opens a file once and re-activates it', () => {
    let s = openFile(two(), A.path, '/home/u/a/x.ts');
    s = openFile(s, A.path, '/home/u/a/y.ts');
    s = openFile(s, A.path, '/home/u/a/x.ts');
    const tabs = s.sessions[A.path].tabs;
    expect(tabs.map((t) => t.title)).toEqual(['x.ts', 'y.ts']);
    expect(s.sessions[A.path].activeTab).toBe(tabs[0].id);
    expect(s.sessions[B.path].tabs).toEqual([]);
  });

  it('the same file in two repos is two tabs', () => {
    let s = openFile(two(), A.path, '/home/u/shared.ts');
    s = openFile(s, B.path, '/home/u/shared.ts');
    expect(openEditorPaths(s)).toEqual(['/home/u/shared.ts', '/home/u/shared.ts']);
  });

  it('numbers Claude tabs per repo', () => {
    let s = addClaudeTab(two(), A.path);
    s = addClaudeTab(s, A.path);
    s = addClaudeTab(s, B.path);
    expect(s.sessions[A.path].tabs.map((t) => t.title)).toEqual(['Claude Code 1', 'Claude Code 2']);
    expect(s.sessions[B.path].tabs.map((t) => t.title)).toEqual(['Claude Code 1']);
  });

  it('ids are unique across everything', () => {
    let s = openFile(two(), A.path, '/home/u/a/x.ts');
    s = addClaudeTab(s, A.path);
    s = addTerminal(s, B.path);
    const ids = [
      ...s.sessions[A.path].tabs.map((t) => t.id),
      ...s.sessions[B.path].terms.map((t) => t.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('closing the active tab activates its neighbour, closing the last leaves none', () => {
    let s = openFile(openFile(openFile(two(), A.path, '/a/1'), A.path, '/a/2'), A.path, '/a/3');
    const [t1, t2, t3] = s.sessions[A.path].tabs;
    s = selectTab(s, A.path, t2.id);
    s = closeTab(s, A.path, t2.id);
    expect(s.sessions[A.path].activeTab).toBe(t3.id);
    s = closeTab(s, A.path, t3.id);
    expect(s.sessions[A.path].activeTab).toBe(t1.id);
    s = closeTab(s, A.path, t1.id);
    expect(s.sessions[A.path].activeTab).toBeNull();
  });

  it('closing a background tab keeps the active one', () => {
    let s = openFile(openFile(two(), A.path, '/a/1'), A.path, '/a/2');
    const [t1, t2] = s.sessions[A.path].tabs;
    s = closeTab(s, A.path, t1.id);
    expect(s.sessions[A.path].activeTab).toBe(t2.id);
  });

  it('unknown repo or tab changes nothing', () => {
    const s = two();
    expect(openFile(s, '/nope', '/x')).toBe(s);
    expect(addClaudeTab(s, '/nope')).toBe(s);
  });
});

describe('terminals are per repo', () => {
  it('opens the first terminal once only', () => {
    let s = ensureTerminal(two(), A.path);
    expect(s.sessions[A.path].terms.map((t) => t.title)).toEqual(['Terminal 1']);
    s = closeTerminal(s, A.path, s.sessions[A.path].terms[0].id);
    s = ensureTerminal(s, A.path); // user closed it on purpose: do not respawn
    expect(s.sessions[A.path].terms).toEqual([]);
  });

  it('each repo has its own terminals and numbering', () => {
    let s = ensureTerminal(two(), A.path);
    s = addTerminal(s, A.path);
    s = ensureTerminal(s, B.path);
    expect(s.sessions[A.path].terms.map((t) => t.title)).toEqual(['Terminal 1', 'Terminal 2']);
    expect(s.sessions[B.path].terms.map((t) => t.title)).toEqual(['Terminal 1']);
  });
});

describe('persistence', () => {
  it('keeps repos, open files and Claude chats, drops terminals', () => {
    let s = openFile(two(), A.path, '/home/u/a/x.ts');
    s = addClaudeTab(s, A.path, 'chat-1');
    s = ensureTerminal(s, A.path);
    const back = fromPersisted(JSON.parse(JSON.stringify(toPersisted(s))));
    expect(back.repos).toEqual(s.repos);
    expect(back.activeRepo).toBe(s.activeRepo);
    expect(back.sessions[A.path].tabs.map((t) => t.title)).toEqual(['x.ts', 'Claude Code 1']);
    expect(back.sessions[A.path].tabs[1].chat).toBe('chat-1');
    expect(back.sessions[A.path].claudeCounter).toBe(1);
    expect(back.sessions[A.path].terms).toEqual([]);
    expect(back.sessions[A.path].termsStarted).toBe(false);
  });

  it('numbers new Claude tabs after the restored ones and never reuses ids', () => {
    let s = addClaudeTab(addClaudeTab(two(), A.path, 'a'), A.path, 'b');
    const back = fromPersisted(JSON.parse(JSON.stringify(toPersisted(s))));
    s = addClaudeTab(back, A.path, 'c');
    const tabs = s.sessions[A.path].tabs;
    expect(tabs.map((t) => t.title)).toEqual(['Claude Code 1', 'Claude Code 2', 'Claude Code 3']);
    expect(new Set(tabs.map((t) => t.id)).size).toBe(3);
  });

  it('ignores stored Claude tabs without a usable chat key, or duplicated', () => {
    const raw = {
      version: 1,
      repos: [A],
      activeRepo: A.path,
      sessions: {
        [A.path]: {
          tabs: [
            { id: 1, kind: 'claude', title: 'x' },
            { id: 2, kind: 'claude', title: 'y', chat: '' },
            { id: 3, kind: 'claude', title: 'ok', chat: 'k' },
            { id: 4, kind: 'claude', title: 'dup', chat: 'k' },
          ],
          activeTab: 3,
        },
      },
    };
    const back = fromPersisted(raw);
    expect(back.sessions[A.path].tabs.map((t) => t.chat)).toEqual(['k']);
  });

  it('new ids never collide with restored ones', () => {
    const s = openFile(openFile(two(), A.path, '/a/1'), A.path, '/a/2');
    const back = fromPersisted(JSON.parse(JSON.stringify(toPersisted(s))));
    const restoredIds = back.sessions[A.path].tabs.map((t) => t.id);
    const next = addTerminal(back, A.path);
    expect(restoredIds).not.toContain(next.sessions[A.path].terms[0].id);
  });

  it.each([null, 'x', 42, [], {}, { version: 2, repos: [] }, { version: 1, repos: 'no' }])(
    'garbage %j gives an empty state',
    (raw) => {
      expect(fromPersisted(raw)).toEqual(initialState());
    },
  );

  it('skips malformed entries but keeps valid ones', () => {
    const raw = {
      version: 1,
      repos: [{ path: 'relative', name: 'r' }, { path: '/ok', name: 'ok' }, 7],
      activeRepo: '/missing',
      sessions: {
        '/ok': {
          tabs: [
            { id: 1, kind: 'editor', path: '/ok/a.ts' },
            { id: 1, kind: 'editor', path: '/ok/dup-id.ts' },
            { id: 2, kind: 'editor', path: 'relative.ts' },
            { id: 3, kind: 'terminal', path: '/ok/t' },
            { id: 4, kind: 'editor', path: '/ok/b.ts' },
          ],
          activeTab: 999,
        },
      },
    };
    const s = fromPersisted(raw);
    expect(s.repos).toEqual([{ path: '/ok', name: 'ok' }]);
    expect(s.activeRepo).toBe('/ok');
    expect(s.sessions['/ok'].tabs.map((t) => t.path)).toEqual(['/ok/a.ts', '/ok/b.ts']);
    expect(s.sessions['/ok'].activeTab).toBe(4);
  });
});

describe('basename', () => {
  it('handles the usual cases', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts');
    expect(basename('/a/b/')).toBe('b');
    expect(basename('/')).toBe('/');
  });
});

describe('tabLabel', () => {
  const claude = (id: number, title: string) => ({ id, kind: 'claude' as const, title, chat: `c${id}` });
  const term = { id: 9, kind: 'terminal' as const, title: 'Terminal 3' };

  it('hides the number of a Claude Code window that is alone', () => {
    const tabs = [claude(1, 'Claude Code 2'), term];
    expect(tabLabel(tabs[0], tabs)).toBe('Claude Code');
  });

  it('keeps the numbers when several Claude Code windows are open', () => {
    const tabs = [claude(1, 'Claude Code 2'), claude(2, 'Claude Code 3')];
    expect(tabLabel(tabs[0], tabs)).toBe('Claude Code 2');
    expect(tabLabel(tabs[1], tabs)).toBe('Claude Code 3');
  });

  it('leaves terminals and editors alone', () => {
    expect(tabLabel(term, [term])).toBe('Terminal 3');
  });
});
