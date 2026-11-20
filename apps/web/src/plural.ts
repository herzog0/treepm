/** Contagem com o substantivo no singular só quando é exatamente 1. */
export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
