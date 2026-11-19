import { useMemo, useRef } from "react";
import { createApiClient } from "./api/client.js";
import { useApiResource } from "./api/useApiResource.js";
import { LoadError } from "./LoadError.js";
import { OrganizationMap } from "./map/OrganizationMap.js";
import type { View } from "./nav/navigation.js";
import { TeamsScreen } from "./teams/TeamsScreen.js";

export interface WorkspaceProps {
  orgId: string;
  view: View;
  getToken: () => Promise<string | null>;
  fetch?: typeof fetch;
}

function OrganizationWorkspace({ view, getToken, fetch: fetchImpl }: Omit<WorkspaceProps, "orgId">) {
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
  return view === "teams" ? (
    <TeamsScreen client={client} me={state.data} />
  ) : (
    <main className="tenant-map">
      <OrganizationMap client={client} me={state.data} />
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
