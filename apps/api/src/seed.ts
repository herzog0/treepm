import type { Database, Ticket, TicketComponent, TicketStatus, User } from "@treepm/domain";

const users: User[] = [
  { id: "u-ana", name: "Ana Ribeiro", email: "ana@treepm.local", color: "#7c5cbf" },
  { id: "u-bruno", name: "Bruno Lima", email: "bruno@treepm.local", color: "#167d6d" },
  { id: "u-caio", name: "Caio Mendes", email: "caio@treepm.local", color: "#b45f35" },
  { id: "u-duda", name: "Duda Santos", email: "duda@treepm.local", color: "#3d6fb4" },
  { id: "u-elisa", name: "Elisa Costa", email: "elisa@treepm.local", color: "#ad4674" },
  { id: "u-fred", name: "Fred Alves", email: "fred@treepm.local", color: "#607d2b" },
];

interface TicketSpec {
  title: string;
  description: string;
  status?: TicketStatus;
  assignees?: string[];
  components?: TicketComponent[];
}

export function createSeed(): Database {
  const tickets: Ticket[] = [];
  const edges: Database["edges"] = [];
  let sequence = 0;
  const timestamp = "2026-11-02T09:00:00.000Z";

  const add = (parentId: string | null, spec: TicketSpec): string => {
    sequence += 1;
    const id = `ticket-${String(sequence).padStart(3, "0")}`;
    tickets.push({
      id,
      projectId: "project-treepm",
      sequence,
      parentId,
      title: spec.title,
      description: spec.description,
      status: spec.status ?? "todo",
      assigneeIds: spec.assignees ?? [],
      components: spec.components ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (parentId) {
      edges.push({
        id: `hierarchy-${id}`,
        projectId: "project-treepm",
        sourceId: parentId,
        targetId: id,
        type: "hierarchy",
        style: { color: "#b7b2c6", width: 2, dashed: false },
        metadata: { meaning: "parent-child" },
        createdAt: timestamp,
      });
    }
    return id;
  };

  const root = add(null, {
    title: "Lançamento da plataforma TreePM",
    description: "Entregar a primeira experiência completa de planejamento visual em árvore.",
    assignees: ["u-ana", "u-bruno"],
    components: [{ name: "produto", assigneeIds: ["u-ana"] }],
  });

  const discovery = add(root, {
    title: "Produto e descoberta",
    description: "Validar fluxos, linguagem e critérios da primeira versão.",
    assignees: ["u-ana", "u-elisa"],
    components: [{ name: "produto", assigneeIds: ["u-ana"] }],
  });
  const journeys = add(discovery, {
    title: "Jornadas essenciais",
    description: "Mapear criação, organização e acompanhamento de trabalho.",
    assignees: ["u-ana"],
  });
  add(journeys, {
    title: "Entrevistar times de produto",
    description: "Sintetizar dores de ferramentas lineares em cinco entrevistas.",
    status: "done",
    assignees: ["u-ana", "u-elisa"],
    components: [{ name: "pesquisa", assigneeIds: ["u-elisa"] }],
  });
  add(journeys, {
    title: "Definir critérios de sucesso",
    description: "Estabelecer sinais de clareza, velocidade e confiança na árvore.",
    status: "done",
    assignees: ["u-ana"],
  });
  const language = add(discovery, {
    title: "Linguagem do domínio",
    description: "Alinhar termos de hierarquia, dependência, folha e progresso.",
    assignees: ["u-ana", "u-bruno"],
  });
  add(language, {
    title: "Publicar glossário inicial",
    description: "Documentar conceitos e regras compartilhadas entre as aplicações.",
    status: "in_progress",
    assignees: ["u-bruno"],
  });

  const design = add(root, {
    title: "Design da experiência",
    description: "Criar um canvas legível, calmo e eficiente em diferentes escalas.",
    assignees: ["u-elisa", "u-duda"],
    components: [{ name: "design", assigneeIds: ["u-elisa"] }],
  });
  const visual = add(design, {
    title: "Sistema visual",
    description: "Definir tipografia, cor, espaçamento e estados acessíveis.",
    assignees: ["u-elisa"],
  });
  add(visual, {
    title: "Tokens e paleta",
    description: "Consolidar cores semânticas e superfícies do produto.",
    status: "done",
    assignees: ["u-elisa"],
    components: [{ name: "design", assigneeIds: ["u-elisa"] }],
  });
  add(visual, {
    title: "Cards e indicadores",
    description: "Desenhar variações completa, compacta e resumida.",
    status: "done",
    assignees: ["u-elisa", "u-duda"],
  });
  const navigation = add(design, {
    title: "Navegação no canvas",
    description: "Prototipar pan, zoom, fit view e níveis de detalhe.",
    assignees: ["u-duda", "u-caio"],
  });
  add(navigation, {
    title: "Testar legibilidade dos LODs",
    description: "Validar transições sem perda de contexto ou seleção.",
    status: "in_progress",
    assignees: ["u-duda"],
  });
  add(navigation, {
    title: "Revisar navegação por teclado",
    description: "Garantir acesso a cards, tabs, formulários e controles.",
    assignees: ["u-duda", "u-elisa"],
  });

  const platform = add(root, {
    title: "Fundação da plataforma",
    description: "Implementar domínio, API e persistência segura da fatia local.",
    assignees: ["u-bruno", "u-caio"],
    components: [{ name: "backend", assigneeIds: ["u-bruno"] }],
  });
  const domain = add(platform, {
    title: "Modelo de árvore",
    description: "Garantir hierarquia recursiva e agregados consistentes.",
    assignees: ["u-bruno"],
  });
  add(domain, {
    title: "Validar ciclos e reparenting",
    description: "Rejeitar self-parent, IDs ausentes e movimentos cíclicos.",
    status: "done",
    assignees: ["u-bruno", "u-caio"],
    components: [{ name: "backend", assigneeIds: ["u-bruno"] }],
  });
  add(domain, {
    title: "Derivar progresso das folhas",
    description: "Calcular percentual e cor agregada sem status manual no pai.",
    status: "done",
    assignees: ["u-bruno"],
  });
  const persistence = add(platform, {
    title: "Persistência local",
    description: "Isolar repositório e gravar snapshots atomicamente.",
    assignees: ["u-caio"],
  });
  add(persistence, {
    title: "Seed demonstrativo",
    description: "Preparar projeto profundo, ramificado e com times multidisciplinares.",
    status: "done",
    assignees: ["u-caio", "u-fred"],
  });
  add(persistence, {
    title: "Fila de escritas atômicas",
    description: "Serializar mutações e substituir o arquivo via rename.",
    status: "in_progress",
    assignees: ["u-caio"],
    components: [{ name: "backend", assigneeIds: ["u-caio"] }],
  });

  const web = add(root, {
    title: "Aplicação web",
    description: "Entregar árvore interativa e visões complementares.",
    assignees: ["u-duda", "u-fred"],
    components: [{ name: "frontend", assigneeIds: ["u-duda"] }],
  });
  const canvas = add(web, {
    title: "Canvas semântico",
    description: "Renderizar a hierarquia e agregações conforme o zoom.",
    assignees: ["u-duda", "u-fred"],
  });
  add(canvas, {
    title: "Layout tidy top-down",
    description: "Distribuir irmãos pelas folhas sem sobreposição.",
    status: "done",
    assignees: ["u-fred"],
  });
  add(canvas, {
    title: "Editor individual de arestas",
    description: "Selecionar, colorir e ajustar conexões independentemente.",
    status: "in_progress",
    assignees: ["u-duda"],
    components: [{ name: "frontend", assigneeIds: ["u-duda"] }],
  });
  add(canvas, {
    title: "Resumos por subárvore",
    description: "Agregar descendentes e progresso em baixos níveis de zoom.",
    status: "in_progress",
    assignees: ["u-fred", "u-duda"],
  });
  const work = add(web, {
    title: "Fluxo de trabalho",
    description: "Criar, detalhar e acompanhar tickets por diferentes visões.",
    assignees: ["u-duda", "u-ana"],
  });
  add(work, {
    title: "Lista e Kanban acessíveis",
    description: "Oferecer alternativas lineares sem esconder o contexto.",
    status: "todo",
    assignees: ["u-duda"],
  });
  add(work, {
    title: "Painel de detalhes",
    description: "Editar responsáveis, componentes, pai e status de folhas.",
    status: "in_progress",
    assignees: ["u-duda", "u-fred"],
  });

  const ai = add(root, {
    title: "Classificação com Jev",
    description: "Sugerir categoria e posição com confirmação humana.",
    assignees: ["u-bruno", "u-ana"],
    components: [
      { name: "backend", assigneeIds: ["u-bruno"] },
      { name: "produto", assigneeIds: ["u-ana"] },
    ],
  });
  const choices = add(ai, {
    title: "Escolhas por nível",
    description: "Navegar candidatos mínimos sem enviar a base inteira.",
    assignees: ["u-bruno"],
  });
  add(choices, {
    title: "Integrar TypeSafe SDK",
    description: "Usar System One e jev-latest exclusivamente no backend.",
    status: "in_progress",
    assignees: ["u-bruno"],
    components: [{ name: "IA", assigneeIds: ["u-bruno"] }],
  });
  add(choices, {
    title: "Exibir confiança e caminho",
    description: "Apresentar probabilidades e exigir revisão em baixa confiança.",
    assignees: ["u-ana", "u-duda"],
  });
  add(ai, {
    title: "Fallback sem credencial",
    description: "Sinalizar indisponibilidade e manter classificação manual.",
    status: "done",
    assignees: ["u-bruno"],
  });

  const dependencyPairs = [
    ["ticket-010", "ticket-014", "Design orienta protótipo"],
    ["ticket-017", "ticket-022", "Layout usa regras do domínio"],
    ["ticket-024", "ticket-026", "Detalhes dependem do canvas"],
    ["ticket-029", "ticket-030", "UI consome resposta do classificador"],
  ] as const;
  dependencyPairs.forEach(([sourceId, targetId, note], index) => {
    edges.push({
      id: `dependency-${index + 1}`,
      projectId: "project-treepm",
      sourceId,
      targetId,
      type: "dependency",
      style: { color: index % 2 === 0 ? "#d18445" : "#7665a8", width: 2, dashed: true },
      metadata: { note },
      createdAt: timestamp,
    });
  });

  return {
    projects: [{
      id: "project-treepm",
      name: "TreePM · Primeira experiência",
      description: "Projeto demonstrativo com hierarquia, dependências e progresso real.",
      key: "TR",
      createdAt: timestamp,
    }],
    tickets: tickets satisfies Ticket[],
    edges,
    users,
  };
}
