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
