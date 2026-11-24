# ADR 0055 — Barra lateral fixa e conversas em níveis: threads dentro de threads, chat geral e resumo da thread

- **Data:** 2026-11-24
- **Estado:** decisão de Teodoro em 2026-11-23 e 24 ("a barra lateral tem que ser fixa"; "a gente vai ter subthreads de subthreads de subthreads em vários níveis"; "Já pode implementar."). O detalhe abaixo é da coordenação, por delegação, e é reversível onde está marcado. Substitui o modelo de chat da [ADR 0049](0049-chat-de-trabalho-por-ticket.md). Desenho em `https://claude.ai/artifact/7H9MAhFLpWq2Qm1m8MojDs` (privado).

## Contexto

O chat por ticket da ADR 0049 é privado por pessoa; mencionar alguém cria uma thread de um nível só, fora do chat, e o assistente não participa dela. A lista de chats fica num painel que abre e fecha por um botão do cabeçalho. Teodoro pediu duas coisas: uma barra lateral permanente, no estilo do Slack e do Orca, com as conversas sempre à vista; e repensar o que é conversar sobre um ticket.

O objetivo, nas palavras dele: "resolver pendências ali mesmo nas conversas [...] agilizar a resolução de conversas sobre tickets sem que os autores percam a privacidade da conversa deles."

Três fatos do código de hoje que a decisão muda: o nível único das threads é garantido por restrições e gatilhos do banco (a mudança é de esquema, não de tela); o "lido até" é um número só por chat, valendo para todas as threads do ticket; e o assistente do chat **não altera nada** (não tem ferramentas).

## Decisão

### 1. A casca: barra lateral fixa

- A barra da esquerda é permanente. De cima para baixo: a organização; "Novo ticket" e a busca; Mapa, Ideias e Times; as conversas; no rodapé, a pessoa e Configurações. O cabeçalho de cima deixa de existir.
- A conversa aberta ocupa uma coluna entre a barra e o mapa; o mapa continua visível e vai até o ticket da conversa. (Reversível: a alternativa, a conversa tomar o centro, foi desenhada e ficou de fora.)
- Cada linha de conversa mostra a cor da situação do ticket, a chave antes do título, a última atividade e as não lidas.
- É mudança explícita da casca aprovada em 2026-11-19; a linha de base de layout é regerada por este pedido. Os tons novos valem para a barra e a conversa; rever os tons do resto da aplicação fica para depois.
- Termos como *thread* não se traduzem.

### 2. Toda conversa é uma thread, e threads cabem dentro de threads

- **Conversa principal:** de uma pessoa sobre um ticket (uma por pessoa e ticket), ou o **chat geral** da pessoa (um por pessoa, sem ticket, para o que ela quiser). Só ela e o assistente.
- **Marcar alguém numa mensagem abre uma thread dentro da conversa em que a mensagem foi escrita.** Várias pessoas na mesma mensagem, uma thread só. A mensagem que abriu é a primeira da thread.
- Threads abertas na mesma conversa são irmãs; uma thread aberta dentro de outra fica um nível abaixo. Até **dez níveis**.
- Do chat geral dá para abrir thread com qualquer pessoa, e sobre qualquer ticket.
- Na barra, as threads aparecem indentadas sob a conversa de que fazem parte.
- Na conversa, a mensagem que abriu uma thread ganha um contorno na cor da thread, com os avatares de quem participa, o número de respostas e quem pode ver.

### 3. Quem vê o quê: uma regra só

- **Quem participa de uma conversa participa de todas as threads abertas dentro dela.** Os participantes de uma thread são sempre os da conversa de cima mais os marcados.
- **Quem é marcado vê a thread em que entrou e as que forem abertas dentro dela, e nada acima.** Não vê a conversa de cima nem sabe que ela existe: nenhuma lista, contagem, prévia ou trilha revela ancestrais.
- **Quem é adicionado a uma thread já aberta vê o histórico inteiro dela** e entra em todas as threads de dentro.
- Para quem foi marcado, a thread aparece na barra sob o ticket de que trata (ou sob o chat geral da própria pessoa, se não há ticket).
- A regra fica em **um lugar só** do servidor, e toda rota de conversa passa por ela. O banco isola por organização; a privacidade entre pessoas é da aplicação, e por isso é conferida por testes que enumeram as rotas e por árvores geradas ao acaso.
- "Lido até" passa a ser por pessoa e por conversa.
- (Reversível) **Só quem abriu a thread adiciona pessoas a ela**, porque adicionar expõe o histórico inteiro. Qualquer participante pode abrir uma thread dentro.

### 4. Quem age sobre o ticket

- **Só a conversa principal altera o ticket**, e só quem a abriu. Dentro de uma conversa aberta por outra pessoa, os demais participam, mas não alteram nada por ali ("as outras pessoas só são passivas").
- Hoje o assistente não altera ticket nenhum. Ele passa a poder propor a alteração de título e descrição na conversa principal, a pedido da pessoa; **a alteração só é aplicada depois de a pessoa confirmar**, com as permissões dela. (Reversível: a confirmação é escolha da coordenação.)

### 5. O assistente marcado

- O assistente do TreePM pode ser marcado em qualquer thread, como uma pessoa. Ele responde ali.
- **Marcado numa thread, ele lê só aquela conversa** (mais o ticket e os resumos das threads de dentro), nunca as de cima; senão a resposta dele entregaria a conversa de cima a quem foi marcado.
- Numa thread ele nunca altera o ticket.
- Marcar outros provedores (`@Claude`, `@Codex`) é ideia para o futuro, registrada à parte.

### 6. O resumo da thread

- Cada thread tem um resumo, mostrado colado ao cartão dela na conversa de cima. Forma fixa e curta: **o que foi decidido, o que ficou pendente e com quem**.
- O resumo é a entrada de contexto da conversa de cima: o assistente da conversa principal lê os resumos das threads dela, não as mensagens.
- **Quando é gerado:** quando alguém abre a conversa de cima (ou o assistente vai responder nela) e o resumo está vencido, isto é, há mensagem nova na thread há pelo menos 30 segundos. Há também "Atualizar". Não há tarefa em segundo plano ([ADR 0039](0039-termos-privacidade-e-aceite-por-organizacao.md)): todo envio nasce de uma requisição com o aceite conferido. Duas pessoas não geram o mesmo resumo ao mesmo tempo, e o resumo guarda até qual mensagem ele vale; mensagens novas são acrescentadas ao que já existe.
- Como quem está em cima também está embaixo, o resumo só chega a quem já podia ler a thread.
- O resumo é texto de outras pessoas entrando numa conversa que pode alterar o ticket: vai ao assistente cercado como dado, em campos, nunca como instrução.

### 7. Dados que vão ao provedor de IA

Autorizado por Teodoro em 2026-11-24: "o resumo envia ao provedor de IA mensagens escritas por outras pessoas. Tem que mandar."

- Passam a ir à Anthropic as mensagens das threads, inclusive as de outras pessoas, para o resumo e para o assistente marcado.
- **Nomes continuam fora:** as pessoas vão como "Pessoa 1", "Pessoa 2", e os nomes são postos de volta no servidor. O que alguém escrever dentro de uma mensagem vai como foi escrito.
- O texto do aceite passa a dizer isso e muda de versão (`rascunho-3`): os aceites anteriores deixam de valer e as funções de IA ficam desligadas até um administrador aceitar de novo. O texto continua rascunho, sujeito à aprovação de Teodoro.

## Como entra

Três fatias, cada uma com servidor e tela juntos, sem modo de compatibilidade:

1. **A casca fixa**, com a lista de conversas de hoje. Só tela.
2. **Conversas em níveis e chat geral.** Esquema novo (as tabelas da ADR 0049 são migradas: cada chat vira conversa principal, cada thread vira thread de primeiro nível sob a conversa principal de quem a abriu), a regra de visibilidade, a barra em árvore, o cartão da thread.
3. **Resumo, assistente marcado, alteração do ticket com confirmação e o aceite novo.**

## Fora deste recorte

- Outros provedores de IA marcados na conversa.
- Notificação fora da plataforma.
- Remover participante de uma thread; apagar ou editar mensagem de thread.
- Rever os tons do resto da aplicação.
- A conversa tomar o centro da tela.

## Consequências

- O chat deixa de ser um apêndice do ticket e passa a ocupar a casca da aplicação.
- A privacidade entre pessoas depende inteira de uma regra da aplicação; é o ponto que mais pede teste e revisão.
- Mensagens de outras pessoas passam a ir ao provedor de IA, e todo aceite precisa ser dado de novo quando a fatia 3 entrar.
- O assistente ganha, pela primeira vez, o poder de alterar um ticket, sempre com confirmação da pessoa.

## Como ficou: fatias 1 e 2 (2026-11-24)

A fatia 1 (barra lateral fixa) entrou no PR #214. A fatia 2 (conversas em níveis e chat geral) entrou numa mudança só, servidor e tela, com a migration `0033_conversations_in_levels`. A fatia 3 (resumo, assistente marcado, alteração do ticket com confirmação, aceite novo) ainda não começou.

- **Esquema:** `conversations` (tipos `ticket`, `general` e `thread`, com a conversa de cima, a raiz, o nível e a mensagem de abertura), `conversation_participants` (com o ponto de leitura por pessoa e conversa) e `conversation_messages`. A migration leva os dados da 0027 para o esquema novo e apaga as tabelas antigas; não tem volta.
- **Regra de visibilidade:** em `packages/domain/src/conversations.ts`; na API, `ConversationAccess.resolve` é a única porta por identificador, e um teste estático impede que outro arquivo leia as três tabelas. Conversa em que a pessoa não está responde o mesmo "não encontrado" de conversa que não existe.
- **Invariante** (a thread de baixo inclui quem está em cima): conferida pelo banco no fim da transação; toda mudança na árvore trava a conversa raiz.
- **Rotas:** `GET /api/conversations` (a árvore que a pessoa vê), `GET /api/conversations/:id`, `POST …/messages` (com `mentions`, abre thread), `POST …/participants`, `POST …/read`, `DELETE …/messages`, `POST /api/conversations/general`, `POST` e `GET /api/tickets/:ticketId/conversation`. Nenhuma resposta traz o identificador da conversa de cima, da raiz, nem o nível.
- **Tela:** barra em árvore (12 px por nível até o quinto), cartão da thread com contorno de cor estável, trilha só com o que a pessoa lê, chat geral ("Meu chat"). A conversa principal de um ticket e o chat geral só nascem no primeiro envio, não ao clicar.
- **Atualização:** não há aviso do servidor em tempo real; a tela recarrega a árvore e a conversa ao abrir e depois de cada escrita.

### O que mudou em relação ao texto acima

- **Os dez níveis são contados para cada pessoa,** a partir da conversa mais alta que ela lê. Contar a partir da raiz deixava quem foi marcado medir quantas conversas havia acima. Consequência: a árvore de quem vê tudo pode passar de dez níveis; o banco tem um teto técnico de quarenta.
- **Thread sobre um ticket aberta dentro de conversa sem ticket** (a partir do chat geral) é recusada se alguém da conversa de cima não enxerga o projeto, com mensagem que diz isso sem dizer quem. Participante desativado não conta.
- **Só quem abriu a thread inclui pessoas,** e quem entra passa a participar também das threads de dentro (`TREEPM-378` segue aberto para Teodoro).

### Resíduos aceitos

- Quem foi marcado vê entre os participantes da thread quem estava em cima, o que sugere que havia algo antes. Vem da própria regra.
- Um convidado que entra acima do nível 30 pode deduzir quantos níveis há acima dele, pelo teto técnico. Exige o dono e três convidados encadeados, cada um descendo dez níveis.
- Quem perde o acesso a um projeto continua lendo, na conversa de cima, a mensagem que abriu uma thread sobre ele; da thread em si não vê nada.

### Em aberto

- Distinguir, na barra, threads de níveis diferentes com as mesmas pessoas (`TREEPM-392`).
- Recolher ramos da barra e remover participante: fora desta fatia.
