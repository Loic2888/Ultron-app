/**
 * Tribal ornament for the draggable divider: curved blades sweeping out from a
 * central gem, mirrored left and right. Pure SVG; the gem lights up through the
 * `.metal-splitter` styles (hover, focus, drag).
 */
const BLADES = [
  // [path of the upper blade] — the lower one is its mirror image.
  'M118 7 C126 0.5 144 -0.5 170 1.5 C150 3.5 136 5.5 118 7 Z',
  'M176 7 C182 3 194 1.8 210 3.6 C197 4.8 185 6.3 176 7 Z',
  'M214 7 C218 5 224 4.4 232 5.2 C225 5.8 219 6.5 214 7 Z',
];

export function SplitterOrnament() {
  const side = (
    <g fill="url(#splitter-steel)" stroke="#7a828e" strokeOpacity="0.85" strokeWidth="0.45" strokeLinejoin="round">
      {BLADES.map((d) => (
        <g key={d}>
          <path d={d} />
          <path d={d} transform="translate(0 14) scale(1 -1)" />
        </g>
      ))}
    </g>
  );
  return (
    <svg
      className="metal-splitter-art"
      viewBox="0 0 244 14"
      width="244"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="splitter-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a4e56" />
          <stop offset="0.5" stopColor="#15171a" />
          <stop offset="1" stopColor="#050506" />
        </linearGradient>
        <radialGradient id="splitter-gem" cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="0.35" stopColor="currentColor" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
      </defs>
      {/* right side, then the same shape mirrored around the centre (x = 122) */}
      <g transform="translate(5 0)">{side}</g>
      <g transform="translate(239 0) scale(-1 1)">{side}</g>
      {/* centre medallion */}
      <g transform="translate(5 0)">
        <polygon points="117,0.5 128,7 117,13.5 106,7" fill="#0b0c0e" stroke="#8a919c" strokeWidth="0.7" />
        <polygon points="117,3 124,7 117,11 110,7" fill="#26292f" stroke="#000" strokeWidth="0.6" />
        <circle className="metal-splitter-gem" cx="117" cy="7" r="2.6" fill="url(#splitter-gem)" stroke="#000" strokeWidth="0.5" />
      </g>
    </svg>
  );
}
