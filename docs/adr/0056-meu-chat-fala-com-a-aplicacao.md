# 0056 — O Meu chat fala com a aplicação: consulta e criação de tickets por conversa, `@` para pessoa e `#` para ticket

- **Data:** 2026-11-24
- **Situação:** decisão de Teodoro em 2026-11-24 (`TREEPM-397`); detalhe da coordenação por delegação, reversível.

## Contexto

Teodoro testou o chat geral (o "Meu chat" da [ADR 0055](0055-barra-lateral-fixa-e-conversas-em-niveis.md)) e ele não servia para nada: o assistente recebia a frase "esta conversa não é sobre um ticket" e não tinha como consultar nem criar. Ao mesmo tempo o produto tinha três lugares para falar com a IA, cada um com a sua tela: a pergunta sobre o projeto (`AskPanel`, [ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md)), a conversa de novo ticket (`AssistantPanel`, ADRs [0052](0052-a-conversa-enxerga-a-arvore.md) e [0054](0054-na-duvida-sobre-o-lugar-a-conversa-pergunta.md)) e o chat.

O pedido, nas palavras dele: "quero poder fazer toda a criação de ticket e consultas de ticket por esse chat geral"; a mensagem livre na barra de pedidos "deve ir para a barra lateral do meu chat [...] como uma nova thread"; "criação de tickets novos é também uma subthread", filha "tanto do meu chat principal, quanto de um chat de ticket específico"; "arroba é só para mencionar pessoas [...] hashtag é para mencionar tickets"; "tira o botão de mencionar". Ele pediu que a coordenação pensasse "o que faz sentido em cada lugar", para a pessoa não se perder, e aprovou os casos e as recomendações.

## Decisão

### 1. Um lugar para cada coisa

- **Barra de pedidos ("Peça qualquer coisa"):** só porta de entrada. Não é conversa.
- **Meu chat:** a casa. Cada assunto é uma thread dentro dele.
- **Chat de um ticket:** sobre aquele ticket; dali também se cria outro ticket.
- **Thread com pessoas:** conversa entre pessoas. Não cria nem altera ticket.

A pergunta sobre o projeto (`AskPanel` e a rota `assistant/ask`) e a conversa de novo ticket como painel próprio (`AssistantPanel`) deixam de existir como telas: o que faziam passa a acontecer dentro das conversas.

### 2. O assistente consulta tickets

Nas conversas principais (Meu chat e chat de ticket) e nas threads de assunto (item 4), o assistente ganha as ferramentas de leitura que a pergunta sobre o projeto já tinha (procurar, ler, listar, visão geral), sobre a mesma camada de consulta, que confere a visibilidade por projeto.

- **No Meu chat** elas valem para todos os projetos que a pessoa enxerga; o assistente recebe a lista desses projetos. **No chat de um ticket** ele continua recebendo o contexto do ticket, e consulta os demais.
- **O que ele lê:** título, descrição, situação, prioridade, posição na árvore, filhos e ligações. É o que os documentos de privacidade já descrevem; o aceite não muda de versão.
- **O que continua fora:** comentários, histórico, texto das áreas e qualquer dado de pessoa. **O responsável não vai ao provedor** (não existe ainda a troca de nomes por rótulos); a única pergunta sobre pessoas que funciona é "o que está comigo", por um filtro que o servidor aplica sem mandar nome. Responsável por rótulo fica com o resumo da thread, que precisa do mesmo mecanismo.
- **Chaves:** como na ADR 0037, o provedor não vê chave de ticket, chave de projeto nem identificador. Vão rótulos neutros, agora com o projeto no rótulo, e o código troca de volta na resposta.
- O que as ferramentas devolvem é dado, cercado como dado; o assistente não executa instrução que venha de dentro de um ticket.
- A conversa fica guardada (a pergunta sobre o projeto não guardava).

### 3. `@` é pessoa, `#` é ticket

- O seletor abre no ponto do texto ao digitar `@` ou `#`, filtra enquanto se escreve, e se opera pelo teclado. O botão "Mencionar" sai.
- **Pessoa** continua sendo escolhida no seletor e enviada à parte, por identificador: o servidor nunca procura pessoa dentro do texto, e "@Alice" colado é só texto. Na tela ela aparece como pastilha.
- **Ticket** é a chave no texto (`#TREEPM-88`), como a menção de ticket já era nas descrições. O seletor de tickets mostra a cor da situação, a chave, o título e o caminho, só de projetos que a pessoa enxerga.
- **No Meu chat, um `#` leva a mensagem à conversa daquele ticket,** que passa a aparecer na lista. Com pessoas marcadas na mesma mensagem, a conversa do ticket abre e, dentro dela, nasce a thread com essas pessoas.
- **Dois ou mais `#`, ou `#` dentro do chat de um ticket, são referência:** a mensagem fica onde está e o assistente lê os tickets citados. Quem está no ticket A perguntando se ele depende do B não é levado embora.
- Antes de enviar, o campo diz o que vai acontecer.

### 4. Thread de assunto

Uma thread pode nascer sem marcar ninguém: **thread de assunto**, só de quem a abriu, em que o assistente fala. É o que a mensagem livre da barra abre no Meu chat, com um título curto.

- A natureza da thread é gravada quando ela nasce e não muda: `people` (as de hoje), `topic` (assunto) ou `creation` (item 5).
- **Thread de assunto e thread de criação nunca recebem participantes.** É isso que permite o assistente falar nelas sem mudar o aceite: nenhuma mensagem de outra pessoa chega ao provedor por esse caminho. A regra é do banco e do serviço, com teste que prova que ela segura.
- O assistente lê só aquela thread.
- O assistente em thread com outras pessoas e o resumo continuam na fatia seguinte da ADR 0055, com o aceite novo.

### 5. Criação de ticket é uma subthread

- **Como nasce:** o assistente, no Meu chat ou no chat de um ticket, entende que a pessoa quer um ticket novo e abre a thread de criação com um título breve; ou a pessoa pede direto, por "Criar ticket" na barra e por "+ Novo ticket", sem depender de o modelo adivinhar.
- **Onde nasce:** só no Meu chat e no chat de um ticket (e nas threads de assunto deles). Nunca dentro de thread com pessoas: é a mesma regra de "só a conversa principal altera tickets".
- **O que tem dentro:** a conversa de novo ticket que já existe, inteira e sem reescrita: rascunho, procura do lugar, pergunta na dúvida, ligações sugeridas e o botão Criar. As tabelas e as rotas dela continuam; a thread aponta para ela. **O assistente nunca cria sozinho.**
- **Projeto:** a criação é por projeto. Vale o projeto do ticket, no chat de um ticket; no Meu chat, o projeto que a pessoa tem aberto no mapa, mostrado no rascunho e trocável enquanto o ticket não existe.
- **Do chat de um ticket,** o rascunho parte do que se conversou ali, e a procura do lugar começa por aquele ticket.
- **Na barra lateral** a thread de criação tem marca própria (um "+" em contorno tracejado) e mostra em que ponto está: rascunho, esperando a pessoa, criado.
- **Depois de criado,** a conversa da criação é copiada para a conversa principal do ticket novo, que aparece na lista de tickets; onde a thread nasceu fica o cartão "ticket criado", que leva a ele. A thread de criação sai da barra. Rascunho descartado também sai, e o cartão diz "descartado".

### 6. A barra de pedidos, linha por linha

- **Tickets encontrados:** como hoje; Enter abre o primeiro.
- **Sem ticket encontrado, Enter manda o texto ao Meu chat,** numa thread de assunto nova (hoje criava ticket). Shift+Enter faz o mesmo havendo ou não ticket encontrado.
- **"Criar ticket «texto»" (Ctrl+Enter):** abre direto a thread de criação no Meu chat.
- **"Registrar ideia" e "Próximo ticket":** como hoje.
- **Campo vazio:** "Abrir o Meu chat" no lugar de "Nova conversa" e "Continuar conversa".

## Como entra

Três fatias, cada uma inteira e sem modo de compatibilidade:

1. **Consulta e menções:** ferramentas de leitura nas conversas principais, rótulos neutros com projeto, seletor de `@` e `#`, e o caminho do `#` no Meu chat. Sem migration.
2. **Thread de assunto e barra:** natureza da thread (migration `0035`), assistente na thread de assunto, texto livre da barra no Meu chat; saem `AskPanel` e a rota `assistant/ask`.
3. **Criação como subthread:** thread de criação ligada à conversa de novo ticket, a tela dela dentro da conversa, cópia para a conversa do ticket ao criar, "Criar ticket" e "+ Novo ticket" pela thread; sai o `AssistantPanel` como painel.

## Fora deste recorte

- Linha permanente no Meu chat dizendo que a mensagem "continuou em" outro ticket: a tela leva a pessoa à conversa do ticket e avisa na hora.
- Rascunhos de novo ticket que estavam abertos antes da fatia 3: ficam no banco e deixam de aparecer. Não há dados de produção.
- Responsável e outros dados de pessoa para o assistente; assistente em thread com outras pessoas; resumo da thread; alteração do ticket pela conversa ([ADR 0055](0055-barra-lateral-fixa-e-conversas-em-niveis.md), fatia 3, replanejada depois desta).
- `@Claude` e `@Codex` (`TREEPM-377`).

## O que muda em outras decisões

- **ADR 0037:** a pergunta sobre o projeto deixa de ser uma tela e uma rota; as ferramentas e os rótulos passam a servir às conversas, e os rótulos ganham o projeto.
- **ADR 0052 e 0054:** a conversa de novo ticket deixa de ser um painel e passa a ser o conteúdo de uma thread; o que ela decide e guarda não muda.
- **ADR 0055:** threads deixam de exigir pessoas marcadas; o assistente fala em thread que é só de quem a abriu.

## Consequências

- Um lugar só para conversar com a aplicação, e duas telas a menos.
- O assistente do chat passa a fazer várias chamadas por resposta (uma por consulta), com limite de rodadas e de tempo, como a pergunta sobre o projeto já fazia.
- O comportamento do Enter na barra muda para quem tinha o hábito de criar ticket por ele.
- A privacidade entre pessoas ganha uma regra nova a vigiar: thread em que o assistente fala nunca tem outra pessoa.

## Como ficou: fatia 1 (2026-11-24)

Consulta e menções entraram numa mudança só, servidor e tela, sem migration.

- **Servidor:** a vez do assistente nas conversas principais roda o mesmo laço de ferramentas da pergunta sobre o projeto (`tool-loop.ts`: rodadas, execuções e prazo total limitados; a última chamada vai sem ferramenta). Ferramentas em `chat-tools.ts`: procurar, ler, listar e visão geral, mais o filtro "atribuídos a quem pergunta", aplicado pelo servidor. Cada execução confere a visibilidade de quem pergunta; projeto invisível ou arquivado responde igual a projeto que não existe. O resultado de cada ferramenta vai cercado como dado e cortado em 20.000 caracteres.
- **Tela:** seletor no ponto do texto para `@` e `#`, sem o botão "Mencionar"; a linha que diz o que vai acontecer antes de enviar; no Meu chat, um `#` leva a mensagem à conversa do ticket, que é quem envia; chave de ticket visível vira elo nas mensagens. A lista de tickets vem da mesma fonte que o mapa já mantém em memória.
- **Ferramenta local:** `chat-show` para a coordenação ler uma conversa como o usuário da ferramenta.
- O nó de thread da árvore ganhou `label` (o começo da mensagem que a abriu), usado na barra quando threads de níveis diferentes têm as mesmas pessoas (`TREEPM-392`).

### O que mudou em relação ao texto acima

- **As chaves de ticket e de projeto vão ao provedor como estão** (decisão de Teodoro em 2026-11-24, `TREEPM-406`). O item 2 dizia que iriam rótulos neutros, como na ADR 0037. Duas revisões independentes mostraram que a troca não se sustenta em texto livre: a chave de projeto sozinha é só uma palavra, grafias comuns escapam, e a troca deforma o texto para o modelo e às vezes para a pessoa. O que protege os dados é a conferência de visibilidade em cada consulta, e ela ficou. A pergunta sobre o projeto continua com os rótulos dela até sair, na fatia 2.
- **O aceite muda de versão** por causa disso: `rascunho-3`. O assistente fica desligado em cada organização até um administrador aceitar de novo. O documento de privacidade passa a listar as chaves entre o que é enviado.
- **O nome do projeto não vai ao provedor,** só a chave.
- **Pessoa marcada é pastilha,** fora do texto; o ticket fica no texto como `#CHAVE-N`.

## Como ficou: fatia 2 (2026-11-24)

Thread de assunto e barra de pedidos entraram numa mudança só, servidor e tela, com a migration `0035_conversation_purpose`.

- **Banco:** `conversations.purpose` (`people`, `topic` ou `creation` nas threads; nulo nas principais), gravado na inserção e imutável; `title`; e a ligação com a conversa de novo ticket, já pronta para a fatia 3. Thread de assunto e de criação só nascem sob a conversa principal da própria pessoa e só aceitam quem as abriu como participante, por gatilho. O assistente passa a poder escrever em thread de assunto; em thread com pessoas continua proibido.
- **Servidor:** `POST …/messages` com `topic: true` abre a thread e roda a vez do assistente dentro dela, lendo só ela. Na primeira resposta o assistente devolve também um título de até 60 caracteres, que o servidor valida antes de guardar. Incluir pessoa em thread de assunto é recusado.
- **Tela:** na barra de pedidos, Enter sem ticket encontrado e Shift+Enter mandam o texto ao Meu chat; o painel abre na thread nova com o assistente respondendo. A thread de assunto aparece na barra lateral com a marca ✦ e o título.
- **Saiu** a pergunta sobre o projeto: rota, painel, os rótulos `T47` e os testes deles.

### Em aberto

- "Limpar a conversa" não apaga as threads de assunto, e não há como apagar uma (`TREEPM-416`).
- A criação de ticket continua pelo painel antigo até a fatia 3.
