import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me } from "../api/client.js";
import { githubEnabled } from "../api/client.js";
import { GithubSettings } from "../github/GithubSettings.js";
import { LANGUAGE_PREFERENCES } from "../i18n/languages.js";
import type { LanguagePreference } from "../i18n/languages.js";
import { usePreferences } from "../preferences/context.js";
import type { Preferences, TicketCloseCamera } from "../preferences/model.js";
import "./settings.css";

const CAMERA_OPTIONS: readonly TicketCloseCamera[] = ["restore", "stay"];

/** Página de configurações (ADR 0028): seções por assunto; cada preferência aplica na hora, sem botão de salvar. */
export function SettingsScreen({ client, me }: { client?: ApiClient | undefined; me?: Me | null | undefined } = {}) {
  const { t } = useTranslation("settings");
  const { preferences, save } = usePreferences();
  // A mensagem aparece na seção da preferência que não foi gravada.
  const [failed, setFailed] = useState<"camera" | "language" | null>(null);

  const persist = async (section: "camera" | "language", next: Preferences) => {
    setFailed(null);
    const result = await save(next);
    if (!result.ok) setFailed(section);
  };
  const choose = async (value: TicketCloseCamera) => {
    if (value === preferences.camera.onTicketClose) return;
    await persist("camera", { ...preferences, camera: { ...preferences.camera, onTicketClose: value } });
  };
  const chooseLanguage = async (value: LanguagePreference) => {
    if (value === preferences.language) return;
    await persist("language", { ...preferences, language: value });
  };

  return (
    <div className="settings-screen">
      <h1>{t("title")}</h1>
      <section aria-labelledby="settings-camera">
        <h2 id="settings-camera">{t("camera.title")}</h2>
        <div role="radiogroup" aria-labelledby="settings-camera-close" className="settings-group">
          <span id="settings-camera-close" className="settings-label">{t("camera.onTicketClose.label")}</span>
          {CAMERA_OPTIONS.map((option) => (
            <label key={option} className="settings-option">
              <input
                type="radio"
                name="camera-on-ticket-close"
                checked={preferences.camera.onTicketClose === option}
                onChange={() => void choose(option)}
              />
              {t(`camera.onTicketClose.${option}`)}
            </label>
          ))}
        </div>
        {failed === "camera" && <p role="alert" className="settings-error">{t("saveFailed")}</p>}
      </section>
      <section aria-labelledby="settings-language">
        <h2 id="settings-language">{t("language.title")}</h2>
        <div role="radiogroup" aria-labelledby="settings-language-choice" className="settings-group">
          <span id="settings-language-choice" className="settings-label">{t("language.label")}</span>
          {LANGUAGE_PREFERENCES.map((option) => (
            <label key={option} className="settings-option">
              <input
                type="radio"
                name="interface-language"
                checked={preferences.language === option}
                onChange={() => void chooseLanguage(option)}
              />
              {t(`language.${option}`)}
            </label>
          ))}
        </div>
        {failed === "language" && <p role="alert" className="settings-error">{t("saveFailed")}</p>}
      </section>
      {client && me && githubEnabled(me) && <GithubSettings client={client} me={me} />}
    </div>
  );
}
