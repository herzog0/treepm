/**
 * Saída da ferramenta. Com a saída padrão num pipe, o Node entrega só o que o pipe aceita (64 KB) e deixa o resto na fila;
 * `process.exit` descartava essa fila e o `ticket-list --json` de um projeto grande saía cortado (TREEPM-325).
 * `exitAfterFlush` espera a fila das duas saídas esvaziar antes de encerrar o processo.
 */
export const log = (line: string): void => console.log(line);

const drained = (stream: NodeJS.WriteStream): Promise<void> => new Promise((resolve) => stream.write("", () => resolve()));

export async function exitAfterFlush(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
