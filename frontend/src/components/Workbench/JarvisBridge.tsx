import { useEffect } from 'react';
import { useNavigate } from 'react-router';

import { claimCommand, sendResult, streamCommands, type ScreenCommand } from '../../lib/jarvisApi';
import { getRepo } from '../../lib/workspaceApi';
import { useClaude } from './claudeStore';
import { executeCommand, type BridgeDeps } from './jarvisBridge';
import { useWorkspace } from './workspaceStore';

const MAX_PAUSE_MS = 30_000;

/**
 * Invisible: keeps a connection to the server and carries out, on this screen,
 * what the Ultron assistant asks for. Mounted once for the whole app, so Ultron
 * works from any page. If several windows are open, only the first to claim a
 * command runs it.
 */
export function JarvisBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    const ctl = new AbortController();
    const deps: BridgeDeps = {
      workspace: () => useWorkspace.getState(),
      claude: () => useClaude.getState(),
      getRepo,
      showWorkspace: () => navigate('/workspace'),
    };

    const handle = async (cmd: ScreenCommand) => {
      try {
        const { claimed } = await claimCommand(cmd.id);
        if (!claimed) return;
        let outcome: { ok: boolean; result?: unknown; error?: string };
        try {
          outcome = { ok: true, result: await executeCommand(cmd.name, cmd.args, deps) };
        } catch (err) {
          outcome = { ok: false, error: err instanceof Error ? err.message : 'The command failed.' };
        }
        await sendResult(cmd.id, outcome);
      } catch {
        // the command expired or the server restarted: nothing to report
      }
    };

    void (async () => {
      let cursor = -1;
      let pause = 1000;
      while (!ctl.signal.aborted) {
        try {
          await streamCommands(
            cursor,
            (cmds) => {
              pause = 1000;
              for (const c of cmds) {
                cursor = Math.max(cursor, c.seq);
                void handle(c);
              }
            },
            ctl.signal,
          );
        } catch {
          // old server, restart or network error: try again, slowly
        }
        if (ctl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, pause));
        pause = Math.min(MAX_PAUSE_MS, pause * 2);
      }
    })();

    return () => ctl.abort();
  }, [navigate]);

  return null;
}
