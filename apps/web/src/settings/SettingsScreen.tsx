import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me } from "../api/client.js";
import type { LanguagePreference } from "../i18n/languages.js";
import { usePreferences } from "../preferences/context.js";
import type { Preferences } from "../preferences/model.js";
import { useLinearConnection } from "./LinearSettings.js";
import { useMcpSwitches, useMcpTokenDraft } from "./McpSettings.js";
import { DEFAULT_SETTINGS_SECTIONS, SETTINGS_GROUPS } from "./sections.js";
import type { SectionContext, SettingsSection } from "./sections.js";
import "./settings.css";

const anchorOf = () => (typeof window === "undefined" ? "" : window.location.hash.replace(/^#/, ""));

/** A âncora do endereço (`#ia`); acompanha o histórico do navegador (voltar, avançar, endereço colado). */
function useAnchor() {
  const [anchor, setAnchor] = useState(anchorOf);
  useEffect(() => {
    const sync = () => setAnchor(anchorOf());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return anchor;
}

/**
 * Página de configurações (ADR 0028): a navegação das seções à esquerda e uma seção por vez à direita.
 * Cada preferência aplica na hora, sem botão de salvar. A seção aberta fica na âncora do endereço; sem âncora, ou com
 * âncora de seção que a pessoa não vê, abre a primeira disponível.
 */
export function SettingsScreen({ client, me, onConsentChange, sections = DEFAULT_SETTINGS_SECTIONS }: {
  client?: ApiClient | undefined;
  me?: Me | null | undefined;
  onConsentChange?: (() => void) | undefined;
  sections?: readonly SettingsSection[] | undefined;
} = {}) {
  const { t } = useTranslation("settings");
  const { preferences, save, readOnly = false } = usePreferences();
  const mcp = useMcpSwitches(client, me);
  const linear = useLinearConnection(client, me);
  const tokenDraft = useMcpTokenDraft();
  const navRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const anchor = useAnchor();
  // A mensagem aparece na seção da preferência que não foi gravada.
  const [failed, setFailed] = useState<"language" | null>(null);

  const isAdmin = me?.roles.clerk === "admin";
  const visible = sections.filter((section) => section.available({ client, me, isAdmin, linear }));
  const current = visible.find((section) => section.id === anchor) ?? visible[0];

  // O foco vai ao título quando a pessoa troca de seção (a âncora muda); ao abrir a página, ou quando a API termina de
  // carregar e a seção da âncora aparece, fica onde está. Comparar com a âncora anterior (e não "primeira vez") também
  // vale sob `StrictMode`, que roda o efeito duas vezes na montagem.
  const lastAnchor = useRef(anchor);
  useEffect(() => {
    if (lastAnchor.current === anchor) return;
    lastAnchor.current = anchor;
    titleRef.current?.focus();
  }, [anchor]);

  // Na faixa horizontal (tela estreita) a seção aberta fica à vista: a faixa rola até o item atual.
  const currentId = current?.id;
  useLayoutEffect(() => {
    const strip = navRef.current;
    const link = strip?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!strip || !link) return;
    const from = strip.getBoundingClientRect();
    const to = link.getBoundingClientRect();
    if (to.left < from.left) strip.scrollLeft += to.left - from.left;
    else if (to.right > from.right) strip.scrollLeft += to.right - from.right;
  }, [currentId]);

  const lead = current?.lead(t) ?? null;
  const open = useCallback((id: string) => {
    window.location.hash = id;
  }, []);

  const persist = async (section: "language", next: Preferences) => {
    setFailed(null);
    const result = await save(next);
    if (!result.ok) setFailed(section);
  };
  const chooseLanguage = async (value: LanguagePreference) => {
    if (readOnly || value === preferences.language) return;
    await persist("language", { ...preferences, language: value });
  };

  const context: SectionContext = { t, client, me, isAdmin, preferences, chooseLanguage, languageFailed: failed === "language", preferencesReadOnly: readOnly, mcp, linear, tokenDraft, onConsentChange, titleId, open };

  return (
    <div className="settings-screen">
      <div className="settings-layout">
        <div className="settings-side">
          <h1>{t("title")}</h1>
          <nav ref={navRef} className="settings-nav" aria-label={t("nav.label")}>
            {SETTINGS_GROUPS.map((group) => {
              const inGroup = visible.filter((section) => section.group === group);
              if (inGroup.length === 0) return null;
              return (
                <div key={group} className="settings-nav-group">
                  <span id={`${titleId}-${group}`} className="settings-nav-heading">{t(`nav.group.${group}`)}</span>
                  <ul aria-labelledby={`${titleId}-${group}`}>
                    {inGroup.map((section) => (
                      <li key={section.id}>
                        <a href={`#${section.id}`} aria-current={section.id === current?.id ? "page" : undefined}>
                          {(section.navLabel ?? section.title)(t)}
                          {section.adminTag && isAdmin && <>{" "}<small className="settings-nav-tag">{t("nav.admin")}</small></>}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </nav>
        </div>
        {current && (
          <section key={current.id} className="settings-pane" aria-labelledby={titleId}>
            <div className="settings-pane-inner">
              <h2 id={titleId} ref={titleRef} tabIndex={-1} className="settings-pane-title">{current.title(t)}</h2>
              {lead !== null && <p className="settings-lead">{lead}</p>}
              {current.render(context)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
