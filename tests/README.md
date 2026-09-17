# Handy E2E tests

Playwright-based end-to-end tests covering both surfaces of the app:

| Spec                          | Surface                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `tests/ui.spec.ts`            | React UI in real Chromium with a mocked Tauri IPC bridge        |
| `tests/cli.spec.ts`           | The native binary's headless CLI (`--list-models`, `--help`, …) |
| `tests/gui.spec.ts`           | The real Tauri window's lifecycle (startup, single instance)    |
| `tests/transcription.spec.ts` | Real audio → text through the native pipeline                   |

The native specs are the ones that catch machine-specific breakage: a missing
shared library, an unusable GPU backend, an abort during teardown. They spawn
`src-tauri/target/<profile>/handy` directly, so **build the binary first**:

```bash
cd src-tauri && cargo build          # or: bun run tauri build
cd .. && bun run test:playwright
```

## Running

```bash
bun run test:playwright          # everything
bun run test:e2e:ui              # UI spec only (fastest)
bun run test:e2e:cli             # CLI + GUI lifecycle
bun run test:e2e:transcription   # native transcription (slowest)
```

## Environment

The harness (`tests/helpers/app-harness.ts`) resolves everything it needs, but
these variables override the defaults:

| Variable                              | Purpose                                                               |
| ------------------------------------- | --------------------------------------------------------------------- |
| `HANDY_E2E_BINARY`                    | Path to the binary under test (default: debug, then release build)    |
| `HANDY_E2E_MODEL`                     | Model id for transcription (default: first installed model)           |
| `HANDY_E2E_WAV`                       | 16 kHz mono PCM WAV (default: shortest recording in the app data dir) |
| `HANDY_E2E_DATA_DIR`                  | App data dir to read recordings from                                  |
| `HANDY_E2E_ALLOW_GPU`                 | Exercise the GPU path instead of forcing CPU                          |
| `HANDY_E2E_SKIP_GPU_CHARACTERISATION` | Skip the GPU teardown characterisation test                           |

Transcription tests **skip** (rather than fail) when no model is installed or no
recording exists — run Handy once and dictate something to populate both.

## `HANDY_DISABLE_GPU`

The harness sets `HANDY_DISABLE_GPU=1` by default. It pins the process to the
CPU transcribe-cpp backend, which is the supported workaround for hosts where the
GPU backend registers a device it cannot actually use.

The known case is **Intel Ivy Bridge (HD 4000)**. The Vulkan device reports no
16-bit storage, so model init correctly falls back to CPU — and then ggml's
Vulkan teardown calls `abort()` while destroying the half-initialised device:

```text
ggml_vulkan: device Vulkan0 does not support 16-bit storage.
[transcribe_cpp][WARN] parakeet: device "Vulkan0" init threw: Unsupported device - skipping it
...
[Vulkan Loader] ERROR: vkDestroyFence: Invalid device [VUID-vkDestroyFence-device-parameter]
```

The abort happens **after** the transcript is produced, so a naive "did we get
text" assertion passes while the process still dies with exit code 134 and
leaves a core dump. The suite asserts on the exit status for exactly this reason.

`HANDY_DISABLE_GPU` also has an in-app equivalent: set the **Accelerator**
setting to **CPU** in Settings → Advanced. The env var exists so the workaround
can be applied to a launch (and by CI) without editing persisted settings.

`tests/transcription.spec.ts` contains a characterisation test that asserts the
abort still happens on an unusable GPU. If it starts failing, upstream fixed the
teardown and `HANDY_DISABLE_GPU` can be dropped from the harness defaults.

## CBLAS / OpenBLAS on Arch and Fedora

`libtranscribe.so` links `libblas.so.3` but calls `cblas_*`. On Debian/Ubuntu
that SONAME is provided by OpenBLAS, so it resolves. On Arch and Fedora the same
SONAME is owned by the _reference_ BLAS (`blas`), which exports no CBLAS symbols
at all, and every model load dies with:

```text
symbol lookup error: libtranscribe.so.0.2: undefined symbol: cblas_sgemm
```

`src-tauri/build.rs` fixes this at build time: it detects that `libtranscribe`
imports CBLAS, finds the system OpenBLAS, and stages a `libblas.so.3` symlink
next to `libtranscribe` in `src-tauri/transcribe-libs/`. `libtranscribe`'s own
`$ORIGIN` runpath is searched before the system paths, so the lookup resolves
without touching the user's `alternatives` setup.

The `installation sanity` test in `tests/gui.spec.ts` asserts the staged link is
present.
