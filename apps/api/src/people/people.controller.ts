import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TenantClient } from "@treepm/db";
import { TEST_PEOPLE_LIMIT, TEST_PEOPLE_TOTAL_LIMIT, TEST_PERSON_PREFIX, refuseWhileActingAs } from "../access/act-as.js";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";

const personSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  clerkRole: z.enum(["admin", "member"]),
  active: z.boolean(),
  /** Pessoa de teste (ADR 0057): sem usuário no Clerk; um administrador pode "entrar como" ela. */
  isTest: z.boolean(),
});
const peopleSchema = z.array(personSchema);
/** Caracteres de controle, de formatação (U+200B…) e espaços que não são o espaço comum: o `trim` não os tira e o nome ficaria enganoso. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;
const hasHiddenCharacter = (name: string): boolean => [...name].some((char) => char !== " " && HIDDEN_CHARACTER.test(char));
/** Para comparar nomes: sem acento, sem diferença de maiúsculas e com espaços colapsados. */
const nameKey = (name: string): string => name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const createTestPersonSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();

@Controller("people")
export class PeopleController {
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<z.output<typeof peopleSchema>> {
    this.authorization.viewDirectory(principal.actor);
    const people = await tx.person.findMany({ orderBy: [{ displayName: "asc" }, { id: "asc" }] });
    return parseOutput(peopleSchema, people);
  }

  /** Cria uma pessoa de teste (ADR 0057): identificador sintético, e-mail inválido, papel de membro. Só administrador. */
  @Post("test")
  async createTest(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(createTestPersonSchema)) body: z.output<typeof createTestPersonSchema>,
  ): Promise<z.output<typeof personSchema>> {
    refuseWhileActingAs(principal);
    this.authorization.manageTestPeople(principal.actor);
    const orgId = principal.organization.orgId;
    // Serializa as criações da organização para o limite valer sob concorrência.
    await tx.$queryRaw`select 1 from organizations where org_id = ${orgId} for update`;
    if (hasHiddenCharacter(body.displayName)) {
      throw new BadRequestException({ code: "invalid_display_name", message: "O nome não pode ter caracteres invisíveis ou de controle." });
    }
    // Nome igual ao de uma pessoa ativa (de verdade ou de teste): a lista de menção ficaria ambígua e uma pessoa de teste imitaria a de verdade.
    const wanted = nameKey(body.displayName);
    const active = await tx.person.findMany({ where: { orgId, active: true }, select: { displayName: true } });
    if (active.some((person) => nameKey(person.displayName) === wanted)) {
      throw new ConflictException({ code: "display_name_taken", message: "Já existe uma pessoa ativa com esse nome." });
    }
    await this.requireRoom(tx, orgId);
    const total = await tx.person.count({ where: { orgId, isTest: true } });
    if (total >= TEST_PEOPLE_TOTAL_LIMIT) {
      throw new ConflictException({ code: "test_people_total_limit", message: `No máximo ${TEST_PEOPLE_TOTAL_LIMIT} pessoas de teste por organização, contando as desativadas.` });
    }
    const key = randomUUID();
    const created = await tx.person.create({
      data: { orgId, clerkUserId: `${TEST_PERSON_PREFIX}${key}`, displayName: body.displayName, email: `${key}@teste.invalid`, clerkRole: "member", active: true, isTest: true },
    });
    return parseOutput(personSchema, created);
  }

  @Post(":id/deactivate")
  @HttpCode(200)
  async deactivate(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<z.output<typeof personSchema>> {
    return this.setActive(tx, principal, id, false);
  }

  @Post(":id/reactivate")
  @HttpCode(200)
  async reactivate(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<z.output<typeof personSchema>> {
    return this.setActive(tx, principal, id, true);
  }

  private async setActive(tx: TenantClient, principal: Principal, id: string, active: boolean): Promise<z.output<typeof personSchema>> {
    refuseWhileActingAs(principal);
    this.authorization.manageTestPeople(principal.actor);
    const orgId = principal.organization.orgId;
    if (active) await tx.$queryRaw`select 1 from organizations where org_id = ${orgId} for update`;
    // Pessoa de verdade, inexistente e de outra organização dão o mesmo 404.
    const person = await tx.person.findFirst({ where: { id, orgId, isTest: true } });
    if (!person) throw new NotFoundException("Pessoa de teste não encontrada.");
    if (active && !person.active) await this.requireRoom(tx, orgId);
    const updated = await tx.person.update({ where: { orgId_id: { orgId, id } }, data: { active } });
    return parseOutput(personSchema, updated);
  }

  private async requireRoom(tx: TenantClient, orgId: string): Promise<void> {
    const count = await tx.person.count({ where: { orgId, isTest: true, active: true } });
    if (count >= TEST_PEOPLE_LIMIT) {
      throw new ConflictException({ code: "test_people_limit", message: `No máximo ${TEST_PEOPLE_LIMIT} pessoas de teste ativas por organização.` });
    }
  }
}
