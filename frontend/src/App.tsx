import { useEffect, useState, useCallback } from 'react';
import { Navigate, Routes, Route, useLocation } from 'react-router';
import { JarvisBridge } from './components/Workbench/JarvisBridge';
import { Shell } from './components/Workbench/Shell';
import { Workbench } from './components/Workbench/Workbench';
import { ApprovalBell } from './components/ApprovalBell';
import { SettingsPage } from './pages/SettingsPage';
import { GetStartedPage } from './pages/GetStartedPage';
import { AgentsPage } from './pages/AgentsPage';
import { DataSourcesPage } from './pages/DataSourcesPage';
import { LogsPage } from './pages/LogsPage';
import { MemoryPage } from './pages/MemoryPage';
import { CommandPalette } from './components/CommandPalette';
import { SetupScreen } from './components/SetupScreen';
import { Toaster } from './components/ui/sonner';
import { useAppStore } from './lib/store';
import { fetchModels, fetchServerInfo, fetchSavings, isTauri } from './lib/api';
import { UpdateChecker } from './components/Desktop/UpdateChecker';
import { runPresence } from './lib/presence';

/** Lets the server know this window is open (a desktop-icon server stops when the last one closes). */
function AppPresence() {
  useEffect(() => {
    const ctl = new AbortController();
    void runPresence(ctl.signal);
    return () => ctl.abort();
  }, []);
  return null;
}

/**
 * Every page lives inside the same frame (see Shell). The workspace centre
 * stays mounted once opened, only hidden when you visit another page, so
 * terminals and open files are not lost when you navigate.
 */
function Pages() {
  const onWorkspace = useLocation().pathname === '/workspace';
  const [visited, setVisited] = useState(onWorkspace);
  useEffect(() => {
    if (onWorkspace) setVisited(true);
  }, [onWorkspace]);
  return (
    <Shell>
      {visited && (
        <div className="flex-1 min-w-0 min-h-0 flex" style={{ display: onWorkspace ? 'flex' : 'none' }}>
          <Workbench />
        </div>
      )}
      {!onWorkspace && (
        <main className="flex-1 min-w-0 min-h-0 flex flex-col relative">
          <div
            className="metal-well flex-1 min-h-0 m-2 ml-0 rounded-md flex flex-col overflow-hidden"
            style={{ paddingRight: 112 }} // room for the floating gauges
          >
            <Routes>
              <Route path="settings" element={<SettingsPage />} />
              <Route path="get-started" element={<GetStartedPage />} />
              <Route path="data-sources" element={<DataSourcesPage />} />
              <Route path="agents" element={<AgentsPage />} />
              <Route path="logs" element={<LogsPage />} />
              <Route path="memory" element={<MemoryPage />} />
              <Route path="*" element={<Navigate to="/workspace" replace />} />
            </Routes>
          </div>
          <div className="dark wb-root">
            <ApprovalBell className="fixed right-[118px] z-40" style={{ top: 'calc(var(--wb-top) + 8px)' }} />
          </div>
        </main>
      )}
    </Shell>
  );
}

export default function App() {
  const [setupDone, setSetupDone] = useState(!isTauri());
  const handleSetupReady = useCallback(() => {
    setSetupDone(true);
  }, []);
  const setModels = useAppStore((s) => s.setModels);
  const setModelsLoading = useAppStore((s) => s.setModelsLoading);
  const setServerInfo = useAppStore((s) => s.setServerInfo);
  const setSavings = useAppStore((s) => s.setSavings);
  const settings = useAppStore((s) => s.settings);
  const commandPaletteOpen = useAppStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);

  // Apply theme class to <html>
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    if (settings.theme === 'dark') root.classList.add('dark');
    else if (settings.theme === 'light') root.classList.add('light');
  }, [settings.theme]);

  // Sync overlay conversations into the main app
  const importOverlay = useAppStore((s) => s.importOverlayConversation);
  useEffect(() => {
    if (!isTauri()) return;
    importOverlay();
    const interval = setInterval(importOverlay, 5000);
    return () => clearInterval(interval);
  }, [importOverlay]);

  // Wait for desktop setup so a startup request cannot clear the models
  // SetupScreen loaded before handing off to chat.
  useEffect(() => {
    if (!setupDone) return;
    let cancelled = false;
    setModelsLoading(true);
    fetchModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      // Preserve models already loaded by setup if this refresh fails.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => { cancelled = true; };
  }, [setupDone, setModels, setModelsLoading]);

  // Fetch server info
  useEffect(() => {
    if (!setupDone) return;
    fetchServerInfo().then(setServerInfo).catch(() => {});
  }, [setupDone, setServerInfo]);

  // Poll local savings (display only; nothing is sent anywhere)
  useEffect(() => {
    const refresh = () =>
      fetchSavings()
        .then((data) => {
          setSavings(data);
        })
        .catch(() => {});
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSystemPanel = useAppStore((s) => s.toggleSystemPanel);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(!commandPaletteOpen);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault();
        toggleSystemPanel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, setCommandPaletteOpen, toggleSystemPanel]);


  if (!setupDone) {
    return <SetupScreen onReady={handleSetupReady} />;
  }

  return (
    <>
      <UpdateChecker />
      <AppPresence />
      <Pages />
      <JarvisBridge />
      <Toaster position="bottom-right" />
      {commandPaletteOpen && <CommandPalette />}
    </>
  );
}
