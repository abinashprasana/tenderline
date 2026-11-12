import type { ReactNode } from "react";

import { GLOSSARY, type GlossaryKey } from "@/lib/labels";

import { Tooltip } from "./ui/states";

/** A word with a dotted underline; hover or focus explains it in one line. */
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  return (
    <Tooltip label={GLOSSARY[k]}>
      <span tabIndex={0} className="cursor-help rounded-sm underline decoration-faint decoration-dotted underline-offset-[3px]">
        {children}
      </span>
    </Tooltip>
  );
}
