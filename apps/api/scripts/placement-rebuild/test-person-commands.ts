import { call } from "./ticket-commands.js";
import type { TicketContext } from "./ticket-commands.js";

/** Pessoas de teste (ADR 0057): só as rotas da API, como o usuário da ferramenta (que precisa ser administrador). Nunca imprimem e-mail. */
type TestPerson = { id: string; displayName: string; active: boolean; isTest: boolean };
const brief = (person: TestPerson) => ({ id: person.id, displayName: person.displayName, active: person.active, isTest: person.isTest });

export async function testPersonCreateCommand(ctx: TicketContext, name: string): Promise<void> {
  const created = await call<TestPerson>("criar pessoa de teste", ctx, "POST", "/people/test", { displayName: name });
  ctx.log(`Pessoa de teste criada: ${created.displayName} (${created.id})`);
}

export async function testPersonListCommand(ctx: TicketContext): Promise<void> {
  const all = await call<TestPerson[]>("listar pessoas", ctx, "GET", "/people");
  ctx.log(JSON.stringify(all.filter((person) => person.isTest).map(brief)));
}
