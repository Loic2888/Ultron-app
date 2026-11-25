import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HALF_BLADES, MetalGauge, bladePath, dialArcPath, gaugeRatio, niceMax } from './MetalGauge';

describe('gaugeRatio', () => {
  it('stays within 0..1 and survives bad input', () => {
    expect(gaugeRatio(50, 100)).toBe(0.5);
    expect(gaugeRatio(500, 100)).toBe(1);
    expect(gaugeRatio(-5, 100)).toBe(0);
    expect(gaugeRatio(10, 0)).toBe(0);
    expect(gaugeRatio(Number.NaN, 100)).toBe(0);
  });
});

describe('niceMax', () => {
  it('picks the next round scale', () => {
    expect(niceMax(0)).toBe(1000);
    expect(niceMax(1000)).toBe(1000);
    expect(niceMax(1001)).toBe(2000);
    expect(niceMax(2600)).toBe(5000);
    expect(niceMax(5001)).toBe(10000);
    expect(niceMax(7, 10)).toBe(10);
    expect(niceMax(11, 10)).toBe(20);
  });
});

describe('paths', () => {
  it('draws one closed flame per blade', () => {
    const d = bladePath(HALF_BLADES[0], 91);
    expect(d.startsWith('M ')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d).not.toContain('NaN');
  });

  it('draws no arc at zero and a large arc past half', () => {
    expect(dialArcPath(55, 0)).toBe('');
    expect(dialArcPath(55, 0.4)).toContain(' 0 0 1 ');
    expect(dialArcPath(55, 0.9)).toContain(' 0 1 1 ');
  });
});

describe('MetalGauge', () => {
  it('exposes its value to assistive tech', () => {
    const html = renderToStaticMarkup(
      <MetalGauge label="Input" unit="tokens" value={1500} max={2000} display="1.5K" />,
    );
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="1500"');
    expect(html).toContain('aria-valuemax="2000"');
    expect(html).toContain('1.5K');
  });

  it('clamps an overflowing value', () => {
    const html = renderToStaticMarkup(<MetalGauge label="x" value={9} max={5} display="9" />);
    expect(html).toContain('aria-valuenow="5"');
  });
});
