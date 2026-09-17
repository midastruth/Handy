/**
 * E2E: the GUI binary's real process behaviour.
 *
 * These tests start the actual Tauri window (not the mocked webview) and check
 * the lifecycle contracts that matter for daily use on a desktop:
 *
 *  - it reaches a running state instead of exiting immediately,
 *  - a second launch forwards to the first via `tauri_plugin_single_instance`
 *    rather than starting a rival process,
 *  - it shuts down on SIGTERM without the ggml teardown abort.
 *
 * The window is never `show()`n: the app starts hidden by default, so no
 * focus-stealing window appears while the suite runs.
 */

import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  findBinary,
  headlessEnv,
  TRANSCRIBE_LIBS,
  waitFor,
  waitForSingleInstanceName,
} from "./helpers/app-harness";

test.setTimeout(180_000);

/**
 * Whether a display is available for GTK to initialise.
 *
 * `headlessEnv()` fills in a Wayland socket when the caller has none, so probe
 * the *resolved* environment rather than `process.env` — otherwise a test run
 * from a bare shell would skip every GUI test on a machine that can support them.
 */
function hasDisplay(): boolean {
  const env = headlessEnv();
  return !!(env.WAYLAND_DISPLAY || env.DISPLAY);
}

/** Start the GUI and resolve once it looks alive, or reject on early exit. */
async function startGui(
  args: string[] = [],
): Promise<{ child: ChildProcess; stderr: () => string }> {
  const child = spawn(findBinary(), args, {
    env: headlessEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const earlyExit = new Promise<"exited">((resolve) =>
    child.once("exit", () => resolve("exited")),
  );
  const alive = waitFor(() => child.exitCode === null, {
    timeoutMs: 30_000,
    description: "handy GUI process to stay alive",
  }).then(() => "alive" as const);

  const outcome = await Promise.race([alive, earlyExit]);
  if (outcome === "exited") {
    throw new Error(
      `handy exited during startup (code ${child.exitCode}). stderr:\n${stderr}`,
    );
  }
  return { child, stderr: () => stderr };
}

/** Stop a GUI process, escalating to SIGKILL if it does not leave promptly. */
async function stopGui(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );

  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 20_000),
    ),
  ]);

  if (result === "timeout") {
    child.kill("SIGKILL");
    await exited;
    throw new Error("handy did not exit within 20s of SIGTERM");
  }
  return result;
}

test.describe("GUI lifecycle", () => {
  test.skip(
    () => !hasDisplay(),
    "no Wayland/X display available for GTK to initialise",
  );

  test("starts, stays alive, and does not crash", async () => {
    const { child, stderr } = await startGui(["--start-hidden", "--no-tray"]);

    try {
      expect(child.exitCode, `stderr:\n${stderr()}`).toBeNull();

      const result = await stopGui(child);

      // Handy installs no SIGTERM handler, so an external SIGTERM terminates the
      // process directly — that is expected and is not a failure. What must
      // *never* happen is a crash signal, which is how the broken ggml Vulkan
      // teardown surfaces (SIGABRT on a host whose GPU device is unusable).
      const crashSignals = ["SIGABRT", "SIGSEGV", "SIGILL", "SIGBUS", "SIGFPE"];
      expect(
        crashSignals,
        `handy died on ${result.signal} — a crash, not a clean shutdown.\nstderr tail:\n${stderr()
          .split("\n")
          .slice(-20)
          .join("\n")}`,
      ).not.toContain(result.signal);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });

  test("a second launch forwards to the running instance and exits", async () => {
    const { child } = await startGui(["--start-hidden", "--no-tray"]);

    try {
      // Launching again without remote-control flags must not create a rival
      // process: `tauri_plugin_single_instance` hands the args to the first
      // instance and the newcomer exits on its own.
      //
      // This only works once the first instance has claimed its session-bus
      // name; before that a second launch is just another cold start. Without
      // this wait the test races the first instance's startup and reports a
      // passing forward as a hang.
      const ready = await waitForSingleInstanceName();
      test.skip(
        !ready,
        "no session D-Bus (com.pais.handy.SingleInstance never claimed)",
      );

      const second = spawn(findBinary(), [], {
        env: headlessEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Attach the listener *before* awaiting: the forward-and-exit path is
      // quick, so a late `once("exit")` can miss the event entirely.
      const secondExited = new Promise<"exited">((resolve) =>
        second.once("exit", () => resolve("exited")),
      );

      const outcome = await Promise.race([
        secondExited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 30_000),
        ),
      ]);

      if (outcome === "timeout") {
        second.kill("SIGKILL");
        throw new Error(
          "second instance did not exit — single-instance forwarding is broken",
        );
      }

      // The original must still be running: the second launch forwarded to it.
      expect(
        child.exitCode,
        "the running instance exited after a second launch",
      ).toBeNull();
    } finally {
      await stopGui(child).catch(() => child.kill("SIGKILL"));
    }
  });
});

test.describe("installation sanity", () => {
  test("the runtime libraries the binary needs are staged and complete", async () => {
    // `libtranscribe` is resolved through the binary's $ORIGIN-relative rpath in
    // a packaged install, and through `LD_LIBRARY_PATH` for an in-tree build
    // (see `headlessEnv`). Either way transcribe then scans *that same*
    // directory for the ggml backend modules, so the staged set must be whole:
    // a missing lib here is the difference between "installed" and "won't run".
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(TRANSCRIBE_LIBS);

    // Core library every transcription path needs.
    expect(entries.some((name) => name.startsWith("libtranscribe.so"))).toBe(
      true,
    );
    // At least one CPU backend module; without it there is no SIGILL-safe
    // fallback on a machine with no usable GPU.
    expect(entries.some((name) => name.startsWith("libggml-cpu"))).toBe(true);
    // The CBLAS repair staged by build.rs. Without it model load dies with
    // "undefined symbol: cblas_sgemm" on distros whose libblas.so.3 is the
    // reference BLAS (Arch, Fedora).
    expect(entries).toContain("libblas.so.3");
  });
});
