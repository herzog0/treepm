/**
 * O último projeto escolhido na tela "Ideias", lembrado só enquanto a página está aberta (ADR 0042): vive na memória do módulo,
 * não em `localStorage`, e some quando a aba recarrega.
 */
let lastProjectId: string | null = null;

export const lastIdeasProject = (): string | null => lastProjectId;
export const rememberIdeasProject = (projectId: string): void => {
  lastProjectId = projectId;
};
/** Esquece a escolha (para os testes). */
export const resetIdeasSession = (): void => {
  lastProjectId = null;
};
