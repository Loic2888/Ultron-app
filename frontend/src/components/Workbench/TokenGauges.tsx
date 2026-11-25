import { useEffect } from 'react';

import { fetchUsage, refreshUsage } from '../../lib/journalApi';
import { formatReset, toneForPct, usageFromSaved, type PlanWindow } from '../../lib/planUsage';
import { useAppStore } from '../../lib/store';
import { MetalGauge } from '../futuristic/MetalGauge';

function Dial({ label, win }: { label: string; win: PlanWindow | null }) {
  const pct = win?.pct ?? null;
  return (
    <div
      className="pointer-events-auto"
      title={win ? `${Math.round(win.pct)}% used, ${formatReset(win.resetsAt)}` : `${label}: no data yet`}
    >
      <MetalGauge
        label={label}
        tone={toneForPct(pct)}
        value={pct ?? 0}
        max={100}
        display={pct === null ? '--' : `${Math.round(pct)}%`}
        size={104}
      />
    </div>
  );
}

/**
 * Subscription limits, floating over the chat and terminal (no background):
 * the 5-hour session and the 7-day window, as a percentage of what is used.
 */
export function TokenGauges() {
  const usage = useAppStore((s) => s.planUsage);
  // Show the usage right away: first what the server last saw, then a fresh
  // reading (one tiny request, at most every 10 minutes server-side).
  useEffect(() => {
    let alive = true;
    const apply = (saved: { windows: unknown } | null) => {
      const next = saved ? usageFromSaved(saved.windows) : null;
      if (alive && next) useAppStore.getState().setPlanUsage(next);
    };
    fetchUsage().then(apply).catch(() => undefined);
    refreshUsage().then(apply).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return (
    <aside
      className="absolute flex flex-col items-center pointer-events-none z-30"
      style={{ right: 10, top: '50%', transform: 'translateY(-50%)' }}
      aria-label="Subscription usage"
    >
      <Dial label="Session 5h" win={usage?.fiveHour ?? null} />
      <Dial label="Weekly 7d" win={usage?.sevenDay ?? null} />
    </aside>
  );
}
