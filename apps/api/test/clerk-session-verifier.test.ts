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
});
