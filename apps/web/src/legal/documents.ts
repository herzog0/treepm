/** Só endereços e nomes: a rota decide o que carregar sem puxar o texto dos documentos. */
export type LegalDocumentId = "terms" | "privacy";

export interface LegalDocument {
  id: LegalDocumentId;
  path: string;
}

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, LegalDocument> = {
  terms: { id: "terms", path: "/termos" },
  privacy: { id: "privacy", path: "/privacidade" },
};

export const otherDocument = (id: LegalDocumentId): LegalDocument => LEGAL_DOCUMENTS[id === "terms" ? "privacy" : "terms"];

/** `/termos` e `/privacidade` (com ou sem barra final); qualquer outro caminho não é documento público. */
export function legalDocumentForPath(pathname: string): LegalDocument | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return Object.values(LEGAL_DOCUMENTS).find((document) => document.path === path) ?? null;
}
