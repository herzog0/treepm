import type { DirectoryOrganization, DirectoryProvider, DirectoryUser } from "./directory-provider.js";

/** Subconjunto de `ClerkClient` usado para ler pessoa e organização. */
export type ClerkDirectoryClient = {
  users: {
    getUser(userId: string): Promise<{
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      imageUrl: string;
      primaryEmailAddressId: string | null;
      emailAddresses: { id: string; emailAddress: string }[];
    }>;
  };
  organizations: {
    getOrganization(params: { organizationId: string }): Promise<{
      name: string;
      slug: string | null;
    }>;
    /** `OrganizationApi.getOrganizationMembershipList` (`@clerk/backend`): `userId` filtra por pessoa, até 100. */
    getOrganizationMembershipList(params: { organizationId: string; userId: string[]; limit: number }): Promise<{
      data: { role: string; publicUserData?: { userId: string } | null }[];
    }>;
  };
};

export class ClerkDirectoryProvider implements DirectoryProvider {
  constructor(private readonly client: ClerkDirectoryClient) {}

  async getUser(userId: string): Promise<DirectoryUser> {
    const user = await this.client.users.getUser(userId);
    const email =
      user.emailAddresses.find((entry) => entry.id === user.primaryEmailAddressId) ??
      user.emailAddresses[0];
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    return {
      displayName: fullName || user.username || email?.emailAddress || userId,
      email: email?.emailAddress ?? "",
      avatarUrl: user.imageUrl || null,
    };
  }

  async getOrganization(orgId: string): Promise<DirectoryOrganization> {
    const organization = await this.client.organizations.getOrganization({ organizationId: orgId });
    return { name: organization.name, slug: organization.slug || orgId.toLowerCase() };
  }

  async getMembership(orgId: string, userId: string): Promise<string | null> {
    const memberships = await this.client.organizations.getOrganizationMembershipList({
      organizationId: orgId,
      userId: [userId],
      limit: 1,
    });
    // Não confia só no filtro: o item precisa ser da pessoa pedida (`publicUserData.userId`), senão não é membro.
    return memberships.data.find((item) => item.publicUserData?.userId === userId)?.role ?? null;
  }
}
