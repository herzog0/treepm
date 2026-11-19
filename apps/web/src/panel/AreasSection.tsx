import type { ApiClient, Me, Project } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";

export interface AreasSectionProps {
  client: ApiClient;
  me: Me;
  selectedProject: Project | null;
  onChanged: () => void;
}

/** Nesta fatia: só a lista somente leitura. Criação e edição entram em outra tarefa. */
export function AreasSection({ client }: AreasSectionProps) {
  const { state, retry } = useApiResource(() => client.listAreas());

  return (
    <section aria-labelledby="areas-title">
      <h2 id="areas-title">Áreas</h2>
      {state.status === "loading" && <p role="status">Carregando áreas…</p>}
      {state.status === "error" && <LoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" &&
        (state.data.length === 0 ? (
          <p>Nenhuma área cadastrada.</p>
        ) : (
          <ul className="panel-list">
            {state.data.map((area) => (
              <li key={area.id}>{area.name}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}
