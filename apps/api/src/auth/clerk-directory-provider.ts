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
}
