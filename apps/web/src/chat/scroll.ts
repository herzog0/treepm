/** Quanto falta para o fim da lista ainda conta como "o fim está à vista", em pixels. */
const NEAR_END = 24;

/** O fim da lista está à vista? O jsdom não tem layout (tudo zero, então sempre sim); os testes trocam as medidas no elemento. */
export const isAtEnd = (element: HTMLElement): boolean => element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_END;
