# Medição da escrita concorrente no mesmo projeto (2026-11-23, TREEPM-249)

Pergunta: o que acontece quando muita gente e muitos agentes escrevem ao mesmo tempo no **mesmo projeto**? Este documento traz números, gargalos e um defeito, **sem nenhuma correção**: nenhum código de produto foi alterado. A ferramenta ficou no repositório. A conferência de integridade passou em todas as 37 rodadas (nenhum ciclo, órfão, concluído com filho aberto, progresso ou raiz de ideia divergente; a lista devolvida depois da última escrita igual à do banco).

## Como reproduzir

```
export TEST_DATABASE_MIGRATION_URL=postgresql://treepm_owner:…@127.0.0.1:54329/treepm_p2   # banco só de medição
export TEST_DATABASE_URL=postgresql://treepm_app:…@127.0.0.1:54329/treepm_p2
pnpm --filter @treepm/api measure:concurrent-writes \
  [--sizes 5000] [--levels 1,4,16,64] [--duration 30] [--seed 7] [--readers 2] \
  [--scenarios edits,structure,mixed,import,branch,mcp,mcp-unlimited] [--log-errors] [--setup-db]
```

Saída em `.measure/concurrent-writes/results-<N>.json` (fora do Git; rodar de novo só uma célula a substitui). Cada rodada recarrega o projeto gerado (`big-project/`, mesma semente, 80 pessoas), sobe a aplicação Nest de teste e dispara requisições HTTP de verdade em laço fechado (cada escritor manda a próxima assim que a anterior volta) por `--duration` segundos. A ferramenta recusa rodar sem as duas variáveis e fora de `treepm_p<N>`/`treepm_test` (apaga todas as organizações do banco a cada rodada). `--log-errors` imprime a causa das primeiras falhas 5xx do servidor. Testes da própria ferramenta: `apps/api/test/concurrent-writes-plan.test.ts` (plano determinístico, sem ciclo possível, pesos, folhas disjuntas) e `concurrent-writes-integrity.test.ts` (a conferência pega ciclo plantado, concluído com filho aberto e lista diferente do banco). Código: `apps/api/scripts/measure-concurrent-writes.ts` e `apps/api/scripts/concurrent-writes/{plan,integrity,stats}.ts`.

**Cenários** (escritores com pessoas diferentes, todas administradoras da organização nas sessões HTTP; cada escritor é dono de folhas próprias, exceto em `branch`):

| Cenário | O que faz |
|---|---|
| `edits` | situação (50%), título (20%), prioridade (20%), pessoas (10%), em folhas próprias |
| `structure` | mover folha entre pais (40%), criar com pai (40%), remover o que ele mesmo criou (20%) |
| `mixed` | 70% edições, 20% criações, 10% movimentos, mais 2 leitores do mapa com `If-None-Match` a cada 3 s |
| `import` | `mixed` e, aos 15 s, uma importação de 500 tickets |
| `branch` | todos no mesmo ramo (o de maior subárvore): situação `todo/in_progress/done` nas mesmas folhas (propagação aos mesmos ancestrais), mover e criar nos mesmos pais |
| `mcp` | agentes pelo MCP (`update_ticket_status` 30%, `set_agent_work` 15%, `add_comment` 20%, `create_ticket` 20%, `get_work_queue` 15%), tokens de escrita, chave da organização ligada, **limites valendo**, agente esperando o `Retry-After` do 429 |
| `mcp-unlimited` | o mesmo com os limites zerados a cada 100 ms |

Só folhas se movem e o destino é sempre um pai que nunca se move: nenhuma sequência sorteada fecha ciclo, então um `ticket_cycle` seria defeito, não azar.

## Onde e com que carga

Notebook de desenvolvimento: i5-11400H (6 núcleos, 12 threads), 31 GB, Node 22.23.1, PostgreSQL 17.12 em contêiner na mesma máquina, pool do Prisma/pg no padrão (**10 conexões**). **A máquina estava com carga média de 34 a 40** (problema de driver, sem nada rodando de meu), e servidor e gerador de carga dividem o mesmo processo Node: a vazão é um **piso**, a ordem de grandeza vale, a segunda casa decimal não. Carga no início de cada bateria: 5 000 → 34,0 / 34,6 / 37,1; 20 000 → 36,2 / 35,8 / 36,2 (subiu a ~40 durante a de 20 000). Cada célula registra a própria carga em `results-N.json`. Todos os números abaixo são de **uma rodada de 30 s por célula** (sem repetição), então diferenças menores que ~15% entre células não são sinal.

## Resultados, N = 5 000 (30 s por célula)

Vazão = escritas confirmadas (2xx) por segundo; latências em ms de todas as escritas; `esp.` = espera média por escrita confirmada em trava (`Lock:*` em `pg_stat_activity`, amostrado a cada ~200 ms, aproximação).

| Cenário | Escr. | ok/s | p50 | p95 | p99 | Códigos além de 2xx | esp. (ms) |
|---|---|---|---|---|---|---|---|
| edits | 1 | 70 | 14 | 19 | 26 | — | 0 |
| | 4 | 142 | 28 | 35 | 39 | — | 0 |
| | 16 | 140 | 112 | 141 | 170 | — | 0,7 |
| | 64 | 141 | 450 | 482 | 662 | — | 2 |
| structure | 1 | 41 | 19 | 44 | 52 | — | 0 |
| | 4 | 52 | 77 | 114 | 135 | — | 51 |
| | 16 | 49 | 324 | 413 | 442 | — | 177 |
| | 64 | 45 | 1 385 | 1 706 | 1 812 | — | 193 |
| mixed | 1 | 45 | 15 | 41 | 58 | — | 0 |
| | 4 | 81 | 36 | 104 | 140 | — | 13 |
| | 16 | 86 | 112 | 402 | 479 | — | 71 |
| | 64 | 84 | 699 | 1 016 | 1 187 | — | 77 |
| import | 1 | 46 | 15 | 41 | 56 | — | 0 |
| | 4 | 79 | 36 | 108 | 142 | — | 13 |
| | 16 | 89 | 107 | 395 | 487 | — | 69 |
| | 64 | 83 | 696 | 1 047 | 1 210 | — | 79 |
| branch | 1 | 42 | 16 | 42 | 66 | — | 0 |
| | 4 | 57 | 51 | 137 | 178 | — | 28 |
| | 16 | 69 | 203 | 390 | 446 | — | 104 |
| | 64 | 65 | 886 | 1 260 | 1 442 | — | 112 |
| mcp (limites) | 1 | 0,7 | 33 | 71 | 110 | 429: 2 | 0 |
| | 4 | 2,7 | 48 | 160 | 214 | 429: 7 | 5 |
| | 16 | 3,3 | 248 | 801 | 904 | 429: 14 | 108 |
| | 64 | 0,8 | 16 | 656 | 722 | 429: 57, **503: 81** | 18 |
| mcp-unlimited | 1 | 28 | 22 | 51 | 68 | — | 0 |
| | 4 | 47 | 55 | 170 | 244 | — | 11 |
| | 16 | 46 | 198 | 794 | 931 | — | 118 |
| | 64 | 13 | 16 | 39 | 58 | 429: 20 833, **503: 28 265** | 304 |

(As células `mcp`, `mcp-unlimited` e `structure` com 64 escritores são de uma segunda rodada, feita para registrar o corpo dos erros; a primeira deu o mesmo quadro: `mcp` 64 com 79 respostas 5xx e `mcp-unlimited` 64 com 28 006.)

Leitores do mapa em `mixed`/`import`/`branch` (2 leitores, `If-None-Match` a cada 3 s): quase toda leitura devolve a lista inteira (a versão do projeto muda a todo instante) e **não vira 304**: p50 de 100 ms com 1 escritor, 140 a 230 ms com 4 a 16, **740 a 910 ms com 64** (3,2 MB por resposta). Nenhuma falhou.

A importação de 500 tickets aos 15 s levou **204 ms** (1 escritor), 211 ms (4), 478 ms (16) e 1 000 ms (64). As escritas que estavam em curso durante ela não foram recusadas (nenhum `structure_busy`) e a pior levou 790 ms com 64 escritores.

### N = 20 000 (só `structure`, `mixed`, `branch`; 1, 16 e 64 escritores)

| Cenário | Escr. | ok/s | p50 | p95 | p99 | Códigos além de 2xx | esp. (ms) |
|---|---|---|---|---|---|---|---|
| structure | 1 | 17 | 25 | 127 | 150 | — | 0 |
| | 16 | 18 | 861 | 1 156 | 1 491 | — | 486 |
| | 64 | 19 | 2 490 | 3 261 | 4 409 | **500: 160 (de 780)** | 463 |
| mixed | 1 | 19 | 21 | 140 | 326 | — | 0 |
| | 16 | 32 | 258 | 1 281 | 1 512 | — | 236 |
| | 64 | 35 | 1 660 | 2 656 | 3 167 | 500: 1 | 225 |
| branch | 1 | 18 | 21 | 130 | 292 | — | 0 |
| | 16 | 24 | 595 | 1 278 | 1 538 | — | 324 |
| | 64 | 29 | 2 002 | 2 925 | 3 121 | 500: 7 | 267 |

Leitor (lista de 13 MB): p50 de 450 a 480 ms com 1 escritor, 720 ms com 16, **1,9 a 2,1 s com 64**. Importação a 20 000 não foi repetida.

## Integridade, em todas as rodadas

- **Árvore:** 0 ciclos, 0 órfãos, 0 auto-pai, 0 concluídos com filho aberto.
- **Progresso e raiz de ideia:** o SQL do produto (`readBranchOf`) igual ao domínio em memória (`ticketProgress`, `ideaRootsOf`), ticket a ticket, inclusive a 20 000.
- **Lista × banco:** a lista devolvida depois da última escrita igual, campo a campo (id, título, situação, pai, prioridade, pessoas), à lida do banco; o `ETag` é `W/"v2.<tickets_version>"` do banco em todas as rodadas.
- **`tickets_version` × escritas:** em `edits`, `structure`, `mixed`, `import`, `mcp` e `mcp-unlimited` até 16 escritores, a diferença entre o contador e as escritas confirmadas que mudam o resumo é **exatamente zero** (a importação conta como uma só, e comentário e `get_work_queue` não contam). Isso confirma que a versão avança uma vez por transação confirmada, mesmo com 64 em paralelo. A diferença é positiva só onde escritas confirmadas **não mudam nada**: em `branch` (a mesma folha disputada por vários escritores, que pedem a situação que outro já pôs: 80 de 1 868 com 4, 133 de 2 224 com 16, 144 de 2 148 com 64; 6 e 11 a 20 000) e em `mcp-unlimited` 64 (38 de 289). No `mcp-unlimited` 64 o plano de cada agente supõe que o chamado anterior funcionou, mas muitos foram recusados com 503, então ligar/desligar o marcador sai de sincronia e vira escrita sem efeito. **Não achei nenhuma rodada em que o contador avançasse mais que as escritas confirmadas, nem em que uma escrita que mudou o resumo deixasse de avançá-lo**; a explicação das escritas sem efeito é inferência (não verifiquei escrita a escrita neste cenário, que não rastreia o estado de cada folha).
- **Deadlocks do PostgreSQL** (`pg_stat_database.deadlocks`): 0 em todas as rodadas, e **nenhum** 409 (`structure_busy`, `concurrent_update`, `ticket_cycle`) em todo o experimento, inclusive em `branch`, onde 64 escritores sobem e descem a situação das mesmas folhas e dos mesmos ancestrais.

## Leitura honesta: onde a vazão satura e por quê

1. **Edições que não mexem na estrutura (`edits`): saturam em cerca de 140 escritas/s, a partir de 4 escritores, e aí é CPU do Node.** Com 4, 16 e 64 escritores a vazão é a mesma (142, 140, 141) e a latência cresce em linha reta (p50 28 → 112 → 450 ms; é a fila da lei de Little: 64 ÷ 141 ≈ 450 ms). O processo Node fica em ~110% de CPU (um núcleo mais o coletor de lixo e o libuv), e como o gerador de carga está no mesmo processo, o teto real do servidor sozinho é algo maior; a trava de estrutura não aparece (espera de 0 a 2 ms por escrita, só linha do ticket e o commit da linha do projeto). A linha do projeto no commit (ADR 0046) não é o limite: `Lock:transactionid`/`tuple` aparecem com no máximo 5 a 7 conexões ao mesmo tempo e custam 2 ms por escrita a 64.
2. **Mudanças de estrutura (`structure`): saturam em 45 a 52 escritas/s já com 4 escritores, pela trava do projeto (ADR 0045).** A vazão **não cresce** com mais escritores (52, 49, 45) e cai um pouco; a CPU do Node fica em 47%. A trava é pega no começo e solta no commit; cada transação a segura ~20 ms (a 5 000) e ~55 ms (a 20 000, porque lê o projeto inteiro para conferir ciclo e progresso), e 1 ÷ 0,020 ≈ 50/s. A 20 000 tickets a vazão cai para 17 a 19/s. Latência de 1,4 s (p50) com 64 escritores a 5 000 e 2,5 s a 20 000.
3. **Misturas realistas (`mixed`, `import`): saturam em ~85 escritas/s a 5 000 tickets e ~35 a 20 000**, entre os dois tetos acima: 70% das escritas não esperam a trava e 30% sim. O limite é a soma da CPU do Node (~80%) com a trava de estrutura. A importação de 500 tickets é barata de esperar (0,2 a 1 s) porque dura pouco; nenhuma escrita foi recusada por causa dela.
4. **As conexões do pool (10) são o primeiro limite que quebra de verdade, e é ele que produz o defeito abaixo.** Uma escrita de estrutura segura uma das 10 conexões **enquanto espera a trava**: `maxActive` e `maxConnections` chegam a 10, com 9 conexões esperando em `Lock:advisory` e uma segurando. O resto das requisições espera uma conexão livre dentro do Prisma, **sem aparecer em `pg_stat_activity`**, então a espera na fila é maior que a espera medida em trava (a latência p50 de 1,4 s a 64 escritores contém esse tempo).
5. **Limite por pessoa e por IP no MCP: o limite é o que manda na vazão do agente**, não a trava. Com os limites valendo, a vazão confirmada somou 0,7 a 3,3 escritas/s em todos os níveis (≈ 120 requisições por minuto por IP; 40 escritas por minuto por pessoa, 20 por token, 60 requisições por minuto por token) e 429 com `Retry-After` quando passa. Sem limites, os agentes chegam a 28 → 47 → 46 ok/s (1, 4, 16 agentes), perto das edições da tela. Dois detalhes: (a) todos os agentes do teste vêm do mesmo IP, e o limite de 120/min por IP vale para a soma, o que não representa produção atrás de um proxy que passe o IP verdadeiro; (b) com 64 agentes sem espera a vazão **cai** para 13/s porque o portão de resolução de token (`MAX_CONCURRENT_RESOLVES = 4`, fila de 16, `mcp-gateway.ts:41-42`) devolve **503 `service_unavailable`** com `Retry-After` (28 265 respostas em 30 s), e os clientes do teste não esperam. O 503 é o desenho (o gateway recusa em vez de formar fila longa), não defeito; o que vale registrar é que 64 agentes simultâneos a um projeto já passam do que o portão atende.
6. **Leitores:** mesmo sem ser o foco, a leitura do mapa é a mais afetada por escrita intensa: com escrita contínua a versão muda a todo instante, o `If-None-Match` quase nunca dá 304 e cada atualização de 30 s (aqui 3 s) paga a lista inteira (3,2 MB a 5 000, 13 MB a 20 000) disputando a mesma CPU do Node: 0,1 → 0,8 s a 5 000 e 0,5 → 2 s a 20 000 conforme os escritores sobem.

## Defeito achado

**500 `internal_error` quando muitos escritores de estrutura esperam a trava com o projeto grande.** O que devia ser um 409 `structure_busy` (a ADR 0045 define 409 depois de 3 s de espera pela trava, e para estouro de prazo da transação) sai como **500 genérico** ("Erro interno do servidor"). Causa (confirmada com `--log-errors`): `PrismaClientKnownRequestError: Transaction API error: Unable to start a transaction in the given time.` (P2028), isto é, a requisição esperou mais de 2 s (o padrão `maxWait` do Prisma, que o código não configura: `packages/db/src/index.ts` só define o prazo da transação, 15 s) por uma conexão livre do pool de 10, ocupado por outras escritas de estrutura aguardando a trava. A trava de 3 s nunca chega a disparar nesses casos, porque a requisição nem obtém conexão. O erro não é traduzido pelo filtro de erros (que só traduz 40P01, 40001, estouro da espera pela trava e estouro do prazo da transação).

Reprodução (rodou duas vezes, 214 e 160 falhas em ~780 escritas):

```
pnpm --filter @treepm/api measure:concurrent-writes --sizes 20000 --levels 64 --scenarios structure --duration 30 --log-errors
```

A 5 000 tickets com 64 escritores a mesma rodada não reproduz (latência p50 de 1,4 s, abaixo dos 2 s); a 20 000, com cada escrita segurando a trava por ~55 ms, passa. Também aparecem 7 respostas 500 em `branch` 64 e 1 em `mixed` 64 a 20 000 (mesma assinatura; não capturei o corpo da primeira bateria). Nenhum dado errado: todas as transações recusadas foram desfeitas e a integridade passou. Efeito para o usuário: "erro interno" em vez do "tente de novo" que a tela já sabe mostrar. Não corrigi.

Não houve: ciclo, ticket órfão, versão do projeto que não muda, dado errado, impasse que não virasse 409 (o PostgreSQL registrou 0 deadlocks).

## O que valeria mudar (sem mudar agora)

**Pequeno (horas)**
- Traduzir P2028 (`Unable to start a transaction in the given time`) em 409 `structure_busy`/"tente de novo" no filtro de erros, ou em 503 com `Retry-After`: fecha o defeito acima. O conserto honesto é também subir `maxWait` do `tenantTransaction` para ficar coerente com os 3 s de espera pela trava e os 15 s do prazo.
- Nas mudanças de estrutura, pegar a trava **antes** de abrir a transação do Prisma (ou numa conexão curta) para uma requisição que vai esperar não ocupar uma das 10 conexões enquanto aguarda: hoje 9 das 10 conexões ficam paradas em `Lock:advisory`.
- Medir/ajustar o tamanho do pool (10) conscientemente; ele é o primeiro limite quando há dezenas de escritores.

**Médio (dias)**
- Tirar da transação de estrutura a leitura do projeto inteiro (conferência de ciclo e progresso por consulta ascendente/recursiva do ramo): a 20 000 tickets cada escrita de estrutura segura a trava ~55 ms e limita a 18 escritas/s; a 5 000 são ~20 ms e 50/s.
- Servir o `If-None-Match` do mapa por uma versão que não mude a cada escrita que não afeta o que a tela mostra, ou entregar a lista em partes/incremental: com escrita contínua o mapa baixa a lista inteira a cada atualização.
- Perfilar o CPU do Node nas edições (110% de um núcleo a 140 escritas/s): a lista de detalhe (`detailFor`) refaz o projeto inteiro em cada escrita (item 7 da medição anterior, já parcialmente tratado).

**Grande (mais de uma semana ou decisão de produto)**
- Mais de uma instância da API: os limites do MCP e a fila do portão são em memória do processo (uma máquina só), e a trava de estrutura é por projeto no banco, que já vale entre instâncias.
- Trava de estrutura mais fina (por ramo) em vez de por projeto, se o produto passar a ter dezenas de pessoas movendo tickets ao mesmo tempo no mesmo projeto: hoje o teto é de ~50 mudanças de estrutura por segundo a 5 000 tickets, o que é muito para uma equipe humana e pouco para uma frota de agentes.

## O que não consegui medir, e os limites desta medição

- **Máquina carregada (34 a 40 de carga média)** e servidor e gerador de carga no mesmo processo: números são piso e ordem de grandeza; nada foi repetido para medir variância (uma rodada de 30 s por célula).
- **Rede e Neon:** banco local; em produção cada ida ao banco soma latência, e uma escrita de estrutura segura a trava durante todas elas, então o teto de estrutura em produção é provavelmente **menor** que o daqui.
- **Pool de 10 e o padrão `maxWait` de 2 s** são do código de hoje; não testei outros tamanhos.
- **20 000 tickets:** só `structure`, `mixed` e `branch`, em 1, 16 e 64 escritores (as demais células e a importação não foram repetidas); `edits` a 20 000 não foi medido.
- **Leitores com 304:** com escrita contínua não houve 304 para medir; o 304 sem escrita foi medido no relatório de 2026-11-22.
- **Escritas sem efeito em `branch`:** a diferença entre o contador e as escritas confirmadas é atribuída a escritas sem efeito por inferência, não verificada escrita a escrita.
- **Espera por trava** é amostragem a cada ~200 ms de `pg_stat_activity` convertida em média por escrita: aproximação; não inclui a espera por conexão dentro do Prisma.
- **Clerk:** a participação do MCP usa o diretório falso (instantâneo); em produção a escrita pelo MCP faz uma ida ao Clerk a cada chamada.

## Depois do adendo 1 da ADR 0045

Mesma ferramenta, mesmo banco (`treepm_p1`), 30 s por célula, uma rodada cada, a máquina com carga média de 40 a 47 (ruído de cerca de 15%). Antes = código sem a fila (`TREEPM-259`/`TREEPM-260`); depois = fila em memória (2 por chave) e `maxWait` de 5 s. `adv.` = máximo de conexões esperando a trava consultiva (`Lock:advisory`) numa amostra de 200 ms; `ativas` = máximo de conexões `active`.

| N | Cenário | Esc. | ok/s antes → depois | p50 (ms) antes → depois | p95 (ms) antes → depois | Além de 2xx, antes | Além de 2xx, depois | ativas / adv. antes | ativas / adv. depois |
|---|---|---|---|---|---|---|---|---|---|
| 5 000 | structure | 16 | 37,2 → 38,8 | 405 → 451 | 602 → 765 | — | — | 10 / 9 | 4 / 3 |
| 5 000 | structure | 64 | 38,4 → 38,4 | 1 634 → 1 973 | 1 894 → 2 870 | — | 409 `structure_busy`: 6 | 10 / 9 | 4 / 3 |
| 5 000 | mixed | 16 | 66,5 → 77,2 | 150 → 52 | 514 → 776 | — | — | 10 / 9 | 10 / 3 |
| 5 000 | mixed | 64 | 63,3 → 79,5 | 966 → 94 | 1 475 → 3 082 | — | 409 `structure_busy`: 151 | 10 / 9 | 10 / 3 |
| 20 000 | structure | 16 | 18,7 → 19,1 | 811 → 911 | 1 235 → 1 462 | — | — | 10 / 9 | 4 / 3 |
| 20 000 | structure | 64 | 16,0 → 16,2 | 2 720 → 3 032 | 3 494 → 3 252 | **500: 197** | 409 `structure_busy`: 165 | 10 / 9 | 4 / 3 |
| 20 000 | mixed | 16 | 35,1 → 34,2 | 233 → 49 | 1 106 → 2 064 | — | — | 10 / 9 | 10 / 3 |
| 20 000 | mixed | 64 | 38,4 → 51,6 | 1 471 → 103 | 2 326 → 3 293 | — | 409 `structure_busy`: 240 | 10 / 9 | 10 / 3 |

Leitura:

- **O defeito sumiu:** nenhum 500 em nenhuma célula (antes: 197 a 20 000 tickets e 64 escritores). A integridade passou nas 8 células.
- **A vazão de `structure` não caiu** (todas as diferenças dentro do ruído). Em `mixed` subiu: a escrita que não muda estrutura deixou de esperar conexão atrás das que esperam a trava (p50 de 966 para 94 ms a 5 000 tickets e 64 escritores).
- **Quem espera demais agora recebe 409 `structure_busy` em vez de 500**, depois de 3 s na fila: 6 a 240 por célula com 64 escritores. É o desenho do adendo (a tela mostra "tente de novo"); a vazão confirmada não muda, só a resposta de quem não cabe. O p95 de `mixed` subiu porque essas respostas chegam aos 3 s.
- **O critério "no máximo 1 conexão esperando a trava por projeto" não foi atingido com a chave por organização na primeira versão: máximo de 3** (antes, 9), porque a chave de projeto e a de organização somavam até 4 transações do mesmo projeto. A revisão 1 troca a chave por organização + projeto sempre (tabela abaixo).
- Em `mixed` as conexões ativas continuam chegando a 10: são as edições comuns (linha do ticket, commit do projeto), que a fila não toca.

### Revisão 1: chave sempre organização + projeto

Mesmas 8 células, mesmo banco, carga média de 40 a 47. Nas rotas que só conhecem o ticket ou a conversa, o projeto sai de uma leitura curta antes da fila.

| N | Cenário | Esc. | ok/s | p50 (ms) | p95 (ms) | Além de 2xx | ativas / adv. |
|---|---|---|---|---|---|---|---|
| 5 000 | structure | 16 | 35,6 | 413 | 719 | — | 2 / 1 |
| 5 000 | structure | 64 | 41,1 | 1 519 | 1 883 | — | 2 / 1 |
| 5 000 | mixed | 16 | 77,8 | 51 | 613 | — | 9 / 1 |
| 5 000 | mixed | 64 | 66,6 | 106 | 3 074 | 409 `structure_busy`: 111 | 10 / 1 |
| 20 000 | structure | 16 | 19,5 | 810 | 1 105 | — | 2 / 1 |
| 20 000 | structure | 64 | 18,2 | 2 914 | 3 119 | 409 `structure_busy`: 113 | 3 / 1 |
| 20 000 | mixed | 16 | 33,0 | 45 | 1 573 | — | 10 / 1 |
| 20 000 | mixed | 64 | 49,5 | 103 | 3 206 | 409 `structure_busy`: 279 | 10 / 1 |

Nenhum 500; integridade ok nas 8 células; **conexões esperando a trava: no máximo 1 em todas** (antes 9); conexões ativas de `structure` caíram de 10 para 2 ou 3; vazão de `structure` dentro do ruído (37,2→35,6; 38,4→41,1; 18,7→19,5; 16,0→18,2). Os 409 são quem passa de 3 s na fila (antes, 500 ou espera sem fim).
