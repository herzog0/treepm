# 0068 — O pai é um pedaço maior, a ordem mora no "depende de", e bloqueio é impedimento

- **Data:** 2026-11-27
- **Situação:** pedido de Teodoro em 2026-11-27 (`TREEPM-566`), decidido com ele em conversa, pergunta por pergunta. Ele pediu "obviedade de dependência: uma coisa tem que ser resolvida para habilitar outras" e disse: "eu acho que eu errei em alguma coisa quando eu estava desenvolvendo isso". Esta ADR cobre o modelo (`TREEPM-568`). As telas (mapa, árvore explodida, modo de edição) e a importação têm ADRs próprias, depois desta. Altera as ADRs [0034](0034-um-so-tipo-de-ticket-das-folhas-para-o-topo.md), [0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md), [0047](0047-prioridade-do-ticket-e-proximo-para-trabalhar.md) e [0051](0051-cores-por-situacao-e-propagacao-do-mais-preocupante.md) nos pontos listados em "O que muda nas ADRs anteriores". Os termos estão em [`GLOSSARY.md`](../../GLOSSARY.md).

## Contexto

O projeto SKI (80 tickets importados do Linear, 265 dependências) mostrou três defeitos do modelo.

1. **A árvore guardava ordem.** Na importação, cada ticket ficou dentro de um dos tickets de que ele depende. A árvore ficou com 14 níveis: a auditoria de acessibilidade do app Web estava dentro de 13 caixas, a mais de fora sendo "Monorepo e CI". A regra "termine os filhos antes do pai" (ADR 0034), aplicada a isso, virou o projeto de cabeça para baixo: a fila de trabalho de produção oferecia só seis tickets vazios, e o único ticket que podia começar ficava fora dela.
2. **"Bloqueado" era todo ticket com dependência aberta** (ADR 0051). No SKI isso pintava 78 de 80 tickets de vermelho, e a cor perdia o valor. Para Teodoro, bloqueio é outra coisa: "um impedimento naquela task que está em progresso […] Desbloqueie isso pra que o resto da árvore possa progredir."
3. **Havia dependência que não segura o começo.** A base do app Web lista cinco dependências; só uma (o monorepo) impede o trabalho de começar. As outras quatro só impedem a entrega. Com todas valendo igual, o ticket aparecia sete passos mais tarde do que a verdade.

## Decisão

### 1. Pai e filho dizem só "faz parte de"

- Um **filho** é um pedaço do **pai**. A relação nunca diz ordem.
- O pai fica pronto quando todos os filhos ficam prontos. Ele diz "tudo aqui dentro está pronto".
- O trabalho próprio de um pai (a casca de uma página, por exemplo) vira um filho com nome: o **habilitador**. Os irmãos dependem dele para começar.

### 2. A situação de um ticket com filhos é calculada

Um ticket que tem pelo menos um filho que não é ideia tem a situação calculada a partir desses filhos:

| Filhos (sem contar ideias) | Situação do pai |
| --- | --- |
| todos cancelados | cancelado |
| todos concluídos ou cancelados, com pelo menos um concluído | concluído |
| algum em andamento, em revisão ou concluído, e ainda há filho aberto | em andamento |
| os demais casos | a fazer |

- A situação continua gravada na linha do ticket, e é refeita na mesma transação de toda escrita que pode mudá-la: situação de um filho, criar, remover, mover, aceitar ou descartar ideia, e as importações. A conta sobe pelos ancestrais até a raiz, com as linhas travadas na ordem do filho para a raiz.
- Mudar à mão a situação de um ticket com filhos é recusado: `409 status_is_derived`. Vale para a API, o MCP, a ferramenta da coordenação e as importações (o valor que vem de fora para um pai é ignorado).
- Um ticket que ganha o primeiro filho passa a ter a situação calculada na hora. Um ticket que perde o último filho guarda a última situação e volta a ser marcado à mão.
- A recusa de concluir um pai com filho aberto (`ticket_has_open_children`) e a reabertura de ancestrais deixam de existir como regras separadas: a conta cobre os dois casos.
- Uma migração refaz a situação de todos os pais que já existem.

### 3. "Depende de" tem dois tipos

- **Para começar** (`start`): o trabalho fica parado até o outro ticket ficar pronto.
- **Para entregar** (`deliver`): o trabalho começa sem o outro ticket, e o ticket só fecha quando o outro fica pronto.

Regras:

- O tipo é um campo da relação. Entre dois tickets existe no máximo uma dependência; trocar o tipo é uma atualização.
- Quem cria uma dependência sem dizer o tipo cria "para começar". As dependências que já existem viram "para começar".
- A recusa de ciclo (ADR 0037) olha os dois tipos juntos.
- Concluir um ticket com dependência "para entregar" aberta é recusado: `409 ticket_has_open_delivery_dependencies`, com as chaves que faltam. Cancelar continua livre.
- A importação do Linear continua trazendo `blocks` como "depende de", agora "para começar". Escolher o tipo na importação é assunto da ADR da importação (`TREEPM-575`).

### 4. Lugar na fila: livre, próximo, esperando

Todo ticket aberto, sem filhos e que não é ideia ganha um campo calculado, o **lugar na fila**:

- **livre**: todas as dependências "para começar" estão concluídas ou canceladas.
- **próximo**: tem dependência "para começar" aberta, e todas as abertas são tickets livres.
- **esperando**: os demais.

O campo `blocked` do resumo do ticket deixa de ser calculado pela dependência aberta. O resumo passa a trazer o lugar na fila.

### 5. Bloqueado é um impedimento marcado

- Uma pessoa (ou um agente) marca um impedimento num ticket aberto, com o motivo em texto. O ticket guarda o motivo, quem marcou e quando.
- **Bloqueado** é o ticket aberto com impedimento. Concluir ou cancelar o ticket limpa o impedimento.
- Vale para qualquer ticket, com ou sem filhos.
- O vermelho e a subida até o topo (ADR 0051) continuam iguais; só a origem do "bloqueado" muda.
- Marcar e limpar entram na linha do tempo do ticket.
- O motivo é texto novo escrito pela pessoa. Ele fica fora do que vai para o provedor de IA até Teodoro autorizar essa categoria de dado.

### 6. Fila de trabalho

A fila (ADR 0047) lista os tickets "a fazer", sem filhos, livres e sem impedimento. A ordem continua a mesma: prioridade efetiva, responsável, número. O motivo de fila vazia "todos bloqueados" passa a ser "todos esperando".

## O que muda nas ADRs anteriores

- **0034:** sai "o pai é trabalho de verdade […] atacado depois dos filhos". O pai não tem trabalho próprio: o trabalho dele é um filho. A frase "B é filho de A quando A não pode ser dado por pronto antes de B" continua valendo.
- **0037:** "depende de" ganha o tipo. O resto fica.
- **0047:** entram na fila só tickets sem filhos; "bloqueado" na fila passa a ser o impedimento; dependência aberta vira "esperando".
- **0051:** "bloqueado é derivado" sai. Entra a alternativa que aquela ADR recusou ("bloqueado como situação que a pessoa marca", `TREEPM-95`). O motivo da recusa era o custo de campo, regra e histórico novos; o SKI mostrou que a dependência aberta, embora verdadeira, mede outra coisa.

## Alternativas descartadas

- **Pai primeiro, filhos depois.** Era a dúvida inicial de Teodoro. Se o pai é a casca e fica pronto primeiro, nenhum ticket diz "a página inteira está pronta". Com a casca como filho, os dois fatos têm dono.
- **Um tipo só de dependência, e apagar as que não seguram o começo.** Perde a ligação com a entrega ("por mais que dê para terminar […] a dependência deles importa", Teodoro).
- **Quebrar o ticket em "fazer" e "entregar"** para manter um tipo só. Dobra o número de tickets para dizer o que um campo diz.
- **Situação do pai calculada na leitura, sem gravar.** Toda consulta, filtro e ferramenta que lê a situação teria que refazer a conta.

## Consequências

- No SKI e em todo projeto importado do Linear, o vermelho some até alguém marcar um impedimento. Entre esta ADR e a do mapa (`TREEPM-572`), o mapa mostra esses tickets só com a cor da situação.
- Pai deixa de ter botão de situação. Para cancelar um ramo inteiro, a pessoa cancela os filhos (`TREEPM-578` registra a falta de um atalho).
- A situação de uma issue-mãe do Linear deixa de ser copiada: no TreePM ela sai dos filhos. A sincronização "deixando o Linear vencer" (ADR 0066) não se aplica a esse campo.
- As situações do projeto (ADR 0063, ainda não implementada) continuam por cima das cinco categorias; a conta do pai usa as categorias.

## Em aberto

- Dependência num ticket com filhos: os filhos herdam a espera? Hoje não (`TREEPM-579`).
- Atalho para cancelar um ramo inteiro (`TREEPM-578`).
- Mandar o motivo do impedimento para a IA da plataforma (`TREEPM-580`, espera Teodoro).
