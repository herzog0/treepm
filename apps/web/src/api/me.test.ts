import { describe, expect, it, vi } from "vitest";
import { fetchMe, getMeIndicatorText } from "./me.js";

const data = {
  person: { id: "person", displayName: "Ana", email: "ana@example.com", avatarUrl: null },
  organization: { orgId: "org", name: "Equipe", slug: "equipe" },
  roles: {
    clerk: "admin",
    teams: [{ teamId: "team", role: "member" }],
    projects: [{ projectId: "project", role: "reader" }],
  },
} as const;

describe("fetchMe", () => {
  it("requests a fresh token for each call and sends it to /api/me", async () => {
    const getToken = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data));

    expect(await fetchMe(getToken, fetchImpl)).toEqual({ status: "ok", data });
    expect(await fetchMe(getToken, fetchImpl)).toEqual({ status: "ok", data });
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/me", {
      headers: { Authorization: "Bearer first" },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/me", {
      headers: { Authorization: "Bearer second" },
    });
  });

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s", async (code, status) => {
    const fetchImpl = async () => new Response(null, { status: code });
    expect(await fetchMe(async () => "token", fetchImpl)).toEqual({ status });
  });

  it("reports network failures as unavailable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    expect(await fetchMe(async () => "token", fetchImpl)).toEqual({ status: "unavailable" });
  });

  it("reports an invalid JSON body as unavailable", async () => {
    const fetchImpl = async () => new Response("<html>");
    expect(await fetchMe(async () => "token", fetchImpl)).toEqual({ status: "unavailable" });
  });

  it.each([
    null,
    {},
    { ...data, person: { ...data.person, avatarUrl: 42 } },
    { ...data, roles: { ...data.roles, clerk: "owner" } },
    { ...data, roles: { ...data.roles, teams: [{ teamId: "team", role: "reader" }] } },
    { ...data, roles: { ...data.roles, projects: [{ projectId: 42, role: "reader" }] } },
  ])("reports malformed response %# as unavailable", async (body) => {
    const fetchImpl = async () => Response.json(body);
    expect(await fetchMe(async () => "token", fetchImpl)).toEqual({ status: "unavailable" });
  });

  it("returns unauthenticated without an API request when Clerk returns no token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await fetchMe(async () => null, fetchImpl)).toEqual({ status: "unauthenticated" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports token retrieval failures as unavailable", async () => {
    const getToken = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Clerk unavailable"));
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await fetchMe(getToken, fetchImpl)).toEqual({ status: "unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("getMeIndicatorText", () => {
  it("returns no text while loading", () => {
    expect(getMeIndicatorText(null)).toBeNull();
  });

  it.each([
    ["admin", "Administrador"],
    ["member", "Membro"],
  ] as const)("renders the %s role", (clerk, label) => {
    const response = {
      ...data,
      roles: { clerk, teams: [...data.roles.teams], projects: [...data.roles.projects] },
    };
    expect(getMeIndicatorText({ status: "ok", data: response })).toBe(label);
  });

  it.each([
    ["unavailable", "API indisponível"],
    ["forbidden", "Sessão sem acesso à API"],
    ["unauthenticated", "Sessão sem acesso à API"],
  ] as const)("renders the %s status", (status, label) => {
    expect(getMeIndicatorText({ status })).toBe(label);
  });
});
