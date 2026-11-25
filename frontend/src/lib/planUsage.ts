/**
 * Claude subscription limits: the 5-hour session window and the 7-day window.
 *
 * Source: the official `claude` program reports them itself. In its
 * stream-json output, a `rate_limit_event` message carries
 * `rate_limit_info.unifiedWindows.{five_hour,seven_day}` with a utilization
 * (a 0..1 fraction) and a reset time. We only read that; no subscription token is
 * touched by this app.
 */

export interface PlanWindow {
  /** Share of the window already used, 0..100. */
  pct: number;
  /** When the window resets, epoch seconds, if known. */
  resetsAt: number | null;
}

export interface PlanUsage {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
}

function toWindow(raw: unknown): PlanWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resetsAt?: unknown; resets_at?: unknown };
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const reset = w.resetsAt ?? w.resets_at;
  let resetsAt: number | null = null;
  if (typeof reset === 'number' && Number.isFinite(reset)) {
    // epoch seconds; tolerate milliseconds
    resetsAt = reset > 1e12 ? Math.round(reset / 1000) : reset;
  } else if (typeof reset === 'string') {
    const t = Date.parse(reset);
    if (Number.isFinite(t)) resetsAt = Math.round(t / 1000);
  }
  // `claude` reports a fraction (0.03 means 3 %), observed on real events.
  return { pct: Math.min(100, Math.max(0, w.utilization * 100)), resetsAt };
}

/**
 * Turns `unifiedWindows` from a `rate_limit_event` into a PlanUsage.
 * A window missing from `raw` is left null so the caller can keep the old value.
 */
export function parseUnifiedWindows(raw: unknown): PlanUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fiveHour = toWindow(r.five_hour);
  const sevenDay = toWindow(r.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/** Keeps the last known value of a window the new event did not mention. */
export function mergePlanUsage(prev: PlanUsage | null, next: PlanUsage): PlanUsage {
  return {
    fiveHour: next.fiveHour ?? prev?.fiveHour ?? null,
    sevenDay: next.sevenDay ?? prev?.sevenDay ?? null,
  };
}

/** Gauge color: calm under 70 %, warning under 90 %, alarm above. */
export function toneForPct(pct: number | null): 'accent' | 'amber' | 'error' {
  if (pct === null) return 'accent';
  if (pct >= 90) return 'error';
  if (pct >= 70) return 'amber';
  return 'accent';
}

/** "resets in 2h 05m" / "resets in 3d 4h" / "reset time unknown". */
export function formatReset(resetsAt: number | null, nowMs = Date.now()): string {
  if (resetsAt === null) return 'reset time unknown';
  const secs = Math.round(resetsAt - nowMs / 1000);
  if (secs <= 0) return 'resetting now';
  const mins = Math.floor(secs / 60);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${String(rest).padStart(2, '0')}m`;
  return `resets in ${rest}m`;
}

/**
 * Usage saved by the server, as it was `seenAt` (epoch seconds). A window whose
 * reset time has passed started over since then, so it reads 0 % (the next
 * real event corrects it as soon as Claude Code runs).
 */
export function usageFromSaved(windows: unknown, nowMs = Date.now()): PlanUsage | null {
  const usage = parseUnifiedWindows(windows);
  if (!usage) return null;
  const fresh = (w: PlanWindow | null): PlanWindow | null =>
    w && w.resetsAt !== null && w.resetsAt * 1000 <= nowMs ? { pct: 0, resetsAt: null } : w;
  return { fiveHour: fresh(usage.fiveHour), sevenDay: fresh(usage.sevenDay) };
}
