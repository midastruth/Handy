/**
 * E2E: CLI surface and process lifecycle of the native binary.
 *
 * These are the cheapest, most machine-sensitive checks: they catch missing
 * shared libraries, GTK/display-less panics, and non-zero exits that a UI test
 * would never see.
 */

import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { findBinary, headlessEnv, runHandy } from "./helpers/app-harness";

// Headless runs scan the backend modules and seed the model registry on every
// start; on a slow disk that alone can approach the 30s default budget.
test.setTimeout(120_000);

test.describe("binary and headless CLI", () => {
  test("binary exists and reports --help with the documented flags", async () => {
    const result = await runHandy(["--help"], { timeoutMs: 30_000 });

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    // Every flag the project documents as public API must survive in --help.
    for (const flag of [
      "--start-hidden",
      "--no-tray",
      "--toggle-transcription",
      "--toggle-post-process",
      "--cancel",
      "--debug",
      "--transcribe-file",
      "--list-devices",
      "--list-models",
      "--json",
    ]) {
      expect(result.stdout, `--help is missing ${flag}`).toContain(flag);
    }
  });

  test("--list-models exits 0 and never starts the UI", async () => {
    const result = await runHandy(["--list-models"], { timeoutMs: 90_000 });

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.signal).toBeNull();
    // Model output must land on stdout; logs are kept on stderr in headless
    // mode specifically so this stream stays machine-parseable.
    expect(result.stdout).toContain("Available models");
    expect(result.stdout.trim().split("\n").length).toBeGreaterThan(1);
  });

  test("--list-models --json emits parseable JSON with the expected shape", async () => {
    const result = await runHandy(["--list-models", "--json"], {
      timeoutMs: 90_000,
    });

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    const models = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);

    for (const model of models) {
      expect(typeof model.id).toBe("string");
      expect((model.id as string).length).toBeGreaterThan(0);
      expect(typeof model.is_downloaded).toBe("boolean");
    }
    // stdout must be pure JSON, so the whole payload parses in one shot.
    expect(result.stdout.trim().startsWith("[")).toBe(true);
  });

  test("--list-devices reports at least one usable compute device", async () => {
    const result = await runHandy(["--list-devices"], { timeoutMs: 90_000 });

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("compute devices");
    // A CPU backend is the SIGILL-safe baseline and must always register.
    expect(result.stdout.toLowerCase()).toContain("cpu");
  });

  test("headless runs terminate instead of leaving a hung event loop", async () => {
    // Assert on the process this test started rather than scanning the global
    // process table: the suite runs in parallel, so `pgrep` would also see the
    // handy processes other workers are legitimately running.
    const binary = findBinary();
    const child = spawn(binary, ["--list-models"], {
      env: headlessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 90_000),
    );

    const outcome = await Promise.race([exited, timeout]);
    if (outcome === "timeout") {
      child.kill("SIGKILL");
      throw new Error(
        "headless run did not exit within 90s — the Tauri event loop is hung",
      );
    }

    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(0);
  });
});
