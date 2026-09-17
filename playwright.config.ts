import { defineConfig, devices } from "@playwright/test";

/**
 * Handy's E2E suite mixes two very different surfaces:
 *
 *  - `tests/ui.spec.ts` drives the React app in real Chromium against a mocked
 *    Tauri IPC bridge (served by the `webServer` below).
 *  - `tests/cli.spec.ts`, `tests/transcription.spec.ts` and `tests/gui.spec.ts`
 *    drive the *native binary* built under `src-tauri/target/`. Those still need
 *    the web server only because the config provides one globally; they spawn
 *    the binary themselves.
 *
 * The native tests are the ones that catch machine-specific breakage (missing
 * shared libraries, unusable GPU backends, aborts during teardown), and they are
 * CPU-bound: a cold model load plus inference can take tens of seconds. Hence
 * the generous global timeout — a genuine hang is bounded by the per-command
 * timeout each test passes to `runHandy`.
 *
 * Transcription is also memory-heavy and starts a second process per run, so
 * workers are capped below the CPU count to keep runs deterministic.
 */
export default defineConfig({
  testDir: "./tests",
  // Native runs spawn a fresh process (and possibly load a model) per test;
  // running them all in parallel oversubscribes a laptop CPU and makes the
  // timings noisy. Two workers keeps the suite quick without thrashing.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  timeout: 300_000,
  reporter: process.env.CI ? ["list", ["html", { open: "never" }]] : "html",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bunx vite dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
