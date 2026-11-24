/** Pedido da barra lateral à barra de pedidos do mapa (ADR 0055): "Novo ticket" abre a conversa de novo ticket; "Buscar" leva o foco ao campo. */
export interface CommandRequest {
  kind: "new" | "search";
  /** Muda a cada pedido: dois pedidos iguais seguidos são dois pedidos. */
  id: number;
}
