import { describe, expect, it } from 'vitest';

import { formatStamp, repoName } from './journalApi';
import { usageFromSaved } from './planUsage';

describe('journal helpers', () => {
  it('formats a stamp as 22/11/2026 à 18h52', () => {
    expect(formatStamp(new Date(2026, 10, 22, 18, 52).getTime())).toBe('22/11/2026 à 18h52');
  });

  it('takes the last folder as the repo name', () => {
    expect(repoName('/home/u/OpenJarvis')).toBe('OpenJarvis');
    expect(repoName('/home/u/OpenJarvis/')).toBe('OpenJarvis');
  });
});

describe('usageFromSaved', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  const windows = {
    five_hour: { utilization: 0.4, resetsAt: now / 1000 + 600 },
    seven_day: { utilization: 0.2, resetsAt: now / 1000 - 10 },
  };

  it('keeps a window that has not reset yet', () => {
    expect(usageFromSaved(windows, now)?.fiveHour?.pct).toBeCloseTo(40);
  });

  it('reads 0 % once the reset time has passed', () => {
    expect(usageFromSaved(windows, now)?.sevenDay).toEqual({ pct: 0, resetsAt: null });
  });

  it('returns null when nothing usable was saved', () => {
    expect(usageFromSaved({}, now)).toBeNull();
    expect(usageFromSaved(null, now)).toBeNull();
  });
});
