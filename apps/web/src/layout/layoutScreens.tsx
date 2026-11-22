import { useState } from "react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { render } from "vitest-browser-react";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import type { ActivityEntry, ApiClient, Contribution, TicketDetail } from "../api/client.js";
import { IdeasScreen } from "../ideas/IdeasScreen.js";
import { resetIdeasSession } from "../ideas/session.js";
import { ImportScreen } from "../import/ImportScreen.js";
import { OrganizationMap } from "../map/OrganizationMap.js";
import { TenantHeader } from "../nav/TenantHeader.js";
import type { View } from "../nav/navigation.js";
import { makePanelMe, makePerson, makeTeam } from "../panel/testing.js";
import { SettingsScreen } from "../settings/SettingsScreen.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import { TeamsScreen } from "../teams/TeamsScreen.js";
import { fakeToken, makeClient, makeMe, makeProject, makeTicket, makeToken, makeTreeClient, ok } from "../test/fakes.js";

/**
 * As telas principais montadas como o `AuthenticatedApp` as monta (cabeçalho + tela dentro de `.tenant-shell`, em `#root`),
 * com o seletor da organização e o avatar do Clerk trocados por botões de mesmo tamanho e mesmas classes `cl-*`.
 * Usado pelas suítes de navegador do layout (TREEPM-231): a estreita e a de desktop inalterado.
 */
export type LayoutScreen = "map" | "ticket" | "teams" | "settings" | "import" | "ideas";

// Textos do Clerk trocados por botões: não são da interface do TreePM.
const STUB = { org: "Organização de Teste Ltda", status: "Administrador", account: "Conta" };
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const ana = { id: "person-1", displayName: "Ana Souza", avatarUrl: null };
const bruno = { id: "person-2", displayName: "Bruno Lima", avatarUrl: null };
const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const LONG = "Texto longo de comentário com uma linha comprida sem quebra https://exemplo.com/um/caminho/muito/longo/que/nao/quebra/nunca/ate/a/borda e mais algumas palavras para quebrar a linha.";

const design: Contribution = { id: "k1", area: { id: "a1", name: "Design" }, commentCount: 1, text: "Telas de **login** e de erro, com uma descrição um pouco mais comprida para ocupar mais de uma linha.", status: "in_progress", people: [ana, bruno] };
const dados: Contribution = { id: "k2", area: { id: "a2", name: "Dados" }, commentCount: 0, text: "", status: "todo", people: [] };

function ticketClient(): ApiClient {
  const base = makeTreeClient({
    projects: [project],
    tickets: {
      p1: [
        makeTicket("t1", "p1", 1, "Tela de acesso por token com um título bem comprido para quebrar linha no celular", { key: "ALFA-1", status: "in_progress" }),
        makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2" }),
        makeTicket("t3", "p1", 3, "Filho do primeiro", { key: "ALFA-3", parentId: "t1" }),
      ],
    },
    people: [makePerson("person-1", "Ana Souza"), makePerson("person-2", "Bruno Lima")],
    areas: [{ id: "a1", name: "Design" }, { id: "a2", name: "Dados" }, { id: "a3", name: "Engenharia" }],
  });
  const entries: ActivityEntry[] = [
    { id: "c1", type: "comment", occurredAt: at(5), actor: ana, body: LONG, editedAt: null, removed: false, canEdit: true, canRemove: true, area: { id: "a1", name: "Design" } },
    { id: "c2", type: "comment", occurredAt: at(50), actor: bruno, body: "Comentário curto", editedAt: null, removed: false, canEdit: true, canRemove: true, area: null },
  ] as ActivityEntry[];
  const original = base.getTicket;
  return Object.assign(base, {
    getTicket: vi.fn(async (id: string) =>
      ok<TicketDetail>({
        ...(await original(id).then((r) => (r.ok ? r.data : ({} as TicketDetail)))),
        description: "Fluxo de acesso com token por projeto. " + LONG,
        contributions: [design, dados],
        canEditContributions: true,
      }),
    ),
    ticketActivity: vi.fn(async () => ok({ entries, before: null, canComment: true })),
  });
}

function mapClient(): ApiClient {
  const client = makeTreeClient({
    projects: [project],
    tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress" }), makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2" })] },
    people: [makePerson("person-1", "Ana")],
  });
  Object.assign(client, { askProject: vi.fn(async () => ok({ text: "Faltam dois itens: ALFA-2 e ALFA-3, com uma resposta um pouco comprida para ocupar a folha toda no celular.", model: "claude-opus-5-5" })) });
  return client;
}

function ideasClient(): ApiClient {
  const stage = (value: "new" | "refining" | "ready" | "discarded") => ({ idea: { root: true as const, stage: value } });
  return makeTreeClient({
    projects: [project, makeProject("p2", "BETA", "Projeto Beta com um nome comprido")],
    tickets: {
      p1: [
        makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1" }),
        makeTicket("t2", "p1", 2, "Login com Google e outras formas de entrar", { key: "ALFA-2", parentId: "t1" }),
        makeTicket("i1", "p1", 3, "Exportar relatórios em CSV com os filtros da tela e o período escolhido pela pessoa", { key: "ALFA-3", parentId: "t2", ...stage("ready") }),
        makeTicket("i2", "p1", 4, "Modo escuro", { key: "ALFA-4", ...stage("refining") }),
        makeTicket("i3", "p1", 5, "Notificações por e-mail", { key: "ALFA-5", ...stage("new") }),
        makeTicket("i4", "p1", 6, "Painel antigo de métricas", { key: "ALFA-6", ...stage("discarded") }),
      ],
      p2: [],
    },
  });
}

function Shell({ view, children }: { view: View; children: ReactNode }) {
  const [current, setCurrent] = useState(view);
  return (
    <div className="tenant-shell">
      <TenantHeader view={current} onNavigate={setCurrent}>
        <button type="button" className="cl-organizationSwitcherTrigger" style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 10px", border: 0, borderRadius: 6, background: "transparent", color: "inherit", font: "500 14px var(--tp-font)" }}>
          <span aria-hidden style={{ flex: "none", width: 24, height: 24, borderRadius: 6, background: "#7c5cff" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{STUB.org}</span>
        </button>
        <span className="tenant-api-status" role="status">{STUB.status}</span>
        <button type="button" className="cl-userButtonTrigger" aria-label={STUB.account} style={{ width: 28, height: 28, padding: 0, border: 0, borderRadius: "50%", background: "#3a4767" }} />
      </TenantHeader>
      {children}
    </div>
  );
}

function MapScreen({ client, openTicket, assistant }: { client: ApiClient; openTicket: string | null; assistant: boolean }) {
  const [openId, setOpenId] = useState<string | null>(openTicket);
  return (
    <Shell view="map">
      <main className="tenant-map">
        <OrganizationMap client={client} me={assistant ? { ...makePanelMe("admin"), assistant: { enabled: true } } : makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
      </main>
    </Shell>
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

/** Monta a tela pedida em `#root` e espera ela ficar pronta; devolve o controle de render e a limpeza. */
export async function renderScreen(name: LayoutScreen, options: { assistant?: boolean } = {}) {
  document.getElementById("root")?.remove();
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const me = makeMe({ mcp: true, mcpWrite: true });
  const client = makeClient({
    me,
    projects: [project],
    teams: [makeTeam("team1", "Plataforma"), makeTeam("team2", "Produto")],
    people: [makePerson("person-1", "Ana Souza"), makePerson("person-2", "Bruno Lima")],
    mcp: { secret: fakeToken("s"), tokens: [makeToken("a", "Coordenação", { scope: "write" }), makeToken("b", "Leitor do Cursor com nome comprido", { scope: "read" })] },
  });
  let ui: ReactNode;
  if (name === "map") ui = <MapScreen client={mapClient()} openTicket={null} assistant={options.assistant === true} />;
  else if (name === "ticket") ui = <MapScreen client={ticketClient()} openTicket="t1" assistant={options.assistant === true} />;
  else if (name === "teams") ui = <Shell view="teams"><TeamsScreen client={client} me={makePanelMe("admin")} /></Shell>;
  else if (name === "ideas") {
    resetIdeasSession();
    ui = <Shell view="ideas"><IdeasScreen client={ideasClient()} me={makePanelMe("admin")} onOpenIdea={vi.fn()} onShowOnMap={vi.fn()} /></Shell>;
  } else if (name === "settings") ui = <Shell view="settings"><main className="tenant-settings"><MemoryPreferencesProvider onSave={vi.fn()}><SettingsScreen client={client} me={me} /></MemoryPreferencesProvider></main></Shell>;
  else ui = <Shell view="map"><ImportScreen client={client} me={makePanelMe("admin")} projectId="p1" onExit={vi.fn()} /></Shell>;
  const screen = await render(ui, { container: root, baseElement: document.body });
  if (name === "map") {
    await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
    // Em tela estreita o painel de áreas e projetos abre por cima do mapa ao escolher o projeto: fecha-se pelo botão do topo antes de explorar o ramo.
    if (window.innerWidth <= 720 && document.querySelector(".side-panel")) document.querySelector<HTMLElement>(".map-panel-toggle")!.click();
    await screen.getByRole("button", { name: "Explorar ramo" }).click();
    await settle();
  }
  if (name === "ticket") await screen.getByRole("region", { name: "Áreas" }).element();
  if (name === "teams") await screen.getByRole("heading", { level: 1 }).element();
  if (name === "ideas") await screen.getByRole("button", { name: "Aceitar ALFA-3" }).element();
  if (name === "settings") await screen.getByRole("heading", { level: 1 }).element();
  if (name === "import") await screen.getByRole("heading", { level: 1, name: "Importar lista" }).element();
  await settle();
  return { screen, root };
}
