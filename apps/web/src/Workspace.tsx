import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createApiClient } from "./api/client.js";
import { useApiResource } from "./api/useApiResource.js";
import { LoadError } from "./LoadError.js";
import { ImportScreen } from "./import/ImportScreen.js";
import { OrganizationMap } from "./map/OrganizationMap.js";
import type { View } from "./nav/navigation.js";
import { SettingsScreen } from "./settings/SettingsScreen.js";
import { TeamsScreen } from "./teams/TeamsScreen.js";

export interface WorkspaceProps {
  orgId: string;
  view: View;
  /** Projeto da tela de importação (`?view=import&project=<id>`). */
  projectId?: string | null;
  /** Troca de tela feita de dentro do espaço de trabalho; a URL e o histórico são de quem a fornece. */
  onNavigate?: (view: View, projectId?: string | null) => void;
  /** Ticket aberto na página do mapa (`?ticket=<id>`); a URL e o histórico são de quem o fornece. */
  ticketId?: string | null;
  onOpenTicket?: (ticketId: string | null) => void;
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

function OrganizationWorkspace({ view, projectId = null, onNavigate, ticketId, onOpenTicket, getToken, fetch: fetchImpl }: Omit<WorkspaceProps, "orgId">) {
  const { t } = useTranslation();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const client = useMemo(
    () => createApiClient({ getToken: () => getTokenRef.current(), ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    [fetchImpl],
  );
  const { state, retry } = useApiResource(() => client.getMe());

  // As configurações são da pessoa, não da organização: não esperam a API.
  if (view === "settings") return <main className="tenant-settings"><SettingsScreen client={client} me={state.status === "ready" ? state.data : null} /></main>;
  if (state.status === "loading") return <p className="map-state" role="status">{t("loading.organization")}</p>;
  if (state.status === "error") {
    return (
      <div className="map-state">
        <LoadError error={state.error} onRetry={retry} />
      </div>
    );
  }
  if (view === "teams") return <TeamsScreen client={client} me={state.data} />;
  if (view === "import") {
    return <ImportScreen client={client} me={state.data} projectId={projectId} onExit={() => onNavigate?.("map")} />;
  }
  return (
    <main className="tenant-map">
      <OrganizationMap
        client={client}
        me={state.data}
        {...(onNavigate ? { onImport: (id: string) => onNavigate("import", id) } : {})}
        {...(ticketId !== undefined && onOpenTicket ? { openTicketId: ticketId, onOpenTicketChange: onOpenTicket } : {})}
      />
    </main>
  );
}

/**
 * Tudo o que vem da API fica abaixo desta fronteira, com `key={orgId}`: trocar de organização
 * descarta o estado (mapa, painel, times) e busca tudo de novo.
 */
export function Workspace({ orgId, ...props }: WorkspaceProps) {
  return <OrganizationWorkspace key={orgId} {...props} />;
}
