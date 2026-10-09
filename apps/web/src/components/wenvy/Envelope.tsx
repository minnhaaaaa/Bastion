import { motion, useReducedMotion } from "framer-motion";

const ring = (delay: number, reduced: boolean) => ({
  initial: reduced ? (false as const) : { opacity: 0, scale: 0.85 },
  whileInView: { opacity: 1, scale: 1 },
  viewport: { once: true, amount: 0.5 },
  transition: {
    duration: reduced ? 0 : 0.7,
    ease: [0.16, 1, 0.3, 1] as const,
    delay,
  },
});

/** Adapted from Wenvy: mediated inputs, handoffs and tool authorization. */
export function Envelope() {
  const reduced = !!useReducedMotion();
  return (
    <figure
      className="envelope"
      aria-label="Bastion execution boundary diagram"
    >
      <svg viewBox="0 0 360 360" role="img">
        <motion.g className="env-ring" {...ring(0, reduced)}>
          <rect x="14" y="14" width="332" height="332" rx="20" />
          <text x="30" y="40">
            source input
          </text>
        </motion.g>
        <motion.g className="env-ring" {...ring(0.12, reduced)}>
          <rect x="56" y="56" width="248" height="248" rx="16" />
          <text x="72" y="82">
            artifact handoff
          </text>
        </motion.g>
        <motion.g className="env-ring" {...ring(0.24, reduced)}>
          <rect x="98" y="98" width="164" height="164" rx="12" />
          <text x="114" y="124">
            policy gate
          </text>
        </motion.g>
        <motion.g className="env-core" {...ring(0.36, reduced)}>
          <rect x="138" y="150" width="84" height="60" rx="8" />
          <text x="180" y="184" textAnchor="middle">
            tool action
          </text>
        </motion.g>
        <text className="env-foot" x="180" y="338" textAnchor="middle">
          authorize before execution
        </text>
      </svg>
    </figure>
  );
}
