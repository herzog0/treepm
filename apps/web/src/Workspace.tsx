import { useMemo, useRef } from "react";
import { createApiClient } from "./api/client.js";
import { useApiResource } from "./api/useApiResource.js";
import { LoadError } from "./LoadError.js";
import { ImportScreen } from "./import/ImportScreen.js";
import { OrganizationMap } from "./map/OrganizationMap.js";
import type { View } from "./nav/navigation.js";
import { TeamsScreen } from "./teams/TeamsScreen.js";

export interface WorkspaceProps {
  orgId: string;
  view: View;
  /** Projeto da tela de importação (`?view=import&project=<id>`). */
  projectId?: string | null;
  /** Troca de tela feita de dentro do espaço de trabalho; a URL e o histórico são de quem a fornece. */
  onNavigate?: (view: View, projectId?: string | null) => void;
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

function OrganizationWorkspace({ view, projectId = null, onNavigate, getToken, fetch: fetchImpl }: Omit<WorkspaceProps, "orgId">) {
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const client = useMemo(
    () => createApiClient({ getToken: () => getTokenRef.current(), ...(fetchImpl ? { fetch: fetchImpl } : {}) }),
    [fetchImpl],
  );
  const { state, retry } = useApiResource(() => client.getMe());

  if (state.status === "loading") return <p className="map-state" role="status">Carregando organização…</p>;
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
