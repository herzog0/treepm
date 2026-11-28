# TreePM

A linguagem do TreePM: um projeto é uma árvore de tickets, e a ordem do trabalho vem das dependências entre eles.

## Linguagem

### Relações entre tickets

**Filho**:
Um ticket que é um pedaço de outro ticket, o seu **Pai**. A relação diz "faz parte de" e nunca diz ordem.
_Evite_: subtarefa, sub-issue

**Pai**:
Um ticket que tem **Filhos**. Ele fica pronto quando todos os filhos ficam prontos, e por isso diz "tudo aqui dentro está pronto".
_Evite_: agrupador, épico

**Habilitador**:
Um **Filho** de que os irmãos dependem para começar, como a casca de uma página. Ele é o primeiro pedaço do **Pai** a ficar pronto.
_Evite_: tratar o pai como o trabalho que vem primeiro

**Depende de**:
A relação que diz a ordem do trabalho entre dois tickets. Um ticket pode depender de vários, e cada dependência é **Para começar** ou **Para entregar**.
_Evite_: bloqueia, blocked by (termos do Linear)

**Para começar**:
O tipo de **Depende de** em que o trabalho fica parado até o outro ticket ficar pronto. Só este tipo decide quem está **Livre**.
_Evite_: dependência forte

**Para entregar**:
O tipo de **Depende de** em que o trabalho começa sem o outro ticket, e o ticket só fecha quando o outro fica pronto.
_Evite_: dependência fraca, dependência falsa

### Estado de um ticket

**Bloqueado**:
Um ticket com um impedimento que alguém marcou, com o motivo. É um problema que pede ação, diferente de esperar a vez na fila de um **Depende de**.
_Evite_: usar "bloqueado" para um ticket que só tem dependência aberta

**Livre**:
Um ticket aberto, sem **Filhos**, cujas dependências **Para começar** estão todas concluídas. Pode começar agora.
_Evite_: desbloqueado

**Próximo**:
Um ticket aberto que ainda tem dependência **Para começar** aberta, e todas as abertas são tickets **Livres**. Ele abre em seguida.
_Evite_: quase livre

**Esperando**:
Um ticket aberto que não é **Livre** nem **Próximo**. Está na fila, e isso é normal.
_Evite_: bloqueado, travado

**Impedimento**:
O problema que alguém marca num ticket, com o motivo em texto. Um ticket aberto com impedimento está **Bloqueado**.
_Evite_: bloqueio por dependência

### Agenda

**Fase**:
Uma janela de entrega do projeto, gravada no ticket como etiqueta e data. A fase fica fora da árvore: ela nunca é pai de um ticket.
_Evite_: usar um ticket vazio para representar uma fase
