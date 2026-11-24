# 0058 — Menções iguais na plataforma inteira: um componente no meio do texto, `#` para ticket, `@` para pessoa

- **Data:** 2026-11-24
- **Situação:** pedido de Teodoro em 2026-11-24 (`TREEPM-409`); detalhe da coordenação por delegação, reversível.

## Contexto

Existem hoje duas implementações de menção. A descrição e os comentários do ticket usam um editor rico (Tiptap), em que `@` abre a lista de tickets e a menção é só o texto da chave com uma decoração por cima; por ser texto, o backspace a come letra por letra, e `TREEPM-88` vira `TREEPM-8`, que pode ser outro ticket. As conversas usam um campo de texto simples, com `#` para ticket e `@` para pessoa ([ADR 0056](0056-meu-chat-fala-com-a-aplicacao.md)), e a pessoa marcada fica numa pastilha fora do texto.

Teodoro, depois de usar: o desenho da menção dos comentários "tem que ser o mesmo design nas conversas também"; "apertar o backspace colado no item apaga o item inteiro", e isso é correção "nesse componente como um todo"; "Tickets é hashtag, pessoas é arroba", na plataforma inteira; a pessoa marcada numa mensagem aparece "com highlight na própria mensagem", além de continuar aparecendo que ela vai fazer parte da thread; e "nos comentários, eu também quero poder marcar pessoas do mesmo jeito", "que nem no Slack" ou no Linear.

## Decisão

1. **Um componente só.** A menção é um item indivisível dentro do texto, com destaque, igual na descrição, nos comentários e nas conversas. Um backspace colado a ele o apaga inteiro; as setas passam por ele como por um caractere; copiar e colar o leva junto.
2. **`#` abre tickets e `@` abre pessoas, em todo lugar.** Na descrição e nos comentários o `@` deixa de abrir tickets. O seletor é o mesmo componente nos três lugares.
3. **Onde cada um vale:**
   - **Ticket (`#`):** descrição, comentários e conversas. Na descrição e nos comentários, tickets do mesmo projeto, como hoje (a ligação entre tickets é do mesmo projeto); nas conversas, de qualquer projeto que a pessoa enxerga.
   - **Pessoa (`@`):** comentários e conversas. **Não na descrição:** a descrição vai ao provedor de IA e às leituras do MCP, e nome de pessoa não vai a nenhum dos dois.
4. **Como fica guardado:**
   - **Ticket:** a chave com `#` na frente (`#TREEPM-88`). A chave sem `#` que já está nos textos continua sendo reconhecida e mostrada como menção; ao salvar de novo, sai com `#`. A detecção das ligações entre tickets não muda (já aceita as duas formas).
   - **Pessoa:** um elo com esquema próprio, `[@Nome](person:<id>)`. Quem lê por fora do TreePM vê "@Nome"; o TreePM mostra o nome atual da pessoa e, se ela não existir mais na organização, o nome guardado, sem destaque de pessoa.
5. **Nas conversas, quem entra na thread continua sendo a lista enviada à parte.** O servidor não decide participante lendo o texto. A tela mantém as duas coisas iguais (o item no texto e a pessoa na lista de quem vai participar: tirar um tira o outro), e o servidor recusa mensagem cujo texto traga pessoa que não está na lista. Com isso, nenhuma mensagem com nome de pessoa em formato de menção chega ao assistente: mensagem que marca alguém abre thread e fica fora do histórico dele.
6. **Na descrição, o servidor recusa texto com menção de pessoa** (colada de um comentário, por exemplo), pelo mesmo motivo do item 3.
7. **O campo de escrita das conversas passa a ser o mesmo editor,** em configuração mínima: parágrafo, quebra de linha e menção, sem formatação. Enter envia, Shift+Enter quebra a linha, colar entra como texto, o limite de 4.000 caracteres e o contador continuam. A mensagem de pessoa continua sendo texto, não markdown.
8. **Marcar pessoa em comentário não avisa ninguém** nesta versão: é destaque e elo. Aviso é assunto próprio.

## Fora deste recorte

- Notificação de quem foi marcado em comentário.
- Menção de pessoa na descrição.
- Ligação entre tickets a partir de comentário (hoje só a descrição gera ligação).

## O que muda em outras decisões

- **ADR 0036 e 0037:** a menção de ticket na descrição passa a ser aberta por `#` e guardada com `#`; a regra de que o texto é a fonte da ligação continua.
- **ADR 0056, item 3:** a pessoa marcada numa conversa deixa de ser só pastilha fora do texto e passa a aparecer também no meio dele; a regra de que o servidor recebe as pessoas à parte continua.

## Consequências

- Quem tinha o hábito de `@` para ticket na descrição precisa trocar para `#`.
- Textos de descrição antigos ganham o `#` na frente das chaves quando forem salvos de novo.
- O campo de escrita das conversas é refeito pela segunda vez em pouco tempo; os testes dele são portados, não apagados.
- Identificador de pessoa passa a existir dentro do texto de comentários e de mensagens. Nenhum dos dois vai ao provedor de IA nesse formato; o servidor guarda as duas portas (itens 5 e 6).

## Como ficou (2026-11-24)

Numa mudança só, sem migration.

- **O item:** dois nós indivisíveis do editor, ticket e pessoa, em `apps/web/src/mentions/`, com um seletor só. O item não quebra por dentro: desce inteiro para a linha seguinte e, se for mais largo que o campo, o título encolhe.
- **O campo das conversas** é o mesmo editor em configuração mínima. Os testes de conversa dirigem o editor por um ajudante único, pelo caminho real de teclado; o comportamento real de Backspace, Delete, colar e posição do seletor fica na suíte de navegador.
- **Formato:** funções em `packages/domain/src/mentions.ts`. O `#` só entra em chave solta; endereço, código e destino de link ficam intocados, e aplicar duas vezes dá o mesmo.
- **`#` seguido de espaço no começo de um bloco continua sendo o atalho de título;** `#` seguido de letra ou número abre os tickets.
- **Recusa de pessoa em texto que vai à IA ou ao MCP:** um detector estrito, que olha o texto cru sem exceção para código (recusar a mais é aceito), aplicado nos esquemas de título e descrição de ticket. Cobre criar, editar, importar, o rascunho e as mensagens da conversa de novo ticket, o pedido ao assistente na descrição e o MCP de escrita.
- **Conversas:** o servidor recusa texto com pessoa que não está na lista enviada à parte, pela mesma varredura crua, antes de chamar o provedor.
- **Na descrição não existe item de pessoa:** colar um vira `@Nome` simples.
- **O comentário mostra o nome atual da pessoa;** identificador desconhecido mostra o nome guardado, sem destaque. Prévia e rótulo de thread trocam o elo por `@Nome`.
- **Tamanho da letra do campo das conversas:** o das mensagens em tela larga; 16 px em tela estreita, para o iOS não dar zoom ao focar.

### Lacunas conhecidas

- A limpeza do que o assistente propõe inserir na descrição não tem teste próprio.
- Marcar pessoa em comentário não avisa ninguém (`TREEPM-410`).
