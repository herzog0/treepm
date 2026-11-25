# 0060 — Importar do Linear: chave por pessoa, vínculo permanente do projeto, origem por ticket e categorização opcional

- **Data:** 2026-11-24
- **Situação:** pedido de Teodoro em 2026-11-24, com altíssima prioridade (`TREEPM-142`, `143`, `144`, `145`, filhos de `TREEPM-139`). Decididos por ele: chave guardada cifrada por pessoa; ao colar a chave, a aplicação consulta o que ela enxerga para a pessoa escolher; a ligação é permanente, com aviso e confirmação dupla. O resto é desenho da coordenação por delegação. **Leitura da coordenação ainda sem resposta dele:** o que é permanente é a ligação do projeto com o time do Linear, e não a chave da pessoa (seção 2).

## Contexto

Hoje só existe a importação por lista de texto ([ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md)). Quem já trabalha no Linear precisa trazer o que tem sem copiar à mão, voltar a importar sem duplicar e, se quiser, deixar a procura do lugar ([ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md), [ADR 0054](0054-lugar-do-ticket-pergunta-na-duvida.md)) arrumar os itens na árvore.

Palavras de Teodoro: "eu preciso plugar a api key em algum lugar das configs […] em prod não vai ter .env e é uma api key por pessoa"; "guarda cifrado por pessoa sim. e acho que ao plugar a chave de api vc deveria consultar os workspaces e times disponíveis pra pessoa selecionar […] plug permanente avisando que não será possível alterar mais depois de configurar, com modal de double check, pra não perder a sincronia."

Fatos do Linear conferidos na documentação e no esquema público em 2026-11-24:

- A chave pessoal vai no cabeçalho `Authorization` sem `Bearer`, enxerga o workspace de quem a criou e pode ser criada só de leitura e restrita a times. Endpoint único: `https://api.linear.app/graphql`.
- Limites por pessoa: 2.500 requisições e 3.000.000 de pontos de complexidade por hora, 10.000 pontos por consulta. Estouro responde HTTP 429 com `RATELIMITED` e `Retry-After`. Uma resposta 200 pode trazer `errors`.
- Paginação por cursor, até 250 por página.
- O `id` (UUID) da issue é estável; o `identifier` (`ENG-123`) muda quando ela troca de time.
- O tipo da situação (`WorkflowState.type`) é um de: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`. O nome é livre e muda de time para time.
- Uma sub-issue pode ter pai em outro time; um projeto do Linear pode abranger vários times; `parent` vem nulo também quando o pai é inacessível.
- Arquivadas só aparecem com `includeArchived: true`.
- **Não confirmado:** se o e-mail dos usuários é legível com a chave de um membro comum. O desenho não depende disso (seção 4).

## Decisão

### 1. A chave do Linear: por pessoa, cifrada, nas Configurações

- Seção nova "Linear" nas Configurações, no grupo de integrações. A pessoa cola a chave; o servidor consulta o Linear na hora (`viewer`, `organization`, `teams`) e só guarda se a chave funcionar. A tela mostra "Conectado ao workspace X", os últimos quatro caracteres e os times que a chave enxerga.
- A tela recomenda criar a chave **só de leitura**: o TreePM nunca escreve no Linear.
- Guarda: tabela `external_credentials` (organização, pessoa, provedor `linear`), com o segredo cifrado por AES-256-GCM, nonce aleatório por gravação e organização, pessoa e provedor como dado autenticado. A linha guarda também a versão da chave de cifra, o id e o nome do workspace e os quatro caracteres finais.
- A chave de cifra é um segredo novo do servidor, `CREDENTIALS_ENCRYPTION_KEY` (32 bytes em base64), próprio, nunca derivado de outro segredo. Sem ele a API sobe e a ligação com o Linear fica desligada (a seção não aparece), como já acontece com a IA e o GitHub.
- A chave do Linear nunca volta ao navegador, nunca aparece em log, resposta, evento ou erro, e nunca vai a provedor de IA. Só o dono a usa: ninguém importa com a chave de outra pessoa.
- A pessoa pode remover ou substituir a chave quando quiser (chave é revogada, a pessoa sai). Isso não desfaz vínculo nenhum.

### 2. O vínculo do projeto com um time do Linear é permanente

- Um projeto do TreePM tem no máximo uma origem no Linear: um workspace e um time. O mesmo time não se liga a dois projetos da mesma organização.
- Quem liga é quem administra o projeto, com a própria chave, escolhendo o time numa lista consultada na hora.
- Antes de gravar, um modal de confirmação dupla diz que a ligação não pode ser trocada nem desfeita depois, e pede que a pessoa digite a chave do time (por exemplo `ENG`) para confirmar.
- A permanência vale no banco: a tabela `project_external_sources` não dá ao papel da aplicação permissão de alterar workspace e time nem de apagar a linha.
- Toda operação num projeto ligado confere que a chave de quem está operando é do mesmo workspace e enxerga aquele time; senão recusa com uma frase que diz qual workspace é esperado. Assim outra pessoa pode reimportar com a própria chave, e trocar de chave não quebra a sincronia.

**Por que o projeto e não a chave.** O que se perde ao trocar de origem é a correspondência entre tickets e issues. A chave é só o meio de leitura; travá-la faria uma revogação matar a integração para sempre.

### 3. A importação é puxada pelo servidor, em passos que o navegador conduz

A rota de lista aceita 500 itens numa transação só, e a máquina de produção para sem tráfego; um trabalho longo em segundo plano morreria no meio. Por isso:

- Uma **rodada** (`external_import_runs`) guarda fase, cursor, contagens, quem iniciou e se a categorização foi pedida.
- `POST …/linear/runs` abre a rodada; `POST …/linear/runs/:id/step` executa um passo curto (uma página de 50 issues, numa transação) e devolve o progresso. A tela chama o passo em laço e mostra o andamento. Se a aba fechar, a rodada continua de onde parou quando alguém voltar. Só uma rodada aberta por projeto.
- Fases: `projects` (os projetos do Linear que têm issue no time), `issues`, `hierarchy` (liga filhos a pais, que podem ter chegado depois), `categorize` (opcional) e `done`.
- Cada passo trava a estrutura do projeto como a importação por lista já faz. Limite do Linear estourado vira "aguardando" com a hora de voltar; o passo seguinte só é tentado depois.
- Antes de começar, a tela mostra quantas issues o time tem e para onde vão. Não há prévia item a item.

### 4. O que vem e como vira ticket (`TREEPM-143`)

| No Linear | No TreePM |
| --- | --- |
| Projeto com issues do time | Ticket pai, com o nome do projeto |
| Issue | Ticket |
| Sub-issue | Filho do ticket da issue-pai |
| Título | Título (cortado em 200 caracteres) |
| Descrição em Markdown | Descrição (cortada em 20.000; texto no formato de menção de pessoa do TreePM é neutralizado) |
| Tipo da situação | `triage`, `backlog`, `unstarted` → a fazer; `started` → em andamento; `completed` → concluído; `canceled`, `duplicate` → cancelado |
| Responsável | A pessoa ativa, não de teste, cujo e-mail casa com o do Linear, só quando a correspondência é única; senão fica sem responsável |
| Prioridade (0 a 4) | Prioridade do TreePM por tabela fixa (sem prioridade → 0; urgente no topo) |
| `identifier` e `url` | Guardados na origem; a página do ticket mostra "Ver no Linear · ENG-123" |

- **Hierarquia.** A issue-pai vence o projeto: sub-issue fica sob o pai. Issue sem pai e com projeto fica sob o ticket do projeto. Issue sem pai e sem projeto fica no destino escolhido na importação (a raiz do projeto ou um ticket). Pai em outro time ou inacessível conta como sem pai.
- **Fora desta rodada:** comentários, anexos, labels, ciclos, estimativas, relações entre issues, histórico. Arquivadas não entram. O e-mail dos usuários do Linear é usado só para casar o responsável e não é guardado.
- A regra que já existe continua valendo: ticket concluído com filho aberto nasce "a fazer".

### 5. Origem por ticket e reimportação sem duplicar (`TREEPM-144`)

- Tabela `ticket_external_refs`: por ticket, o provedor, o tipo (issue ou projeto), o **id estável** do Linear, o `identifier` e a `url` atuais, e um **retrato** da última importação com dois lados de cada campo: o valor que veio do Linear e o valor que foi aplicado no TreePM. Único por **organização**, provedor e id externo: a origem acompanha o ticket para onde ele for (inclusive outro projeto), e a reimportação o encontra lá em vez de criar outro.
- Reimportar é abrir outra rodada no mesmo projeto. Ela percorre o time inteiro de novo (não há filtro por data: o volume cabe com folga no limite, e o Linear avisa que nem toda mudança avança a data de atualização).
- Por campo:
  - **mudou no Linear** quando o valor que chega difere do valor do Linear no retrato;
  - **foi mexido no TreePM** quando o valor atual difere do valor aplicado no retrato.
  - Só se atualiza o campo que mudou no Linear e não foi mexido no TreePM. Comparar com o retrato, e não com o Linear, evita o vaivém de casos em que o TreePM aplica um valor diferente do que veio (o concluído com filho aberto).
- **Lugar na árvore:** a reimportação nunca move um ticket que foi movido no TreePM. Issue nova entra pela regra de hierarquia da seção 4.
- **Sumiu do Linear** (arquivada, apagada ou movida para outro time): o ticket fica como está e a origem ganha a marca de "não encontrada desde". Nada é apagado nem cancelado sozinho.
- O resumo da rodada diz quantos foram criados, atualizados, deixados como estavam porque foram mexidos aqui, e não encontrados.

### 6. Categorização automática, opcional (`TREEPM-145`)

- Uma opção na tela de importação, desligada por padrão, só oferecida quando a IA está configurada e o aceite da organização vale. Antes de rodar, mostra quantos itens serão procurados. O custo estimado é a `TREEPM-146`, fora desta rodada.
- Só as **raízes do lote** são procuradas: os tickets de projeto do Linear e as issues soltas. Filhos seguem o pai.
- Cada passo da fase `categorize` roda a procura do lugar para um ticket, no servidor, pelo mesmo portão da IA (`AssistantGate`) e com as mesmas regras da conversa. Decisão segura move o ticket; **na dúvida não move**: ele fica onde entrou, marcado na rodada como "a conferir", com o atalho para decidir pela conversa. O lote não pergunta nada.
- A decisão fica em `placement_decisions`, com a marca de que veio da importação.
- **Dados à IA:** título e descrição dos tickets importados vão à Anthropic, à TypeSafe e à Voyage, a mesma categoria já autorizada para texto de ticket. Nada novo: nem nome, nem e-mail, nem a chave, nem identificadores do Linear.

## Fatias

1. **Conexão e vínculo:** segredo de cifra, tabelas de credencial e de origem do projeto, cliente do Linear com limites, seção "Linear" e o modal de confirmação dupla.
2. **Importação e origem:** rodada em passos, mapeamento, hierarquia, origem por ticket, tela de andamento e o atalho "Ver no Linear".
3. **Reimportação:** retrato com dois lados, regras por campo, "não encontrada", resumo.
4. **Categorização:** fase `categorize`, "a conferir", contagem antes de rodar.

As telas novas (seção "Linear", modal de confirmação, andamento e resumo da importação) passam pelo Claude Design antes da implementação da tela.

## Fora deste recorte

- **Reorganizar com a IA, com prévia** (pergunta de Teodoro em 2026-11-24: numa importação grande, pais que deviam virar filhos, tickets que deviam mudar de árvore). A importação traz a hierarquia do Linear como está, e a categorização só coloca as raízes do lote. Arrumar à mão depois é seguro, porque a reimportação não desfaz. Propor movimentos em lote (tirar issues de dentro do projeto do Linear, sugerir agrupadores), numa prévia que a pessoa aceita ou recusa, é uma fatia própria.

- GitHub e Jira (`TREEPM-140`, `141`), custo estimado com aceite (`TREEPM-146`), sincronização contínua e webhooks (`TREEPM-319`), escrever de volta no Linear, OAuth ("Conectar ao Linear").
- Rotação da chave de cifra: a coluna de versão existe para permitir; o procedimento fica para quando for preciso.

## Consequências

- É a primeira vez que o TreePM guarda no banco uma credencial de terceiro. Perder `CREDENTIALS_ENCRYPTION_KEY` torna as chaves gravadas ilegíveis (as pessoas colam de novo; os vínculos e os tickets não se perdem).
- Um vínculo errado não se desfaz pela tela. Corrigir exige intervenção no banco, de propósito.
- Com a origem por ticket, a sincronização contínua (`TREEPM-319`) passa a ter onde se apoiar.

## Como ficou

### Fatia 1: chave e vínculo (2026-11-24, `TREEPM-428`)

- **Cifra:** `apps/api/src/common/credential-cipher.ts`, AES-256-GCM, nonce novo a cada gravação; o dado autenticado é organização, pessoa, provedor **e versão da chave**. Linha copiada para outra pessoa, ou com a versão trocada, não decifra. Credencial ilegível vira "não conectado" e a pessoa cola de novo.
- **Banco (migration `0037_linear_connection`):** `external_credentials` e `project_external_sources`. O papel da aplicação só lê e insere o vínculo, e o projeto ligado não pode ser apagado (`ON DELETE RESTRICT`): a permanência vale no banco, não só na API.
- **Rotas:** `GET`, `PUT` e `DELETE /api/linear/connection`, `GET /api/linear/teams`, `GET` e `POST /api/projects/:id/linear`. Não existe rota que altere ou remova o vínculo. Ligar exige a permissão de administrar o projeto (administrador da organização ou gerente do projeto) e a chave do time digitada.
- **Chamadas ao Linear:** sempre fora de transação; listagem com teto de 5 páginas e 30 segundos; resposta de até 1 MB; a conferência de um time consulta só aquele time. Ler o projeto não chama o Linear (`keyMatches` compara só o workspace).
- **Quem sai da organização:** a credencial é apagada na desativação da pessoa. Remover a própria chave funciona mesmo com o segredo de cifra ausente do servidor.
- **"Entrar como":** as rotas do Linear recusam; a leitura da conexão responde sem conexão, e a tela mostra uma frase própria.
- **Tela:** seção "Linear" nas Configurações (chave, times com três estados) e diálogo de confirmação dupla. O campo da chave é apagado da tela assim que a resposta chega.

Diferenças em relação ao desenho: "Abrir importação", a data da última importação e a contagem de issues no diálogo ficam para a fatia 2, que é quando esses dados passam a existir.


### Fatia 2: importação em passos e origem por ticket (2026-11-25, `TREEPM-423`)

- **Banco (migration `0038_linear_import`):** `ticket_external_refs` (origem por ticket, única por organização, provedor, tipo e id externo, com os dois retratos) e `external_import_runs` (a rodada: fase, cursor, tamanho de página, contagens, sequência de falhas). Uma rodada aberta por projeto.
- **Rotas:** abrir a rodada, ler a atual, dar um passo e **abandonar** (`POST …/linear/runs`, `GET …/runs/current`, `POST …/runs/:id/step`, `POST …/runs/:id/abandon`). Fases: `projects`, `issues`, `hierarchy`, `mentions`, `done`; `failed` é a rodada abandonada.
- **O passo:** lê a rodada, chama o Linear fora de transação (no máximo 6 chamadas e 25 segundos), mapeia a página fora de transação e grava numa transação curta com a trava de estrutura, só se fase e cursor ainda forem os lidos. Passo repetido, duas abas ou duas instâncias não duplicam.
- **Nenhuma rodada fica presa:** item fora do formato é pulado e contado; página grande ou lenta demais é dividida (50 até 1, e por último sem a descrição); e-mail ilegível desliga só os responsáveis; limite do Linear vira espera; e sempre dá para abandonar e abrir outra, que reconhece pela origem o que já veio.
- **Issues criadas durante a rodada** entram numa repescagem ao fim da fase `issues`.
- **Mapeamento:** como na seção 4. Prioridade do Linear vira 400 (urgente), 300, 200, 100 e 0. A situação do projeto do Linear vale para o ticket pai. Pai concluído que recebe filho aberto é reaberto, também quando alguém o concluiu entre dois passos; filho com situação não entra em ideia.
- **Texto do Linear não vira menção:** a descrição é cortada em 20.000 caracteres e, só para a chave do próprio projeto, o hífen de `CHAVE-123` vira hífen inseparável (U+2011), ou `%2D` dentro de endereço. É um caractere comum: sobrevive à edição pela tela, ao contrário de um escape de Markdown. Uma conferência final garante que o detector de menções não vê a chave. Traduzir a referência para a chave do ticket importado correspondente é a `TREEPM-441`.
- **Menções:** os passos de criação não varrem descrições; os textos antigos que citam números recém-criados são ligados na fase `mentions`, em lotes.
- **Arrumação à mão é respeitada:** a fase `hierarchy` só move um ticket criado naquela rodada ou cujo pai ainda é o que a importação aplicou.
- **Tela:** aba "Do Linear" na importação do projeto, com destino, andamento por fases, retomada automática, espera, erro de chave com o caminho para corrigir, abandonar com confirmação e resumo. "Ver no Linear · ENG-123" na página do ticket, só para endereço `https://linear.app/`.

Diferenças em relação ao desenho: "Vai trazer N issues" só aparece depois de abrir a rodada (o total vem do servidor nesse momento); a atividade da importação é registrada, mas nenhuma tela mostra atividades de projeto; a linha "Mantidos onde você os moveu" do resumo entra com a fatia 3.

Ordem de publicação: a migration `0038` precisa estar aplicada antes do código, porque o detalhe de todo ticket consulta a tabela de origens.
