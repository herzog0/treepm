# ADR 0027 — Card em nível "detalhe" no mapa e trecho da descrição na listagem

**Status:** Aceita. **Data:** 2026-11-20.

## Contexto

A [ADR 0026](0026-pagina-do-ticket-e-zoom-ate-a-folha.md) levou o zoom até a folha chegar a 440 px, mas o card grande continuou mostrando o conteúdo do nível "completo" em letra pequena, no canto. Teodoro viu o resultado e decidiu em 2026-11-20: "quero card detalhe, com texto maior, descrição e pessoas. Zoom = controle de detalhe de informação."

O nível "detalhe" já está desenhado no quadro aprovado da [proposta visual](https://claude.ai/artifact/Mt7furZnr5y5gFRiqgWG8D) e ficou pendente na [ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md) por dois motivos: o conteúdo do nó só recebe os quatro níveis do pacote, sem a largura projetada, e a listagem de tickets não traz a descrição.

## Decisão

### Princípio

O zoom controla o detalhe da informação. Quanto maior o card na tela, mais conteúdo e mais legível; quanto menor, menos. O card mostra o que cabe; a página do ticket mostra tudo.

### Quinto nível, feito pela web

`packages/engine` e `packages/react` não mudam. Um card entra no nível "detalhe" quando a sua largura na tela chega a **300 px**, como no quadro aprovado. A largura na tela é a largura do próprio nó no layout multiplicada pela escala da câmera; não se assume a mesma largura para todos os nós de um nível.

- A troca de nível é decidida por nó. Zoom e pan dentro do mesmo nível não redesenham o conteúdo dos cards.
- Os limiares dos quatro níveis atuais, os gestos e a câmera não mudam. `?demo` não muda.

### Conteúdo do card em "detalhe"

Segue o bloco do quadro aprovado, com as medidas dele:

1. **Linha de cima:** a chave à esquerda e, à direita, a contagem de filhos diretos ("3 subtickets"; no projeto, "n tickets na raiz"; na organização, "n projetos").
2. **Título** em letra maior (22 px), inteiro quando couber.
3. **Situação** com o marcador; em ticket com filhos, o progresso com a base.
4. **Descrição:** o trecho que couber na altura do card, cortado com reticências.
5. **Rodapé:** as pessoas atribuídas, em iniciais com o nome acessível, e, em ticket com filhos, a contagem das folhas por situação.

Organização e projeto em "detalhe" mostram a linha de cima e o nome em letra maior; não têm descrição nem pessoas.

### Trecho da descrição na listagem

O contrato da [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md) ganha um campo: todo `TicketSummary` passa a trazer `descriptionExcerpt`, os primeiros 600 caracteres da descrição, sem cortar um caractere pela metade, terminando em "…" quando a descrição é maior. Descrição vazia dá trecho vazio.

- O trecho vem na listagem que o mapa já carrega. Não há requisição por card.
- `TicketDetail` continua trazendo a descrição inteira.

### Pessoas

O mapa passa a carregar `GET /api/people` junto com os projetos, para dar nome às pessoas atribuídas. Todo membro da organização já pode ler essa lista.

## Consequências

- O card grande deixa de ter área vazia: passa a servir para ler o ticket sem abrir a página.
- A listagem de tickets fica maior, em até 600 caracteres por ticket.
- O mapa faz uma requisição a mais na carga.
- O conteúdo do nó passa a depender da escala da câmera por um caminho próprio da web. Se o pacote um dia expuser a largura projetada, esse caminho pode ser trocado sem mudar a aparência.
- Fica valendo, para os próximos níveis e telas, o princípio de que zoom é detalhe de informação.
