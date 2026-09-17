/**
 * Shared helpers for the Handy E2E (Playwright) suite.
 *
 * Two very different surfaces are exercised here:
 *
 *  1. The **native binary** (`src-tauri/target/<profile>/handy`) driven through
 *     its headless CLI (`--list-models`, `--list-devices`, `--transcribe-file`).
 *     This is the only way to E2E the Rust/audio/transcription pipeline, and it
 *     is what actually catches machine-specific breakage (missing shared libs,
 *     broken GPU backends, aborts during teardown).
 *
 *  2. The **webview UI**, served by `vite dev` on port 1420. Playwright drives
 *     it in real Chromium with a mocked `window.__TAURI_INTERNALS__` so the React
 *     tree renders without the Tauri IPC bridge.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Repository root (this file lives in `<root>/tests/helpers/`). */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
export const TAURI_DIR = join(REPO_ROOT, "src-tauri");
export const TRANSCRIBE_LIBS = join(TAURI_DIR, "transcribe-libs");

/**
 * Handy's app data dir. `XDG_DATA_HOME` is honoured so the suite can run
 * against an isolated profile via `HANDY_E2E_DATA_DIR`.
 */
/** Locate the built binary, preferring the profile under test. */
export function findBinary(): string {
  const candidates = [
    process.env.HANDY_E2E_BINARY,
    join(TAURI_DIR, "target", "debug", "handy"),
    join(TAURI_DIR, "target", "release", "handy"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `handy binary not found. Build it first (cd src-tauri && cargo build) or set HANDY_E2E_BINARY. Tried:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * Environment that makes the headless CLI usable outside a desktop session.
 *
 * - `LD_LIBRARY_PATH` covers `libtranscribe.so` and the ggml backend modules,
 *   which sit in `src-tauri/transcribe-libs` for an in-tree build (installed
 *   packages put them on the binary's rpath, so this is a no-op there).
 * - `WAYLAND_DISPLAY`/`DISPLAY` are needed because Tauri still initialises GTK
 *   even for `--list-models`; without a display it panics in `gtk::rt::init`.
 * - The Vulkan/GL stack is left alone deliberately: tests assert the *real*
 *   machine behaviour rather than a sanitised one.
 *
 * `HANDY_DISABLE_GPU=1` is set by default. On hosts whose GPU backend registers a
 * device it cannot actually use (Intel Ivy Bridge / HD 4000 is the known case),
 * ggml's Vulkan teardown calls `abort()` on the half-initialised device *after*
 * a successful transcription, so every run would exit 134 and dump core. Forcing
 * CPU is the supported workaround; the transcription suite asserts that the
 * flag keeps the pipeline stable. Set `HANDY_E2E_ALLOW_GPU=1` to exercise the
 * GPU path instead (used by the workaround regression test).
 */
export function headlessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };

  if (!process.env.HANDY_E2E_ALLOW_GPU && env.HANDY_DISABLE_GPU === undefined) {
    env.HANDY_DISABLE_GPU = "1";
  }

  const libPath = [TRANSCRIBE_LIBS, env.LD_LIBRARY_PATH]
    .filter(Boolean)
    .join(":");
  env.LD_LIBRARY_PATH = libPath;

  // Inherit the caller's display when present, else fall back to the first
  // Wayland socket so tests work from a bare SSH/tty shell on this machine.
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) {
    const runtimeDir =
      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`;
    try {
      const socket = readdirSync(runtimeDir).find((name) =>
        name.startsWith("wayland-"),
      );
      if (socket) env.WAYLAND_DISPLAY = socket;
    } catch {
      // No runtime dir: let the app fail loudly rather than masking it.
    }
  }

  return env;
}

/**
 * Parse `--list-devices` into `{ index, kind }` entries.
 *
 * Registry indices are process-local and shift with the machine (index 0 is the
 * GPU when one registers, otherwise the CPU), so tests must resolve the index
 * they want instead of hardcoding it.
 */
export async function listComputeDevices(): Promise<
  Array<{ index: number; kind: string; name: string }>
> {
  const result = await runHandy(["--list-devices"], { timeoutMs: 90_000 });
  const devices: Array<{ index: number; kind: string; name: string }> = [];

  for (const line of result.stdout.split("\n")) {
    const match = line.match(
      /^\s*index=(\d+)\s+kind=(\S+)\s+name=(.*?)\s+vram=/,
    );
    if (match) {
      devices.push({
        index: Number(match[1]),
        kind: match[2],
        name: match[3],
      });
    }
  }
  return devices;
}

/** The registry index of the CPU compute device, or null when none is listed. */
export async function cpuDeviceIndex(): Promise<number | null> {
  const devices = await listComputeDevices();
  return (
    devices.find((device) => device.kind.toLowerCase() === "cpu")?.index ?? null
  );
}

/**
 * Wait until the running GUI has claimed its single-instance D-Bus name.
 *
 * `tauri_plugin_single_instance` registers `com.pais.handy.SingleInstance` on
 * the session bus, and the plugin installs the handler that receives forwarded
 * launches. Polling for the name is therefore the only race-free "the first
 * instance is ready to forward" signal — a fixed sleep is both slower and
 * flakier, and testing before the name is claimed would report a passing
 * forward as a hang.
 */
export async function waitForSingleInstanceName({
  timeoutMs = 30_000,
} = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "dbus-send",
        [
          "--session",
          "--dest=org.freedesktop.DBus",
          "--type=method_call",
          "--print-reply",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus.ListNames",
        ],
        { timeout: 5_000 },
      );
      if (stdout.includes("com.pais.handy.SingleInstance")) return true;
    } catch {
      // No session bus (or dbus-send absent): fall through to the timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

export interface CliResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * True when stderr shows ggml fell back to CPU because the registered GPU
 * device is unusable (no 16-bit storage). This is the condition that leads to
 * the Vulkan teardown abort unless `HANDY_DISABLE_GPU` is set.
 */
export function hasUnusableGpuFallback(stderr: string): boolean {
  return /does not support 16-bit storage/i.test(stderr);
}

/** Run the handy binary headlessly and capture its exit status and streams. */
export async function runHandy(
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  const binary = findBinary();
  const { timeoutMs = 180_000, env = {} } = options;

  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      env: headlessEnv(env),
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      // The binary aborts (SIGABRT) on broken backends; execFile surfaces that
      // through the rejected error, which we normalise below.
      killSignal: "SIGKILL",
    });
    return { code: 0, signal: null, stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      signal: err.signal ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

/** Spawn the GUI binary and return the process so tests can inspect/stop it. */
/** Wait for `predicate` to become true, polling every `intervalMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 250, description = "condition" } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

/**
 * Handy's app data dir. `XDG_DATA_HOME` is honoured so the suite can run
 * against an isolated profile via `HANDY_E2E_DATA_DIR`.
 */
function appDataDir(): string {
  if (process.env.HANDY_E2E_DATA_DIR) return process.env.HANDY_E2E_DATA_DIR;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "com.pais.handy");
}

function recordingsDir(): string {
  return join(appDataDir(), "recordings");
}

/** The WAV files a real Handy session left in the recordings dir, oldest first. */
export function listRecordings(): string[] {
  const dir = recordingsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".wav"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * Preferred model for transcription tests: the first installed (✓) entry from
 * `--list-models`, falling back to `HANDY_E2E_MODEL`.
 */
export async function installedModelId(): Promise<string | null> {
  if (process.env.HANDY_E2E_MODEL) return process.env.HANDY_E2E_MODEL;
  const result = await runHandy(["--list-models"], { timeoutMs: 60_000 });
  for (const line of result.stdout.split("\n")) {
    const match = line.match(/^\s*✓\s+(\S+)/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Resolve the reference audio used for transcription assertions.
 *
 * `HANDY_E2E_WAV` wins; otherwise the shortest recording from a previous
 * session is used (real speech, so the assertion is meaningful without
 * shipping a fixture in the repo).
 */
export function referenceWav(): string | null {
  if (process.env.HANDY_E2E_WAV) {
    return existsSync(process.env.HANDY_E2E_WAV)
      ? process.env.HANDY_E2E_WAV
      : null;
  }
  const recordings = listRecordings();
  return recordings.length > 0 ? recordings[0] : null;
}

/**
 * Ensure `libblas.so.3` resolves to an implementation that actually exports
 * CBLAS. `libtranscribe.so` links `libblas.so.3` but calls `cblas_*`, so on
 * distros where the `blas` package owns that SONAME (Arch, Fedora) the process
 * dies with `undefined symbol: cblas_sgemm`. Linking the system OpenBLAS into
 * the staged lib dir fixes it via the `$ORIGIN` runpath already baked into
 * `libtranscribe.so`.
 *
 * Returns true when a symlink was created.
 */
export function ensureCblasAvailable(): boolean {
  const target = "/usr/lib/libopenblas.so.0";
  const link = join(TRANSCRIBE_LIBS, "libblas.so.3");
  if (!existsSync(target)) return false;
  try {
    if (existsSync(link)) rmSync(link, { force: true });
    mkdirSync(TRANSCRIBE_LIBS, { recursive: true });
    symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}
