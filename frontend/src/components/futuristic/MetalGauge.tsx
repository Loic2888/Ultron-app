import { useId } from 'react';

/**
 * Speedometer-style gauge in a black metallic housing, framed by a symmetric
 * tribal ornament (curved flame blades). Pure SVG, with gradients and shadows
 * for a 3D, bevelled look.
 */

const CX = 100;
const CY = 100;
const SWEEP = 270; // degrees of the dial
const START = 135; // degrees, SVG convention (clockwise from +x, y down)

export type GaugeTone = 'accent' | 'amber' | 'purple' | 'success' | 'error';

const TONE_VAR: Record<GaugeTone, string> = {
  accent: 'var(--color-accent)',
  amber: 'var(--color-accent-amber)',
  purple: 'var(--color-accent-purple)',
  success: 'var(--color-success)',
  error: 'var(--color-error)',
};

/** Fraction of the dial to fill, always within [0, 1]. */
export function gaugeRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Smallest "round" scale (1, 2, 5 × 10^n) that contains the value. */
export function niceMax(value: number, floor = 1000): number {
  if (!Number.isFinite(value) || value <= floor) return floor;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const f = (n: number) => n.toFixed(2);

/** Point at radius r, angle measured clockwise from the top (0° = up). */
const pt = (r: number, fromTop: number): [number, number] => [
  CX + r * Math.sin(rad(fromTop)),
  CY - r * Math.cos(rad(fromTop)),
];
const P = (r: number, fromTop: number) => {
  const [x, y] = pt(r, fromTop);
  return `${f(x)} ${f(y)}`;
};

export interface Blade {
  /** Position on the ring, degrees clockwise from the top. */
  a: number;
  /** How far the tip sticks out of the base radius. */
  len: number;
  /** Angular width of the base, in degrees. */
  w: number;
  /** How far the tip is swept sideways (positive = clockwise), in degrees. */
  curl: number;
}

/** One curved flame blade: a crescent with a sharp, swept-back tip. */
export function bladePath(b: Blade, rBase: number): string {
  const { a, len, w, curl } = b;
  const tip = P(rBase + len, a + curl);
  const start = P(rBase - 3, a - w / 2);
  const end = P(rBase - 3, a + w / 2);
  // Leading edge bulges outward, trailing edge hugs the tip: reads as a flame.
  const c1 = P(rBase + len * 0.42, a - w * 0.75 + curl * 0.15);
  const c2 = P(rBase + len * 0.88, a + curl * 0.55);
  const c3 = P(rBase + len * 0.55, a + curl * 0.85 + w * 0.15);
  const c4 = P(rBase + len * 0.12, a + w * 0.2);
  return `M ${start} C ${c1} ${c2} ${tip} C ${c3} ${c4} ${end} Z`;
}

/** Right-hand half of the ornament; the left half is its mirror image. */
export const HALF_BLADES: readonly Blade[] = [
  { a: 10, len: 30, w: 22, curl: 26 },
  { a: 40, len: 44, w: 26, curl: 32 },
  { a: 76, len: 40, w: 26, curl: 30 },
  { a: 112, len: 34, w: 24, curl: 28 },
  { a: 146, len: 28, w: 20, curl: 22 },
  // smaller counter-curved thorns in the gaps
  { a: 25, len: 22, w: 12, curl: -22 },
  { a: 58, len: 24, w: 12, curl: -22 },
  { a: 94, len: 20, w: 11, curl: -20 },
  { a: 129, len: 18, w: 10, curl: -18 },
];

export const RING_R = 91;
export const HALF_PATH = HALF_BLADES.map((b) => bladePath(b, RING_R)).join(' ');
/** Single pointed tail at the bottom, on the axis of symmetry. */
export const TAIL_PATH = bladePath({ a: 180, len: 30, w: 30, curl: 0 }, RING_R);

/** SVG arc along the dial from the start up to `ratio` of the sweep. */
export function dialArcPath(r: number, ratio: number): string {
  const sweep = SWEEP * Math.min(1, Math.max(0, ratio));
  if (sweep <= 0) return '';
  // dial angles use the SVG convention (clockwise from +x), convert to "from top"
  const toTop = (d: number) => d + 90;
  return `M ${P(r, toTop(START))} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${P(r, toTop(START + sweep))}`;
}

const TICK_COUNT = 28;

export interface MetalGaugeProps {
  value: number;
  max: number;
  /** Text shown in the center (already formatted, e.g. "12.4K"). */
  display: string;
  label: string;
  unit?: string;
  tone?: GaugeTone;
  /** Rendered size in px, ornament included. */
  size?: number;
}

export function MetalGauge({
  value,
  max,
  display,
  label,
  unit,
  tone = 'accent',
  size = 112,
}: MetalGaugeProps) {
  const uid = useId().replace(/:/g, '');
  const ratio = gaugeRatio(value, max);
  const color = TONE_VAR[tone];
  const needleAngle = -SWEEP / 2 + SWEEP * ratio;
  const id = (name: string) => `${name}-${uid}`;
  const blade = `url(#${id('blade')})`;

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      aria-valuetext={`${display}${unit ? ` ${unit}` : ''}`}
      style={{ width: size, height: size, flex: 'none' }}
    >
      <svg viewBox="-34 -34 268 268" width={size} height={size} aria-hidden="true" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id={id('rim')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7b828d" />
            <stop offset="0.35" stopColor="#2a2d33" />
            <stop offset="0.7" stopColor="#0b0c0e" />
            <stop offset="1" stopColor="#3b3f47" />
          </linearGradient>
          <radialGradient id={id('housing')} cx="0.35" cy="0.3" r="0.9">
            <stop offset="0" stopColor="#3a3e46" />
            <stop offset="0.55" stopColor="#15171b" />
            <stop offset="1" stopColor="#050506" />
          </radialGradient>
          {/* Black metal: bright edge, deep black body. */}
          <linearGradient id={id('blade')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#434850" />
            <stop offset="0.4" stopColor="#0c0d10" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <radialGradient id={id('face')} cx="0.5" cy="0.42" r="0.65">
            <stop offset="0" stopColor="#14171c" />
            <stop offset="1" stopColor="#050607" />
          </radialGradient>
          <radialGradient id={id('hub')} cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#d5dae1" />
            <stop offset="0.5" stopColor="#5b616b" />
            <stop offset="1" stopColor="#15171b" />
          </radialGradient>
          <linearGradient id={id('glass')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <filter id={id('glow')} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id={id('drop')} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity="0.9" />
          </filter>
        </defs>

        {/* Tribal ornament: right half, mirrored left half, and a tail. */}
        <g filter={`url(#${id('drop')})`}>
          <g fill={blade} stroke="#b9c1cd" strokeOpacity="0.75" strokeWidth="1.1" strokeLinejoin="round">
            <path d={HALF_PATH} />
            <path d={HALF_PATH} transform={`translate(${CX * 2} 0) scale(-1 1)`} />
            <path d={TAIL_PATH} />
          </g>
        </g>

        {/* Housing and bevelled rim. */}
        <circle cx={CX} cy={CY} r="93" fill={`url(#${id('housing')})`} />
        <circle cx={CX} cy={CY} r="92" fill="none" stroke={`url(#${id('rim')})`} strokeWidth="3.5" />
        <circle cx={CX} cy={CY} r="88.5" fill="none" stroke="#000" strokeWidth="1.5" />

        {/* Dial face, sunken. */}
        <circle cx={CX} cy={CY} r="80" fill={`url(#${id('face')})`} />
        <circle cx={CX} cy={CY} r="80" fill="none" stroke="#000" strokeWidth="3" strokeOpacity="0.9" />

        {/* Tick marks, lit up to the current value. */}
        {Array.from({ length: TICK_COUNT + 1 }, (_, i) => {
          const t = i / TICK_COUNT;
          const fromTop = START + 90 + SWEEP * t;
          const major = i % 7 === 0;
          const [x1, y1] = pt(major ? 66 : 68.5, fromTop);
          const [x2, y2] = pt(74, fromTop);
          const lit = t <= ratio && ratio > 0;
          return (
            <line
              key={i}
              x1={f(x1)}
              y1={f(y1)}
              x2={f(x2)}
              y2={f(y2)}
              stroke={lit ? color : '#3b3f47'}
              strokeWidth={major ? 2.2 : 1.2}
              strokeLinecap="round"
              opacity={lit ? 1 : 0.8}
            />
          );
        })}

        {/* Track + value arc. */}
        <path d={dialArcPath(60, 1)} fill="none" stroke="#000" strokeWidth="9" strokeLinecap="round" />
        <path d={dialArcPath(60, 1)} fill="none" stroke="#1c1f24" strokeWidth="5.5" strokeLinecap="round" />
        {ratio > 0 && (
          <path
            d={dialArcPath(60, ratio)}
            fill="none"
            stroke={color}
            strokeWidth="5.5"
            strokeLinecap="round"
            filter={`url(#${id('glow')})`}
          />
        )}

        {/* Needle. */}
        <g
          style={{
            transform: `rotate(${needleAngle}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            transition: 'transform 600ms cubic-bezier(0.2, 0.9, 0.3, 1.1)',
          }}
        >
          <path d={`M ${CX - 3} ${CY} L ${CX} ${CY - 56} L ${CX + 3} ${CY} Z`} fill={color} filter={`url(#${id('glow')})`} />
        </g>
        <circle cx={CX} cy={CY} r="10" fill={`url(#${id('hub')})`} stroke="#000" strokeWidth="1.5" />

        {/* Readout. */}
        <text x={CX} y={CY + 38} textAnchor="middle" fontFamily="var(--font-display)" fontWeight="700" fontSize="30" fill="var(--color-text)">
          {display}
        </text>
        <text x={CX} y={CY + 57} textAnchor="middle" fontFamily="var(--font-display)" fontSize="11" letterSpacing="1.5" fill="var(--color-text-secondary)">
          {label.toUpperCase()}
        </text>

        {/* Glass reflection. */}
        <ellipse cx={CX} cy="56" rx="58" ry="30" fill={`url(#${id('glass')})`} />
      </svg>
    </div>
  );
}
