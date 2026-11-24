import { describe, expect, it } from "vitest";
import { ACT_AS, snapshot } from "./act-as-support.js";
import { useMcpHarness } from "./mcp-support.js";

// ADR 0057: as chaves de acesso ignoram o "entrar como"; com o cabeçalho, a chamada é recusada (não atendida como a dona da chave).
const h = useMcpHarness();

describe("chave de acesso com o cabeçalho de 'entrar como'", () => {
  it("é recusada com 403, com token válido ou não, e sem o cabeçalho a mesma chamada funciona", async () => {
    const { token } = await h.issue("contributor");
    expect((await h.rpc(token, "PRIV", "tools/list")).status).toBe(200);
    const before = await snapshot(h.pool);
    const withHeader = await h.post(token, "PRIV", { jsonrpc: "2.0", id: 1, method: "tools/list" }, { [ACT_AS]: h.world().people.reader });
    expect(withHeader.status).toBe(403);
    expect(withHeader.body.error.code).toBe("act_as_not_allowed");
    const bad = await h.post("tre_invalido", "PRIV", {}, { [ACT_AS]: "" });
    expect(bad.status).toBe(403);
    // a recusa não deixa efeito: nem último uso do token, nem linha alguma
    expect(await snapshot(h.pool)).toEqual(before);
  });
});
