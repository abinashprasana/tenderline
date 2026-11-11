import { motion } from "motion/react";

import { cn } from "@/lib/cn";

/** The agent's 0–100 fit score as a ring. Colour bands: 70+ strong, 40–69 possible, below 40 weak. */
export function FitRing({ score, size = 40, className }: { score: number | null | undefined; size?: number; className?: string }) {
  const value = typeof score === "number" ? Math.max(0, Math.min(100, score)) : null;
  const stroke = 3.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = value === null ? "text-faint" : value >= 70 ? "text-won" : value >= 40 ? "text-soon" : "text-lost";
  const label = value === null ? "No fit score" : `Fit score ${value} out of 100`;
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", tone, className)} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={stroke} />
        {value !== null ? (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: circumference * (1 - value / 100) }}
            transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1] }}
          />
        ) : null}
      </svg>
      <span className="tabular absolute font-mono text-[0.6875rem] font-medium text-text" aria-hidden>
        {value ?? "–"}
      </span>
    </span>
  );
}
