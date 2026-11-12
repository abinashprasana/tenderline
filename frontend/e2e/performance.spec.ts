import { expect, test } from "@playwright/test";

/**
 * Budgets from docs/adr/0006: LCP under 2.5 s, CLS under 0.1, initial JavaScript under 250 KB compressed.
 * Run against the production build (the web image on :8080), not the Vite dev server:
 * `E2E_BASE_URL=http://localhost:8080 npx playwright test performance`.
 */
test("landing page stays inside its performance budget", async ({ page, baseURL }) => {
  test.skip(baseURL?.includes(":5173") ?? false, "budgets apply to the production build");
  const scripts: { url: string; bytes: number }[] = [];
  page.on("response", async (response) => {
    if (response.request().resourceType() === "script") {
      const size = (await response.request().sizes()).responseBodySize;
      scripts.push({ url: response.url(), bytes: size });
    }
  });
  await page.goto("/", { waitUntil: "load" });
  const metrics = await page.evaluate(
    () =>
      new Promise<{ lcp: number; cls: number }>((resolve) => {
        let lcp = 0;
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) lcp = entry.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
        }).observe({ type: "layout-shift", buffered: true });
        setTimeout(() => resolve({ lcp, cls }), 2500);
      }),
  );
  const initialJs = scripts.reduce((sum, s) => sum + s.bytes, 0);
  console.log(`LCP ${Math.round(metrics.lcp)} ms, CLS ${metrics.cls.toFixed(3)}, JS ${(initialJs / 1024).toFixed(0)} KB over ${scripts.length} files`);
  expect(metrics.lcp).toBeLessThan(2500);
  expect(metrics.cls).toBeLessThan(0.1);
  expect(initialJs).toBeLessThan(250 * 1024);
});
