import { describe, expect, it } from 'vitest';

import { MAX_RATIO, MIN_RATIO, clampRatio } from './useSplit';

describe('clampRatio', () => {
  it('keeps both panes visible', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(1)).toBe(MAX_RATIO);
    expect(clampRatio(0.5)).toBe(0.5);
  });

  it('falls back on invalid values', () => {
    expect(clampRatio(Number.NaN)).toBe(0.65);
    expect(clampRatio(Number.POSITIVE_INFINITY, 0.4)).toBe(0.4);
  });
});
