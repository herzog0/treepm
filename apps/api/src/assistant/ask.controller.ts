import { Body, Controller, HttpCode, Inject, Logger, Param, Post, ServiceUnavailableException } from "@nestjs/common";
import type { z } from "zod";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { ProjectQueryService } from "../query/project-query.service.js";
import { ProjectToolExecutor } from "./ask-executor.js";
import { fromNeutralLabels, labelNumbers, toNeutralLabels } from "./ask-labels.js";
import { askBodySchema, askResponseSchema } from "./ask.schema.js";
import type { AskResponse } from "./ask.schema.js";
import { AssistantGate } from "./assistant-gate.js";
import { AssistantUnavailableError } from "./ports.js";

/**
 * Pergunta sobre o projeto (ADR 0037, fatia 5). Não grava nada e não cria evento; a conversa vem da tela e não é
 * guardada. Ao provedor vai só o que a ADR lista, em rótulos neutros: a chave do projeto e as dos tickets são trocadas
 * por `T47` na ida e de volta na resposta. Nenhuma transação fica aberta durante a chamada: cada ferramenta abre a sua.
 */
@Controller()
export class AskController {
  private readonly logger = new Logger("ProjectAsk");

  constructor(
    @Inject(ProjectQueryService) private readonly query: ProjectQueryService,
    @Inject(AssistantGate) private readonly gate: AssistantGate,
  ) {}

  @Post("projects/:projectId/assistant/ask")
  @HttpCode(200)
  @OwnTransactions()
  async ask(
    @Tenant() tenant: TenantRunner,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(askBodySchema)) body: z.output<typeof askBodySchema>,
  ): Promise<AskResponse> {
    const { answerer } = await this.gate.open(tenant);
    // Leitura curta (a pessoa precisa enxergar o projeto; arquivado pode ser consultado) → chamada SEM transação aberta.
    const { key } = await tenant.run(async (tx, principal) => this.query.requireProject(tx, principal, projectId));

    try {
      const answer = await answerer.answer({
        question: toNeutralLabels(body.question, key),
        history: body.history.map((message) => ({ author: message.author, body: toNeutralLabels(message.body, key) })),
        tools: new ProjectToolExecutor(tenant, this.query, projectId, key),
      });
      const real = await this.realKeys(tenant, projectId, key, answer.text);
      // Texto fora de 1 a 8.000 caracteres (já com as chaves reais) não é resposta: nunca é cortado em silêncio.
      const parsed = askResponseSchema.safeParse({ text: real, model: answer.model });
      if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
      return parsed.data;
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        throw new ServiceUnavailableException({ code: "assistant_unavailable", message: error.message });
      }
      throw error;
    }
  }

  /** `T<número>` de ticket que existe no projeto volta a ser `CHAVE-<número>`; o que não existe fica como veio. */
  private async realKeys(tenant: TenantRunner, projectId: string, key: string, text: string): Promise<string> {
    const numbers = labelNumbers(text);
    if (numbers.length === 0) return text;
    const existing = await tenant.run(async (tx) => tx.ticket.findMany({ where: { projectId, number: { in: numbers } }, select: { number: true } }));
    return fromNeutralLabels(text, key, new Set(existing.map((row) => row.number)));
  }
}
