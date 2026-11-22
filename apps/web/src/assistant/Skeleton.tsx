/** Esqueleto de carregamento da resposta do assistente (TREEPM-194): linhas de larguras diferentes com brilho passando. */
export function Skeleton() {
  return (
    <div className="assistant-skeleton" aria-hidden="true">
      <span style={{ width: "92%" }} />
      <span style={{ width: "78%" }} />
      <span style={{ width: "54%" }} />
    </div>
  );
}
