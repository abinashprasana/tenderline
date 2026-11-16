import { Outlet, useRouter } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { Tooltip } from "radix-ui";
import { useCallback } from "react";
import { Toaster } from "sonner";

import { useSessionKeeper } from "@/auth/use-session";
import { useTheme } from "@/lib/theme";

export function RootLayout() {
  const router = useRouter();
  const theme = useTheme();
  const onEnded = useCallback(() => {
    const here = router.state.location.href;
    void router.navigate({ to: "/sign-in", search: { next: here } });
  }, [router]);
  useSessionKeeper(onEnded);

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <Tooltip.Provider delayDuration={300}>
        <Outlet />
        <Toaster
          theme={theme}
          position="bottom-right"
          offset={{ bottom: 84, right: 20 }}
          mobileOffset={{ bottom: 136 }}
          closeButton
          toastOptions={{ classNames: { toast: "glass glass-strong !rounded-xl !text-text !border-hairline" } }}
        />
      </Tooltip.Provider>
    </MotionConfig>
  );
}
