/**
 * E2E: real transcription through the native pipeline.
 *
 * This is the suite that reproduces the failures found on this machine:
 *
 *  1. `undefined symbol: cblas_sgemm` — `libtranscribe.so` links `libblas.so.3`
 *     but calls `cblas_*`, and on Arch/Fedora that SONAME is the *reference*
 *     BLAS, which exports no CBLAS symbols at all. Fixed in `build.rs`, which
 *     now stages a `libblas.so.3` -> system OpenBLAS link next to `libtranscribe`
 *     (its `$ORIGIN` runpath is searched first).
 *
 *  2. `SIGABRT` in `vkDestroyFence` at shutdown — ggml's Vulkan module registers
 *     a device it cannot use (Intel Ivy Bridge reports no 16-bit storage), model
 *     init correctly falls back to CPU, and the process then aborts while
 *     destroying the half-initialised Vulkan device. The abort happens *after*
 *     the transcript is produced, so a naive "did we get text" assertion passes
 *     while the process still dies with exit code 134. `HANDY_DISABLE_GPU=1`
 *     pins the run to CPU, which keeps the broken device uninitialised.
 *
 * Every test therefore asserts on the exit status as well as the text.
 */

import { expect, test } from "@playwright/test";
import {
  cpuDeviceIndex,
  ensureCblasAvailable,
  hasUnusableGpuFallback,
  installedModelId,
  referenceWav,
  runHandy,
} from "./helpers/app-harness";

// Transcription is CPU-bound on the machines this suite targets: a cold model
// load plus inference on a short clip already takes seconds, and a genuine
// hang guard is the per-command timeout passed to runHandy.
test.setTimeout(300_000);

/** Transcription needs a model on disk and a real recording; skip loudly if not. */
async function requireModelAndAudio() {
  const model = await installedModelId();
  const wav = referenceWav();

  test.skip(!model, "no installed model (run Handy once to download one)");
  test.skip(!wav, "no reference recording in the app data dir");

  return { model: model as string, wav: wav as string };
}

test.describe("headless transcription", () => {
  test.beforeAll(() => {
    // Keep the CBLAS fix present even when the build ran before it landed;
    // idempotent and a no-op on distros whose libblas already exports CBLAS.
    ensureCblasAvailable();
  });

  test("transcribes a real recording and exits 0", async () => {
    const { model, wav } = await requireModelAndAudio();

    const result = await runHandy(
      ["--transcribe-file", wav, "--model", model, "--json"],
      { timeoutMs: 300_000 },
    );

    expect(
      result.signal,
      `process was killed by ${result.signal}\nstderr:\n${result.stderr}`,
    ).toBeNull();
    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      audio_secs: number;
      text: string;
      best_ms: number;
      bound_backend: string;
    };

    // Whisper-family models legitimately emit nothing for noise-only audio, so
    // assert the pipeline ran rather than that speech was recognised.
    expect(payload.audio_secs).toBeGreaterThan(0);
    expect(typeof payload.text).toBe("string");
    expect(payload.best_ms).toBeGreaterThan(0);
    expect(payload.bound_backend.length).toBeGreaterThan(0);
  });

  test("repeated runs are stable: no abort, no leaked process", async () => {
    const { model, wav } = await requireModelAndAudio();

    // Repeat a few times: an intermittent teardown race must not pass by luck.
    // This is the regression guard for the CBLAS/SIGABRT pair above.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runHandy(
        ["--transcribe-file", wav, "--model", model],
        { timeoutMs: 300_000 },
      );

      expect(
        result.signal,
        `attempt ${attempt} was killed by ${result.signal}\nstderr tail:\n${result.stderr
          .split("\n")
          .slice(-15)
          .join("\n")}`,
      ).toBeNull();
      expect(result.code, `attempt ${attempt} exited ${result.code}`).toBe(0);
    }
  });

  test("HANDY_DISABLE_GPU keeps this host off the unusable GPU device", async () => {
    const { model, wav } = await requireModelAndAudio();

    const result = await runHandy(
      ["--transcribe-file", wav, "--model", model, "--json"],
      { timeoutMs: 300_000, env: { HANDY_DISABLE_GPU: "1" } },
    );

    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.signal).toBeNull();

    // The flag must actually suppress the GPU device rather than merely happen
    // to work: no unusable-device fallback warning should appear.
    expect(
      hasUnusableGpuFallback(result.stderr),
      "HANDY_DISABLE_GPU did not prevent the GPU device from being initialised",
    ).toBe(false);

    const payload = JSON.parse(result.stdout) as { bound_backend: string };
    expect(payload.bound_backend.toLowerCase()).toContain("cpu");
  });

  test("--device-index forces an exact backend and still exits 0", async () => {
    const { model, wav } = await requireModelAndAudio();

    // Resolve the CPU index rather than assuming it: the registry shifts with
    // the machine (a GPU takes index 0 when one registers). Explicitly selecting
    // CPU is the other reliable workaround for a broken GPU backend.
    const cpuIndex = await cpuDeviceIndex();
    test.skip(cpuIndex === null, "no CPU compute device registered");

    const result = await runHandy(
      [
        "--transcribe-file",
        wav,
        "--model",
        model,
        "--device-index",
        String(cpuIndex),
        "--json",
      ],
      { timeoutMs: 300_000, env: { HANDY_E2E_ALLOW_GPU: "1" } },
    );

    expect(result.signal, `stderr:\n${result.stderr}`).toBeNull();
    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as { bound_backend: string };
    expect(payload.bound_backend.toLowerCase()).toContain("cpu");
  });

  test("--repeat reuses a warm model and reports the best run", async () => {
    const { model, wav } = await requireModelAndAudio();

    const result = await runHandy(
      ["--transcribe-file", wav, "--model", model, "--repeat", "2", "--json"],
      { timeoutMs: 300_000 },
    );

    expect(result.signal, `stderr:\n${result.stderr}`).toBeNull();
    expect(result.code, `stderr:\n${result.stderr}`).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      transcribe_ms: number[];
      best_ms: number;
    };
    expect(payload.transcribe_ms).toHaveLength(2);
    expect(payload.best_ms).toBe(Math.min(...payload.transcribe_ms));
  });

  test("rejects malformed audio with usage exit code 2", async () => {
    // The CLI documents exit 2 for bad input; a missing file must not be
    // silently transcribed as garbage.
    const { model } = await requireModelAndAudio();

    const result = await runHandy(
      [
        "--transcribe-file",
        "/nonexistent/definitely-not-here.wav",
        "--model",
        model,
      ],
      { timeoutMs: 60_000 },
    );

    expect(result.code).toBe(2);
    expect(result.signal).toBeNull();
    expect(result.stderr).toContain("error:");
  });
});

/**
 * Characterisation of the GPU teardown abort itself.
 *
 * This documents *why* `HANDY_DISABLE_GPU` exists and fails loudly if a future
 * ggml/transcribe-cpp bump fixes the upstream teardown, at which point the
 * workaround can be retired. On hosts with a usable GPU the test is skipped.
 */
test.describe("GPU backend teardown (upstream characterisation)", () => {
  test.skip(
    !!process.env.HANDY_E2E_SKIP_GPU_CHARACTERISATION,
    "characterisation test disabled",
  );

  test("an unusable GPU device aborts during Vulkan teardown", async () => {
    const model = await installedModelId();
    const wav = referenceWav();
    test.skip(!model, "no installed model");
    test.skip(!wav, "no reference recording");

    const result = await runHandy(
      ["--transcribe-file", wav as string, "--model", model as string],
      { timeoutMs: 300_000, env: { HANDY_E2E_ALLOW_GPU: "1" } },
    );

    if (!hasUnusableGpuFallback(result.stderr)) {
      test.skip(
        true,
        "this host has a usable GPU device; the teardown abort does not apply",
      );
    }

    // Transcription itself succeeds; only teardown is broken. If upstream ever
    // fixes the abort this assertion is the signal to drop HANDY_DISABLE_GPU
    // from the harness defaults.
    expect(
      result.signal,
      [
        "Expected the known ggml Vulkan teardown abort (SIGABRT).",
        `Got exit=${result.code} signal=${result.signal}.`,
        "If upstream fixed the teardown, remove the HANDY_DISABLE_GPU default from tests/helpers/app-harness.ts.",
      ].join(" "),
    ).toBe("SIGABRT");
  });
});
