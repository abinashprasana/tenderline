import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog as Primitive } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

import { Button } from "./button";

const EASE = [0.22, 1, 0.36, 1] as const;

/** A centred glass dialog. Scales in from 96% with a 200 ms ease-out; under reduced motion it just appears. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <Primitive.Portal forceMount>
            <Primitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-[oklch(0.1_0.02_230/0.55)]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: EASE }}
              />
            </Primitive.Overlay>
            <Primitive.Content asChild forceMount>
              <motion.div
                className={cn(
                  "glass fixed top-1/2 left-1/2 z-50 flex max-h-[min(90dvh,48rem)] w-[min(calc(100vw-2rem),32rem)]",
                  "flex-col overflow-hidden rounded-2xl focus:outline-none",
                  className,
                )}
                style={{ x: "-50%", y: "-50%" }}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.2, ease: EASE }}
              >
                <div className="flex items-start justify-between gap-4 px-6 pt-5">
                  <div>
                    <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
                    {description ? (
                      <Primitive.Description className="mt-1 text-sm text-muted">{description}</Primitive.Description>
                    ) : (
                      <Primitive.Description className="sr-only">{title}</Primitive.Description>
                    )}
                  </div>
                  <Primitive.Close asChild>
                    <Button variant="ghost" size="icon" aria-label="Close" className="-mt-1 -mr-2">
                      <X className="size-4" />
                    </Button>
                  </Primitive.Close>
                </div>
                <div className="overflow-y-auto px-6 py-4">{children}</div>
                {footer ? (
                  <div className="flex flex-wrap justify-end gap-2 border-t border-hairline px-6 py-4">{footer}</div>
                ) : null}
              </motion.div>
            </Primitive.Content>
          </Primitive.Portal>
        ) : null}
      </AnimatePresence>
    </Primitive.Root>
  );
}
