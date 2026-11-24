/**
 * "Entrar como" uma pessoa de teste (ADR 0057): o id da pessoa escolhida fica no `sessionStorage` (por aba, some ao fechar a aba) SÓ para restaurar o modo ao recarregar a página.
 * A fonte do que vale é o estado da árvore montada: o cliente da API daquela árvore é criado com o id e manda sempre o mesmo cabeçalho
 * `X-TreePM-Act-As`, do começo ao fim da vida dela. Quem decide se vale é o servidor.
 */
export const ACT_AS_HEADER = "X-TreePM-Act-As";
const KEY = "treepm.actAs";

export type ActingAs = { id: string; displayName: string };

/** `sessionStorage` pode faltar ou lançar (janela privada, dados bloqueados): sem ele o modo simplesmente não existe. */
export function readActAs(): ActingAs | null {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, displayName } = parsed as Record<string, unknown>;
    return typeof id === "string" && id !== "" && typeof displayName === "string" ? { id, displayName } : null;
  } catch {
    return null;
  }
}

export function writeActAs(value: ActingAs | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* sem armazenamento: o modo não se guarda */
  }
}

const rejectionListeners = new Set<(personId: string) => void>();

/** O servidor recusou o "entrar como" (`act_as_not_allowed`): quem monta a aplicação sai do modo e avisa. `personId` é a pessoa que o pedido levava. */
export function onActAsRejected(listener: (personId: string) => void): () => void {
  rejectionListeners.add(listener);
  return () => rejectionListeners.delete(listener);
}
export function notifyActAsRejected(personId: string): void {
  for (const listener of [...rejectionListeners]) listener(personId);
}
