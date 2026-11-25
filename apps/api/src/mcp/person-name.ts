/**
 * O ÚNICO lugar por onde o nome de uma pessoa sai pelo MCP (ADR 0062; revisão de segurança, TREEPM-494).
 *
 * O Clerk cai no e-mail ou no id quando a pessoa não tem nome nem apelido, e o TreePM guarda isso como nome de exibição. A tela
 * pode mostrar; o MCP NUNCA entrega e-mail nem id do Clerk, com ou sem o alcance de pessoas. Por isso toda ferramenta lê o nome
 * por `mcpPersonRef`/`mcpPersonName` e nenhum outro arquivo de `apps/api/src/mcp/` lê o campo de nome do banco (há um teste
 * estrutural, `mcp-person-name.test.ts`, que falha se alguém ler). As próximas ferramentas (comentários, histórico, conversas)
 * entram por aqui também.
 */

/** O rótulo que sai no lugar de um nome que seria e-mail ou id. Fixo, em inglês (a ferramenta é lida por um modelo). */
export const UNNAMED_PERSON = "Unnamed person";

/** O que precisa vir do banco para decidir o nome: as colunas de nome, e-mail e id externo da pessoa. */
export const PERSON_NAME_SELECT = { id: true, displayName: true, email: true, clerkUserId: true } as const;

export type PersonNameSource = { id: string; displayName: string; email: string; clerkUserId: string };

const EMAIL_SHAPE = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/;
const CLERK_ID_SHAPE = /^(user|org|usr)_[A-Za-z0-9]{8,}$/i;

/** O nome que pode sair: o de exibição, ou o rótulo neutro se for vazio, o e-mail ou o id externo da pessoa, ou tiver forma de um dos dois. */
export function mcpPersonName(person: PersonNameSource): string {
  const name = person.displayName.trim();
  const lower = name.toLowerCase();
  if (name === "") return UNNAMED_PERSON;
  if (lower === person.email.trim().toLowerCase() || lower === person.clerkUserId.trim().toLowerCase()) return UNNAMED_PERSON;
  if (EMAIL_SHAPE.test(name) || CLERK_ID_SHAPE.test(name)) return UNNAMED_PERSON;
  return name;
}

/** `{ id, name }` como o MCP entrega uma pessoa. */
export function mcpPersonRef(person: PersonNameSource): { id: string; name: string } {
  return { id: person.id, name: mcpPersonName(person) };
}
