import { markProjectChanged } from "@treepm/db";
import type { TenantClient } from "@treepm/db";

/**
 * Versão do projeto para a lista de tickets (ADR 0046, TREEPM-246): `projects.tickets_version`, um contador da LINHA DO PROJETO
 * (revisão 2: não é mais `updated_at`, que o Prisma grava com o relógio de cada instância).
 *
 * Por que a linha do projeto e não "o maior `updated_at` dos tickets" ou "a contagem": `tickets` só tem índices por
 * `(org_id, project_id, number)` e `(org_id, project_id, parent_id)`, e as pessoas responsáveis ficam em outra tabela; qualquer
 * derivação a partir deles varre o projeto (o que a versão existe para evitar), e um índice novo exigiria migration. A linha do
 * projeto é uma leitura por chave primária, que a rota já faz para conferir a permissão: a versão sai sem consulta extra.
 *
 * Contrato: TODA escrita que muda algo do `ticketSummarySchema` chama `touchProjectVersion` na mesma transação. O teste
 * `project-version.test.ts` percorre as escritas conhecidas e exige que cada uma mude a versão. Escrita nova que mexe no
 * resumo e não chama a função deixa o mapa velho: entra no inventário do teste.
 *
 * O toque NÃO é feito na hora: `touchProjectVersion` só marca o projeto (`markProjectChanged`, em `@treepm/db`), e a abertura da
 * transação do tenant (`@treepm/db`) faz o `UPDATE tickets_version = tickets_version + 1` dos projetos marcados como ÚLTIMO comando
 * antes do commit (uma vez por projeto, em ordem de id; nada se a transação falha). Regra de marcar: marca-se sem condição sempre
 * que houver gravação, ou com o que foi lido DEPOIS da trava de linha; nunca com leitura sem trava.
 *
 * ORDEM DAS TRAVAS (a que vale em cada caminho):
 *  - edições (situação, título, pai, pessoas, ideias, marcador, remoção): advisory (estrutura, quando o caminho a pega) → linhas de
 *    tickets (`for update`, pela ordem única de `TicketsService.lockTicketSet`: o conjunto inteiro num comando, em ordem de id;
 *    ADR 0068, revisão 1) → linha do projeto, por último, no toque do fim da transação;
 *  - criação e importação: advisory → `for update`, pela mesma ordem única, no pai com a subida, nos mencionados e nos que citam
 *    as chaves novas (`lockLinkedTickets`) → linha do projeto (reserva de `next_ticket_number`, que a segura até o fim, como antes
 *    da ADR 0046) → inserts. Só os tickets citantes de um número que mude entre a leitura e a reserva (corrida com criação sem
 *    pai) escapam da trava antecipada: viram, no pior caso, 409 `concurrent_update` retentável;
 *  - arquivar o projeto: tickets (marcadores, em lote) → linha do projeto.
 */
export async function touchProjectVersion(_tx: TenantClient, projectId: string): Promise<void> {
  markProjectChanged(projectId);
}

/** O `ETag` da lista: fraco, porque o corpo pode variar sem a versão mudar (o marcador de trabalho pela IA expira pelo relógio). */
export function projectEtag(ticketsVersion: bigint): string {
  return `W/"v2.${ticketsVersion}"`; // v2: o prefixo novo (contador) nunca casa com uma versão antiga (v1, relógio)
}

/**
 * `If-None-Match` casa com `etag`? Comparação fraca (RFC 9110 §13.1.2): lista separada por vírgulas, `W/` ignorado, `*` casa com
 * qualquer representação existente.
 */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const mine = strip(etag);
  return header.split(",").some((candidate) => candidate.trim() === "*" || strip(candidate) === mine);
}
