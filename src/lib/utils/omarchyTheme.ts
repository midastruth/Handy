import { commands, type OmarchyTheme } from "@/bindings";

const THEME_REFRESH_INTERVAL = 2_000;
let lastTheme = "";

const applyOmarchyTheme = (theme: OmarchyTheme): void => {
  const signature = JSON.stringify(theme);
  if (signature === lastTheme) return;
  lastTheme = signature;

  const root = document.documentElement;
  root.dataset.omarchyTheme = theme.name;
  root.style.colorScheme = theme.mode === "light" ? "light" : "dark";

  const properties: Record<string, string> = {
    "--color-text": theme.foreground,
    "--color-background": theme.background,
    "--color-background-ui": theme.accent,
    "--color-logo-primary": theme.accent,
    "--color-logo-stroke": theme.light_foreground,
    "--color-text-stroke": theme.darker_background,
    "--color-mid-gray": theme.light_foreground,
    "--color-warning": theme.yellow,
    "--color-error": theme.red,
    "--color-omarchy-selection": theme.selection,
    "--color-omarchy-muted": theme.muted,
    "--color-omarchy-surface": theme.lighter_background,
    "--color-omarchy-sidebar": theme.dark_background,
    "--color-omarchy-deep": theme.darker_background,
  };

  Object.entries(properties).forEach(([property, value]) => {
    root.style.setProperty(property, value);
  });
};

const refreshOmarchyTheme = async (): Promise<void> => {
  try {
    const theme = await commands.getOmarchyTheme();
    if (theme) applyOmarchyTheme(theme);
  } catch {
    // The command is intentionally optional so frontend-only development and
    // non-Omarchy platforms continue to use Handy's standard palette.
  }
};

/** Keep Handy in sync when `omarchy theme set` changes the active palette. */
export const startOmarchyThemeSync = (): void => {
  void refreshOmarchyTheme();
  window.setInterval(() => {
    if (document.visibilityState === "visible") void refreshOmarchyTheme();
  }, THEME_REFRESH_INTERVAL);
  window.addEventListener("focus", () => void refreshOmarchyTheme());
};
