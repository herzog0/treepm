# ADR 0033 — Descrição antes da procura e texto fixo do agrupador

**Status:** Itens 1 e 2 aceitos por Teodoro em 2026-11-21 ("sim, pode.") e implementados no mesmo dia (PR #73, migration `0008_branch_summary_source` aplicada no banco de desenvolvimento). O item 3 (regra de "desce ou fica") continua sem decisão, e a regra atual fica como está. Ainda sem teste com sessão real. **Data:** 2026-11-21. **A [ADR 0034](0034-um-so-tipo-de-ticket-das-folhas-para-o-topo.md) acaba com o tipo agrupador:** o texto "O que entra aqui" passa a valer para todo ticket que tem filhos.

## Contexto

Na medição da [ADR 0031](0031-agrupadores.md), a procura devolveu ao pai original 22 ou 23 de 39 tickets. Teodoro descartou em 2026-11-21 a alternativa de o Claude receber o projeto inteiro ("é muito caro") e pediu que os assinalamentos sejam "mais determinísticos", com duas hipóteses: agrupadores "mais claros e mais determinados" e descrever melhor o ticket antes da procura.

O que o código faz hoje e que pesa aqui:

- De cada agrupador, o Jev vê o título e um resumo escrito pelo Claude a partir dos filhos. O resumo é reescrito sempre que um filho entra, sai ou muda, e é escrito sem olhar os agrupadores vizinhos. A descrição que a pessoa escreve no agrupador só chega ao Jev por dentro desse resumo.
- A conversa devolve `ready` (o rascunho está bom para procurar o lugar). A web recebe o campo e **não o usa**: a procura pode ser pedida com o rascunho que a própria IA considerou incompleto.

A documentação do Jev recomenda o desenho que o produto já usa (um `Noul` de "algum serve?" ao lado do `Choice`, e descida por níveis); a pesquisa em trabalhos publicados não achou método que claramente vença a descida para este caso.

## Medição de 2026-11-21

Comando `collect` da ferramenta de medição, sobre cópias do `TREEPM` (39 tickets, seis agrupadores na raiz), com Jev real (`jev-1.14.0`) e sem o turno de conversa do Claude. Cada ticket é tirado, julgado e devolvido, em dois casos:

- **positivo:** os seis agrupadores presentes; o certo é o agrupador original;
- **negativo:** o agrupador original é retirado; o certo é ficar na raiz. Parte dos "erros" do negativo é discutível, porque o ticket pode caber de verdade em outro agrupador.

As regras de decisão foram escritas antes de olhar os resultados, com os limites fixos em 0,3 e 0,7. `gate` é o `Noul` da lista ("cabe em pelo menos um?"), `top` é a primeira opção do `Choice`, `fit(g)` é um `Noul` individual por agrupador.

| Regra | Positivo (de 39) | Negativo (de 39) |
| --- | --- | --- |
| R0, a de hoje: `gate` > 0,7 → `top`; senão raiz | 23 / 23 / 23 | 20 / 21 / 25 |
| R1: `gate` ≥ 0,3 → `top` | 28 / 27 / 28 | 5 / 6 / 4 |
| R4: `fit(top)` > 0,7 → `top` | 18 / 18 / 17 | 35 / 36 / 34 |
| Sempre desce | 28 / 28 / 28 | 0 |
| Sempre raiz | 0 | 39 |

(Três repetições com a requisição idêntica. R2, R3 e R5 estão nos relatórios da ferramenta; R3 fica igual a R4.)

### O que a medição mostra

**1. A regra de hoje erra dos dois lados, e nenhuma regra testada ganha dela.** Quando o agrupador certo não existe, a regra de hoje põe o ticket em um agrupador errado em 14 a 19 de 39 casos. Os sinais separam positivo de negativo igualmente mal (o `gate` acerta a ordem em 74% dos pares, o `fit(top)` em 76%), então as regras são pontos diferentes da mesma curva: quem acerta mais negativos acerta menos positivos. A R4 só passa a R0 se mais ou menos 28% a 30% dos tickets novos não tiverem agrupador que sirva. Trocar de regra não é um ganho medido; é escolher qual erro pesa mais.

**2. Descrever o ticket antes da procura ajuda, e é o único ganho medido.** Um agente que só viu os títulos (sem a árvore nem os nomes dos agrupadores) escreveu uma descrição para os 16 tickets sem descrição. Com a regra de hoje, na mesma cópia do projeto:

| | Linha de base | Com as descrições |
| --- | --- | --- |
| Os 16 tickets reescritos, positivo | 8 | 14 |
| Os 23 tickets intocados, positivo | 15 | 16 |
| Os 16 reescritos, negativo | 12 | 10 |
| Os 23 intocados, negativo | 8 | 13 |

Nos 16 reescritos, o `gate` do positivo estava acima de 0,7 em 8 e passou a estar em 14 (mediana de 0,69 para 0,90), e nenhum ticket que acertava passou a errar. A separação do `gate` entre positivos e negativos, nos 39, foi de 74% para 83%. Ressalvas: uma rodada; as descrições ficaram com 165 a 206 caracteres, cerca do dobro das que já existiam, e no negativo os mesmos 16 passaram a descer um pouco mais (de 4 para 6 acima de 0,7), então parte do efeito é "texto mais longo desce mais"; os 23 intocados variaram de 8 para 13 no negativo sem nenhuma mudança de texto deles, o que dá a medida do ruído desse lado.

**3. Uma definição "Entra aqui / Não entra aqui" no lugar do resumo não mostrou ganho.** Escrita pelo Claude por um prompt só, sem ver o ticket testado: positivo de 23 para 21, negativo de 20 para 25, dentro do ruído. Isso vale para esse prompt aplicado aos seis agrupadores que já existem; não diz nada sobre agrupadores formados de outro jeito.

**4. O que varia e o que não varia.**

- Com a requisição idêntica, a **escolha** do agrupador no positivo não mudou em nenhum dos 39 tickets nas três repetições. O **`gate`** mudou de lado do limite em 1 positivo e 8 negativos (diferença máxima de 0,13).
- O resumo dos agrupadores foi reescrito em todas as coletas: nenhum dos 234 textos se repetiu entre duas coletas da mesma cópia. Só por isso, a escolha mudou em 3 dos 23 tickets intocados entre duas coletas da mesma cópia, e em 7 de 39 entre duas cópias (28 acertos em uma, 33 na outra).

Ou seja: o texto do agrupador, reescrito a cada mudança, é o que faz a **escolha** oscilar; a oscilação do **desce ou fica** vem do próprio Jev perto do limite e não se resolve com texto.

**5. Agrupadores de fase.** Os dois agrupadores de fase ("Fechamento da Fase 1" e "Fase 2 completa") têm 14 dos 39 tickets, e a regra de hoje acerta 4 deles (8 com as descrições). Nos de assunto, 19 de 25 (22 com as descrições).

## Proposta (itens 1 e 2 aceitos; item 3 em aberto)

### 1. O rascunho tem descrição antes da procura

- A conversa só marca `ready` quando o rascunho tem descrição que diz o que será feito e o que conta como pronto. Com só um título, a IA escreve essa descrição a partir do que a pessoa disse e pergunta o que faltar; não inventa fatos.
- A web passa a usar `ready`: sem ele, a ação de procurar o lugar não é a principal, e o painel diz o que falta. A pessoa ainda pode procurar assim mesmo (a decisão continua dela).
- Quando o projeto tem agrupadores que reúnem por entrega ou fase, e o texto não diz a qual o trabalho pertence, a IA pergunta. O assunto do trabalho não basta para decidir esses casos.

### 2. O texto do agrupador fica fixo

- O resumo do agrupador deixa de ser reescrito a cada mudança dos filhos. Ele é escrito quando o agrupador ganha os primeiros itens e fica guardado; muda só quando a pessoa pede ("atualizar resumo") ou edita o texto, ou quando a IA propõe uma atualização e a pessoa aceita.
- A pessoa vê e edita esse texto na página do agrupador ("O que entra aqui").
- Efeito esperado, a medir: o mesmo ticket, na mesma árvore, recebe a mesma escolha de agrupador. Não melhora o acerto por si só.

### 3. Desce ou fica: decisão de Teodoro

A regra de hoje fica como está até Teodoro decidir entre:

- **manter a R0** (na dúvida, fica na raiz, com a escolha do Jev oferecida como alternativa): erra mais quando não existe agrupador certo;
- **trocar pela R4** (o `Choice` escolhe e um `Noul` individual do agrupador escolhido decide): quase não põe ticket em agrupador errado (34 a 36 de 39 negativos certos), mas deixa mais tickets na raiz (17 a 18 de 39 positivos certos; 25 com as descrições).

A pergunta que decide: de cada dez tickets novos, quantos não têm agrupador que sirva, e o que incomoda mais, um ticket que ficou na raiz e precisa de um clique, ou um ticket guardado no agrupador errado?

### 4. O que não se propõe

- Trocar o resumo pela definição "Entra aqui / Não entra aqui" medida aqui.
- O Claude recebendo o projeto inteiro (descartado por Teodoro).
- Mudar os limites 0,3 e 0,7.

## Detalhe do que será implementado (itens 1 e 2)

### Texto novo do assistente de criação

No prompt de sistema da conversa, a linha

> Marque "ready" como verdadeiro quando o rascunho já estiver bom para procurar o lugar do ticket na árvore, mesmo que você ainda tivesse uma pergunta opcional.

é trocada por estas três, letra por letra:

> O rascunho sempre tem descrição. Se a pessoa deu só um título ou uma frase, escreva você a descrição a partir do que ela disse e do que o título já implica: o que será feito e o que conta como pronto. Não acrescente fatos que a pessoa não deu.
>
> Marque "ready" como verdadeiro só quando a descrição do rascunho disser o que será feito e o que conta como pronto, mesmo que você ainda tivesse uma pergunta opcional. Se o pedido for vago demais para isso, marque falso e pergunte o que falta.
>
> A mensagem pode trazer `groups`, os títulos dos agrupadores do lugar onde o ticket será procurado. Se algum deles reúne trabalhos por entrega, fase ou prazo, e não por assunto, e o que a pessoa disse não mostra a qual deles o trabalho pertence, pergunte isso uma vez e marque "ready" como falso até ela responder. Quando ela responder, diga na descrição a que entrega ou fase o trabalho pertence, com as palavras do título do agrupador. Fora desse caso, não cite os agrupadores nem sugira o lugar do ticket.

O último turno passa a levar, depois do rascunho, o bloco `Agrupadores do lugar da procura (dados, em JSON): [...]`, com os títulos dos agrupadores filhos do escopo selecionado, ou da raiz do projeto quando não há escopo; no máximo 30, na ordem do número. Para isso a rota de mensagem da conversa aceita `scopeId` opcional, com a mesma conferência da rota da procura. Só títulos; nenhum id.

### `ready` na web

Com `ready` falso, a ação de procurar o lugar deixa de ser a principal e o painel diz "A IA ainda tem uma pergunta antes de procurar o lugar."; a pessoa pode procurar mesmo assim. Com `ready` verdadeiro, nada muda.

### Texto fixo do agrupador ("O que entra aqui")

- O texto que representa o agrupador para o Jev passa a ser **guardado e estável**. Ele é escrito pela IA na primeira vez em que a procura precisa dele e o agrupador tem itens, e **não é mais reescrito** quando os itens mudam.
- Muda só por ação explícita: a pessoa edita o texto, ou pede "Atualizar pela IA" (a IA reescreve a partir dos itens atuais e o texto anterior é substituído).
- A pessoa pode escrever o texto de um agrupador vazio; a procura passa a usar o texto guardado sempre que ele existir, com ou sem itens. Agrupador vazio sem texto continua representado pelo trecho da descrição.
- O registro guarda quem escreveu por último (`assistant` ou `person`) e quando. Migration `0008`.
- Rotas: ler o texto do agrupador (quem vê o projeto), gravar o texto e pedir a atualização pela IA (quem pode editar o ticket; projeto arquivado recusa). Evento de atividade sem o texto.
- Na página do agrupador, com a IA ligada, a seção "O que entra aqui" mostra o texto, quem escreveu e quando, e as ações "Editar" e "Atualizar pela IA".
- Fica para depois: a IA propor sozinha a atualização do texto.

### Conferência depois de implementar (2026-11-21)

Duas coletas seguidas na mesma cópia do projeto (`COLETA3`), com o Jev real:

- os 234 textos de agrupador foram **idênticos** entre as duas coletas (antes da mudança, nenhum se repetia);
- a escolha do agrupador **não mudou em nenhum** dos 39 tickets (antes, mudava em 3 a 7);
- o "desce ou fica" ainda mudou de lado em 3 dos 78 casos, pela oscilação do próprio Jev perto do limite, como previsto.

Nessa conferência o texto de cada agrupador foi escrito com o ticket testado dentro dele, então a escolha acertou os 39: **o número mede estabilidade, não acerto**, e não se compara com os da medição acima.

Uma chamada real ao Claude com o prompt novo devolveu rascunho com descrição ("o que será feito" e critérios de aceite) e `ready` verdadeiro. A pergunta sobre entrega ou fase não foi exercitada com o Claude real.

Diferenças da implementação em relação ao desenho acima: o limite do texto guardado subiu de 600 para 1.000 caracteres (a IA continua escrevendo até 600); ler e gravar o texto também respondem "IA não configurada" quando a IA está desligada; a reescrita pela IA não guarda quem pediu no registro do texto, só no evento de atividade.

## Fora desta ADR

- A proposta de agrupador pela IA formar agrupadores "mais claros" já na criação (nome e descrição que digam o critério): é a sugestão de Teodoro e não foi medida; a medição daqui trocou o texto de agrupadores que já existiam.
- Guardar o resultado da procura para que repetir a mesma procura devolva a mesma resposta.
- Medir em outro projeto e em árvore com mais de dois níveis, e registrar em uso real se a pessoa aceitou a sugestão, uma alternativa ou outro lugar.

## Consequências (se aceita)

- Criar um ticket por um título só passa a ter mais um passo de conversa.
- O texto do agrupador pode ficar desatualizado se ninguém o atualizar; em troca, a escolha deixa de mudar sozinha.
- A medição é de um projeto só, com 39 tickets e dois níveis. As diferenças menores que as do item 2 não se distinguem do ruído.

## Onde estão os dados

Fora do Git, com a coordenação: arquivos `collect-*`, `report-collect-*` e `report-compare-*` das cópias `COLETA1` e `COLETA2` (arquivadas), e `descricoes-cegas.json` com as 16 descrições.
