# ADR 0034 — Qualquer ticket recebe filhos, e a procura considera também os tickets

**Status:** Proposta, aguardando a confirmação de Teodoro sobre o escopo. Nada foi implementado. **Data:** 2026-11-21.

## Contexto

Em 2026-11-21, depois de criar os tickets `TREEPM-46`, `47` e `48` pelo painel da IA, Teodoro escreveu:

> Tá um pouco esquisito isso de ter que transformar um item em agrupador. Meio contra intuitivo. A IA deveria conseguir encontrar o filho onde quer que seja, agrupador ou não. Remove essa feature e faz folhas serem candidatos a terem filhos tbm. Acho que se o classificador "erra" entre tentativas isso pode entrar como nuances que humanos também cometeriam, mas daí a gente eleva todos os tickets em consideração: escolhe um pai -> vê os filhos -> escolhe um filho que vai ser pai desse ticket -> assim por diante até achar o local certo.

Isso muda dois pontos da [ADR 0031](0031-agrupadores.md): o passo manual "Transformar em agrupador" e a regra de que a procura desce só por agrupadores. A ADR 0031 tinha substituído a regra de candidatos da [ADR 0030](0030-ticket-folha-como-candidato-na-procura-do-caminho.md), em que toda folha era candidata.

## O que a medição de 2026-11-20 diz sobre isso

As duas regras foram medidas em 2026-11-20, uma rodada cada, tirando um ticket por vez de uma cópia da árvore original e pedindo o lugar de volta. Cada ticket foi testado contra a árvore inteira, sem depender dos anteriores.

| | Folhas candidatas (ADR 0030) | Só agrupadores (ADR 0031) |
| --- | ---: | ---: |
| Chegou ao agrupador original | 21 | 23 |
| ...e ficou direto nele | 10 | 23 |
| ...e entrou em um ticket de dentro dele | 11 | 0 |
| Ficou na raiz | 15 | 13 |
| Foi para outro agrupador | 3 | 3 |

- **A decisão entre agrupadores não piora.** Chegar ao agrupador certo deu 21 contra 23, e raiz e agrupador errado ficaram iguais. A regra das folhas só acrescenta uma decisão a mais, dentro do agrupador.
- **O "10 contra 23" não serve de argumento.** O gabarito tem só dois níveis (agrupador e tickets), então todo ticket posto dentro de outro ticket conta como erro por construção. Se entrar em um ticket vizinho é erro ou é uma leitura aceitável é justamente o que Teodoro questiona, e só ele pode julgar.
- **Não há medição atual.** Essas rodadas são anteriores à [ADR 0033](0033-descricao-antes-da-procura-e-texto-fixo-do-agrupador.md), e desde ela a ferramenta de medição não mede acerto (o texto guardado do agrupador foi escrito com o ticket testado dentro).

Os 11 tickets que entraram em um ticket vizinho:

| Ticket testado | Entrou dentro de |
| --- | --- |
| 6 — Buscar `/api/me` uma única vez por sessão | Reduzir as idas ao banco por requisição |
| 7 — Atualizar os papéis da pessoa depois de uma mudança de papel | Buscar `/api/me` uma única vez por sessão |
| 15 — Aplicar a base visual ao cabeçalho, ao painel lateral e à tela de times | Aplicar a base visual aos cards do mapa |
| 16 — Aplicar a base visual aos cards do mapa | Card em nível "detalhe" no mapa |
| 17 — Card em nível "detalhe" no mapa | Aplicar a base visual aos cards do mapa |
| 18 — Decidir se "cancelado" e "a fazer" têm cores diferentes no mapa | Aplicar a base visual aos cards do mapa |
| 20 — ADR 0024: modelo de ticket e importação por lista | Tela de importação de lista com prévia |
| 26 — Tela de importação de lista com prévia | Cliente da API e interpretador da lista na web |
| 27 — Inserir em lote na importação | ADR 0024: modelo de ticket e importação por lista |
| 28 — Importar esta lista no projeto TreePM | ADR 0024: modelo de ticket e importação por lista |
| 35 — Mudança de pai quando a edição muda a categoria | Busca do caminho do topo até a folha |

Dois padrões nessa lista não são a variação entre tentativas que Teodoro aceitou:

- **A direção inverte.** O 16 entrou no 17 e, em outro teste, o 17 entrou no 16. A pergunta de então media "tem a ver com", e não "é parte de". No uso real, quem for criado primeiro vira o pai.
- **Um ticket vira ímã.** "Aplicar a base visual aos cards do mapa" recebeu quatro tickets (15, 17, 18 e, vindo de outro agrupador, o 24).

Oito dos 11 vieram sem a marca de incerto. Mudar o limite não separa esses casos; a pergunta feita sobre um ticket candidato é que precisa mudar.

## Proposta

### Parte A — Sem o passo manual

- **Qualquer ticket recebe filhos.** Criar ou mover um item para dentro de um ticket, pela página, pelo mapa, pela importação ou pela procura da IA, passa a funcionar. Na mesma transação, o ticket que recebe o primeiro filho vira agrupador.
- **A regra do banco não muda.** Só agrupador tem filhos (migration 0006); a promoção acontece antes de o filho entrar.
- **Some o botão "Transformar em agrupador".** Na página do ticket entra "Novo ticket aqui dentro". "Mudar o pai" lista também os tickets. Em "Escolher no mapa", clicar em um ticket escolhe aquele ticket, e não mais o agrupador que o contém.
- **Agrupadores continuam existindo.** "Novo agrupador" continua criando um agrupador vazio, para fases e entregas como "Fechamento da Fase 1".
- **Quando o último filho sai** *(escolha da coordenação)*: o item que foi promovido por receber um filho volta a ser ticket, com a situação que tinha. O agrupador criado como agrupador continua agrupador, vazio. A implementação diz como o banco distingue os dois.
- **O aviso na hora de confirmar.** Quando o destino é um ticket, o cartão do caminho diz: "«chave» passa a ser agrupador e deixa de ter situação própria."

### Parte B — A procura considera os tickets

- **A descida é a que Teodoro descreveu:** em cada nível, os candidatos são os agrupadores e os tickets daquele nível; a procura escolhe um, desce, e repete até parar. Um ticket sem filhos é sempre o fim da descida.
- **Ticket candidato entra com título e o trecho da descrição**, sem chamada ao Claude. Agrupador continua com o texto guardado (ADR 0033).
- **A pergunta sobre um ticket candidato é de continência, e não de assunto:** o ticket novo é uma parte do trabalho que o candidato descreve? "Tratar do mesmo assunto" não basta. O texto exato é definido com chamadas reais ao Jev antes da implementação, e a ADR registra o que foi testado.
- **O que conta como resultado bom, declarado antes de medir:**
  1. chegar ao agrupador original não cai (hoje, 21 a 23 de 39);
  2. nos pares em que a direção inverteu (16 e 17), no máximo um dos dois sentidos passa;
  3. Teodoro julga a lista dos tickets que entraram em outro ticket.
- **A ferramenta de medição precisa de um ajuste antes:** reescrever o texto do agrupador sem o ticket testado.

A Parte A não depende da Parte B e pode entrar antes.

## Consequências

- **O ticket que vira pai deixa de mostrar a própria situação.** É a regra desde a [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md), e foi o que aconteceu com o `TREEPM-46`: a descrição dele é a de um trabalho, com critérios de aceite, e não há mais como marcá-lo como feito. Com a IA sugerindo destinos dentro de tickets, isso passa a acontecer com frequência, inclusive com ticket em andamento ou concluído. O aviso do cartão é a única proteção nesta proposta.
- **Mais candidatos por nível.** Na reconstrução do zero de 2026-11-20, a escolha acertou 4 de 5 julgamentos com até 10 candidatos e 14 de 34 com mais de 10. Um agrupador com muitos tickets fica nessa faixa.
- **A regra de "desce ou fica" passa a valer um nível mais fundo.** O item 3 da ADR 0033 continua em aberto.
- **A ordem de criação passa a pesar.** Entre dois tickets parecidos, o que existir primeiro pode virar pai do outro.

## O que não muda

- A proposta de agrupador novo para tickets soltos (ADR 0031) continua: ela cobre o caso em que dois tickets tratam do mesmo assunto e nenhum contém o outro.
- O bloco `groups` da conversa (ADR 0033) continua levando só títulos de agrupadores.
- O escopo da procura continua sendo definido só por agrupador selecionado.
- "O que entra aqui", as rotas do texto do agrupador e os limites 0,3 e 0,7.

## Em aberto, para Teodoro

1. O escopo da Parte A está certo: some o passo manual, e os agrupadores continuam existindo?
2. O ticket que vira pai perde a situação própria, como hoje, ou passa a manter a situação dele além do progresso dos filhos? A segunda opção é uma mudança de modelo maior e pediria outra ADR.
3. Dos 11 casos da tabela, quais são leituras aceitáveis?
