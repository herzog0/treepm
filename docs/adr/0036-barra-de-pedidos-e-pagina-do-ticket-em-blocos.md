# ADR 0036 — Barra de pedidos no topo do mapa e página do ticket com descrição em blocos

**Status:** Desenho aprovado por Teodoro em 2026-11-21 ("design aprovado, pode implementar"). Os pontos marcados como escolha da coordenação valem até ele dizer o contrário. As duas capacidades de IA foram autorizadas por ele em 2026-11-21 ("Segue a sua recomendação pras coisas em aberto"); a pergunta sobre o projeto segue a [ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md), e "Pedir ao assistente para escrever" foi implementada em 2026-11-21 (PR #103), sem chamada a provedor real nem teste com sessão real; a pergunta sobre o projeto ainda não. As fatias 1, 2 e 3 (a barra com busca, a página do ticket e a conversa dentro da barra) foram implementadas em 2026-11-21 (PRs #92, #93 e #94), e a descrição em blocos (fatia 4) também (PR #96). Nada foi testado com sessão real. **Data:** 2026-11-21.

Muda, na [ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md), onde a conversa de novo ticket aparece (o painel lateral dá lugar à barra); e, na [ADR 0026](0026-pagina-do-ticket-e-zoom-ate-a-folha.md), o desenho interno da página do ticket. A largura de 620 px, o deslize e o foco do mapa continuam como estão.

## Contexto

Em 2026-11-21 Teodoro pediu:

> propõe um novo design pros paineis de interação com ticket e com a IA, pense em coisa moderna, barra fixa flutuante no topo onde usuário pode perguntar qualquer coisa do projeto, achar tickets, criar novos etc. placeholder "peça qualquer coisa" com ícone de IA. painel de ticket mais modernizado, opções e estilo de edição tipo notion com suporte markdown e menção de outros tickets.

A proposta está no canvas [TreePM — Barra de pedidos e página do ticket](https://claude.ai/artifact/MnKtCAewNtyzyWCxgDJiNw) (privado), em sete pranchas. Ele respondeu "design aprovado, pode implementar". Depois da aprovação, a coordenação corrigiu a posição de dois menus nas pranchas de edição, que cobriam a linha que os abre.

Duas coisas no canvas não são especificação: o mapa de fundo é esquemático (o mapa real não muda), e a última frase da descrição do `TREEPM-46`, com duas menções, foi inventada para ilustrar.

O que existe hoje:

- A conversa de novo ticket vive em um painel lateral de 440 px, aberto pelo botão "+ Novo ticket" no canto inferior direito do mapa. Abrir um ticket ou o painel de áreas fecha a conversa, e o contrário.
- Não há busca de tickets. Os tickets de todos os projetos visíveis já ficam carregados na web.
- A descrição do ticket é texto puro (até 20.000 caracteres), editada em uma área de texto com "Salvar" e "Cancelar" e mostrada com as quebras de linha como foram digitadas.
- A chave do projeto não pode ser alterada depois de criada (a API não aceita o campo na alteração).

## Decisão

### Barra de pedidos

**Onde fica** *(escolha da coordenação nos detalhes)*

- No topo do palco do mapa, flutuando, centralizada na parte do mapa que está livre: com a página do ticket (620 px) ou o painel de áreas (380 px) abertos, ela se centraliza no que sobra. Largura de até 620 px.
- Só na tela do mapa. Times, Configurações e Importação não mostram a barra neste recorte.
- A barra de câmera continua no canto superior direito. Quando a largura livre não comporta as duas lado a lado, a barra de pedidos desce para baixo da de câmera.
- Com a página do ticket ocupando a tela inteira (abaixo de 1.000 px), a barra fica coberta por ela, como o resto do mapa.

**Foco e teclado**

- `Ctrl+K` (`⌘K` no Mac) leva o foco à barra de qualquer lugar da tela do mapa. Clicar nela também.
- Com o foco na barra ou na folha dela, os atalhos do mapa (`Esc` limpa a seleção, `Enter` abre o ticket, `c` alterna as cores) não disparam.
- Ordem do `Esc`: cancela a escolha no mapa, se houver; senão recolhe a folha da barra e devolve o foco ao mapa; senão vale o que já existe (fecha a página do ticket ou a criação).
- `Tab` não é atalho de nenhuma ação: continua movendo o foco.

**Com texto digitado: busca**

- A busca é feita na web, sobre os tickets já carregados, sem rota nova na API.
- Procura na chave (`TREEPM-47` ou só `47`), no título e no trecho da descrição, sem diferenciar maiúsculas nem acentos.
- Ordem: chave que bate; título que começa com o texto; título que contém; trecho que contém. Até oito resultados.
- Cada resultado mostra o marcador de situação, a chave, o título e a situação ou o progresso. A chave já diz o projeto.
- `Enter` abre o ticket destacado, do mesmo jeito que o botão "Abrir" de hoje.

**Ações, abaixo dos resultados**

- "Criar ticket «texto»" (`Ctrl+Enter`): começa a conversa de novo ticket com o texto como primeira mensagem.
- Quem aparece para quem:

| Situação da pessoa | O que a barra oferece |
| --- | --- |
| Pode criar e a IA está ligada | Busca e "Criar ticket", pela conversa |
| Pode criar e a IA está desligada | Busca e "Criar ticket", que abre a criação manual com o título preenchido |
| Não pode criar em nenhum projeto | Só a busca |

**Escopo e projeto**

- Ticket selecionado no mapa ao começar a criação vira o escopo da procura, mostrado na barra como "Dentro de `CHAVE`". O "×" tira o escopo (é o "Procurar no projeto inteiro" de hoje).
- O projeto é o do nó selecionado, ou o único em que a pessoa pode criar. Com mais de um possível e nada selecionado, a folha pergunta "Em qual projeto?", como hoje.

**A conversa passa a viver na folha da barra**

- Tudo o que o painel lateral faz hoje continua, com os mesmos textos e as mesmas regras: mensagens, rascunho editável, "Procurar o lugar", pergunta pendente com "Procurar assim mesmo", caminho encontrado, outros lugares possíveis, "Um nível acima", proposta de ticket pai, fora do escopo, incerto, aviso de reabertura do destino concluído, erro do provedor com "Tentar de novo" e "Criar manualmente", conversas anteriores, "Nova conversa" e "Apagar conversa".
- O painel lateral da conversa e o botão "+ Novo ticket" deixam de existir. O botão de criar o primeiro ticket de um projeto vazio continua.
- **Exclusão mútua (muda):** abrir um ticket ou o painel de áreas não encerra mais a conversa. A folha se recolhe para a barra, que mostra que há uma conversa em andamento, e clicar na barra reabre a folha onde estava.
- **"Escolher no mapa":** a folha se recolhe, a barra mostra a instrução ("Clique em um ticket ou no projeto, no mapa. Esc cancela.") e "Cancelar escolha". Depois do clique, a folha reabre com o lugar escolhido.

### Página do ticket

- **Cabeçalho:** projeto e chave à esquerda; à direita, "Ver no mapa" (refaz o foco da câmera no ticket), "Copiar link", "Mais ações" (onde fica "Excluir", com a confirmação de hoje) e "Fechar".
- **Título** editável no lugar, como hoje.
- **Propriedades em linhas,** rótulo à esquerda e valor à direita, sem borda em repouso: Situação (mostra a atual e abre um menu com as cinco), Responsáveis, Ticket pai e, quando há itens, Itens (barra de progresso e "n de m concluídos").
- A recusa de concluir com item aberto e o aviso de reabertura aparecem junto da linha de Situação, com os textos de hoje.
- **Descrição:** ver a próxima seção.
- **Itens:** a lista de hoje e "Novo ticket aqui dentro". "O que entra aqui" continua, com o comportamento de hoje.
- **Código** e o aviso de somente leitura continuam.
- A criação manual usa o mesmo desenho.
- Nenhuma regra muda: permissões, o que cada papel edita e o que a API aceita ficam como estão.

### Descrição em blocos

**O que é guardado**

- A mesma coluna e o mesmo limite de 20.000 caracteres. O texto passa a ser lido como markdown. Sem migration e sem mudança na API.
- **A quebra de linha simples continua sendo quebra de linha.** As descrições existentes e os rascunhos da IA dependem disso; sem essa regra todo ticket atual mudaria de forma.
- Subconjunto: parágrafo, título em dois níveis, lista, lista numerada, lista de tarefas, citação, código (em linha e em bloco), negrito, itálico e link. HTML escrito no texto não é interpretado. Imagem e tabela ficam fora.

**Como se edita** *(escolha da coordenação)*

- Clicar no texto edita no lugar. Salva ao sair do campo ou com `Ctrl+Enter`; `Esc` desfaz o que não foi salvo. A API só é chamada se o texto mudou. Um indicador discreto mostra "salvando" e "salvo", e a falha mantém o texto na tela com o erro.
- "/" abre o menu de blocos: Texto, Título, Lista, Lista de tarefas, Citação, Código e Mencionar ticket. Os atalhos de markdown digitados (`#`, `-`, `[]`, `>`, crases) também funcionam.
- Quem pode editar o ticket marca e desmarca itens de lista de tarefas direto na leitura.
- O rascunho da conversa de novo ticket usa o mesmo componente.

**Menções**

- "@" abre a lista de tickets do mesmo projeto, com a busca da barra.
- A menção é guardada como a **chave do ticket no texto** (`TREEPM-47`). A [ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md) acrescenta uma ligação gravada no banco, derivada desse texto. Qualquer chave de um ticket existente do mesmo projeto, digitada ou inserida, aparece como menção: marcador de situação, chave e título atuais, e o clique abre o ticket.
- Chave que não existe (ticket apagado, ou de outro projeto) aparece como texto comum.
- Não há lista de "quem menciona este ticket" neste recorte.
- A chave é estável porque a chave do projeto não pode ser alterada e o número do ticket não muda.

**Onde a descrição aparece como texto**

- O trecho da descrição (`descriptionExcerpt`) **não muda na API**: ele alimenta a procura do caminho, que foi medida com esse texto. No card em detalhe do mapa, a web tira os sinais de markdown na hora de mostrar.

**Biblioteca** *(escolha da coordenação)*

`Tiptap` (sobre ProseMirror) com a extensão oficial de markdown e o utilitário de sugestões para "/" e "@", desde que a documentação atual confirme o que segue; se não confirmar, a implementação propõe outra e diz por quê, antes de escrever código:

1. licença compatível com o projeto (MIT ou equivalente) em tudo o que for usado;
2. React 19;
3. ida e volta estável: gravar o que foi lido sem edição não altera o texto, para o subconjunto acima e para as descrições que existem hoje no `TREEPM`;
4. menus de "/" e "@" desenhados por nós, com os textos do catálogo de traduções;
5. leitura e edição pelo mesmo componente, para não haver dois interpretadores de markdown.

**Testes**

- O `jsdom` não exercita digitação em campo editável. Por isso:
  - funções puras (busca, detecção de menção, limpeza do trecho, ida e volta do markdown pela API da biblioteca) ficam na suíte de hoje;
  - a digitação de verdade ("/" abre o menu, "@" abre a lista, `Enter` insere, salvar ao sair) roda em **navegador real, sem janela**, em uma suíte separada (`test:browser`, modo navegador do Vitest com Chromium), que entra nas verificações obrigatórias.
- Se a suíte de navegador não for viável no ambiente, a implementação para e relata antes de seguir.

### Capacidades de IA, autorizadas em 2026-11-21

Estão no canvas aprovado e enviam à Anthropic mais do que estava autorizado até então (texto de ticket e texto de conversa, sem identificadores). Ficaram à espera de Teodoro, que respondeu em 2026-11-21: "Segue a sua recomendação pras coisas em aberto".

**Pergunta sobre o projeto** (prancha "Barra 3"). A proposta original enviava, por ticket do projeto, título, trecho da descrição, **situação**, **de qual ticket é filho** e um rótulo neutro, a cada pergunta. A [ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md) troca isso por ferramentas de consulta: a IA pede só os tickets de que precisa. A lista do que vai e do que não vai à Anthropic está lá.

**"Pedir ao assistente para escrever"** (item do menu de blocos): envia o título, a descrição atual, os títulos do caminho até a raiz e o pedido. Nada sobre pessoas, nenhum id e nenhuma chave além das que a pessoa escreveu no próprio texto. O texto volta como proposta, que a pessoa aceita ou descarta; nada é salvo sem ela.

### Fatias

1. **Barra: busca e abrir ticket.** "Criar ticket" abre a conversa atual, ainda no painel lateral, com o texto. Só web.
2. **Página do ticket: novo desenho,** com a descrição ainda em área de texto. Só web.
3. **Conversa dentro da barra;** saem o painel lateral e o botão. Só web.
4. **Descrição em blocos,** com menções e a suíte de navegador. Só web, com dependência nova.
5. **As duas capacidades de IA,** autorizadas em 2026-11-21 (`TREEPM-79` e `TREEPM-80`). API e web.

As fatias 1 e 2 não trazem dependência nova nem enviam nada novo a provedor. Todo texto novo entra no catálogo nos três idiomas (ADR 0035), e todo comportamento novo começa por um teste que falha.

## Como ficou na implementação (fatias 1 a 3)

- **Busca por palavras.** O texto é dividido em palavras, e o ticket bate quando todas aparecem. Ordem: chave que bate (texto de uma palavra só); título que começa com o texto inteiro; título com todas as palavras; todas as palavras somando título e trecho. A primeira entrega procurava a frase inteira, e `exportar csv` não achava "Exportar tickets em CSV".
- **Criar pela barra abre sempre uma conversa nova.** A anterior continua guardada e volta por "Continuar conversa".
- **Campo vazio com foco:** "Continuar conversa", com o título do rascunho ou o começo da primeira mensagem, e "Nova conversa". Nada vem destacado, para um `Enter` não começar conversa sem querer.
- **Recolher uma conversa sem nenhuma mensagem a encerra;** com texto digitado e não enviado, ela fica em andamento.
- **Com a conversa à vista, o campo "Peça qualquer coisa" some;** buscar um ticket exige recolher antes (`Esc` ou "Recolher").
- **A barra desce para baixo da barra de câmera** quando a largura livre é menor que 980 px, o que acontece com a página do ticket aberta em uma tela de 1.440 px. O número é uma estimativa.
- **`Ctrl+K` é escutado em fase de captura,** porque a página do ticket e os painéis param a propagação das teclas. A dica na barra diz "Ctrl K" em todos os sistemas.
- **Rótulos da página do ticket mantidos:** "Pessoas", "Progresso" e "Remover ticket" (o texto desta ADR dizia "Responsáveis", "Itens" e "Excluir"). O aviso de reabertura continua junto de "Ticket pai" e do formulário de criação, onde já aparecia.
- **Textos que mudaram:** "Fechar conversa" virou "Recolher"; "Procurando dentro de «título»" virou o chip "Dentro de `CHAVE`"; o texto do botão flutuante "Novo ticket" saiu.
- **Criação manual com a IA desligada e mais de um projeto possível:** usa o projeto do nó selecionado ou, sem seleção, o primeiro em que a pessoa pode criar.
- **Conferência visual:** capturas sem janela com dados falsos, da página do ticket e da conversa na barra. A barra em repouso e a folha de busca não foram capturadas na fatia 1.
- Web com 1.277 testes; os testes do painel lateral foram migrados um a um.

## Como ficou na implementação (fatia 4)

**Biblioteca confirmada antes do código:** Tiptap 3.35 com a extensão oficial de markdown, o utilitário de sugestões e as listas de tarefas. Licença MIT em tudo o que vai para produção; React 19 suportado; menus de "/" e "@" nossos; leitura e edição pelo mesmo componente.

**Ida e volta, medida nas 29 descrições reais do `TREEPM`:** 26 voltam idênticas; 3 ganhariam uma linha em branco entre "Critérios de aceite:" e a lista que vem logo depois. Por isso:

- **abrir um ticket nunca regrava a descrição.** O texto só é gravado quando a pessoa edita de fato (a comparação é com o que o editor escreveria do próprio texto lido);
- **uma edição normaliza o texto:** entra a linha em branco antes de lista e `_itálico_` vira `*itálico*`.

**Desvios da configuração padrão da biblioteca, todos cobertos por teste:**

- o serializador escapava o texto (`x_y` virava `x\_y`, `&` virava `&amp;`), o que estragaria endereços e chaves. O escape foi desligado trocando um método não público do gerenciador de markdown; uma atualização do Tiptap pode quebrar isso, e os testes de ida e volta são a trava;
- a opção de quebra de linha da biblioteca gravava dois espaços no fim da linha. Ficou desligada: a quebra simples permanece no texto e é mostrada como quebra pelo estilo;
- HTML, tabela, imagem, riscado e endereço solto ficam como texto (um endereço solto não vira link, para a gravação não reescrevê-lo);
- o nó vazio que a biblioteca acrescenta no fim foi desligado, porque reescrevia o documento ao abrir.

**Links:** endereços `javascript:`, `data:` e `vbscript:` nunca viram link. Os outros abrem em outra aba, sem repassar a origem.

**Menção:** uma etiqueta única, que não quebra no meio; o título é encurtado em 36 caracteres e fica completo no nome acessível. Chave dentro de código não vira menção.

**Suíte de navegador:** `pnpm --filter @treepm/web test:browser` (modo navegador do Vitest, Chrome já instalado na máquina, sem janela; a variável `TREEPM_CHROME` troca o caminho). Nenhum navegador foi baixado. Entra nas verificações obrigatórias de mudanças na web.

**Custo:** o pacote da área autenticada passou de 599 kB (157 kB comprimido) para 1.116 kB (323 kB comprimido). Carregar o editor só quando um ticket é aberto ficou como `TREEPM-72`.

**Ordem dos testes:** as funções puras nasceram do teste; o componente e os testes de navegador foram escritos depois do componente. Três deles falharam de verdade na primeira rodada e viraram correção.

**Não há aviso próprio do limite de 20.000 caracteres** na página: vale o erro da API, como antes.

Web com 1.333 testes em `jsdom` e 46 em navegador.

## Fora deste recorte

- A barra em outras telas.
- Busca no servidor (texto completo, tickets de projetos não carregados).
- Menção a ticket de outro projeto e lista de menções recebidas.
- Imagem, tabela e anexo na descrição.
- Edição simultânea por duas pessoas: vale o último que salvou, como hoje.
- Comentários e histórico do ticket, que são da Fase 2 completa.

## Consequências

- Chaves de ticket passam a aparecer com mais frequência dentro das descrições, e a descrição do rascunho vai aos provedores de IA na procura do caminho. Isso já acontecia quando alguém digitava uma chave; a menção torna comum. A chave não identifica pessoa.
- Os sinais de markdown passam a existir no texto que a procura do caminho lê. A procura foi medida com texto puro; a diferença é pequena, mas não foi medida.
- A web ganha a primeira dependência de edição de texto e a primeira suíte de teste em navegador.
- A conversa de novo ticket deixa de disputar o lado direito da tela com a página do ticket.
- Os testes do painel lateral são migrados um a um para a barra, e não apagados.

## Como ficou na implementação (fatia 5, "Pedir ao assistente para escrever")

- **Rota:** `POST /api/tickets/:id/description/draft`, com o pedido (até 2.000 caracteres) e o texto atual do editor, que pode não estar salvo. Devolve o trecho em markdown (até 6.000 caracteres). Só para quem pode alterar o ticket. Não grava nada e não cria evento.
- **O que vai à Anthropic:** o título do ticket, o texto do editor, os títulos dos tickets acima dele e o pedido, em uma mensagem só. Um teste confere a mensagem exata e que o log leva só modelo, tempo e tamanho.
- **Modelo:** o mesmo dos outros adaptadores (Claude Opus 5.5), esforço baixo, prazo de 30 segundos. Texto vazio ou acima do limite é tratado como falha, nunca cortado.
- **Idioma:** o do pedido *(escolha da coordenação; a decisão geral segue no `TREEPM-56`)*.
- **Onde aparece:** só na página do ticket, com o assistente ligado e a pessoa podendo editar. A criação manual não tem o item.
- **Na tela:** o campo do pedido flutua junto do cursor, como os menus "/" e "@". A proposta é desenhada pelo mesmo componente que mostra a descrição, só para leitura, com "Inserir" e "Descartar". `Esc` durante a espera cancela o pedido e mantém o texto digitado.
- **Não salva sozinho:** o foco no campo e nos botões conta como dentro da edição, e `Esc` neles não desfaz a edição nem fecha a página.
- API com 1.217 testes; web com 1.336 e 81 na suíte de navegador.
- Nenhuma chamada a provedor real foi feita; a conferência visual foi por cinco capturas sem janela, com dados falsos.

## Editor carregado sob demanda (TREEPM-72, PR #120)

Quando a descrição em blocos entrou, o pedaço da área autenticada foi de 157 para 323 kB comprimidos, porque o editor ia junto. Em 2026-11-22 o editor passou a ser baixado só quando algo precisa mostrar ou editar uma descrição: o pedaço que o mapa baixa ficou em 168 kB, e o editor é um pedaço à parte de 165 kB, pré-carregado quando o mapa fica ocioso. Enquanto ele não chega, a descrição aparece em texto simples e ainda não é clicável. O tempo até o primeiro ticket abrir não foi medido em navegador de verdade.
