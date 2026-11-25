# 0059 — Fechar conversa, e thread só quando alguém marcado não está na conversa

- **Data:** 2026-11-24
- **Situação:** pedido de Teodoro em 2026-11-24 (`TREEPM-417`), com o desenho aprovado por ele no mesmo dia; detalhe da coordenação por delegação, reversível.

## Contexto

Com as conversas em níveis ([ADR 0055](0055-barra-lateral-fixa-e-conversas-em-niveis.md)) e as threads de assunto e de criação ([ADR 0056](0056-meu-chat-fala-com-a-aplicacao.md)), a barra lateral só cresce: não há como tirar uma conversa da frente. E toda mensagem que marca alguém abre uma thread, mesmo quando a pessoa marcada já está na conversa, o que parte uma conversa entre as mesmas pessoas em pedaços.

Teodoro: "A gente tem que ter a possibilidade de [...] um xizinho, não que apaga, né, mas que fecha a conversa e ela não aparece mais para a pessoa ali. Todo controle de fluxo de chat que você achar no Slack tem que ter uma coisa dessas." E: "a gente só abre uma nova thread por padrão se algum dos usuários tagueados não fizer parte da conversa original [...] se todas as pessoas mencionadas na mensagem estiverem já no canal, aí a gente só envia a mensagem."

## Decisão

### 1. Fechar uma conversa

- **Fechar é de cada pessoa e não apaga nada.** A conversa some da barra de quem fechou; os outros participantes não percebem, e nada muda no que cada um pode ler.
- **O que fecha:** threads (com pessoas, de assunto e de criação) e a conversa de um ticket. **O Meu chat não fecha.** Fechar uma conversa fecha junto, para aquela pessoa, as threads de dentro dela.
- **Volta sozinha** quando outra pessoa escreve nela, e quando a própria pessoa escreve nela. Uma thread de dentro que recebe mensagem volta sozinha, pendurada na conversa visível mais próxima acima dela.
- **Reabrir à mão:** uma lista "Fechadas" no fim da barra; o cartão da thread na conversa de cima; e, para a conversa de um ticket, abrir o chat pelo ticket.
- Fechar uma thread de criação não descarta o rascunho. Fechar não é apagar: apagar conversa continua não existindo (`TREEPM-416`).
- Na tela, um × na linha, ao passar o mouse ou focar, e um aviso com "Desfazer".

### 2. Marcar pessoas: thread só quando alguém é de fora

- **Todas as pessoas marcadas já participam da conversa:** a mensagem é uma mensagem comum daquela conversa, com as pessoas destacadas no texto. Nenhuma thread nasce.
- **Pelo menos uma pessoa marcada não participa:** a mensagem abre uma thread, como hoje, com quem já estava e quem foi marcado.
- Nas conversas que são só de uma pessoa (Meu chat, conversa de ticket, thread de assunto), qualquer pessoa marcada é de fora, e nada muda.
- Marcar a si mesmo não conta.
- A regra de que o servidor recebe as pessoas marcadas à parte e recusa texto que não bate com essa lista ([ADR 0058](0058-mencoes-iguais-na-plataforma-inteira.md)) continua. Como mensagem que marca quem já está não abre thread, ela passa a existir dentro de conversas com pessoas, onde o assistente não fala; nenhuma delas vai ao provedor de IA.

### 3. O campo mostra a thread que vai nascer

Quando a mensagem vai abrir uma thread, o próprio campo de escrita ganha o contorno e o cabeçalho do cartão de thread ("Nova thread · com Carla", com os avatares de quem vai participar), a pessoa de fora aparece no texto na cor da thread, e o botão muda de cor e de nome. Sai a linha de aviso em texto e a faixa de pastilhas. Depois de enviar, a mensagem aparece na conversa como o cartão, com o mesmo contorno.

## Fora deste recorte

- Apagar conversa ou thread (`TREEPM-416`).
- Avisar a pessoa marcada (`TREEPM-410`).
- Sair de uma thread (deixar de participar): fechar só tira da barra.

## Consequências

- A barra lateral passa a ter estado por pessoa além do que cada um pode ler: a árvore que o servidor monta precisa distinguir "não lê" de "fechou".
- Marcar alguém que já está na conversa deixa de ter efeito além do destaque, enquanto não houver avisos.
- Quem fechou uma conversa e recebe resposta nela a vê reaparecer; não existe "silenciar".

## Como ficou

Implementado em 2026-11-24 (`TREEPM-417`; achados da revisão em `TREEPM-418`).

- **Banco:** migration `0036_conversation_closed` acrescenta `conversation_participants.closed_seq` (a posição da última mensagem quando a pessoa fechou; nulo é aberta). "Voltou sozinha" se decide na leitura: existe mensagem de outra pessoa ou do assistente depois da marca. Nenhuma linha é atualizada quando chega mensagem.
- **API:** `POST /api/conversations/:id/close` fecha a conversa e as de dentro que a pessoa lê, e devolve em `closedIds` só o que este pedido fechou (é o que o "Desfazer" reabre; o que já estava fechado antes continua fechado). `POST …/reopen` e `GET /api/conversations/closed` completam. Quem escreve na conversa a reabre, inclusive nas rotas do rascunho de ticket; pedir um ticket novo com um rascunho fechado em aberto traz esse rascunho de volta à barra, em vez de travar em silêncio.
- **Menções:** todas as pessoas marcadas já participam, a mensagem é comum; alguma é de fora, nasce a thread. No último nível o `@` abre e só quem já participa pode ser marcado. Onde o assistente fala, mensagem que só marca a própria pessoa é recusada (`assistant_mention_self`), e o nome em formato de menção é retirado do que vai ao provedor.
- **Tela:** × na linha (no ponteiro ou no foco, no lugar da hora e do contador; sempre à vista em tela de toque), aviso com "Desfazer" por 8 segundos preso ao pé da lista, que acumula fechamentos seguidos e para de contar com o foco ou o ponteiro em cima; seção "Fechadas (N)" com a chave do ticket e o começo da conversa; faixa "Você fechou esta conversa" com "Reabrir". O campo ganha o contorno e o cabeçalho "Nova thread · com …" só quando alguém de fora foi marcado, e o botão vira "Abrir thread".
- **Acessibilidade:** fechar pelo teclado leva o foco ao "Desfazer" e, depois, à linha vizinha; os avisos usam regiões que já existem vazias, para o leitor de tela anunciar; × e "Reabrir" levam o nome da conversa.

Diferenças em relação ao desenho: as pastilhas de pessoa acima do campo saíram (o cabeçalho da thread que nasce faz esse papel); a lista "Fechadas" não mostra a conversa-mãe de uma thread, só o ticket, porque a lista plana do servidor não traz esse dado.

Fica em aberto: o caminho em que dois pedidos simultâneos de ticket novo esbarram no mesmo rascunho fechado (`409 creation_open`) reabre o rascunho, mas não tem teste.
