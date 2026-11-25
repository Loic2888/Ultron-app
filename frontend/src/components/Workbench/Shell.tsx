import { Bot, Brain, Database, Rocket, ScrollText, Settings, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { JarvisOrb } from '../futuristic/JarvisOrb';
import { FileTree } from './FileTree';
import { JarvisPanel } from './JarvisPanel';
import { useJarvisUi } from './jarvisUi';
import { RepoSwitcher } from './RepoSwitcher';
import { TokenGauges } from './TokenGauges';
import { useWorkspace } from './workspaceStore';

const NAV_TOP = [
  { path: '/workspace', icon: SquareTerminal, label: 'Workspace' },
  { path: '/data-sources', icon: Database, label: 'Integrations' },
  { path: '/agents', icon: Bot, label: 'Agents' },
  { path: '/logs', icon: ScrollText, label: 'Logs' },
  { path: '/memory', icon: Brain, label: 'Memory' },
] as const;

const NAV_BOTTOM = [
  { path: '/get-started', icon: Rocket, label: 'Get Started' },
  { path: '/settings', icon: Settings, label: 'Settings' },
] as const;

/** Vertical icon bar on the far left, like the VS Code activity bar. */
function ActivityBar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const item = (it: { path: string; icon: typeof Bot; label: string }) => (
    <button
      key={it.path}
      type="button"
      className="metal-btn activity-btn"
      aria-label={it.label}
      title={it.label}
      aria-current={pathname === it.path ? 'page' : undefined}
      onClick={() => navigate(it.path)}
    >
      <it.icon size={20} />
    </button>
  );
  return (
    <nav className="metal-panel flex flex-col items-center gap-2 py-2 shrink-0 z-10" style={{ width: 54 }} aria-label="Main">
      {NAV_TOP.map(item)}
      <div className="mt-auto flex flex-col items-center gap-2">{NAV_BOTTOM.map(item)}</div>
    </nav>
  );
}

function LeftPanel() {
  const navigate = useNavigate();
  const onWorkspace = useLocation().pathname === '/workspace';
  const repos = useWorkspace((st) => st.repos);
  const activeRepo = useWorkspace((st) => st.activeRepo);
  // Every visited repo keeps its tree mounted (hidden) to remember its open folders.
  return (
    <aside
      className="metal-panel flex flex-col shrink-0"
      style={{ width: 250 }}
      aria-label="Repositories"
      // Any click here (switch repo, open a file) brings the workspace back.
      onClickCapture={() => {
        if (!onWorkspace) navigate('/workspace');
      }}
    >
      <RepoSwitcher />
      <div className="metal-well flex-1 min-h-0 m-2 rounded-md overflow-hidden">
        {repos.length === 0 && (
          <div className="p-3 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            Open a repository to see its folders here.
          </div>
        )}
        {repos.map((r) => (
          <div key={r.path} className="h-full" style={{ display: r.path === activeRepo ? 'block' : 'none' }}>
            <FileTree repo={r.path} name={r.name} />
          </div>
        ))}
      </div>
    </aside>
  );
}


/**
 * The frame shared by every page: icon bar, open repos with their folders,
 * the floating gauges and the Ultron button. Only the centre changes.
 */
export function Shell({ children }: { children: ReactNode }) {
  const toggleJarvis = useJarvisUi((s) => s.toggle);
  return (
    <div className="dark wb-root fixed inset-0 flex overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div className="hud-backdrop" aria-hidden="true" />
      <div className="wb-titlebar" aria-hidden="true">
        Ultron
      </div>
      <ActivityBar />
      <div className="flex flex-1 min-h-0 min-w-0 relative z-[1]">
        <LeftPanel />
        {children}
      </div>
      {/* Floating over the page, no background panel. */}
      <JarvisOrb onClick={toggleJarvis} />
      <TokenGauges />
      <JarvisPanel />
    </div>
  );
}
