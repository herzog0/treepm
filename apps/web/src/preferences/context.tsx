import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_PREFERENCES } from "./model.js";
import type { Preferences } from "./model.js";

export type SaveResult = { ok: true } | { ok: false };

export interface PreferencesApi {
  readonly preferences: Preferences;
  /** Grava as preferências. Em falha, o valor anterior continua valendo. */
  save: (next: Preferences) => Promise<SaveResult>;
  /** Vendo como outra pessoa (ADR 0057): as preferências são da conta do administrador e não se mudam por ali. */
  readonly readOnly?: boolean;
}

// Sem provedor (demo, testes isolados): o padrão, e gravar não faz nada.
const PreferencesContext = createContext<PreferencesApi>({ preferences: DEFAULT_PREFERENCES, save: async () => ({ ok: true }) });

export const PreferencesProvider = PreferencesContext.Provider;

/** Único ponto de leitura e escrita das preferências. O mapa nunca espera a leitura: sem dado, vale o padrão. */
export const usePreferences = (): PreferencesApi => useContext(PreferencesContext);

/** Implementação em memória, para testes e para o harness do navegador. */
export function MemoryPreferencesProvider({ initial = DEFAULT_PREFERENCES, failSave = false, readOnly = false, onSave, children }: {
  initial?: Preferences;
  failSave?: boolean;
  readOnly?: boolean;
  onSave?: (next: Preferences) => void;
  children: ReactNode;
}) {
  const [preferences, setPreferences] = useState(initial);
  const save = useCallback(async (next: Preferences): Promise<SaveResult> => {
    onSave?.(next);
    if (failSave) return { ok: false };
    setPreferences(next);
    return { ok: true };
  }, [failSave, onSave]);
  const value = useMemo(() => ({ preferences, save, readOnly }), [preferences, save, readOnly]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
