# ADR 0025 — Base visual "Constelação", tema do mapa pela web e tela de importação

**Status:** Aceita, com as partes pendentes listadas no fim. **Data:** 2026-11-19.

## Contexto

As telas de administração da [ADR 0023](0023-telas-de-administracao-e-mapa-da-organizacao.md) foram construídas sem desenho de Teodoro. Em 2026-11-19 ele pediu um visual moderno, em tons escuros, na linha do Linear, mantendo a temática de constelação do mapa.

A proposta está em [TreePM — proposta visual](https://claude.ai/artifact/Mt7furZnr5y5gFRiqgWG8D) (privada). Teodoro corrigiu a primeira versão do mapa (tamanhos iguais por nível, filhos muito menores, detalhe crescendo com o zoom, resumo dos filhos) e trocou o marcador de situação em círculo por um quadrado que se enche. À sequência de cinco quadros de zoom resultante ele respondeu "perfeito". Esta ADR lê essa resposta como aprovação da direção escura, do card escuro no mapa e da cor do nó como situação, que são o que os quadros mostram. As pranchas acrescentadas depois dessa resposta não estão aprovadas e ficam fora desta ADR.

## Decisão

### Tokens

A web ganha `apps/web/src/theme.css` com propriedades CSS em `:root`. Todo CSS de `apps/web` passa a usar os tokens; nenhuma cor literal fora desse arquivo, exceto as cores de projeto de `map/items.ts`.

| Token | Valor | Uso |
| --- | --- | --- |
| `--tp-bg` | `#08090d` | Fundo da aplicação e do mapa |
| `--tp-bar` | `#0b0c11` | Cabeçalho, barra de caminho e fundo de campo |
| `--tp-surface` | `#0e1016` | Painéis e listas |
| `--tp-card` | `#12151d` | Cards do mapa e cartões |
| `--tp-raised` | `#14171f` | Controles secundários |
| `--tp-selected` | `#1a1e2b` | Linha ou item selecionado |
| `--tp-divider` | `#1c1f28` | Divisor entre regiões |
| `--tp-border` | `#272c38` | Borda de controle e de card |
| `--tp-border-strong` | `#343a49` | Borda em destaque |
| `--tp-text` | `#eceef2` | Texto principal |
| `--tp-text-2` | `#a0a6b4` | Texto secundário |
| `--tp-text-3` | `#8b92a3` | Rótulos e metadados |
| `--tp-accent` | `#a99bff` | Ação principal, seleção e foco |
| `--tp-accent-soft` | `#d6ceff` | Texto sobre fundo escuro que precisa do destaque |
| `--tp-on-accent` | `#121019` | Texto sobre `--tp-accent` |
| `--tp-todo` | `#8b92a3` | Situação a fazer e cancelado |
| `--tp-doing` | `#6ea8ff` | Em andamento |
| `--tp-review` | `#e7b450` | Em revisão |
| `--tp-done` | `#4fc48c` | Concluído e progresso |
| `--tp-danger` | `#e5687a` | Erro e confirmação de remoção |
| `--tp-danger-text` | `#f0919b` | Texto de erro e ação destrutiva em repouso |

Raios de 6 px (controles), 8 px (campos grandes e listas) e 10 px (painéis). Espaçamento em múltiplos de 4 px. Controles com 28 a 32 px de altura.

### Tipografia

Inter na interface e JetBrains Mono nas chaves de ticket e na lista colada. As fontes são servidas pela própria aplicação (pacotes `@fontsource-variable/inter` e `@fontsource/jetbrains-mono` em `apps/web`), sem requisição a terceiros.

Tamanhos: 22/600 para título de tela, 16/600 para seção, 13/400 para texto, 12/400 para rótulo e 11,5/500 em mono para chave.

### Regras de componente

- Uma ação principal por tela, em `--tp-accent`. As demais são secundárias (borda) ou de texto.
- Ação destrutiva continua pedindo o segundo clique no mesmo lugar, como a ADR 0023 já faz; o segundo estado usa `--tp-danger`.
- Foco de teclado: contorno de 2 px em `--tp-accent`.
- Erro de campo: borda em `--tp-danger` e mensagem em `--tp-danger-text` logo abaixo, ligada ao campo.

### Marcador de situação

A situação é um quadrado com borda que se enche de baixo para cima: vazio (a fazer), metade (em andamento), três quartos (em revisão), cheio (concluído) e borda tracejada sem preenchimento (cancelado). Em ticket com filhos, o mesmo quadrado se enche na proporção de folhas concluídas. O marcador nunca aparece sozinho onde há espaço para texto: vem com o nome da situação ou com o progresso e a base.

### Tema do mapa, feito pela web

`packages/engine` e `packages/react` não mudam. O mapa autenticado é tematizado de `apps/web`: as variáveis `--spatial-*` que o pacote já expõe e regras próprias com escopo no mapa da organização, que vencem os seletores `:where()` do pacote. `?demo` continua com a aparência atual.

- Card escuro (`--tp-card`, borda `--tp-border`, texto `--tp-text`), com a linha superior na cor do nó.
- Cor do nó, pelos adaptadores `getColor` e `mixColors`: organização e projeto em `--tp-accent`; ticket folha na cor da situação; ticket com filhos e quadrado mesclado na mistura das cores das folhas descendentes.
- Conteúdo por nível de detalhe, nos quatro níveis que o pacote já tem: completo com chave, título e marcador com situação ou progresso; compacto com chave, título e marcador; chip com marcador e título; ponto só com a cor.
- Gestos, câmera, limiares e atalhos não mudam.

### Tela de importação

A importação da [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md) ganha a tela `?view=import&project=<id>`, no padrão de navegação da ADR 0023.

- Entrada: ação "Importar lista" no detalhe do projeto, no painel lateral, para quem pode criar tickets (administrador da organização, gestor ou colaborador) em projeto não arquivado.
- A tela tem a lista colada à esquerda e a prévia da árvore à direita, atualizada enquanto a pessoa digita, com erros por linha e o aviso de marcador em item com filhos.
- A ação principal informa a quantidade ("Importar 37 tickets") e fica desabilitada enquanto houver erro ou a lista estiver vazia.
- Depois de importar, a web volta ao mapa e recarrega. Falha da API mostra a mensagem junto da ação e mantém o texto.
- Projeto inexistente, invisível ou sem permissão mostra a mensagem correspondente, sem a área de texto.

## Pendente, fora desta ADR

Em 2026-11-20 Teodoro aprovou a proposta visual inteira. A página do ticket e a criação e edição manual passaram a ser decididas na [ADR 0026](0026-pagina-do-ticket-e-zoom-ate-a-folha.md); os itens abaixo ficam como registro do que estava pendente nesta data.

- **Página lateral do ticket com deslize e foco (IDEA-013).** Falta decidir que gesto abre o ticket. Hoje um clique seleciona sem mover a câmera, e essa interação é a aprovada.
- **Card em nível "detalhe".** Os quadros mostram um quinto nível, para o card grande. `renderNodeContent` só recebe os quatro níveis atuais, sem a largura projetada, então isso pede mudança em `packages/react` ou outra técnica a avaliar.
- **Novo ticket pela conversa com a IA e reclassificação ao editar (IDEA-005 e IDEA-014).** Dependem de ADR própria, das dúvidas 5, 9, 10 e 11 do blueprint e de chaves de provedores.
- **Criação e edição manual de ticket pela interface.** Entram junto com a página do ticket.

## Consequências

- A aparência das telas de administração muda inteira, sem mudança de comportamento. Os testes de componente continuam valendo, porque consultam papéis e nomes acessíveis.
- O mapa autenticado e a demo passam a ter aparências diferentes: a demo fica como registro do card claro.
- A cor deixa de identificar o projeto no mapa. Com mais de um projeto, quem os distingue é o card do projeto, com nome e chave.
- A mistura de cores passa a indicar de longe quanto de um ramo andou, mas não permite ler contagens; o progresso com a base continua no card e na seleção.
- Duas dependências novas em `apps/web`, só de fontes.
