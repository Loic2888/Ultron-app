import { useId } from 'react';
import { toast } from 'sonner';

import { HALF_PATH, TAIL_PATH } from './MetalGauge';

const CX = 100;

/** Four-pointed star, the "spark" at the center of the orb. */
const STAR = 'M 100 62 C 103 88 112 97 138 100 C 112 103 103 112 100 138 C 97 112 88 103 62 100 C 88 97 97 88 100 62 Z';

/**
 * Round Ultron button, same black metal and tribal ornament as the gauges.
 * Floats in the bottom-right corner of the workbench (the gauges sit top-right).
 */
export function JarvisOrb({ onClick }: { onClick?: () => void }) {
  const uid = useId().replace(/:/g, '');
  const id = (name: string) => `${name}-${uid}`;
  const size = 84;

  return (
    <button
      type="button"
      className="jarvis-orb z-30"
      style={{ right: 10, bottom: 10, width: size, height: size }}
      aria-label="Ultron assistant"
      title="Ultron assistant"
      onClick={
        onClick ??
        (() => toast.info('The Ultron assistant arrives in a later step (step 5).'))
      }
    >
      <svg viewBox="-34 -34 268 268" width={size} height={size} aria-hidden="true" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id={id('blade')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#434850" />
            <stop offset="0.4" stopColor="#0c0d10" />
            <stop offset="1" stopColor="#000" />
          </linearGradient>
          <radialGradient id={id('housing')} cx="0.35" cy="0.3" r="0.9">
            <stop offset="0" stopColor="#3a3e46" />
            <stop offset="0.55" stopColor="#15171b" />
            <stop offset="1" stopColor="#050506" />
          </radialGradient>
          <linearGradient id={id('rim')} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7b828d" />
            <stop offset="0.35" stopColor="#2a2d33" />
            <stop offset="0.7" stopColor="#0b0c0e" />
            <stop offset="1" stopColor="#3b3f47" />
          </linearGradient>
          <radialGradient id={id('face')} cx="0.5" cy="0.4" r="0.7">
            <stop offset="0" stopColor="#1a1e24" />
            <stop offset="1" stopColor="#050607" />
          </radialGradient>
          <linearGradient id={id('glass')} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <filter id={id('glow')} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g fill={`url(#${id('blade')})`} stroke="#b9c1cd" strokeOpacity="0.75" strokeWidth="1.1" strokeLinejoin="round">
          <path d={HALF_PATH} />
          <path d={HALF_PATH} transform={`translate(${CX * 2} 0) scale(-1 1)`} />
          <path d={TAIL_PATH} />
        </g>

        <circle cx={CX} cy={CX} r="93" fill={`url(#${id('housing')})`} />
        <circle cx={CX} cy={CX} r="92" fill="none" stroke={`url(#${id('rim')})`} strokeWidth="3.5" />
        <circle cx={CX} cy={CX} r="88.5" fill="none" stroke="#000" strokeWidth="1.5" />
        <circle cx={CX} cy={CX} r="80" fill={`url(#${id('face')})`} stroke="#000" strokeWidth="3" />
        {/* Glowing inner ring, the part that reacts on hover. */}
        <circle cx={CX} cy={CX} r="68" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeOpacity="0.75" filter={`url(#${id('glow')})`} />

        <path d={STAR} fill="var(--color-accent)" filter={`url(#${id('glow')})`} />
        <circle cx={CX} cy={CX} r="6" fill="#ffecec" />

        <ellipse cx={CX} cy="58" rx="56" ry="28" fill={`url(#${id('glass')})`} />
      </svg>
    </button>
  );
}
