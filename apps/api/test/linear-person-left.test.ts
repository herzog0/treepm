import { describe, expect, it } from "vitest";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { MINUTE, useTokenHarness } from "./access-token-support.js";
import { LINEAR_CONFIG } from "./helpers.js";
import { ORG } from "./world.js";

// Quem sai da organização perde também a chave do Linear guardada (ADR 0060; TREEPM-428).
const h = useTokenHarness(LINEAR_CONFIG);

const keep = (personId: string) =>
  h.pool.query(
    `insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
     values ($1, $2::uuid, 'linear', $3, $4, 1, 'ws-1', 'Acme', 'abcd')`,
    [ORG, personId, Buffer.from("cifrado-0123456789ab"), Buffer.alloc(12, 3)],
  );

describe("a pessoa que sai da organização", () => {
  it("perde a credencial do Linear junto com os tokens de acesso; a de quem ficou continua", async () => {
    await h.enableMcp();
    const created = await h.create("contributor", h.world().projects.priv);
    expect(created.status).toBe(201);
    await keep(h.world().people.contributor);
    await keep(h.world().people.reader);

    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    h.clock.advance(5 * MINUTE + 1);
    const result = await h.app().get(AccessTokenService).resolve(created.body.token as string, "PRIV");
    expect(result.ok).toBe(false);

    const left = (await h.pool.query<{ person_id: string }>("select person_id from external_credentials")).rows;
    expect(left).toEqual([{ person_id: h.world().people.reader }]);
  });
});
