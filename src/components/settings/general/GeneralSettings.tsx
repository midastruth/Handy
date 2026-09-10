import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ChannelSelector } from "../ChannelSelector";
import { ShortcutInput } from "../ShortcutInput";
import { SettingContainer } from "../../ui/SettingContainer";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { OutputDeviceSelector } from "../OutputDeviceSelector";
import { ShortcutActivationSetting } from "../ShortcutActivation";
import { AudioFeedback } from "../AudioFeedback";
import { useSettings } from "../../../hooks/useSettings";
import { VolumeSlider } from "../VolumeSlider";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { ModelSettingsCard } from "./ModelSettingsCard";
import { commands } from "@/bindings";

const EXTERNAL_SHORTCUT_CONFIG_PATH = "~/.config/hypr/bindings.lua";

export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { audioFeedbackEnabled } = useSettings();
  const [usesExternalShortcuts, setUsesExternalShortcuts] = useState(false);
  const isLinux = type() === "linux";

  useEffect(() => {
    commands
      .usesExternalShortcuts()
      .then(setUsesExternalShortcuts)
      .catch(() => setUsesExternalShortcuts(false));
  }, []);

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.general.title")}>
        {usesExternalShortcuts ? (
          <SettingContainer
            title={t("settings.general.shortcut.bindings.transcribe.name")}
            description={t("settings.general.shortcut.external.description")}
            descriptionMode="inline"
            grouped={true}
            disabled={true}
          >
            <div className="flex flex-col items-end gap-0.5">
              <span className="rounded-md border border-logo-primary/40 bg-logo-primary/10 px-2 py-1 text-sm font-semibold text-logo-primary">
                {t("settings.general.shortcut.external.managedBy")}
              </span>
              <code className="text-[10px] text-mid-gray">
                {EXTERNAL_SHORTCUT_CONFIG_PATH}
              </code>
            </div>
          </SettingContainer>
        ) : (
          <>
            <ShortcutInput shortcutId="transcribe" grouped={true} />
            <ShortcutActivationSetting
              descriptionMode="tooltip"
              grouped={true}
            />
            {/* Cancel shortcut remains hidden on Linux because of dynamic shortcut instability. */}
            {!isLinux && <ShortcutInput shortcutId="cancel" grouped={true} />}
          </>
        )}
      </SettingsGroup>
      <ModelSettingsCard />
      <SettingsGroup title={t("settings.sound.title")}>
        <MicrophoneSelector descriptionMode="tooltip" grouped={true} />
        <ChannelSelector descriptionMode="tooltip" grouped={true} />
        <MuteWhileRecording descriptionMode="tooltip" grouped={true} />
        <AudioFeedback descriptionMode="tooltip" grouped={true} />
        <OutputDeviceSelector
          descriptionMode="tooltip"
          grouped={true}
          disabled={!audioFeedbackEnabled}
        />
        <VolumeSlider disabled={!audioFeedbackEnabled} />
      </SettingsGroup>
    </div>
  );
};
