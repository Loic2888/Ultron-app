import { describe, expect, it } from 'vitest';

import { formatReset, mergePlanUsage, parseUnifiedWindows, toneForPct } from './planUsage';

describe('parseUnifiedWindows', () => {
  it('reads both windows from a rate_limit_event', () => {
    const u = parseUnifiedWindows({
      five_hour: { utilization: 0.424, resetsAt: 1_800_000_000 },
      seven_day: { utilization: 0.09, resets_at: '2027-01-15T08:00:00Z' },
    });
    expect(u?.fiveHour).toEqual({ pct: 42.4, resetsAt: 1_800_000_000 });
    expect(u?.sevenDay?.pct).toBe(9);
    expect(u?.sevenDay?.resetsAt).toBe(Math.round(Date.parse('2027-01-15T08:00:00Z') / 1000));
  });

  it('converts milliseconds and clamps to 0..100', () => {
    const u = parseUnifiedWindows({ five_hour: { utilization: 1.4, resetsAt: 1_800_000_000_000 } });
    expect(u?.fiveHour).toEqual({ pct: 100, resetsAt: 1_800_000_000 });
  });

  it('returns null on junk or when no window is usable', () => {
    expect(parseUnifiedWindows(null)).toBeNull();
    expect(parseUnifiedWindows('x')).toBeNull();
    expect(parseUnifiedWindows({ five_hour: { utilization: 'high' } })).toBeNull();
    expect(parseUnifiedWindows({ five_hour: null })).toBeNull();
  });
});

describe('mergePlanUsage', () => {
  it('keeps the previous value of a window the event did not mention', () => {
    const prev = { fiveHour: { pct: 10, resetsAt: 1 }, sevenDay: { pct: 20, resetsAt: 2 } };
    const merged = mergePlanUsage(prev, { fiveHour: { pct: 30, resetsAt: 3 }, sevenDay: null });
    expect(merged.fiveHour?.pct).toBe(30);
    expect(merged.sevenDay?.pct).toBe(20);
  });
});

describe('toneForPct', () => {
  it('warns at 70 and alarms at 90', () => {
    expect(toneForPct(null)).toBe('accent');
    expect(toneForPct(69.9)).toBe('accent');
    expect(toneForPct(70)).toBe('amber');
    expect(toneForPct(90)).toBe('error');
  });
});

describe('formatReset', () => {
  const now = 1_000_000_000_000; // ms
  const at = (secs: number) => now / 1000 + secs;
  it('formats minutes, hours and days', () => {
    expect(formatReset(null, now)).toBe('reset time unknown');
    expect(formatReset(at(-5), now)).toBe('resetting now');
    expect(formatReset(at(25 * 60), now)).toBe('resets in 25m');
    expect(formatReset(at(2 * 3600 + 5 * 60), now)).toBe('resets in 2h 05m');
    expect(formatReset(at(3 * 86400 + 4 * 3600), now)).toBe('resets in 3d 4h');
  });
});
