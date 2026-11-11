import { useEffect, useState } from "react";

/** The current time, refreshed every `everyMs`. Keeps render pure: components read time from here, not Date.now(). */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}
