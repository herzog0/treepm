import privacidade from "./content/pt-BR/privacidade.md?raw";
import termos from "./content/pt-BR/termos.md?raw";
import type { LegalDocumentId } from "./documents.js";

/** Os documentos existem só em português; o idioma da interface não os traduz (ADR 0039: tradução depois da aprovação do texto). */
export const LEGAL_MARKDOWN: Record<LegalDocumentId, string> = { terms: termos, privacy: privacidade };
