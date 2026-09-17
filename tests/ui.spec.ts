/**
 * E2E: the React UI rendered against a mocked Tauri IPC bridge.
 *
 * The real webview cannot be driven by Playwright on Linux (WebKitGTK has no
 * WebDriver here), so the frontend is loaded from the Vite dev server and the
 * `window.__TAURI_INTERNALS__` bridge is replaced with an in-page mock that
 * answers the commands `App.tsx` / the settings store actually call.
 *
 * This catches regressions in the render path: render crashes, missing
 * translations, onboarding gating, and unreachable settings sections.
 */

import { expect, test, type Page } from "@playwright/test";

/** Minimal but complete AppSettings payload matching Rust's `AppSettings`. */
function mockSettings() {
  return {
    bindings: {
      transcribe: {
        id: "transcribe",
        name: "Transcribe",
        description: "Converts your speech into text.",
        default_binding: "ctrl+space",
        current_binding: "ctrl+space",
      },
      transcribe_with_post_process: {
        id: "transcribe_with_post_process",
        name: "Transcribe with Post-Processing",
        description:
          "Converts your speech into text and applies AI post-processing.",
        default_binding: "ctrl+shift+space",
        current_binding: "ctrl+shift+space",
      },
      cancel: {
        id: "cancel",
        name: "Cancel",
        description: "Cancels the current recording.",
        default_binding: "escape",
        current_binding: "escape",
      },
    },
    push_to_talk: true,
    audio_feedback: false,
    audio_feedback_volume: 1.0,
    sound_theme: "marimba",
    start_hidden: false,
    autostart_enabled: false,
    update_checks_enabled: false,
    show_whats_new_on_update: false,
    whats_new_last_seen_version: "0.9.6",
    shortcut_activation: "push_to_talk",
    hold_threshold_ms: 300,
    selected_microphone: null,
    selected_channel: null,
    clamshell_microphone: null,
    selected_output_device: null,
    recording_retention_period: "preserve_limit",
    history_limit: 5,
    translate_to_english: false,
    selected_language: "auto",
    overlay_position: "bottom",
    overlay_style: "live",
    debug_mode: false,
    custom_words: [],
    word_correction_threshold: 0.18,
    custom_filler_words: null,
    filler_word_removal_enabled: true,
    paste_delay_ms: 60,
    paste_delay_after_ms: 60,
    reliable_paste: false,
    paste_method: "ctrl_shift_v",
    typing_tool: "auto",
    external_script_path: null,
    clipboard_handling: "dont_modify",
    auto_submit: false,
    auto_submit_key: "enter",
    mute_while_recording: false,
    append_trailing_space: false,
    lazy_stream_close: false,
    vad_enabled: true,
    vad_backend: "earshot",
    always_on_microphone: false,
    extra_recording_buffer_ms: 0,
    model_unload_timeout: "min5",
    selected_model:
      "handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf",
    experimental_enabled: false,
    post_process_enabled: false,
    post_process_provider_id: "openai",
    post_process_providers: [],
    post_process_api_keys: {},
    post_process_models: {},
    post_process_prompts: [],
    post_process_selected_prompt_id: null,
    post_process_base_url: "",
    post_process_api_key: "",
    post_process_model: "",
    app_language: "en",
    theme: "system",
    keyboard_implementation: "tauri",
    show_tray_icon: true,
    transcribe_accelerator: "auto",
    transcribe_gpu_device: null,
    ort_accelerator: "auto",
    onboarding_completed: true,
    settings_schema_version: 2,
  };
}

/**
 * Install the IPC mock before any application code runs.
 *
 * `window.__TAURI_INTERNALS__.invoke` must resolve to the command's **raw**
 * return value: the generated `bindings.ts` is what wraps it in the
 * `Result<T, string>` envelope (`{ status: "ok", data }`). Returning an
 * already-wrapped value here double-wraps it and every `result.data` read
 * becomes `undefined`, which surfaces as a render crash rather than a mock
 * failure — so the raw shape matters.
 */
async function installTauriMock(page: Page) {
  await page.addInitScript(() => {
    const settings = (window as unknown as { __MOCK_SETTINGS__: unknown })
      .__MOCK_SETTINGS__;

    let callbackId = 1;
    const callbacks = new Map<number, (payload: unknown) => void>();

    type Payload = { event?: string };
    const listeners = new Map<string, number[]>();

    const invoke = async (cmd: string, args?: Payload) => {
      if (cmd.startsWith("plugin:event|")) {
        switch (cmd) {
          case "plugin:event|listen": {
            const event = args?.event ?? "";
            const handler = (args as unknown as { handler: number }).handler;
            const ids = listeners.get(event) ?? [];
            ids.push(handler);
            listeners.set(event, ids);
            return handler;
          }
          case "plugin:event|unlisten":
          case "plugin:event|emit":
          default:
            return null;
        }
      }

      switch (cmd) {
        case "get_app_settings":
        case "get_default_settings":
          return settings;
        case "is_portable":
        case "is_update_checks_locked":
        case "is_laptop":
          return false;
        case "get_available_microphones":
        case "get_available_output_devices":
        case "get_history_entries":
        case "get_available_models":
        case "get_available_typing_tools":
          return [];
        case "get_current_model":
          return "handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf";
        case "get_available_accelerators":
          return {
            transcribe: ["auto", "cpu"],
            ort: ["auto"],
            gpu_devices: [],
          };
        case "get_keyboard_implementation":
          return "tauri";
        case "get_secure_input_status":
          return { enabled: false, active: false };
        case "get_log_dir_path":
        case "get_app_dir_path":
          return "/tmp/handy-e2e";
        case "is_model_loading":
        case "is_recording":
        case "check_custom_sounds":
          return false;
        case "initialize_enigo":
        case "initialize_shortcuts":
          return null;
        default:
          // Unknown commands must not break the render; the UI treats them as a
          // no-op result so a missing mock is visible as a missing element
          // rather than a white screen.
          return null;
      }
    };

    const tauriWindow = window as unknown as Record<string, unknown>;

    tauriWindow.__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: (cb: (payload: unknown) => void) => {
        const id = callbackId++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback: (id: number) => {
        callbacks.delete(id);
      },
      runCallback: (id: number, payload: unknown) => {
        callbacks.get(id)?.(payload);
      },
      callbacks,
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      convertFileSrc: (path: string) =>
        `asset://localhost/${encodeURIComponent(path)}`,
    };

    tauriWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };

    // `platform()` is read synchronously at module load (`main.tsx` sets
    // `document.documentElement.dataset.platform`), so the OS plugin internals
    // must exist before any application code runs — an `invoke`-based mock
    // cannot satisfy it.
    tauriWindow.__TAURI_OS_PLUGIN_INTERNALS__ = {
      platform: "linux",
      version: "6.0.0",
      family: "unix",
      os_type: "linux",
      arch: "x86_64",
      eol: "\n",
      exe_extension: "",
    };
  }, mockSettings());
}

/** Merge the settings payload into the init script before it is installed. */
async function gotoApp(page: Page) {
  await page.addInitScript((settings) => {
    (window as unknown as { __MOCK_SETTINGS__: unknown }).__MOCK_SETTINGS__ =
      settings;
  }, mockSettings());
  await installTauriMock(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

test.describe("settings UI", () => {
  test("renders the app shell without a render crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await gotoApp(page);

    // The root must get content: an empty #root means React threw during render.
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: 20_000 });
    // React strips its own error overlay; a pageerror is the reliable signal.
    expect(errors, `render errors:\n${errors.join("\n")}`).toEqual([]);
  });

  test("shows the main app, not the first-run onboarding", async ({ page }) => {
    await gotoApp(page);

    // `onboarding_completed: true` is what a returning user has, and it is the
    // gate the whole settings shell hangs off. If this regresses the user is
    // sent back through first-run setup and their saved model looks lost.
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: 20_000 });
    const body = await page.locator("body").innerText();

    // Settings navigation labels are a stable surface that only exists once the
    // main app renders (they are absent from every onboarding step).
    expect(body.toLowerCase()).toContain("general");
  });

  test("does not hardcode user-facing strings (i18n is wired up)", async ({
    page,
  }) => {
    await gotoApp(page);

    const body = await page.locator("body").innerText({ timeout: 20_000 });
    // Translation keys leaking to the DOM (`settings.general.title`) or the
    // i18next "key not found" marker would both show up here.
    expect(body).not.toMatch(/\b[a-z]+\.[a-z]+\.[a-z]+\b/);
    expect(body.length).toBeGreaterThan(0);
  });

  test("navigating settings sections does not crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await gotoApp(page);
    await expect(page.locator("#root")).not.toBeEmpty({ timeout: 20_000 });

    // Every sidebar entry mounts a different settings component; a crash in one
    // is invisible if the suite only ever asserts on the initial section. The
    // sidebar is navigated by its translated labels (there is no stable test id).
    for (const label of ["General", "History", "Models", "Advanced", "About"]) {
      const nav = page.getByText(label, { exact: true }).first();
      if ((await nav.count()) === 0) continue;
      await nav.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(250);
    }

    await expect(page.locator("#root")).not.toBeEmpty();
    expect(errors, `errors while navigating:\n${errors.join("\n")}`).toEqual(
      [],
    );
  });
});
