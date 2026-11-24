import { useUser } from "@clerk/react";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useActAs } from "../people/ActAs.js";
import { PreferencesProvider } from "./context.js";
import type { SaveResult } from "./context.js";
import { parsePreferences, withPreferences } from "./model.js";
import type { Preferences } from "./model.js";

/**
 * Preferências no `unsafeMetadata` do usuário do Clerk (ADR 0028). A leitura vem com o usuário já carregado; a
 * gravação usa `updateMetadata`, e o valor novo chega de volta pelo próprio `useUser`.
 */
export function ClerkPreferencesProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const readOnly = useActAs().acting !== null;
  const metadata = user?.unsafeMetadata;
  const preferences = useMemo(() => parsePreferences(metadata), [metadata]);
  const save = useCallback(async (next: Preferences): Promise<SaveResult> => {
    if (!user || readOnly) return { ok: false };
    try {
      await user.updateMetadata({ unsafeMetadata: withPreferences({ ...user.unsafeMetadata }, next) });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }, [user, readOnly]);
  const value = useMemo(() => ({ preferences, save, readOnly }), [preferences, save, readOnly]);
  return <PreferencesProvider value={value}>{children}</PreferencesProvider>;
}
