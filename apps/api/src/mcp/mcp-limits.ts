/**
 * Tetos por minuto do servidor MCP (ADR 0038, ADR 0043, TREEPM-197). Ficam num módulo só deles para que as descrições das
 * ferramentas citem o valor vindo daqui, sem import circular com o `McpGateway`.
 *
 * Requisições por minuto por endereço IP, antes de qualquer outra conferência (ADR 0038). Em MEMÓRIA do processo:
 * a publicação prevê uma máquina só; com mais de uma, o limite efetivo passa a ser por máquina.
 */
export const IP_LIMIT_PER_MINUTE = 5000;
/** Escritas por minuto por token (ADR 0043), contadas à parte das leituras. */
export const WRITE_LIMIT_PER_MINUTE = 5000;
/** Somando todos os tokens da mesma pessoa na mesma organização (TREEPM-197). */
export const WRITE_LIMIT_PER_PERSON_PER_MINUTE = 5000;
