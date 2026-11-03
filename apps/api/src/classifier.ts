import { choice, TypeSafeClient } from "@typesafe-ai/sdk";
import { childrenOf } from "@treepm/domain";
import type { ChoiceLevel, ClassificationSuggestion, Database, Ticket } from "@treepm/domain";

interface ClassificationInput {
  title: string;
  description: string;
}

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

const CATEGORIES = {
  backend: "API, persistência, domínio, integrações e infraestrutura",
  frontend: "Interface, canvas, acessibilidade e experiência de navegação",
  design: "Pesquisa visual, protótipos, sistema visual e conteúdo de interface",
  produto: "Descoberta, estratégia, jornadas e priorização",
  outro: "Trabalho que não pertence claramente às categorias anteriores",
};
const CONFIDENCE_THRESHOLD = 0.65;
const MAX_CANDIDATES = 20;
const MAX_DEPTH = 6;

export function classificationLimitations(tickets: Ticket[]): string[] {
  const childCounts = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.parentId) childCounts.set(ticket.parentId, (childCounts.get(ticket.parentId) ?? 0) + 1);
  }
  const roots = tickets.filter((ticket) => ticket.parentId === null);
  const crowdedParent = tickets.find((ticket) => (childCounts.get(ticket.id) ?? 0) > MAX_CANDIDATES);
  const limitations: string[] = [];
  if (roots.length > MAX_CANDIDATES) {
    limitations.push(`A raiz tem ${roots.length} candidatos; o classificador aceita no máximo ${MAX_CANDIDATES} por nível.`);
  }
  if (crowdedParent) {
    limitations.push(`O ramo “${crowdedParent.title}” tem ${childCounts.get(crowdedParent.id)} candidatos; o classificador aceita no máximo ${MAX_CANDIDATES} por nível.`);
  }

  const pending = roots.map((ticket) => ({ ticket, depth: 0 }));
  const visited = new Set<string>();
  let exceedsDepth = false;
  while (pending.length > 0 && !exceedsDepth) {
    const current = pending.shift();
    if (!current || visited.has(current.ticket.id)) continue;
    visited.add(current.ticket.id);
    if (current.depth >= MAX_DEPTH) {
      exceedsDepth = true;
      break;
    }
    for (const child of childrenOf(tickets, current.ticket.id)) {
      pending.push({ ticket: child, depth: current.depth + 1 });
    }
  }
  if (exceedsDepth) {
    limitations.push(`Há ramos além dos ${MAX_DEPTH} níveis analisáveis pelo classificador.`);
  }
  return limitations;
}

function unavailable(): ClassificationSuggestion {
  return {
    mode: "unavailable",
    category: null,
    parentId: null,
    confidence: 0,
    manualRequired: true,
    path: [],
    categoryProbabilities: {},
    message: "Jev indisponível: configure TYPESAFE_API_KEY somente na API. Escolha categoria e pai manualmente.",
  };
}

export async function suggestClassification(
  database: Database,
  projectId: string,
  input: ClassificationInput,
): Promise<ClassificationSuggestion> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) return unavailable();
  const tickets = database.tickets.filter((ticket) => ticket.projectId === projectId);
  const limitations = classificationLimitations(tickets);
  if (limitations.length > 0) {
    return {
      mode: "unavailable",
      category: null,
      parentId: null,
      confidence: 0,
      manualRequired: true,
      path: [],
      categoryProbabilities: {},
      message: `Classificação automática não executada: ${limitations.join(" ")} Nenhum ramo foi descartado silenciosamente; escolha categoria e pai manualmente.`,
    };
  }
  const client = new TypeSafeClient({ defaultModel: "jev-latest" });
  const path: ChoiceLevel[] = [];
  const selectedPath: Ticket[] = [];
  let category: string | null = null;
  let categoryProbabilities: Record<string, number> = {};
  const confidences: number[] = [];

  try {
    const categoryResponse = await client.systemOne({
      state: { title: input.title, description: input.description.slice(0, 2000) },
      questions: {
        category: choice("Qual disciplina melhor descreve o novo ticket?", CATEGORIES),
      },
    });
    const categoryAnswer = categoryResponse.answers.category as ChoiceAnswer;
    category = categoryAnswer.choice;
    categoryProbabilities = categoryAnswer.probabilities;
    confidences.push(categoryAnswer.confidence);

    let candidates = childrenOf(tickets, null).slice(0, MAX_CANDIDATES);
    let parentId: string | null = null;
    let depth = 0;

    while (candidates.length > 0 && depth < MAX_DEPTH) {
      const criteria = Object.fromEntries(candidates.map((ticket) => [
        ticket.id,
        `${ticket.title}: ${ticket.description.slice(0, 240)}`,
      ]));
      if (parentId !== null) criteria.__stop__ = "O novo ticket deve ficar diretamente sob o pai já selecionado; nenhum filho é mais específico.";
      const response = await client.systemOne({
        state: {
          ticket: { title: input.title, description: input.description.slice(0, 2000) },
          path: selectedPath.map((ticket) => ticket.title),
          instruction: "Escolha o ramo mais específico. Não crie categorias nem IDs.",
        },
        questions: {
          placement: choice(
            `Nível ${depth + 1} da árvore: onde este ticket deve ser posicionado?`,
            criteria,
          ),
        },
      });
      const answer = response.answers.placement as ChoiceAnswer;
      const chosen = candidates.find((ticket) => ticket.id === answer.choice);
      const selectedId = chosen?.id ?? "__stop__";
      path.push({
        depth,
        choice: selectedId,
        label: chosen?.title ?? "Permanecer no pai atual",
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      });
      confidences.push(answer.confidence);
      if (!chosen) break;
      parentId = chosen.id;
      selectedPath.push(chosen);
      candidates = childrenOf(tickets, chosen.id).slice(0, MAX_CANDIDATES);
      depth += 1;
    }

    const confidence = confidences.length > 0 ? Math.min(...confidences) : 0;
    return {
      mode: "available",
      category,
      parentId,
      confidence,
      manualRequired: confidence < CONFIDENCE_THRESHOLD,
      path,
      categoryProbabilities,
      message: confidence < CONFIDENCE_THRESHOLD
        ? "Confiança baixa: revise e escolha manualmente a categoria e o pai antes de criar."
        : "Sugestão gerada por Jev. Revise e confirme; nenhum ticket foi criado automaticamente.",
    };
  } catch {
    return {
      mode: "error",
      category,
      parentId: null,
      confidence: 0,
      manualRequired: true,
      path,
      categoryProbabilities,
      message: "Não foi possível consultar Jev. Nenhuma classificação foi presumida; escolha manualmente.",
    };
  }
}
