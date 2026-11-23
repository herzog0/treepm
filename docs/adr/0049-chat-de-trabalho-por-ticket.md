# ADR 0049 — Chat de trabalho por ticket: um por pessoa, com threads de menção

- **Data:** 2026-11-23
- **Estado:** decisão da coordenação, por delegação de Teodoro em 2026-11-23; reversível. Implementação em `TREEPM-195` (fatias 1 e 2 desta ADR). A parte de execução de trabalho (harness) fica fora e depende de decisões que continuam com ele.

## Contexto

Pedido de Teodoro em 2026-11-22 (inteiro em `TREEPM-195`): uma interface de chat no painel lateral esquerdo, no estilo do Slack; quem tem um ticket ganha um chat para trabalhar nele; cada pessoa tem o próprio chat com o próprio contexto; mencionar outra pessoa numa mensagem dá a ela um chat daquele ticket só com aquela mensagem, para conversarem numa thread; se a mencionada já trabalha no ticket, a mensagem aparece no fluxo dela, com a origem explícita, e numa aba dedicada. O chat age como harness: ligado ao repositório, cria branch e executa o trabalho com modelos de divisão entre agentes, de mais de um provedor, com consumo em fluxo.

O pedido tem duas metades de natureza diferente. A **conversa** (chat por pessoa, contexto do ticket, menções e threads) cabe no que a plataforma já tem. A **execução** (branch, agentes rodando, provedores, custo) pede três coisas que hoje não existem e que não são decisão de desenho: permissão de escrita no GitHub (o app instalado é só de leitura, por decisão dele), um lugar para os agentes rodarem, e credenciais de outros provedores com o aceite correspondente (ADR 0039).

## Decisão

### Fatia 1: o chat de cada pessoa com o ticket

- **Um chat por pessoa em cada ticket.** É privado: só a própria pessoa lê o que conversou com o assistente. Nem administrador lê o chat de outra pessoa.
- **Quem tem chat:** qualquer pessoa que enxerga o ticket pode abrir o chat dela com ele. "Ter o ticket" (ser uma das pessoas responsáveis) faz o chat aparecer sozinho na lista "Meus chats", sem a pessoa precisar abrir.
- **Onde fica:** um painel lateral esquerdo, "Chats", com a lista dos chats da pessoa (tickets de que é responsável, tickets em que já conversou e tickets em que foi mencionada), com contagem de não lidas, e o chat aberto no estilo de mensagens em sequência com o campo de escrever embaixo. A página do ticket ganha "Abrir chat". Em tela estreita o painel ocupa a tela inteira e fecha de volta para o mapa. O mapa, a página do ticket e a barra de pedidos continuam como são.
- **O assistente:** responde no chat com o contexto do ticket: título, descrição, situação, prioridade, caminho até a raiz, filhos e dependências, mais as mensagens da própria conversa. **Não recebe** comentários, histórico, texto das áreas nem a nota do marcador de trabalho (`TREEPM-93` continua com Teodoro), nem nomes, e-mails ou identificadores de pessoas, nem as threads entre pessoas. Passa pela mesma porta de aceite da organização (ADR 0039) e pelo mesmo provedor da conversa de novo ticket. Nesta fatia o assistente conversa e ajuda a pensar; **não executa nem altera nada**, e diz isso quando pedirem.
- **Guardado no banco**, para a conversa continuar de onde parou em qualquer aparelho. A pessoa pode limpar o próprio chat. Remover o ticket remove os chats dele.

### Fatia 2: menções e threads entre pessoas

- **Mencionar** uma ou mais pessoas numa mensagem do chat cria uma **thread** daquela mensagem. Só se pode mencionar quem enxerga o ticket: mencionar não concede acesso (regra do blueprint).
- **Quem foi mencionado** passa a ver, no chat dela daquele ticket, **só aquela mensagem** e as respostas da thread; nada mais da conversa de quem mencionou. Pode responder; a resposta aparece para todos os participantes da thread.
- **Se a mencionada já trabalha no ticket** (é responsável), a mensagem entra no fluxo normal do chat dela com a origem explícita ("de Ana, numa thread"), e também na aba **Menções**. Para quem não trabalha no ticket, o chat dela daquele ticket é só a aba de menções.
- **Thread é conversa entre pessoas:** o assistente não participa nem recebe o conteúdo dela. Mencionar alguém numa mensagem não manda essa mensagem ao assistente como pergunta: ou se fala com o assistente, ou se abre uma thread.
- **Não lidas:** a lista de chats e o botão do painel mostram a contagem. Sem e-mail nem notificação fora da plataforma por enquanto.

### O que fica fora, e com quem

- **Execução de trabalho pelo chat** (`TREEPM-202` a `TREEPM-206`): ligar ao repositório e criar branch, agentes rodando, modelos de divisão de trabalho, outros provedores e consumo em fluxo. Dependem de: dar permissão de escrita ao app do GitHub; escolher onde os agentes rodam e quanto podem gastar; e de quem são as credenciais de cada provedor, com o aceite. São decisões de segurança e de custo, que continuam com Teodoro. Até lá, o caminho para um agente trabalhar num ticket é o MCP (ADR 0043).
- **Resposta em fluxo de verdade** do assistente: a web já revela a resposta aos poucos (ADR 0044); o fluxo pelo servidor entra junto com a execução.

### Banco

Tabelas novas para chat, mensagem, participantes de thread e leitura, com isolamento por organização como as demais e a regra de pessoa conferida no serviço. Migration própria.

## Alternativas descartadas

- **Um chat só por ticket, compartilhado.** É um canal, não um espaço de trabalho: o pedido é explícito em que cada pessoa tem o seu contexto. Para conversa aberta do ticket já existem os comentários (ADR 0040).
- **Threads como comentários do ticket.** Deixaria a dúvida de duas pessoas exposta a todos e misturada ao histórico.
- **Esperar a execução para lançar o chat.** A conversa por ticket e as threads têm valor sozinhas e são a base sobre a qual a execução vai aparecer.

## Em aberto

1. A execução (acima).
2. Se comentários e áreas entram no contexto do assistente (`TREEPM-93`).
3. Notificação fora da plataforma para menções.
4. Trazer para o chat o resultado do trabalho de um agente que usa o MCP (o comentário de progresso aparecer na conversa de quem pediu).

## Como ficou o banco e a API (2026-11-23)

- **Banco (migration `0027`):** `ticket_chats` (um por pessoa e ticket, com o ponto de leitura e a vez do assistente reservada), `ticket_chat_messages` (mora num chat **ou** numa thread, nunca nos dois; a raiz da thread aponta para si) e `ticket_chat_thread_members`. Isolamento por organização como nas demais tabelas. O banco recusa apagar mensagem de thread, recusa participante em mensagem que não é raiz e garante que a mensagem de pessoa num chat é da dona dele.
- **Privacidade:** a regra de leitura é uma função do domínio (`canReadChatMessage`), que nem recebe o papel da pessoa, aplicada como filtro final em toda leitura, além de a consulta já ser restrita ao chat de quem pede. Testada rota a rota, com cada papel.
- **O que vai ao provedor:** chave, título, descrição, situação e prioridade que vale do ticket; caminho, filhos e dependências (chave, título, situação; até 50 de cada); e as últimas 20 mensagens (até 24 000 caracteres) da própria conversa. Nenhum identificador. Passa pela porta de aceite da organização antes de qualquer leitura.
- **Menção** é uma lista de pessoas escolhidas (`mentions`), não um nome procurado no texto: sem ambiguidade e sem nome em mensagem de erro. Mensagem com menção não passa pelo aceite nem exige provedor: é conversa entre pessoas.
- **Limites:** mensagem de até 4 000 caracteres; 10 menções por mensagem; 25 participantes por thread; 10 mensagens ao assistente e 30 de thread por pessoa por minuto; uma resposta do assistente por vez em cada chat (a segunda requisição recebe conflito sem gastar chamada de IA).
- **Posições opacas:** a API devolve cursores cifrados, não o número global da mensagem, para ninguém inferir a atividade dos outros.
- **Sem aceite, sem provedor ou com falha do provedor**, a mensagem da pessoa não é guardada; a tela mantém o texto e oferece tentar de novo.
- **Quem perde o acesso ao ticket** deixa de ler e de escrever, mas continua podendo apagar a própria conversa com o assistente.
- **Revisão independente de privacidade** antes do merge: nenhum achado grave; os menores (número global exposto, threads sem limite, proteções só no serviço, limpar sem acesso) foram corrigidos.
- **Para a tela:** a resposta do assistente é mostrada no subconjunto de formatação da descrição, sem imagem e sem carregar nada remoto, com links só por clique. Uma descrição de ticket maliciosa pode tentar induzir o modelo a montar um endereço que leve trechos da conversa para fora.
- **Não foi exercitado** com provedor de verdade nem com sessão real; a tela é a fatia seguinte.
