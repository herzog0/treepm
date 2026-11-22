export const PATH_SEPARATOR = " › ";
const KEEP_WHOLE = 3;

/** O caminho completo da ideia na árvore, para a dica. */
export const fullPath = (path: readonly string[]): string => path.join(PATH_SEPARATOR);

/** O caminho na linha: até três títulos inteiros; acima disso, o primeiro, reticências e os dois últimos. */
export function shortPath(path: readonly string[]): string {
  if (path.length <= KEEP_WHOLE) return fullPath(path);
  return [path[0], "…", ...path.slice(-2)].join(PATH_SEPARATOR);
}
