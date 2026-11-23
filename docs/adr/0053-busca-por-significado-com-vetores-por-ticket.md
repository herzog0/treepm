# ADR 0053 — Busca por significado: um vetor por ticket no próprio banco, gerado pela Voyage AI

- **Data:** 2026-11-23
- **Estado:** aprovada por Teodoro em 2026-11-23 no que é dele ("autorizo sim, vamos começar, o que precisar que vc não conseguir acesso pede pro grok": a Voyage AI como terceiro provedor, recebendo título e descrição de tickets). O desenho abaixo é da coordenação, por delegação, e é reversível. Implementação em `TREEPM-127`.

## Contexto

A [ADR 0052](0052-a-conversa-enxerga-a-arvore.md) fez a conversa de novo ticket procurar tickets relacionados antes de decidir o lugar e antes de propor tarefas implicadas. A primeira triagem é por palavras (radical de cinco letras, até 30 candidatos); só o que passa por ela chega ao Jev e ao Claude.

Na medição com os provedores de verdade, o pedido "sincronizar os tickets com Jira, GitHub e Linear recebendo só o diff" precisava achar o ticket "Reimportar sem duplicar: guardar a origem de cada ticket" (`TREEPM-144`). Os dois textos quase não têm palavra em comum. A ligação certa apareceu em 4 de 6 repetições, e só depois de uma segunda chamada ao Claude; quando a triagem não entrega o ticket, nada depois dela consegue achá-lo. É falha de significado, não de estrutura: por isso a resposta não é um banco de grafo (as arestas que temos, pai e filho e "depende de", já estão no PostgreSQL) e sim uma busca que compare o sentido dos textos.

O ticket `TREEPM-127` ("Busca semântica que navega até o contexto") pede a mesma capacidade para a barra de busca. Esta ADR decide a base comum e o primeiro uso (a busca de relacionados da conversa); a barra de busca fica para depois, em cima da mesma base.

### O que foi conferido nas páginas da Voyage em 2026-11-23

- **Modelo e preço:** `voyage-4-lite`, US$ 0,02 por milhão de tokens; dimensões de saída 256, 512, 1024 (padrão) ou 2048; até 1 000 textos e 1 milhão de tokens por requisição; parâmetro `input_type` (`query` ou `document`). Os primeiros 200 milhões de tokens são gratuitos por conta ([preços](https://docs.voyageai.com/docs/pricing), [representações](https://docs.voyageai.com/docs/embeddings)).
- **Treino com o conteúdo: ligado por padrão.** Os termos dizem que, a menos que o cliente saia ("opt out"), ele concede à Voyage licença para usar o conteúdo enviado para treinar e melhorar o serviço ([termos](https://www.voyageai.com/tos), seção 3).
- **Como sair:** no painel, em Organization › Terms of Service, por um administrador da organização e **com meio de pagamento cadastrado**. Depois de sair, o conteúdo enviado é "apagado imediatamente depois de processado" (a página de perguntas chama isso de retenção de zero dias). A saída **não pode ser desfeita pelo painel**, só vale para o que for enviado depois dela, e os termos dizem que os créditos gratuitos **podem ser anulados** ([perguntas](https://docs.voyageai.com/docs/faq)).
- **Não confirmado:** o prazo de retenção para quem não saiu (nenhuma página lida informa); o adendo de tratamento de dados (`voyageai.com/dpa`) não foi lido.

## Decisão

### 1. Pré-condição: nenhuma chamada à Voyage antes da saída do treino

- A conta da Voyage usada pelo TreePM tem meio de pagamento e está com a saída do treino feita ("Opted Out") **antes** de a chave existir em qualquer ambiente. Quem faz é a coordenação operacional (painéis e chaves são dela); o pedido vai pelo canal e a confirmação do estado faz parte da resposta.
- Enquanto a confirmação não chegar, ninguém chama a Voyage com texto de ticket: nem a coordenação, na medição. A implementação anda com o adaptador falso.
- Custo sem contar com os créditos gratuitos: um projeto de 20 000 tickets com 300 tokens cada são 6 milhões de tokens, cerca de US$ 0,12 para indexar tudo uma vez.

### 2. O que vai à Voyage, e o que não vai

- **Vai:** o título e a descrição de tickets do projeto (para o vetor guardado), e o título e a descrição do rascunho da conversa e das tarefas sugeridas (para a consulta). Rascunho e tarefa sugerida são texto de ticket que ainda não foi criado; o texto cru da conversa **não** vai.
- **Não vai:** nomes, e-mails e identificadores de pessoas; ids internos; comentários, histórico, texto das áreas e nota de trabalho; código. Nada do conteúdo entra em log. **Correção de 2026-11-23:** esta ADR dizia que o texto passava por uma limpeza de menções a pessoas; essa limpeza não existe, nem aqui nem no que vai ao Claude e ao Jev. Os campos de pessoas não são enviados, mas o que alguém digitar no título ou na descrição vai como foi escrito (`TREEPM-354`, decisão de Teodoro).
- **Tamanho:** título, linha em branco, descrição, cortado em 8 000 caracteres.
- **Outros dados ou outro provedor pedem nova pergunta a Teodoro.**

### 3. Aceite da organização

- Vale o aceite "Assistente de IA" da [ADR 0039](0039-termos-privacidade-e-aceite-por-organizacao.md): sem ele em vigor, nenhum vetor é gerado nem consultado para a organização.
- O texto que o administrador lê ao aceitar hoje cita a Anthropic e a TypeSafe. Ele passa a citar também a Voyage AI, nos três idiomas, e a versão do aceite muda de `rascunho-1` para `rascunho-2`. Pela regra da ADR 0039, **todo aceite dado ao rascunho anterior deixa de valer**: o administrador de cada organização aceita de novo, lendo o texto que cita a Voyage. Na organização de desenvolvimento, é Teodoro. Ninguém aceita por ele.
- O rascunho da política de privacidade ganha a Voyage na tabela de operadores e no trecho do que cada provedor declara, com as páginas e a data da consulta acima. O texto continua rascunho, sujeito à aprovação dele e à revisão jurídica.

### 4. Onde os vetores ficam

- No próprio PostgreSQL (Neon), com a extensão `vector` (pgvector). Tabela nova `ticket_embeddings`: ticket (chave, apagada em cascata com o ticket), organização, projeto, modelo, dimensões, resumo criptográfico do texto que gerou o vetor, o vetor (`vector(512)`) e a data. Isolamento por organização (RLS) igual ao das outras tabelas.
- **512 dimensões:** metade do espaço e do custo de comparação do padrão, com perda pequena segundo a Voyage. Trocar de modelo ou de dimensão é reindexar: por isso o modelo e as dimensões ficam em cada linha, e uma linha de outro modelo ou dimensão conta como desatualizada.
- **Sem índice aproximado por enquanto.** A consulta filtra pelo projeto e ordena por distância do cosseno, exata. Um projeto de 20 000 tickets são 20 000 comparações de 512 números, o que é pequeno; e um índice aproximado com filtro pode devolver menos resultados que o pedido. Um índice entra por medição, quando algum projeto pedir.
- O banco de teste passa a usar uma imagem do PostgreSQL 17 com pgvector.

### 5. Quando o vetor é gerado: na hora do uso, não na escrita

- Criar, editar, mover ou importar tickets **não chama a Voyage** e não espera por ela. A escrita de tickets não ganha passo novo, nem dentro da transação nem dentro da fila de estrutura da [ADR 0045](0045-escrita-concorrente.md).
- Quem precisa da busca **põe em dia antes de consultar**: lê os tickets vivos do projeto (a busca de relacionados já os carrega), calcula o resumo do texto de cada um e compara com o guardado. O que falta ou mudou vai à Voyage em lote e é gravado. Ideias descartadas e tickets cancelados não entram.
- Limites por requisição: até 256 tickets postos em dia, dentro de um prazo de 4 s. O que não couber fica para a próxima; a busca segue com o que há, e a triagem por palavras cobre o resto.
- Para o primeiro carregamento e para projetos grandes, a ferramenta local ganha `embeddings-reindex` (projeto inteiro, em lotes) e `embeddings-status` (quantos em dia, desatualizados e faltando; só números).
- Continua valendo a regra da ADR 0039: não há tarefa de IA em segundo plano; todo envio nasce de uma requisição que passou pela conferência do aceite.
- Duas requisições ao mesmo tempo podem gerar o mesmo vetor duas vezes; a gravação é por substituição, e o custo repetido é desprezível.

### 6. A porta e a falha

- Décima primeira porta de provedor, `EmbeddingProvider` (`embed(textos, tipo)`), injetada só pelo `AssistantGate`, com adaptador da Voyage e um falso determinístico para os testes. O teste que enumera as portas passa a incluí-la.
- Chave em `VOYAGE_API_KEY`. Sem a chave, o assistente continua configurado e a busca usa só palavras.
- **Falha, prazo ou resposta malformada da Voyage nunca falham a requisição:** a busca cai para só palavras e o diagnóstico registra o motivo, em números e códigos, sem texto.
- Tickets são enviados com `input_type` `document`; a consulta, com `query`. A medição da triagem compara com as outras combinações antes de fixar.

### 7. Primeiro uso: a busca de relacionados da conversa

- Os candidatos passam a ser a **fusão** de duas listas: a triagem por palavras de hoje e os vizinhos mais próximos por vetor. A fusão é por posição (soma de 1 / (60 + posição) em cada lista), e continua entregando até 30 candidatos ao julgamento do Jev, que não muda.
- A mesma fusão vale para a procura de cada tarefa sugerida na árvore (10 candidatos por sugerida), que hoje é só por palavras.
- As regras do lugar, do duplicado e da elaboração da ADR 0052 não mudam: muda só quem chega até elas.
- A decisão guardada da procura ganha números do novo passo (quantos candidatos vieram de cada lista, quantos só do vetor, tempos, motivo da queda para palavras). Nenhum texto.

### 8. Como medir, escrito antes de medir

Os vetores são determinísticos; então a triagem é medida à parte do resto, que oscila.

- **Triagem (sem Jev nem Claude):** comando novo na ferramenta local. Conjunto fixo de pares tirados da árvore do `TREEPM`: cada ligação "depende de" confirmada (o ticket de origem é a consulta e sai do índice; o alvo é o esperado), o par do caso de Teodoro (pedido de sincronização → `TREEPM-144`) e os pares esperados dos casos de `measure:conversation`. Medidas: quantos esperados aparecem entre os 30 (e entre os 10) só com palavras, só com vetor e com a fusão, e a posição de cada um.
- **Critério para ficar:** com a fusão, nenhum par achado só com palavras se perde entre os 30; o total achado é maior que só com palavras; o par do caso de Teodoro entra entre os 10.
- **Fim a fim, com repetição:** o caso de Teodoro em 6 repetições (base: lugar certo em 6, ligação com `TREEPM-144` em 4) e `measure:conversation` em 2 rodadas (base: 11 de 13 passam em tudo, nenhum perdido, nenhum inventado, "nada implicado" vazio). Critério: não pior em nenhum dos números; a ligação com `TREEPM-144` é relatada, mas uma rodada de 6 não prova melhora (ver `TREEPM-338`).
- Se o critério da triagem não passar, a fusão não entra na conversa; os vetores e a ferramenta ficam, e a causa é investigada antes de outra tentativa.

## Fora deste recorte

- A barra de busca por significado, com trecho de evidência e caminho na árvore (`TREEPM-130`, `TREEPM-131`), e a regra de só buscar no que a pessoa enxerga (`TREEPM-132`): mesma base, outra fatia.
- Tipos novos de relação ("duplica", "cobre parte de", "relacionado") e guardar o que a pessoa confirma ou recusa na prévia: não dependem da Voyage, ficam para depois.
- Vetores de comentários, de áreas ou de código.
- Reordenação por modelo próprio da Voyage (`rerank`): o Jev já julga os candidatos.

## Consequências

- Um terceiro provedor recebe texto de tickets. A promessa de não treinar depende de uma configuração da conta (a saída), não do padrão do provedor; por isso ela é pré-condição e fica registrada no canal.
- Todo aceite de IA existente precisa ser dado de novo quando esta mudança entrar. Até lá, as funções de IA ficam desligadas para a organização.
- O banco de desenvolvimento, o de produção e o de teste passam a depender da extensão `vector`.
- A primeira busca num projeto nunca indexado é mais lenta (um lote à Voyage); as seguintes só pagam pelo que mudou.

## Como ficou (2026-11-23)

Fatia 1 no PR #204 (migration `0030_ticket_embeddings`) e fatia 2 no PR #205 (migration `0031_placement_decisions_triage`). **Nenhuma chamada à Voyage foi feita até aqui:** a conta ainda não saiu do uso para treino, e a medição do item 8 espera por isso.

- **Tabela:** chave `(org_id, ticket_id)`, chave estrangeira `(org_id, project_id, ticket_id)` para o ticket, com cascata; o papel da aplicação só altera modelo, dimensões, resumo, vetor e data.
- **Porta:** expõe o nome do modelo, que é gravado em cada linha. O provedor falso dos testes grava `fake`, que conta como desatualizado para o de verdade; na ferramenta local, um provedor falso se recusa a gravar num projeto que já tenha vetores de outro modelo.
- **Sincronização:** lotes de 128; em `bad_request` ou `timeout` o lote é dividido ao meio, e um texto que falha sozinho é pulado; erros de autorização, limite de taxa, servidor e rede param na hora. O adaptador recusa redirecionamento.
- **Vivo:** todas as ideias ficam fora dos vizinhos, não só as descartadas, como na procura.
- **Prazos:** na procura, o passo de vetor fica com até 5 s e no máximo metade do que sobra da etapa de 20 s; a sincronização fica com o prazo do passo menos 1,5 s, reservado à consulta. Na elaboração, o passo de vetor fica com até um quarto do orçamento da procura das sugeridas (na prática, só a consulta).
- **Limiar de distância:** `SEMANTIC_MAX_DISTANCE`, hoje 1, a ajustar pela medição. Sem candidato por palavras nem por vetor, nenhuma chamada ao Jev ou ao Claude, como antes.
- **Corte:** quando a união das duas listas passa do limite, o corte é pela nota da fusão; quando a lista precisa encolher para caber na requisição ao Jev, saem primeiro os achados só por vetor.
- **Diagnóstico:** coluna `triage` na decisão guardada e `diagnostics.semantic` na elaboração, só números e códigos. A API tolera a ausência da coluna, e só trata como coluna ausente o erro `42703` do PostgreSQL.
- **Ferramenta:** `embeddings-status`, `embeddings-reindex` e `triage-measure` (posições e distâncias em pares fixos; opções `--kinds` e `--max-distance`).
- **Banco de teste:** imagem `pgvector/pgvector:pg17` com `--locale=C`, igual à ordenação do Neon de desenvolvimento (`C.UTF-8`).

Em aberto: a medição com a Voyage (`TREEPM-350`, `TREEPM-351`); gerar o vetor também ao criar ou editar, pedido de Teodoro (`TREEPM-355`); tela de importação com etapas (`TREEPM-356`); a frase do aceite sobre texto livre (`TREEPM-354`).

## Adendo de 2026-11-23: medição com a Voyage e fusão desligada por padrão

A conta saiu do uso para treino antes de a chave existir (confirmado pelo canal), o administrador aceitou o texto novo, e o projeto `TREEPM` foi indexado (304 tickets, cerca de 4 s).

- **Triagem, 7 pares** (4 ligações "depende de" e 3 do caso de Teodoro). Entre os 30: palavras 4, vetor 4, fusão 6, nenhum achado por palavras perdido. Entre os 10: palavras 4, fusão 2: a soma de posições rebaixa achados por palavras (4º para 18º, 6º para 13º), porque quem está nas duas listas sempre passa quem está em uma só. O par do caso de Teodoro ficou entre a 19ª e a 27ª posição; o critério pedia entre os 10 e **não passou**. O limiar de distância não separa (esperados de 0,42 a 0,55; 10º vizinho em 0,53).
- **Fim a fim:** caso de Teodoro em 6 repetições, lugar certo em 6 e ligação com `TREEPM-144` em 4; `measure:conversation`, 11 de 13 passam, nenhum perdido, nenhum inventado. Igual à base. Custo: cerca de 0,6 s por busca com os vetores em dia.
- **O critério "entre os 10" foi mal escolhido:** na busca de relacionados os 30 vão ao Jev. Fica o registro de que fixar limiar antes de medir não ajudou.
- **Decisão:** a fusão fica **desligada por padrão** (`SEMANTIC_TRIAGE=off`; `rrf` e `interleave` ligam a soma de posições ou a intercalação; `SEMANTIC_QUERY_KIND` escolhe o tipo da consulta). A tabela, os vetores e a ferramenta continuam, para a barra de busca e para duplicados. O comando de medição ganhou pares por citação entre tickets, para a amostra deixar de ser de 7.
- A [ADR 0054](0054-na-duvida-sobre-o-lugar-a-conversa-pergunta.md) explica por que semelhança não resolve o lugar do ticket.
