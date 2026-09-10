use serde::Serialize;
use specta::Type;
use std::collections::HashMap;

/// The small, stable subset of Omarchy's `colors.toml` used by the UI.
#[derive(Clone, Debug, Serialize, Type)]
pub struct OmarchyTheme {
    pub name: String,
    pub mode: String,
    pub accent: String,
    pub selection: String,
    pub muted: String,
    pub background: String,
    pub dark_background: String,
    pub darker_background: String,
    pub lighter_background: String,
    pub foreground: String,
    pub dark_foreground: String,
    pub light_foreground: String,
    pub red: String,
    pub yellow: String,
}

fn parse_value(line: &str) -> Option<(&str, String)> {
    let (key, value) = line.split_once('=')?;
    let value = value.trim().trim_matches('"');
    Some((key.trim(), value.to_string()))
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

fn color(values: &HashMap<String, String>, key: &str, fallback: &str) -> String {
    values
        .get(key)
        .filter(|value| valid_color(value))
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

/// Read the active Omarchy palette when Handy is running on an Omarchy desktop.
/// Other platforms return `None`, preserving Handy's regular theme support.
#[tauri::command]
#[specta::specta]
pub fn get_omarchy_theme() -> Option<OmarchyTheme> {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var_os("HOME")?;
        let state_dir = std::path::PathBuf::from(home).join(".local/state/omarchy/current");
        let contents = std::fs::read_to_string(state_dir.join("theme/colors.toml")).ok()?;
        let values: HashMap<String, String> = contents
            .lines()
            .filter_map(|line| parse_value(line.trim()))
            .map(|(key, value)| (key.to_string(), value))
            .collect();
        let name = std::fs::read_to_string(state_dir.join("theme.name"))
            .unwrap_or_else(|_| "omarchy".to_string())
            .trim()
            .to_string();

        return Some(OmarchyTheme {
            name,
            mode: values
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "dark".to_string()),
            accent: color(&values, "accent", "#7daea3"),
            selection: color(&values, "selection", "#504945"),
            muted: color(&values, "muted", "#665c54"),
            background: color(&values, "background", "#282828"),
            dark_background: color(&values, "dark_background", "#1e1e1e"),
            darker_background: color(&values, "darker_background", "#161616"),
            lighter_background: color(&values, "lighter_background", "#3c3836"),
            foreground: color(&values, "foreground", "#d4be98"),
            dark_foreground: color(&values, "dark_foreground", "#7c6f64"),
            light_foreground: color(&values, "light_foreground", "#bdae93"),
            red: color(&values, "red", "#ea6962"),
            yellow: color(&values, "yellow", "#d8a657"),
        });
    }

    #[cfg(not(target_os = "linux"))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_theme_values() {
        assert_eq!(
            parse_value("accent = \"#7daea3\""),
            Some(("accent", "#7daea3".into()))
        );
    }

    #[test]
    fn rejects_non_hex_css_values() {
        assert!(valid_color("#7daea3"));
        assert!(!valid_color("red"));
        assert!(!valid_color("#12345;"));
    }
}
