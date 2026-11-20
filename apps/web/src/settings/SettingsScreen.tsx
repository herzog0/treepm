import { useState } from "react";
import { usePreferences } from "../preferences/context.js";
import type { TicketCloseCamera } from "../preferences/model.js";
import "./settings.css";

const OPTIONS: readonly { value: TicketCloseCamera; label: string }[] = [
  { value: "restore", label: "Voltar ao lugar de antes" },
  { value: "stay", label: "Ficar onde está" },
];

/** Página de configurações (ADR 0028): seções por assunto; cada preferência aplica na hora, sem botão de salvar. */
export function SettingsScreen() {
  const { preferences, save } = usePreferences();
  const [failed, setFailed] = useState(false);

  const choose = async (value: TicketCloseCamera) => {
    if (value === preferences.camera.onTicketClose) return;
    setFailed(false);
    const result = await save({ ...preferences, camera: { ...preferences.camera, onTicketClose: value } });
    if (!result.ok) setFailed(true);
  };

  return (
    <div className="settings-screen">
      <h1>Configurações</h1>
      <section aria-labelledby="settings-camera">
        <h2 id="settings-camera">Câmera</h2>
        <div role="radiogroup" aria-labelledby="settings-camera-close" className="settings-group">
          <span id="settings-camera-close" className="settings-label">Ao fechar um ticket</span>
          {OPTIONS.map((option) => (
            <label key={option.value} className="settings-option">
              <input
                type="radio"
                name="camera-on-ticket-close"
                checked={preferences.camera.onTicketClose === option.value}
                onChange={() => void choose(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>
        {failed && <p role="alert" className="settings-error">Não foi possível salvar a preferência. Tente de novo.</p>}
      </section>
    </div>
  );
}
