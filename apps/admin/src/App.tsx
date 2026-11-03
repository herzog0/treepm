import { useEffect, useMemo, useState } from "react";
import { getProgress } from "@treepm/domain";
import type { BootstrapData, Project, Ticket, User } from "@treepm/domain";

type Section = "overview" | "projects" | "tickets" | "users";
const labels = { todo: "A fazer", in_progress: "Em andamento", done: "Concluído" };

export function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/api/bootstrap").then((response) => {
      if (!response.ok) throw new Error(`API respondeu ${response.status}`);
      return response.json() as Promise<BootstrapData>;
    }).then(setData).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Falha ao carregar."));
  }, []);
  const filteredTickets = useMemo(() => data?.tickets.filter((ticket) => `${ticket.title} ${ticket.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [], [data, query]);
  if (!data) return <main className="admin-loading"><div className="admin-logo">T</div><h1>TreePM Backoffice</h1>{error ? <p className="error">{error}. Inicie a API na porta 3001.</p> : <p>Carregando dados da plataforma…</p>}</main>;
  const leaves = data.tickets.filter((ticket) => !data.tickets.some((item) => item.parentId === ticket.id));
  return <div className="admin-shell">
    <aside className="admin-sidebar"><div className="admin-brand"><div className="admin-logo">T</div><div><strong>TreePM</strong><span>BACKOFFICE</span></div></div><nav>{([{ id: "overview", label: "Visão geral", icon: "◫" }, { id: "projects", label: "Projetos", icon: "◇" }, { id: "tickets", label: "Tickets", icon: "≡" }, { id: "users", label: "Usuários seed", icon: "○" }] as const).map((item) => <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => setSection(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav><div className="environment"><span /><div><strong>Ambiente local</strong><small>JSON · sem autenticação</small></div></div></aside>
    <main className="admin-main"><header><div><span className="admin-eyebrow">PLATAFORMA / {section.toUpperCase()}</span><h1>{{ overview: "Visão geral", projects: "Projetos", tickets: "Tickets", users: "Usuários seed" }[section]}</h1></div><a href="http://localhost:5173" target="_blank" rel="noreferrer">Abrir plataforma ↗</a></header>
      <div className="auth-warning"><strong>Ambiente de desenvolvimento</strong><span>Autenticação e autorização ainda não existem. Não exponha este backoffice ou a API.</span></div>
      {section === "overview" && <Overview data={data} leafCount={leaves.length} onNavigate={setSection} />}
      {section === "projects" && <Projects projects={data.projects} tickets={data.tickets} />}
      {section === "tickets" && <section className="admin-section"><div className="section-toolbar"><p>{filteredTickets.length} de {data.tickets.length} tickets</p><input type="search" placeholder="Buscar título ou descrição…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><TicketTable tickets={filteredTickets} allTickets={data.tickets} projects={data.projects} users={data.users} /></section>}
      {section === "users" && <Users users={data.users} tickets={data.tickets} />}
    </main>
  </div>;
}

function Overview({ data, leafCount, onNavigate }: { data: BootstrapData; leafCount: number; onNavigate: (section: Section) => void }) {
  const metrics = [{ label: "Projetos", value: data.projects.length, note: "workspace demonstrativo", section: "projects" as const }, { label: "Tickets", value: data.tickets.length, note: `${leafCount} folhas com status manual`, section: "tickets" as const }, { label: "Usuários seed", value: data.users.length, note: "identidades locais, sem login", section: "users" as const }, { label: "Conexões", value: data.edges.length, note: `${data.edges.filter((edge) => edge.type === "dependency").length} dependências independentes`, section: "tickets" as const }];
  return <><div className="metric-grid">{metrics.map((metric) => <button className="metric-card" key={metric.label} onClick={() => onNavigate(metric.section)}><span>{metric.label}</span><strong>{String(metric.value).padStart(2, "0")}</strong><small>{metric.note}</small></button>)}</div><div className="overview-grid"><section className="admin-card"><div className="card-heading"><h2>Atividade do workspace</h2><button onClick={() => onNavigate("tickets")}>Ver todos</button></div><TicketTable tickets={data.tickets.slice(-5).reverse()} allTickets={data.tickets} projects={data.projects} users={data.users} compact /></section><section className="admin-card system-card"><span className="admin-eyebrow">INFRAESTRUTURA</span><h2>Persistência local</h2><p>O repositório JSON usa fila serializada, arquivo temporário e rename atômico.</p><dl><div><dt>Repositório</dt><dd>JSON atômico</dd></div><div><dt>Jev</dt><dd>Fallback manual sem chave</dd></div><div><dt>Produção</dt><dd>Banco transacional necessário</dd></div></dl></section></div></>;
}

function Projects({ projects, tickets }: { projects: Project[]; tickets: Ticket[] }) {
  return <section className="admin-section project-list">{projects.map((project) => <article className="project-row" key={project.id}><div className="project-monogram">{project.key}</div><div><span className="admin-eyebrow">{project.id}</span><h2>{project.name}</h2><p>{project.description}</p></div><dl><div><dt>Tickets</dt><dd>{tickets.filter((ticket) => ticket.projectId === project.id).length}</dd></div><div><dt>Criado em</dt><dd>{new Date(project.createdAt).toLocaleDateString("pt-BR")}</dd></div></dl></article>)}</section>;
}

function TicketTable({ tickets, allTickets, projects, users, compact = false }: { tickets: Ticket[]; allTickets: Ticket[]; projects: Project[]; users: User[]; compact?: boolean }) {
  const aggregateLabels = { not_started: "A fazer", active: "Em andamento", done: "Concluído" };
  return <div className="admin-table-scroll"><table><thead><tr><th>Ticket</th>{!compact && <th>Projeto</th>}<th>Status</th><th>Responsáveis</th></tr></thead><tbody>{tickets.map((ticket) => {
    const isLeaf = !allTickets.some((item) => item.parentId === ticket.id);
    const progress = getProgress(allTickets, ticket.id);
    const status = isLeaf ? ticket.status : progress.status;
    const statusLabel = isLeaf
      ? labels[ticket.status]
      : `${aggregateLabels[progress.status]} · ${progress.doneLeaves}/${progress.totalLeaves} folhas · ${progress.percent}%`;
    return <tr key={ticket.id}><td><span className="table-id">{projects.find((project) => project.id === ticket.projectId)?.key}-{String(ticket.sequence).padStart(3, "0")}</span><strong>{ticket.title}</strong></td>{!compact && <td>{projects.find((project) => project.id === ticket.projectId)?.name}</td>}<td><span className={`admin-status status-${status}`}>{statusLabel}</span></td><td><div className="admin-user-stack">{ticket.assigneeIds.length === 0 ? "—" : ticket.assigneeIds.map((id) => <span key={id} title={users.find((user) => user.id === id)?.name}>{users.find((user) => user.id === id)?.name.split(" ").map((part) => part[0]).join("")}</span>)}</div></td></tr>;
  })}</tbody></table></div>;
}

function Users({ users, tickets }: { users: User[]; tickets: Ticket[] }) {
  return <section className="admin-section"><div className="user-grid">{users.map((user) => <article className="user-card" key={user.id}><div className="user-avatar" style={{ background: user.color }}>{user.name.split(" ").map((part) => part[0]).join("")}</div><div><h2>{user.name}</h2><p>{user.email}</p><span>{tickets.filter((ticket) => ticket.assigneeIds.includes(user.id)).length} tickets atribuídos</span></div><code>{user.id}</code></article>)}</div><p className="seed-note">Estas identidades são apenas dados seed para demonstrar múltiplos responsáveis. Não representam contas autenticadas.</p></section>;
}
