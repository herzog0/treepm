import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createApiClient } from "./api/client.js";
import { AdminProvider } from "./api/ConsentRequired.js";
import { useApiResource } from "./api/useApiResource.js";
import { LoadError } from "./LoadError.js";
import { IdeasScreen } from "./ideas/IdeasScreen.js";
import { ImportScreen } from "./import/ImportScreen.js";
import { OrganizationMap } from "./map/OrganizationMap.js";
import type { NavigateFn, View } from "./nav/navigation.js";
import { scheduleDescriptionEditorPreload } from "./ticket/description/RichDescription.js";
import { SettingsScreen } from "./settings/SettingsScreen.js";
import { TeamsScreen } from "./teams/TeamsScreen.js";

export interface WorkspaceProps {
  orgId: string;
  view: View;
  /** Projeto da tela de importação (`?view=import&project=<id>`). */
  projectId?: string | null;
  /** Troca de tela feita de dentro do espaço de trabalho; a URL e o histórico são de quem a fornece. */
  onNavigate?: NavigateFn;
  /** Ticket aberto na página do mapa (`?ticket=<id>`); a URL e o histórico são de quem o fornece. */
  ticketId?: string | null;
  onOpenTicket?: (ticketId: string | null) => void;
  /** Ticket a que a câmera vai ao chegar no mapa ("Ver no mapa" da tela "Ideias"); `onFocusHandled` tira o pedido da URL. */
  focusTicketId?: string | null;
  onFocusHandled?: () => void;
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

function OrganizationWorkspace({ view, projectId = null, onNavigate, ticketId, onOpenTicket, focusTicketId, onFocusHandled, getToken, fetch: fetchImpl }: Omit<WorkspaceProps, "orgId">) {
  const { t } = useTranslation();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const client = useMemo(
    () => createApiClient({ getToken: () => getTokenRef.current(), ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    [fetchImpl],
  );
  const { state, retry, reload } = useApiResource(() => client.getMe());

  // Com o mapa ocioso, o editor da descrição começa a baixar em segundo plano: o primeiro ticket abre sem espera (e o mapa não o espera).
  useEffect(() => (view === "map" ? scheduleDescriptionEditorPreload() : undefined), [view]);

  // As configurações são da pessoa, não da organização: não esperam a API.
  if (view === "settings") return <main className="tenant-settings"><SettingsScreen client={client} me={state.status === "ready" ? state.data : null} onConsentChange={reload} /></main>;
  if (state.status === "loading") return <p className="map-state" role="status">{t("loading.organization")}</p>;
  if (state.status === "error") {
    return (
      <div className="map-state">
        <LoadError error={state.error} onRetry={retry} />
      </div>
    );
  }
  if (view === "teams") return <TeamsScreen client={client} me={state.data} />;
  if (view === "ideas") {
    return (
      <IdeasScreen
        client={client}
        me={state.data}
        onOpenIdea={(id) => onNavigate?.("map", null, { ticketId: id })}
        onShowOnMap={(id) => onNavigate?.("map", null, { focusId: id })}
      />
    );
  }
  if (view === "import") {
    return <ImportScreen client={client} me={state.data} projectId={projectId} onExit={() => onNavigate?.("map")} />;
  }
  return (
    <AdminProvider isAdmin={state.data.roles.clerk === "admin"}>
    <main className="tenant-map">
      <OrganizationMap
        client={client}
        me={state.data}
        {...(onNavigate ? { onImport: (id: string) => onNavigate("import", id) } : {})}
        {...(ticketId !== undefined && onOpenTicket ? { openTicketId: ticketId, onOpenTicketChange: onOpenTicket } : {})}
        {...(focusTicketId && onFocusHandled ? { focusTicketId, onFocusHandled } : {})}
      />
    </main>
    </AdminProvider>
  );
}

/**
 * Tudo o que vem da API fica abaixo desta fronteira, com `key={orgId}`: trocar de organização
 * descarta o estado (mapa, painel, times) e busca tudo de novo.
 */
export function Workspace({ orgId, ...props }: WorkspaceProps) {
  return <OrganizationWorkspace key={orgId} {...props} />;
}
