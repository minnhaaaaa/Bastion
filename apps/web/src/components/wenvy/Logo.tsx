/**
 * Bastion adaptation of the Wenvy brand mark — an original ink ensō (open brush circle) wrapping a
 * hand-brushed "B" monogram. Single-color via `currentColor` so it adapts
 * to whatever it sits on (cream on the vermillion/ink masthead).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden="true"
    >
      <g
        stroke="currentColor"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* ensō, open at the top */}
        <path d="M45 15 A47 47 0 1 0 76 14" strokeWidth="6" />
        {/* brush overshoot where the stroke lifts off */}
        <path d="M72 10 C 84 7 92 12 98 21" strokeWidth="3.4" />
        {/* B monogram, brush strokes */}
        <path
          d="M43 40 L43 82 M43 41 C80 36 86 59 44 61 M44 61 C87 56 87 87 43 81"
          strokeWidth="7"
        />
      </g>
      {/* ink flecks near the lift-off */}
      <circle cx="101" cy="25" r="2" fill="currentColor" />
      <circle cx="105" cy="30" r="1.2" fill="currentColor" />
    </svg>
  );
}
