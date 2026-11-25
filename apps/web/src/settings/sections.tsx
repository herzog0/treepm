import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import type { ApiClient, Me } from "../api/client.js";
import { aiPrivacyAvailable, githubEnabled, mcpAvailable } from "../api/client.js";
import { GithubSettings } from "../github/GithubSettings.js";
import { LANGUAGE_PREFERENCES } from "../i18n/languages.js";
import type { LanguagePreference } from "../i18n/languages.js";
import type { Preferences } from "../preferences/model.js";
import { AiPrivacySettings } from "./AiPrivacySettings.js";
import { LinearSettings } from "./LinearSettings.js";
import type { LinearState, OpenImport } from "./LinearSettings.js";
import { PeopleSettings, peopleAvailable } from "./PeopleSettings.js";
import { McpAccessSection, McpTokensSection } from "./McpSettings.js";
import type { McpSwitches, McpTokenDraft } from "./McpSettings.js";
import { SettingsCard, SettingsNote } from "./parts.js";

export type SettingsGroup = "you" | "organization" | "integrations";
/** A ordem dos grupos na navegação. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["you", "organization", "integrations"];

/** O que a casca entrega a cada seção. */
export interface SectionContext {
  t: TFunction<"settings">;
  client: ApiClient | undefined;
  me: Me | null | undefined;
  isAdmin: boolean;
  preferences: Preferences;
  chooseLanguage: (value: LanguagePreference) => Promise<void>;
  languageFailed: boolean;
  /** Vendo como outra pessoa: a preferência é da conta do administrador e só se lê. */
  preferencesReadOnly: boolean;
  mcp: McpSwitches;
  /** A chave do Linear da pessoa e se o servidor o tem configurado (ADR 0060). */
  linear: LinearState;
  tokenDraft: McpTokenDraft;
  /** Abre a importação do Linear de um projeto (a casca leva à tela, no projeto certo). */
  onOpenImport: OpenImport | undefined;
  onConsentChange: (() => void) | undefined;
  /** Id do título da seção aberta (para nomear listas e grupos). */
  titleId: string;
  /** Abre outra seção. */
  open: (id: string) => void;
}

/**
 * Uma seção das Configurações. A casca (`SettingsScreen`) só conhece este contrato: uma seção nova entra no
 * registro (`DEFAULT_SETTINGS_SECTIONS`) sem mexer nela. `id` é a âncora do endereço (`#idioma`).
 */
export interface SettingsSection {
  id: string;
  group: SettingsGroup;
  title: (t: TFunction<"settings">) => string;
  /** O nome na navegação, quando é mais curto que o título (a navegação lateral não quebra linha). */
  navLabel?: (t: TFunction<"settings">) => string;
  /** A frase que diz para que serve a seção; `null` não mostra frase (IA e privacidade: o texto legal é só o que já existia). */
  lead: (t: TFunction<"settings">) => string | null;
  /** Marca "admin" ao lado do nome (só aparece para quem é administrador). */
  adminTag: boolean;
  available: (context: Pick<SectionContext, "client" | "me" | "isAdmin" | "linear">) => boolean;
  render: (context: SectionContext) => ReactNode;
}

const withApi = (context: Pick<SectionContext, "client" | "me">) => context.client !== undefined && context.me != null;

/* O texto "GitHub" vem do catálogo do próprio GitHub (`github:title`), igual ao de antes. */
export const DEFAULT_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "idioma",
    group: "you",
    title: (t) => t("language.title"),
    lead: (t) => t("sections.language.lead"),
    adminTag: false,
    available: () => true,
    render: ({ t, preferences, chooseLanguage, languageFailed, preferencesReadOnly }) => (
      <SettingsCard title={t("language.label")} titleId="settings-language-choice">
        <div role="radiogroup" aria-labelledby="settings-language-choice" className="settings-group settings-card-body">
          {LANGUAGE_PREFERENCES.map((option) => (
            <label key={option} className="settings-option">
              <input type="radio" name="interface-language" checked={preferences.language === option} disabled={preferencesReadOnly} onChange={() => void chooseLanguage(option)} />
              {t(`language.${option}`)}
            </label>
          ))}
        </div>
        {preferencesReadOnly && <SettingsNote>{t("language.readOnlyActingAs")}</SettingsNote>}
        {languageFailed && <SettingsNote role="alert" tone="error">{t("saveFailed")}</SettingsNote>}
      </SettingsCard>
    ),
  },
  {
    id: "tokens",
    group: "you",
    title: (t) => t("mcp.own.title"),
    lead: (t) => t("sections.tokens.lead"),
    adminTag: false,
    available: (context) => withApi(context) && mcpAvailable(context.me!),
    render: ({ client, me, mcp, tokenDraft, titleId }) => <McpTokensSection client={client!} me={me!} mcp={mcp} draft={tokenDraft} titleId={titleId} />,
  },
  {
    id: "pessoas",
    group: "organization",
    title: (t) => t("people.title"),
    lead: (t) => t("people.lead"),
    adminTag: true,
    available: (context) => withApi(context) && peopleAvailable(context),
    render: ({ client, me, titleId }) => <PeopleSettings client={client!} me={me!} titleId={titleId} />,
  },
  {
    id: "ia",
    group: "organization",
    title: (t) => t("ai.title"),
    lead: () => null,
    adminTag: true,
    available: (context) => withApi(context) && aiPrivacyAvailable(context.me!),
    render: ({ client, me, onConsentChange }) => <AiPrivacySettings client={client!} me={me!} onChange={onConsentChange} />,
  },
  {
    id: "github",
    group: "integrations",
    title: (t) => t("title", { ns: "github" }),
    lead: (t) => t("sections.github.lead"),
    adminTag: true,
    available: (context) => withApi(context) && githubEnabled(context.me!),
    render: ({ client, me }) => <GithubSettings client={client!} me={me!} />,
  },
  {
    id: "mcp",
    group: "integrations",
    title: (t) => t("mcp.title"),
    navLabel: (t) => t("nav.mcp"),
    lead: (t) => t("sections.mcp.lead"),
    adminTag: true,
    available: (context) => withApi(context) && mcpAvailable(context.me!),
    render: ({ client, me, mcp, open }) => <McpAccessSection client={client!} me={me!} mcp={mcp} onOpenTokens={() => open("tokens")} />,
  },
  {
    id: "linear",
    group: "integrations",
    title: (t) => t("linear.title"),
    lead: (t) => t("sections.linear.lead"),
    adminTag: false,
    available: (context) => withApi(context) && context.linear.configured,
    render: ({ client, me, linear, onOpenImport }) => <LinearSettings client={client!} me={me!} linear={linear} onOpenImport={onOpenImport} />,
  },
];
