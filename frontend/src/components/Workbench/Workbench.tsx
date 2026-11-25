import { lazy, Suspense, useEffect } from 'react';
import { Plus, SquareTerminal, X, FileCode2, Cpu } from 'lucide-react';
import { useClaude } from './claudeStore';
import { SplitterOrnament } from '../futuristic/SplitterOrnament';
import { TerminalView } from './TerminalView';
import { useSplit } from './useSplit';
import { type Tab, openEditorPaths } from './workspaceModel';
import { dirtyKeyOf, useWorkspace } from './workspaceStore';

// Monaco is heavy: it is only downloaded when a file is first opened.
const EditorView = lazy(() => import('./EditorView'));
const ClaudeChat = lazy(() => import('./ClaudeChat'));

function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
  dirty,
  children,
}: {
  tabs: Tab[];
  active: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  /** Tabs with unsaved changes get a dot. */
  dirty?: (tab: Tab) => boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-end gap-1 px-2 pt-1.5 shrink-0 relative" style={{ background: '#050506' }}>
      <div role="tablist" className="flex items-end gap-1 min-w-0 overflow-x-auto">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            tabIndex={0}
            aria-selected={t.id === active}
            className="metal-tab"
            onClick={() => onSelect(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(t.id);
              }
            }}
          >
            {t.kind === 'editor' && <FileCode2 size={12} />}
            {t.kind === 'claude' && <Cpu size={12} />}
            {t.kind === 'terminal' && <SquareTerminal size={12} />}
            {t.title}
            {dirty?.(t) && (
              <span aria-label="Unsaved changes" style={{ color: 'var(--color-warning, #f59e0b)' }}>
                ●
              </span>
            )}
            <button
              type="button"
              aria-label={`Close ${t.title}`}
              className="opacity-60 hover:opacity-100 cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-6">
      <div className="metal-title text-xs">{title}</div>
      <div className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
        {text}
      </div>
    </div>
  );
}

/** The centre of the workspace page: chats and files on top, terminals below. */
export function Workbench() {
  const split = useSplit('openjarvis.workbench.split', 0.65);
  // Narrow selectors: typing in the editor changes `buffers` on every key and
  // must not redraw the whole workbench (terminals included).
  const repos = useWorkspace((s) => s.repos);
  const activeRepo = useWorkspace((s) => s.activeRepo);
  const sessions = useWorkspace((s) => s.sessions);
  const dirtyKey = useWorkspace((s) => dirtyKeyOf(s.buffers));
  const dirtyPaths = new Set(dirtyKey ? dirtyKey.split('\n') : []);
  const state = useWorkspace.getState();
  const session = activeRepo ? sessions[activeRepo] : undefined;
  const activeTab = session?.tabs.find((t) => t.id === session.activeTab);

  // A repo opens with one terminal, like a VS Code window does.
  useEffect(() => {
    if (activeRepo) state.ensureTerminal(activeRepo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepo]);

  // Leaving with unsaved edits asks first.
  const anyDirty = dirtyKey !== '';
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyDirty]);

  const tabDirty = (t: Tab) => t.kind === 'editor' && !!t.path && dirtyPaths.has(t.path);

  const closeEditorTab = (id: number) => {
    if (!activeRepo || !session) return;
    const tab = session.tabs.find((t) => t.id === id);
    if (tab?.kind === 'editor' && tab.path) {
      if (tabDirty(tab) && !window.confirm(`${tab.title} has unsaved changes. Close it and lose them?`)) return;
      // Forget the text only if no other repo has the same file open.
      const stillOpen = openEditorPaths(useWorkspace.getState()).filter((p) => p === tab.path).length > 1;
      if (!stillOpen) state.dropBuffer(tab.path);
    }
    if (tab?.kind === 'claude' && tab.chat) {
      const chat = useClaude.getState().chats[tab.chat];
      if (
        chat?.model.busy &&
        !window.confirm(`${tab.title} is still working. Close it and stop Claude?`)
      ) {
        return;
      }
      void useClaude.getState().close(tab.chat);
    }
    state.closeTab(activeRepo, id);
  };

  return (
    <>
        <main ref={split.containerRef} className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Top: Claude Code chats and editors of the active repo */}
          <section className="flex flex-col min-h-0" style={{ flex: `${split.ratio} 1 0%` }} aria-label="Editor area">
            <TabStrip
              tabs={session?.tabs ?? []}
              active={session?.activeTab ?? null}
              onSelect={(id) => activeRepo && state.selectTab(activeRepo, id)}
              onClose={closeEditorTab}
              dirty={tabDirty}
            >
              <button
                type="button"
                className="metal-btn ml-1 mb-1"
                style={{ padding: '0.15rem 0.4rem' }}
                aria-label="New Claude Code"
                title="New Claude Code chat"
                disabled={!activeRepo}
                onClick={() => activeRepo && state.addClaudeTab(activeRepo)}
              >
                <Plus size={14} />
              </button>
            </TabStrip>
            <div className="metal-well flex-1 min-h-0">
              {activeRepo && activeTab?.kind === 'editor' && activeTab.path ? (
                <Suspense fallback={<Placeholder title="Editor" text="Starting the editor…" />}>
                  <EditorView path={activeTab.path} repoPath={activeRepo} openPaths={openEditorPaths(useWorkspace.getState())} />
                </Suspense>
              ) : activeRepo && activeTab?.kind === 'claude' && activeTab.chat ? (
                <Suspense fallback={<Placeholder title={activeTab.title} text="Starting Claude Code…" />}>
                  <ClaudeChat key={activeTab.chat} chatKey={activeTab.chat} cwd={activeRepo} />
                </Suspense>
              ) : activeRepo ? (
                <Placeholder
                  title={repos.find((r) => r.path === activeRepo)?.name ?? 'Workspace'}
                  text="Click a file in the tree to open it, or press + for a Claude Code chat."
                />
              ) : (
                <Placeholder title="Workspace" text="Open a repository from the top of the left column." />
              )}
            </div>
          </section>

          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize terminal"
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(split.ratio * 100)}
            tabIndex={0}
            className="metal-splitter"
            data-dragging={split.dragging}
            {...split.handleProps}
          >
            <SplitterOrnament />
          </div>

          {/* Bottom: terminals of the active repo */}
          <section className="flex flex-col min-h-0" style={{ flex: `${1 - split.ratio} 1 0%` }} aria-label="Terminals">
            <TabStrip
              tabs={session?.terms ?? []}
              active={session?.activeTerm ?? null}
              onSelect={(id) => activeRepo && state.selectTerminal(activeRepo, id)}
              onClose={(id) => activeRepo && state.closeTerminal(activeRepo, id)}
            >
              <button
                type="button"
                className="metal-btn ml-1 mb-1"
                style={{ padding: '0.15rem 0.4rem' }}
                aria-label="New terminal"
                disabled={!activeRepo}
                onClick={() => activeRepo && state.addTerminal(activeRepo)}
              >
                <Plus size={14} />
              </button>
            </TabStrip>
            <div className="metal-well flex-1 min-h-0">
              {!activeRepo && <Placeholder title="Terminal" text="Open a repository to start a terminal in it." />}
              {activeRepo && session?.terms.length === 0 && (
                <Placeholder title="Terminal" text="Press + to open a terminal." />
              )}
              {/* Every terminal of every repo stays mounted (hidden): shells keep running. */}
              {repos.flatMap((r) =>
                (sessions[r.path]?.terms ?? []).map((t) => {
                  const visible = r.path === activeRepo && t.id === sessions[r.path].activeTerm;
                  return (
                    <div key={t.id} className="h-full" style={{ display: visible ? 'block' : 'none' }}>
                      <TerminalView active={visible} cwd={r.path} />
                    </div>
                  );
                }),
              )}
            </div>
          </section>
        </main>
    </>
  );
}
