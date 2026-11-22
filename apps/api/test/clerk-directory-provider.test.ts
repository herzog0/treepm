import { describe, expect, it, vi } from "vitest";
import { ClerkDirectoryProvider } from "../src/auth/clerk-directory-provider.js";
import type { ClerkDirectoryClient } from "../src/auth/clerk-directory-provider.js";

type Item = { role: string; publicUserData?: { userId: string } | null };

function client(data: Item[]) {
  const getOrganizationMembershipList = vi.fn().mockResolvedValue({ data });
  return {
    getOrganizationMembershipList,
    provider: new ClerkDirectoryProvider({
      users: { getUser: vi.fn() },
      organizations: { getOrganization: vi.fn(), getOrganizationMembershipList },
    } as unknown as ClerkDirectoryClient),
  };
}

describe("ClerkDirectoryProvider.getMembership", () => {
  it("filtra a lista de participações pela organização e pela pessoa e devolve o papel", async () => {
    const { provider, getOrganizationMembershipList } = client([{ role: "org:admin", publicUserData: { userId: "user_1" } }]);
    expect(await provider.getMembership("org_1", "user_1")).toBe("org:admin");
    expect(getOrganizationMembershipList).toHaveBeenCalledWith({ organizationId: "org_1", userId: ["user_1"], limit: 1 });
  });

  it("devolve null quando a pessoa não é da organização", async () => {
    expect(await client([]).provider.getMembership("org_1", "user_1")).toBeNull();
  });

  it("trata como não membro a participação de OUTRA pessoa, sem confiar só no filtro", async () => {
    const other = client([{ role: "org:admin", publicUserData: { userId: "user_2" } }]);
    expect(await other.provider.getMembership("org_1", "user_1")).toBeNull();
  });

  it("trata como não membro o item sem dados da pessoa", async () => {
    expect(await client([{ role: "org:admin" }]).provider.getMembership("org_1", "user_1")).toBeNull();
    expect(await client([{ role: "org:admin", publicUserData: null }]).provider.getMembership("org_1", "user_1")).toBeNull();
  });

  it("acha a pessoa pedida entre vários itens", async () => {
    const many = client([
      { role: "org:admin", publicUserData: { userId: "user_2" } },
      { role: "org:member", publicUserData: { userId: "user_1" } },
    ]);
    expect(await many.provider.getMembership("org_1", "user_1")).toBe("org:member");
  });
});
