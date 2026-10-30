// The login panel's illustration: a gantry crane over a stack of shipping
// containers, in the palette's container colours. Decorative only.

const STACKS: { x: number; tone: string; rows: number }[] = [
  { x: 40, tone: "var(--rust)", rows: 3 },
  { x: 120, tone: "var(--harbor)", rows: 2 },
  { x: 200, tone: "var(--sea)", rows: 4 },
  { x: 280, tone: "var(--steel)", rows: 1 },
  { x: 360, tone: "var(--crane)", rows: 2 },
]
const BOX_W = 72
const BOX_H = 30
const GROUND = 300

export function ContainerYard({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 320" className={className} aria-hidden role="presentation">
      <defs>
        {/* Corrugated container wall: darker vertical ribs. */}
        <pattern id="ribs" width="6" height="30" patternUnits="userSpaceOnUse">
          <rect x="4" width="1.5" height="30" fill="black" opacity="0.22" />
        </pattern>
      </defs>
      {STACKS.flatMap((s, i) =>
        Array.from({ length: s.rows }, (_, r) => {
          const y = GROUND - (r + 1) * (BOX_H + 3)
          // Alternate the shade a little so a stack doesn't read as one block.
          const shade = (i + r) % 2 ? 0.82 : 1
          return (
            <g key={`${i}-${r}`} opacity={shade}>
              <rect x={s.x} y={y} width={BOX_W} height={BOX_H} rx="2" fill={s.tone} />
              <rect x={s.x} y={y} width={BOX_W} height={BOX_H} rx="2" fill="url(#ribs)" />
              <rect x={s.x + BOX_W - 10} y={y + 6} width="4" height={BOX_H - 12} rx="1" fill="black" opacity="0.25" />
            </g>
          )
        })
      )}
      {/* The gantry: two legs and a beam, with a trolley lowering a box. */}
      <g fill="var(--crane)">
        <rect x="22" y="40" width="10" height="262" rx="2" />
        <rect x="448" y="40" width="10" height="262" rx="2" />
        <rect x="14" y="30" width="452" height="14" rx="3" />
        <rect x="236" y="44" width="40" height="12" rx="2" />
      </g>
      <rect x="255" y="56" width="2" height="54" fill="var(--crane)" opacity="0.8" />
      <g opacity="0.95">
        <rect x="220" y="110" width={BOX_W} height={BOX_H} rx="2" fill="var(--harbor)" />
        <rect x="220" y="110" width={BOX_W} height={BOX_H} rx="2" fill="url(#ribs)" />
      </g>
      <rect x="0" y={GROUND + 2} width="480" height="3" fill="white" opacity="0.12" />
    </svg>
  )
}
