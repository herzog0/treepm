export type DirectoryUser = {
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

export type DirectoryOrganization = {
  name: string;
  slug: string;
};

/** Porta para os dados de identidade no Clerk; nada disso vem do cliente. */
export interface DirectoryProvider {
  getUser(userId: string): Promise<DirectoryUser>;
  getOrganization(orgId: string): Promise<DirectoryOrganization>;
}

export const DIRECTORY_PROVIDER = Symbol("DIRECTORY_PROVIDER");
