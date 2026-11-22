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
  /**
   * Participação da pessoa na organização (ADR 0038): o papel com o prefixo do Clerk (`org:admin`) ou `null`
   * se ela não é mais da organização. Chamada de rede: nunca com a transação do tenant aberta.
   */
  getMembership(orgId: string, userId: string): Promise<string | null>;
}

export const DIRECTORY_PROVIDER = Symbol("DIRECTORY_PROVIDER");
