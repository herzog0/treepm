# ADR 0044 — A conversa de novo ticket preserva o pedido e sabe quebrá-lo em pai e filhos

**Status:** Proposta da coordenação para corrigir um defeito de prioridade alta apontado por Teodoro em 2026-11-22 ("eu sinto que a IA não capturou detalhes importantes do que eu falei"; "crie também uma família de tickets pra lidar justamente com esse problema e corrigi-lo, prioridade alta"). Ele mandou seguir com os padrões da coordenação ("aceita os seus defaults"). **Data:** 2026-11-22.

Altera a conversa de novo ticket da [ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md) e o texto do sistema dela (ADR 0033). Família `TREEPM-209`.

## Contexto

O caso que mostrou o defeito é o `TREEPM-195`. Teodoro descreveu, numa mensagem só, uma funcionalidade com várias partes e terminou com "quebre a tarefa que eu vou pedir o design dela". A conversa criou um ticket só, com a primeira parte; escreveu na descrição que a funcionalidade "foi dividida em quatro tickets" que nunca existiram; perdeu a maior parte dos detalhes; e acrescentou uma frase sobre fase e uma lista de critérios de aceite que ele não disse.

As causas, conferidas no código em 2026-11-22:

1. **O rascunho é um ticket.** A resposta da IA é `{ message, draft: { title, description }, ready }`. Não há como propor mais de um.
2. **O texto do sistema pede reescrita em seções:** "com o contexto, o resultado esperado e, quando houver, os critérios de aceite", e manda escrever a descrição "a partir do que ela disse e do que o título já implica". Um pedido longo é resumido para caber nesse molde.
3. **A regra dos agrupadores "por entrega, fase ou prazo"** manda dizer na descrição a que fase o trabalho pertence. Foi a origem da frase sobre fase.
4. **Nada compara** o que a pessoa escreveu com o que vai ser criado.

Teodoro aprovou a quebra feita à mão pela coordenação (`TREEPM-200` a `208`): "gostei bastante da sua quebra e de como os tickets estão organizados e descritos a partir da minha descrição". Ela é a referência.

## Decisão

### O rascunho pode ser um ticket ou um pai com filhos

- A resposta da IA passa a aceitar, além do rascunho de um ticket, um rascunho com **filhos**: um ticket pai e uma lista de até 20 filhos, cada um com título e descrição. Só um nível: filho não tem filho no rascunho.
- A IA propõe filhos quando a pessoa **pede** a quebra ("quebre", "divida", "separe em tarefas") ou quando o pedido descreve **partes independentes**, que pessoas diferentes fariam em momentos diferentes. Na dúvida, pergunta uma vez. Um pedido simples continua virando um ticket só, como hoje.
- A pessoa pode pedir outra quebra em texto livre, juntar, separar ou tirar filhos, e editar cada um à mão, como já edita o rascunho de hoje.

### O texto da pessoa é preservado

- **O pedido original fica guardado no ticket, como ela escreveu.** A descrição do ticket (do pai, quando há filhos) começa por uma citação com as palavras dela, sem correção nem resumo. O que a IA organiza vem depois da citação.
- **A citação é montada pela API, não pela IA.** A API guarda as mensagens da pessoa naquela conversa e monta a citação a partir delas na hora de criar. A IA não tem como alterar, encurtar ou omitir o texto citado.
- Cada **filho** traz primeiro o que a pessoa disse sobre aquela parte e, separado, sob o título "A definir", as perguntas que o pedido deixa abertas.

### A IA não acrescenta o que a pessoa não disse

- Saem do texto do sistema as seções obrigatórias (contexto, resultado esperado, critérios de aceite) e a instrução de escrever "o que o título já implica".
- O que a IA acha que falta vai para **"A definir"**, como pergunta, nunca como fato. Critério de aceite só aparece se a pessoa o disse.
- A regra dos agrupadores por fase deixa de mandar escrever na descrição a que fase o trabalho pertence. A pergunta sobre a fase pode continuar sendo feita na conversa, porque ajuda a procura; a resposta orienta a procura do lugar e não vira texto do ticket, a menos que a pessoa tenha dito.
- "Pronto para criar" deixa de exigir que a descrição diga "o que conta como pronto".

### Nenhum ticket citado que não existe

- Uma descrição só pode citar outro ticket pela chave de um que já existe no projeto. A API confere antes de gravar e recusa o rascunho que cite uma chave inexistente, devolvendo à conversa o que precisa ser corrigido.
- Num rascunho com filhos, eles se referem uns aos outros pelo título, não por chave: as chaves ainda não existem. Depois de criados, a relação aparece na árvore (pai e filhos).
- A IA é instruída a nunca dizer que criou ou dividiu algo: ela só propõe.

### Criar é uma operação só

- Confirmar um rascunho com filhos cria o pai e todos os filhos **na mesma transação**: ou todos existem, ou nenhum.
- A procura do lugar roda **uma vez**, para o pai, com o texto do pai e os títulos dos filhos. Os filhos nascem dentro dele, na ordem do rascunho.
- Vale tudo o que já vale para um ticket criado: histórico, menções, reabertura do pai de destino, e as regras de ideia (um pai criado dentro de uma ideia faz parte dela, com os filhos).

### Prévia

Antes de criar, a folha da conversa mostra o pai e cada filho, com título e descrição, e a citação do pedido original. A pessoa edita um título ou uma descrição, tira um filho, e confirma. Segue o desenho aprovado da conversa na barra de pedidos (ADR 0036); nada muda quando o rascunho é de um ticket só, além da citação.

### Conferência de que nada se perdeu

Depois que a quebra existir, uma conferência compara o pedido com o rascunho e avisa a pessoa, na prévia, quando um trecho do que ela escreveu não aparece em nenhum ticket. Como o pedido inteiro já fica citado no pai, essa conferência é um aviso de qualidade da quebra, não a garantia de preservação. Fica por último (`TREEPM-218`) e só entra se a medição mostrar que ainda se perde conteúdo nos filhos.

### O que vai à Anthropic

O mesmo de hoje: o texto da conversa e do rascunho, que agora pode ter filhos. Nenhum dado novo.

## Medição

Um conjunto pequeno de pedidos longos, cada um com a quebra esperada e a lista dos detalhes que não podem se perder; o pedido do `TREEPM-195` é o primeiro. Roda com o provedor de verdade, pela coordenação, antes e depois da mudança, e junto com pedidos simples, para conferir que eles não pioram. O critério de aceite da família é repetir o pedido do `TREEPM-195` e chegar a algo equivalente aos `TREEPM-200` a `208` (`TREEPM-219`).

## Fatias

1. **API** (`TREEPM-212`, `213`, `215`, `216`): rascunho com filhos, texto do sistema novo, citação montada pela API, conferência de chaves, criação numa transação, procura uma vez.
2. **Web** (`TREEPM-214`, `217`): prévia do pai e dos filhos com a citação, edição e confirmação. Junto, o `TREEPM-194`: a mensagem aparece na hora, esqueleto de carregamento e resposta revelada aos poucos, porque é o mesmo componente.
3. **Medição** (`TREEPM-211`) antes e depois; a conferência automática (`TREEPM-218`) conforme o resultado.

## Alternativas descartadas

- **Só mudar o texto do sistema.** Tira as seções inventadas, mas a IA continuaria sem ter como propor mais de um ticket, e nada garantiria que o texto da pessoa sobrevive.
- **A IA criar os tickets por ferramenta.** A ADR 0029 decidiu que a IA só propõe e a pessoa confirma; isso não muda.
- **Uma procura de lugar por filho.** Espalharia pela árvore partes que a pessoa pediu juntas, e multiplicaria o custo.
- **A IA escrever a citação.** É exatamente o ponto em que ela falhou: quem cita é a API.

## Em aberto

1. Quebra em mais de um nível (filhos com filhos) num rascunho só.
2. Registrar o rascunho inteiro como ideia pela conversa.
3. Se a conferência automática deve ser uma pergunta ao Jev em vez de mais uma instrução ao Claude.

## Como ficou (PRs #149, #151, #154, #157 e #158, 2026-11-22)

- **Rascunho com filhos:** `ticket_conversations.draft_children` (migration `0021`), até 20 filhos, um nível. A criação devolve `{ conversation, ticket, children }`, numa transação.
- **Pedido citado:** `request-quote.ts` monta "Pedido original:" com as mensagens da pessoa em citação; quem monta é a API, não a IA. `GET /ticket-conversations/:id/preview` devolve título, descrição, citação, filhos, `unknownKeys` e `descriptionTooLong`.
- **Web:** a prévia mostra a citação e a lista de partes (editar, reordenar, tirar) antes de criar, e o botão diz quantas partes nascem. A mensagem enviada aparece na hora, um esqueleto ocupa o lugar da resposta, e a resposta é revelada por palavras em até 1,5 s (de uma vez com movimento reduzido). A API continua respondendo de uma vez; o fluxo de verdade pelo servidor não foi feito.
- **Quebra por padrão:** a primeira regra só propunha filhos quando a pessoa pedia ou quando o pedido tinha "partes independentes, que pessoas diferentes fariam em momentos diferentes". No primeiro uso real (o pedido do botão play, `TREEPM-235`) a IA não quebrou. A regra passou a ser: propor filhos por padrão quando o pedido descreve uma funcionalidade com três ou mais peças distinguíveis, dizendo numa frase que a pessoa pode pedir para juntar; ação única continua um ticket só (`TREEPM-241`).
- **Medição** (`pnpm --filter @treepm/api measure:conversation`, provedor de verdade, 3 rodadas por caso, 2026-11-22): 7 de 7 casos passam em todas as rodadas; nenhum detalhe perdido; nenhuma chave de ticket inventada. Os casos incluem o pedido do chat por ticket (8 a 9 filhos, 24 de 24 detalhes), o do botão play (4 filhos, 8 de 8) e três que não podem ser quebrados (0 filhos). A conferência de frases "criei/dividi" deixou de contar "separei o pedido em partes", que fala do rascunho.
- **Não foi exercitado** por Teodoro com sessão real depois da regra nova (`TREEPM-219`). A conferência automática depois da resposta (`TREEPM-218`) não foi feita.

## Adendo de 2026-11-22: registrar o rascunho como ideia (`TREEPM-242`)

Resolve o item 2 de "Em aberto". No mesmo primeiro uso real, Teodoro escreveu "Ideia de alta prioridade…" e o ticket nasceu como trabalho comum. Decisão da coordenação, pelos padrões que ele aceitou:

- O rascunho ganha `idea` (falso por padrão), guardado com ele. A IA só o liga quando **a pessoa diz** que é uma ideia ("ideia:", "é só uma ideia", "registra como ideia"); nunca por julgar que o pedido é vago. Na mensagem, diz numa frase que vai registrar como ideia.
- A prévia mostra "Registrar como ideia" como uma opção que a pessoa liga ou desliga antes de criar. A palavra final é dela.
- Ao criar, o pai nasce como ideia no estágio "Nova" e os filhos nascem dentro dele, como parte da ideia ([ADR 0042](0042-ideias-na-arvore.md)). Nenhuma regra nova: é a mesma criação de ideia da tela.
- A procura do lugar funciona como hoje e a pessoa confirma o lugar. Se o lugar escolhido já está dentro de uma ideia, a opção some: o que nasce ali já é parte dela.
- Quem não pode registrar ideia no projeto não vê a opção, e a API recusa.
- Nenhuma migration: o rascunho já é guardado como documento.
