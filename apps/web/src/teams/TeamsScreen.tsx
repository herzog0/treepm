import type { ApiClient, Me } from "../api/client.js";

export interface TeamsScreenProps {
  client: ApiClient;
  me: Me;
}

/** Casca desta fatia: outro executor preenche a gestão de times. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function TeamsScreen(_props: TeamsScreenProps) {
  return (
    <main className="teams-screen">
      <h1>Times</h1>
    </main>
  );
}
