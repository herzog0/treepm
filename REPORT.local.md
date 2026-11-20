# REPORT — Brief B: ferramenta de reconstrução (ADR 0030)

Nada foi commitado por mim. O diff do trabalho: a primeira rodada já foi commitada e mesclada com a `main` pela coordenação (`467614e`, `036bc33`); este relatório cobre o conjunto, e a **segunda rodada (correções da revisão) está só na árvore de trabalho, sem commit** (6 arquivos modificados, listados abaixo). Verificação final, já sobre a árvore mesclada com a Brief A: `pnpm build` OK, `pnpm typecheck` OK, `pnpm lint` OK, `git diff --check` OK, `test/placement-rebuild-core.test.ts` com 41 testes passando. Não toquei em `apps/api/src/assistant/` nem em `apps/web`.

## O que foi criado

- `apps/api/package.json`: script `placement:rebuild` (mesmo formato do `verify:providers`).
- `apps/api/scripts/placement-rebuild.ts`: ponto de entrada. Lê os argumentos, sobe a API, despacha o comando e fecha a aplicação no `finally`. Saídas: 0 ok, 1 falha ou "não confere", 2 uso errado.
- `apps/api/scripts/placement-rebuild/core.ts`: **parte pura**: ordem de inserção e de remoção, classificação nos três grupos, retomada, `withRetry503`, `compareTrees`, `buildImportTree`, `parseCliArgs`, números e markdown do relatório.
- `apps/api/scripts/placement-rebuild/app.ts`: sobe o `AppModule` real com `Test.createTestingModule`, trocando só `SESSION_VERIFIER`. Escuta em `127.0.0.1`, porta efêmera; um middleware antes de qualquer rota exige o cabeçalho `x-rebuild-token` (valor aleatório da subida) em TODA requisição, e o verificador de sessão também o confere. `BRANCH_JUDGE` vira um `RecordingJudge` que guarda cada julgamento. Com `--fake-providers` troca também conversa, resumidor, diretório e `CONFIG` (para a IA contar como ligada).
- `apps/api/scripts/placement-rebuild/client.ts`: cliente HTTP; erros só com status e código.
- `apps/api/scripts/placement-rebuild/commands.ts`: os nove comandos.
- `apps/api/scripts/placement-rebuild/fakes.ts`: provedores falsos (o juiz escolhe pelo vocabulário em comum; conversa e juiz aceitam simular 503).
- `apps/api/test/placement-rebuild-core.test.ts`: 41 testes da parte pura.

## Testes falhando antes da implementação

1. Antes de existir `core.ts` (vermelho de "módulo ausente", não de asserção):

```
 FAIL  test/placement-rebuild-core.test.ts [ test/placement-rebuild-core.test.ts ]
Error: Cannot find module '../scripts/placement-rebuild/core.js' imported from .../apps/api/test/placement-rebuild-core.test.ts
 Test Files  1 failed (1)
      Tests  no tests
```
Depois de `core.ts`: 37 passando.

2. Na revisão, 4 testes novos escritos **antes** das correções, falhando por asserção:

```
 × guarda os dados do Claude da marca de conversa iniciada, para o registro retomado não perdê-los
   TypeError: Cannot read properties of undefined (reading 'get')
 × aceita as opções ocultas de ensaio (--retry-delays-ms, --fake-503-first, --fake-503-judge-at, --role)
   AssertionError: expected { ok: false, …(1) } to match object { ok: true, options: { …(4) } }
 × registro retomado fica fora das medianas de tempo e não tem caminho escolhido registrado
   AssertionError: expected { median: 100, max: 300 } to deeply equal { median: 150, max: 300 }
 × mostra 'não registrado' no caminho escolhido de um registro retomado
   AssertionError: expected '# Relatório da reconstrução — PROJ\n\n…' to contain 'não registrado'
 Tests  4 failed | 37 passed (41)
```
Depois do código: `Tests 41 passed (41)`.

A parte que fala com rede e disco (`app.ts`, `client.ts`, `commands.ts`, `fakes.ts`) não tem teste automático; quem a cobre é o ensaio abaixo. O reset do gravador dentro do fecho do 503 (correção da revisão) foi provado só pelo ensaio (4 julgamentos com e sem falha).

## Linha de comando de cada comando

Todos começam por `pnpm --filter @treepm/api placement:rebuild`. `--org`/`--user` são ids do Clerk. `--dir` é sempre obrigatória.

- `export --org O --user U --project P --dir D`
- `check --org O --user U --project P --dir D` (exit 1 se não conferir)
- `wipe --org O --user U --project P --dir D --confirm <CHAVE>`
- `rebuild --org O --user U --project P --dir D [--limit N]`
- `restore-state --org O --user U --project P --dir D`
- `report --project P --dir D` (não sobe a API; não pede `--org` nem `--user`)
- `restore-original --org O --user U --project P --dir D`
- `create-project --org O --user U --dir D --key CHAVE --name "Nome"`
- `archive-project --org O --user U --project P --dir D`

`--fake-providers` só para ensaio. Variáveis: as da API (`DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `APP_ORIGIN`) e, com IA real, `ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY`; `.env.local` de `apps/api` é carregado como no `verify:providers`. Opções ocultas: `--role` (padrão `org:admin`), `--retry-delays-ms a,b,c` (padrão 2000,5000,10000), `--fake-503-first N`, `--fake-503-judge-at N`.

Arquivos em `--dir`: `gabarito.json`, `run-<projeto>.jsonl` (uma linha por ticket), `started-<projeto>.jsonl` (marca de conversa aberta, com a resposta do Claude), `report-<projeto>.md`.

## Ensaio (provedores falsos, banco `treepm_rebuild` no contêiner de teste)

Preparação: banco `treepm_rebuild` criado no contêiner; migrations aplicadas com `DATABASE_MIGRATION_URL` apontando para ele; `alter role treepm_app login password …` como no setup dos testes; `DATABASE_URL` do papel `treepm_app` nesse banco, Clerk falso, `--org org_ensaio --user user_ensaio`. Projeto `ORIG` com 16 tickets em 3 níveis, situações `todo`/`in_progress`/`done`/`cancelled` e 4 atribuições a 2 pessoas (a segunda pessoa inserida por SQL só no banco do ensaio). A semente foi criada com `restore-original` a partir de um gabarito escrito à mão. O contêiner não foi derrubado. `<ensaio>` é a pasta de trabalho.

### 1 e 2. export, check, restore-original (a árvore do COPIA saiu igual à do ORIG: títulos, pais, situações e pessoas, comparados por SQL)

```
$ export
Gabarito gravado: 16 tickets (profundidade 0: 4; profundidade 1: 5; profundidade 2: 7).
$ export de novo (deve recusar)
<ensaio>/work/gabarito.json já existe; recuso sobrescrever o gabarito.
exit=1
$ check
Confere: o projeto vivo é igual ao gabarito.
exit=0
$ restore-original no COPIA
Árvore recriada: 16 tickets.
Atribuições reaplicadas: 4; falhas: 0.
$ restore-original de novo (deve recusar)
O projeto 01a1f9f7-259e-7c96-b8f9-1b017d0a6327 tem 16 ticket(s); recuso restaurar em projeto não vazio.
exit=1
ORIG e COPIA IGUAIS (16 linhas: título|pai|situação|pessoas)
1|Autenticação||todo|
2|Tela de login|Autenticação|todo|
3|Botão entrar celular|Tela de login|in_progress|user_ensaio
```

### 3 a 6. wipe, rebuild interrompido e retomado, 503 simulado

Entre `rebuild --limit 5` e o seguinte apaguei a última linha de `run-*.jsonl`, simulando queda entre "criar o ticket" e "registrar": a retomada reaproveitou conversa e ticket (`retomado`) sem duplicar (16 tickets, 16 títulos distintos no fim). `--fake-503-first 99` mostra as 4 tentativas e a parada com exit 1; `--fake-503-first 2` mostra o sucesso na terceira tentativa. (Esta rodada foi anterior à regra nova de candidatos, por isso tudo ficou na raiz.)

```
$ (psql) altera um título no projeto vivo
UPDATE 1
$ check (deve falhar)
NÃO confere: 1 diferença(s).
  01a1f9f7-58da-75c6-b6e1-3236c6016443: título diferente
exit=1
$ wipe (com o título alterado: deve recusar)
O projeto vivo não confere com o gabarito (1 diferença(s)); rode `check`. Nada foi removido.
exit=1
UPDATE 1
$ wipe --confirm ERRADO (deve recusar)
--confirm precisa ser igual à chave do projeto do gabarito.
exit=1
$ wipe --confirm ORIG
Removidos 16/16.
Projeto com zero tickets.
exit=0
tickets restantes no ORIG:|0
$ rebuild --limit 5
Ordem: 16 tickets; já registrados: 0; a processar agora: 5.
[1/5] ORIG-17 (esperava profundidade 0) → same_parent em 129 ms
[2/5] ORIG-18 (esperava profundidade 0) → same_parent em 90 ms
[3/5] ORIG-19 (esperava profundidade 0) → same_parent em 72 ms
[4/5] ORIG-20 (esperava profundidade 0) → same_parent em 61 ms
[5/5] ORIG-21 (esperava profundidade 1) → elsewhere em 58 ms
Rebuild: nada mais a fazer nesta execução.
--- simula queda entre criar o ticket e registrar: apaga a última linha de run-*.jsonl
4
$ rebuild com 503 persistente (deve parar, exit!=0)
Ordem: 16 tickets; já registrados: 4; a processar agora: 12.
[1/12] ORIG-21 (esperava profundidade 1) → elsewhere retomado em 222 ms
abrir conversa: resposta 503 (assistant_unavailable) persistente depois de 4 tentativas; rode de novo para continuar.
exit=1
$ rebuild com 2 respostas 503 e depois sucesso (retoma de onde parou)
Ordem: 16 tickets; já registrados: 5; a processar agora: 11.
[1/11] ORIG-22 (esperava profundidade 1) → elsewhere em 383 ms
[2/11] ORIG-23 (esperava profundidade 1) → elsewhere em 83 ms
[3/11] ORIG-24 (esperava profundidade 1) → elsewhere em 72 ms
[4/11] ORIG-25 (esperava profundidade 1) → elsewhere em 75 ms
[5/11] ORIG-26 (esperava profundidade 2) → elsewhere em 70 ms
[6/11] ORIG-27 (esperava profundidade 2) → elsewhere em 54 ms
[7/11] ORIG-28 (esperava profundidade 2) → elsewhere em 56 ms
[8/11] ORIG-29 (esperava profundidade 2) → elsewhere em 58 ms
[9/11] ORIG-30 (esperava profundidade 2) → elsewhere em 56 ms
[10/11] ORIG-31 (esperava profundidade 2) → elsewhere em 53 ms
[11/11] ORIG-32 (esperava profundidade 2) → elsewhere em 49 ms
Rebuild: nada mais a fazer nesta execução.
exit=0
$ rebuild de novo (nada a fazer)
Ordem: 16 tickets; já registrados: 16; a processar agora: 0.
Rebuild: nada mais a fazer nesta execução.
tickets no ORIG:|16|16
linhas em run: 16  marcas started: 16
```

### restore-state e `report` (primeira rodada)

```
$ restore-state
Situações aplicadas: 5; atribuições: 4; situações puladas (ticket com filhos): 0; falhas: 0.
exit=0
$ restore-state de novo (idempotente)
Situações aplicadas: 5; atribuições: 4; situações puladas (ticket com filhos): 0; falhas: 0.
gabarito (título|situação|atribuídas) vs reconstruído, por título:
tickets com situação divergente: 0 | linhas com pessoa: 3
$ report
Relatório gravado: 16 tickets (same_parent 4, deeper 0, elsewhere 12).
--- tentativas > 1 no run:
  ORIG-21 {'open': 1, 'draft': 0, 'placement': 0, 'ticket': 1} resumed
  ORIG-22 {'open': 3, 'draft': 1, 'placement': 1, 'ticket': 1} 
```

### Revisão: caminho sem `--fake-providers`, 503 no juiz, `archive-project`

O `check` sem falsos diz "não confere" porque o `ORIG` já tinha sido reconstruído (ids novos) contra o gabarito antigo: resultado correto e prova que o caminho real sobe, autentica pelo cabeçalho, fala HTTP e lê o banco. A pessoa já provisionada com o mesmo papel dispensa o Clerk. Com as chaves falsas `x`, o `useFactory` do `BRANCH_JUDGE` executou (construiu o `JevBranchJudge` embrulhado) e não foi chamado. Com `--fake-503-judge-at 2`, a procura tentou 2 vezes e o registro ficou com os mesmos 4 julgamentos da execução sem falha.

```
$ (sem --fake-providers, chaves de IA vazias) rebuild: deve falhar antes de tudo
A IA está desligada (faltam ANTHROPIC_API_KEY e/ou TYPESAFE_API_KEY). Este comando precisa dela; use --fake-providers só para ensaio.
exit=1
$ (sem --fake-providers, chaves de IA vazias) check: pessoa já provisionada dispensa o Clerk
NÃO confere: 32 diferença(s).
  01a1f9f7-…: falta no projeto   (16 linhas assim)
  01a1f9f8-…: a mais no projeto   (mais linhas assim)
  … e mais 12.
exit=1
$ (sem --fake-providers, com chaves falsas "x": só para executar o useFactory do juiz) check
NÃO confere: 32 diferença(s).
  01a1f9f7-…: falta no projeto   (16 linhas assim)
  01a1f9f8-…: a mais no projeto   (mais linhas assim)
  … e mais 12.
exit=1
$ juiz falso com 503 na 2ª chamada, retomando do zero um projeto com árvore (COPIA), com e sem a falha
[1/1] COPIA-23 (esperava profundidade 0) → elsewhere incerto em 405 ms
Rebuild: nada mais a fazer nesta execução.
  fake-503-judge-at=0  julgamentos: 4  tentativas: {'open': 1, 'draft': 1, 'placement': 1, 'ticket': 1}
[1/1] COPIA-24 (esperava profundidade 0) → elsewhere incerto em 296 ms
Rebuild: nada mais a fazer nesta execução.
  fake-503-judge-at=2  julgamentos: 4  tentativas: {'open': 1, 'draft': 1, 'placement': 2, 'ticket': 1}
$ archive-project no COPIA
Projeto 01a1f9f7-259e-7c96-b8f9-1b017d0a6327 arquivado.
exit=0
COPIA|t
ORIG|f
```

Cabeçalho exigido em toda requisição, inclusive rota pública:

```
$ requisição sem o cabeçalho a uma rota pública (/api/health) e com ele
sem cabeçalho: 401 | com cabeçalho: 200
```

### Ensaio completo com a regra nova da Brief A já mesclada (projeto `NOVO`)

```
$ create-project
Projeto criado: 01a1fa00-2b9f-7af6-9928-d661a3e4d88c
$ restore-original (semeia NOVO com a árvore do gabarito do ORIG)
Árvore recriada: 16 tickets.
Atribuições reaplicadas: 4; falhas: 0.
$ export
Gabarito gravado: 16 tickets (profundidade 0: 4; profundidade 1: 5; profundidade 2: 7).
$ wipe
Removidos 16/16.
Projeto com zero tickets.
$ rebuild (regra nova da Brief A já mesclada)
Ordem: 16 tickets; já registrados: 0; a processar agora: 16.
[1/16] NOVO-17 (esperava profundidade 0) → same_parent em 160 ms
[2/16] NOVO-18 (esperava profundidade 0) → same_parent em 111 ms
[3/16] NOVO-19 (esperava profundidade 0) → same_parent em 62 ms
[4/16] NOVO-20 (esperava profundidade 0) → same_parent em 68 ms
[5/16] NOVO-21 (esperava profundidade 1) → same_parent em 75 ms
[6/16] NOVO-22 (esperava profundidade 1) → elsewhere em 82 ms
[7/16] NOVO-23 (esperava profundidade 1) → same_parent em 78 ms
[8/16] NOVO-24 (esperava profundidade 1) → deeper em 78 ms
[9/16] NOVO-25 (esperava profundidade 1) → same_parent em 68 ms
[10/16] NOVO-26 (esperava profundidade 2) → elsewhere em 68 ms
[11/16] NOVO-27 (esperava profundidade 2) → deeper em 58 ms
[12/16] NOVO-28 (esperava profundidade 2) → same_parent em 79 ms
[13/16] NOVO-29 (esperava profundidade 2) → elsewhere em 62 ms
[14/16] NOVO-30 (esperava profundidade 2) → elsewhere incerto em 62 ms
[15/16] NOVO-31 (esperava profundidade 2) → elsewhere em 57 ms
[16/16] NOVO-32 (esperava profundidade 2) → same_parent em 56 ms
Rebuild: nada mais a fazer nesta execução.
$ restore-state
Situações aplicadas: 4; atribuições: 4; situações puladas (ticket com filhos): 1; falhas: 0.
$ report
Relatório gravado: 16 tickets (same_parent 9, deeper 2, elsewhere 5).
```

Relatório gerado (início): 9 `same_parent`, 2 `deeper`, 5 `elsewhere`; 1 incerto (alternativas listadas e "alguma bateria com o gabarito: não"); lista dos fora do pai esperado com caminho esperado e escolhido; tabela de calibração por julgamento do juiz. O ticket que virou pai na reconstrução teve a situação do gabarito **pulada** (409), contada à parte.

## Decisões fora do brief

0. **Ticket de raiz que desceu = `deeper`.** A raiz do projeto é ancestral de qualquer ticket; um ticket do gabarito sem pai que ficou dentro de outro cai em `deeper`. Segue a ADR 0030 ("mais fundo dentro do grupo certo") e a definição do brief. Pai escolhido sem correspondência no gabarito é `elsewhere`.
1. **Papel da sessão fixa:** `--role` (padrão `org:admin`). Sem papel de administração, `wipe`, `create-project` e `archive-project` não teriam permissão. **Atenção:** o serviço de identidade guarda o papel da pessoa; se o usuário real do Clerk tiver outro papel no banco, a primeira requisição o atualiza para o desta sessão (e lê o Clerk real nesse caso). Confira antes de rodar com `--user` real.
2. **Marcas de conversa em arquivo separado** (`started-<projeto>.jsonl`), mantendo uma linha por ticket no arquivo de execução. A marca guarda a resposta do Claude (rascunho proposto, `ready`, mensagem), que o rascunho do gabarito apaga. Registro retomado (`resumed: true`) tem caminho e julgamentos vazios; o relatório o exclui das medianas de tempo, mostra o caminho como "(não registrado: retomado)" e conta quantos são.
3. **`--limit N` vale para a ordem inteira:** os N primeiros da ordem, depois saem os já feitos. Repetir `--limit 5` não avança; rodar sem `--limit` termina.
4. **`rebuild` recusa projeto que já tenha tickets** quando não existe execução registrada.
5. **Limiares do relatório fixos** (0,3 e 0,7, do brief) em `judgmentBand`, não importados de `placement-search.ts`. Se os limiares da procura mudarem, atualize `core.ts`.
6. **`restore-state` e ticket que ganhou filhos:** situação não reaplicável (409) conta como "pulada", não falha. Outro erro (ou pessoa não atribuível) dá exit 1.
7. **`restore-original` aceita no máximo 500 tickets** (limite da rota de importação, uma chamada); acima disso recusa com mensagem clara, sem dividir em lotes.
8. **Cabeçalho aleatório em toda requisição** por middleware antes das rotas (401 sem ele).
9. **Reset do gravador de julgamentos dentro do fecho repetido em 503**, para um 503 no meio da descida não duplicar níveis.
10. Candidato com título repetido no mesmo nível entra no registro como `Título [id]`.
11. O tempo "por passo" soma as tentativas (inclui as esperas do 503).

## Atenção para a coordenação

- **O `globalSetup` do Vitest da API recria o schema do banco de teste padrão a cada execução, mesmo para o meu arquivo de teste puro.** Rodei meus testes com `TEST_DATABASE_MIGRATION_URL`/`TEST_DATABASE_URL` apontando para um terceiro banco, `treepm_rebuild_unit`. Na suíte normal o arquivo roda como os demais.
- Bancos `treepm_rebuild` e `treepm_rebuild_unit` ficaram no contêiner; podem ser apagados (`drop database`).
- `rebuild` precisa das duas chaves de IA; sem elas falha com mensagem clara antes de processar qualquer ticket (exit 1).

## Fora do brief ou em dúvida

- Não rodei nada contra IA real nem contra o banco de desenvolvimento. `archive-project` rodou no `COPIA` (exit 0, `archived_at` preenchido).
- `export` busca a descrição de cada ticket por `GET /tickets/:id`, cinco de cada vez (só lê).
- Não rodei a suíte inteira da API (o contêiner de teste é compartilhado); só o meu arquivo, no banco isolado.
