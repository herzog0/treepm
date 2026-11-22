import { describe, expect, it, vi } from "vitest";
import { ClerkSessionVerifier } from "../src/auth/clerk-session-verifier.js";

function fakeClient(state: unknown) {
  return { authenticateRequest: vi.fn().mockResolvedValue(state) };
}

const request = {
  method: "GET",
  originalUrl: "/api/me",
  headers: { authorization: "Bearer tok", "x-multi": ["a", "b"] } as Record<string, string | string[] | undefined>,
};

const signedIn = (auth: Record<string, unknown>) => ({
  status: "signed-in",
  isAuthenticated: true,
  toAuth: vi.fn().mockReturnValue(auth),
});

describe("ClerkSessionVerifier", () => {
  it("chama authenticateRequest com authorizedParties igual a APP_ORIGIN", async () => {
    const client = fakeClient(signedIn({ userId: "u", orgId: "o", orgRole: "org:admin", sessionStatus: "active" }));
    const verifier = new ClerkSessionVerifier(client, { appOrigin: "https://treepm.ai", jwtKey: undefined });
    await verifier.verify(request);
    const [req, options] = client.authenticateRequest.mock.calls[0] ?? [];
    expect(options).toMatchObject({ authorizedParties: ["https://treepm.ai"], acceptsToken: "session_token" });
    expect(req).toBeInstanceOf(Request);
    expect((req as Request).url).toBe("https://treepm.ai/api/me");
    expect((req as Request).headers.get("authorization")).toBe("Bearer tok");
  });

  it("repassa jwtKey quando configurada", async () => {
    const client = fakeClient(signedIn({ userId: "u", orgId: null, orgRole: null, sessionStatus: "active" }));
    await new ClerkSessionVerifier(client, { appOrigin: "https://treepm.ai", jwtKey: "k" }).verify(request);
    expect(client.authenticateRequest.mock.calls[0]?.[1]).toMatchObject({ jwtKey: "k" });
  });

  it("devolve a sessão autenticada, mantendo pendente como pendente", async () => {
    const state = signedIn({ userId: "u", orgId: "o", orgRole: "org:member", sessionStatus: "pending" });
    const session = await new ClerkSessionVerifier(fakeClient(state), { appOrigin: "https://treepm.ai" }).verify(request);
    expect(state.toAuth).toHaveBeenCalledWith({ treatPendingAsSignedOut: false });
    expect(session).toEqual({ userId: "u", orgId: "o", orgRole: "org:member", sessionStatus: "pending" });
  });

  it("devolve null quando não autenticado", async () => {
    const state = { status: "signed-out", isAuthenticated: false, toAuth: vi.fn() };
    expect(await new ClerkSessionVerifier(fakeClient(state), { appOrigin: "https://treepm.ai" }).verify(request)).toBeNull();
  });

  it("devolve null quando o SDK lança", async () => {
    const client = { authenticateRequest: vi.fn().mockRejectedValue(new Error("boom")) };
    expect(await new ClerkSessionVerifier(client, { appOrigin: "https://treepm.ai" }).verify(request)).toBeNull();
  });

  describe("com origens extras (APP_EXTRA_ORIGINS)", () => {
    /** Imita a conferência de `azp` do SDK: só autentica se a parte autorizada da requisição estiver na lista. */
    const azpClient = {
      authenticateRequest: vi.fn(async (req: Request, options: { authorizedParties: string[] }) => {
        const azp = req.headers.get("x-azp") ?? "";
        const ok = options.authorizedParties.includes(azp);
        return { status: ok ? "signed-in" : "signed-out", isAuthenticated: ok, toAuth: () => ({ userId: "u", orgId: null, orgRole: null, sessionStatus: "active" }) };
      }),
    };
    const verifier = new ClerkSessionVerifier(azpClient, { appOrigin: "https://treepm.ai", extraOrigins: ["http://localhost:5173", "https://dev.tailnet.ts.net"] });
    const withAzp = (azp: string) => ({ ...request, headers: { ...request.headers, "x-azp": azp } });

    it("repassa a principal e as extras, nessa ordem", async () => {
      await verifier.verify(request);
      expect(azpClient.authenticateRequest.mock.calls.at(-1)?.[1]).toMatchObject({
        authorizedParties: ["https://treepm.ai", "http://localhost:5173", "https://dev.tailnet.ts.net"],
      });
    });

    it("aceita a parte autorizada igual à principal e a uma extra; recusa a não listada", async () => {
      expect(await verifier.verify(withAzp("https://treepm.ai"))).not.toBeNull();
      expect(await verifier.verify(withAzp("https://dev.tailnet.ts.net"))).not.toBeNull();
      expect(await verifier.verify(withAzp("https://evil.example"))).toBeNull();
    });

    it("a URL da requisição montada continua sendo a da origem principal", async () => {
      await verifier.verify(request);
      expect((azpClient.authenticateRequest.mock.calls.at(-1)?.[0] as Request).url).toBe("https://treepm.ai/api/me");
    });

    it("sem extras, authorizedParties é só a principal", async () => {
      const client = fakeClient(signedIn({ userId: "u", orgId: null, orgRole: null, sessionStatus: "active" }));
      await new ClerkSessionVerifier(client, { appOrigin: "https://treepm.ai" }).verify(request);
      expect(client.authenticateRequest.mock.calls[0]?.[1]).toMatchObject({ authorizedParties: ["https://treepm.ai"] });
    });
  });
});
