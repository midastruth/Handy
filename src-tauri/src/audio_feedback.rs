use crate::settings::SoundTheme;
use crate::settings::{self, AppSettings};
use cpal::traits::{DeviceTrait, HostTrait};
use log::{debug, error, warn};
use rodio::OutputStreamBuilder;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::thread;
use tauri::{AppHandle, Manager};

pub enum SoundType {
    Start,
    Stop,
}

fn resolve_sound_path(
    app: &AppHandle,
    settings: &AppSettings,
    sound_type: SoundType,
) -> Option<PathBuf> {
    let mut effective = settings.clone();
    effective.sound_theme = effective_sound_theme(app, settings);
    let settings = &effective;

    let sound_file = get_sound_path(settings, sound_type);
    let base_dir = get_sound_base_dir(settings);
    match base_dir {
        tauri::path::BaseDirectory::AppData => {
            crate::portable::resolve_app_data(app, &sound_file).ok()
        }
        _ => app.path().resolve(&sound_file, base_dir).ok(),
    }
}

fn get_sound_path(settings: &AppSettings, sound_type: SoundType) -> String {
    match (settings.sound_theme, sound_type) {
        (SoundTheme::Custom, SoundType::Start) => "custom_start.wav".to_string(),
        (SoundTheme::Custom, SoundType::Stop) => "custom_stop.wav".to_string(),
        (_, SoundType::Start) => settings.sound_theme.to_start_path(),
        (_, SoundType::Stop) => settings.sound_theme.to_stop_path(),
    }
}

fn get_sound_base_dir(settings: &AppSettings) -> tauri::path::BaseDirectory {
    match settings.sound_theme {
        SoundTheme::Custom => tauri::path::BaseDirectory::AppData,
        _ => tauri::path::BaseDirectory::Resource,
    }
}

/// Whether a saved custom sound file is actually on disk.
///
/// `check_custom_sounds` uses the same rule, so the UI and the playback path
/// agree on when a custom theme is usable.
pub fn custom_sound_exists(app: &AppHandle, sound_type: &str) -> bool {
    crate::portable::resolve_app_data(app, &format!("custom_{}.wav", sound_type))
        .is_ok_and(|path| path.exists())
}

/// A custom theme is only playable when *both* files are present.
fn custom_theme_is_usable(app: &AppHandle) -> bool {
    custom_sound_exists(app, "start") && custom_sound_exists(app, "stop")
}

/// Pure form of the theme fallback: a `Custom` theme is only usable when both
/// files are present. Split out so the decision can be unit-tested without an
/// `AppHandle`.
fn resolve_effective_theme(theme: SoundTheme, custom_usable: bool) -> SoundTheme {
    if theme == SoundTheme::Custom && !custom_usable {
        SoundTheme::Marimba
    } else {
        theme
    }
}

/// Resolve the theme to play. An unusable `Custom` theme (a file was deleted
/// after it was selected) falls back to the default theme rather than playing
/// nothing, and downgrades the persisted setting so the UI stops offering a
/// preview that cannot work.
fn effective_sound_theme(app: &AppHandle, settings: &AppSettings) -> SoundTheme {
    let effective = resolve_effective_theme(settings.sound_theme, custom_theme_is_usable(app));
    if effective == settings.sound_theme {
        return effective;
    }

    warn!("Custom sound theme selected but custom_start.wav/custom_stop.wav are missing; falling back to the default theme");

    let mut updated = settings.clone();
    updated.sound_theme = effective;
    settings::write_settings(app, updated);

    effective
}

pub fn play_feedback_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_async(app, path);
    }
}

pub fn play_feedback_sound_blocking(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if !settings.audio_feedback {
        return;
    }
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

pub fn play_test_sound(app: &AppHandle, sound_type: SoundType) {
    let settings = settings::get_settings(app);
    if let Some(path) = resolve_sound_path(app, &settings, sound_type) {
        play_sound_blocking(app, &path);
    }
}

fn play_sound_async(app: &AppHandle, path: PathBuf) {
    let app_handle = app.clone();
    thread::spawn(move || {
        if let Err(e) = play_sound_at_path(&app_handle, path.as_path()) {
            error!("Failed to play sound '{}': {}", path.display(), e);
        }
    });
}

fn play_sound_blocking(app: &AppHandle, path: &Path) {
    if let Err(e) = play_sound_at_path(app, path) {
        error!("Failed to play sound '{}': {}", path.display(), e);
    }
}

fn play_sound_at_path(app: &AppHandle, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let settings = settings::get_settings(app);
    let volume = settings.audio_feedback_volume;
    let selected_device = settings.selected_output_device.clone();
    play_audio_file(path, selected_device, volume)
}

fn play_audio_file(
    path: &std::path::Path,
    selected_device: Option<String>,
    volume: f32,
) -> Result<(), Box<dyn std::error::Error>> {
    let stream_builder = if let Some(device_name) = selected_device {
        if device_name == "Default" {
            debug!("Using default device");
            OutputStreamBuilder::from_default_device()?
        } else {
            let host = crate::audio_toolkit::get_cpal_host();
            let devices = host.output_devices()?;

            let mut found_device = None;
            for device in devices {
                if device.name()? == device_name {
                    found_device = Some(device);
                    break;
                }
            }

            match found_device {
                Some(device) => OutputStreamBuilder::from_device(device)?,
                None => {
                    warn!("Device '{}' not found, using default device", device_name);
                    OutputStreamBuilder::from_default_device()?
                }
            }
        }
    } else {
        debug!("Using default device");
        OutputStreamBuilder::from_default_device()?
    };

    let stream_handle = stream_builder.open_stream()?;
    let mixer = stream_handle.mixer();

    let file = File::open(path)?;
    let buf_reader = BufReader::new(file);

    let sink = rodio::play(mixer, buf_reader)?;
    sink.set_volume(volume);
    sink.sleep_until_end();

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_theme_is_kept_when_both_files_exist() {
        assert_eq!(
            resolve_effective_theme(SoundTheme::Custom, true),
            SoundTheme::Custom
        );
    }

    #[test]
    fn custom_theme_falls_back_when_a_file_is_missing() {
        // Regression: selecting Custom and then deleting the files used to leave
        // the app silent forever with an ERROR per chime.
        assert_eq!(
            resolve_effective_theme(SoundTheme::Custom, false),
            SoundTheme::Marimba
        );
    }

    #[test]
    fn builtin_themes_are_never_affected_by_custom_files() {
        for theme in [SoundTheme::Marimba, SoundTheme::Pop] {
            assert_eq!(resolve_effective_theme(theme, false), theme);
            assert_eq!(resolve_effective_theme(theme, true), theme);
        }
    }
}
