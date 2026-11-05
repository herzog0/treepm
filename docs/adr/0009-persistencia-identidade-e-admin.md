# ADR 0009 — Persistência JSON, identidades seed e admin

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

A primeira fatia precisa persistir mutações localmente sem fingir garantias de um banco de produção. O admin também precisa inspecionar o workspace sem inventar contas, sessões ou permissões inexistentes.

## Decisão

`JsonTreeRepository` implementa `TreeRepository` com snapshot clonado, fila serializada de mutações e publicação por arquivo temporário seguido de `rename` atômico. Na ausência do arquivo, cria o seed de `apps/api/src/seed.ts`. `TREEPM_DATA_FILE` escolhe o caminho; dados gerados ficam fora do Git.

O admin consome `GET /api/bootstrap` e apresenta visão geral, projetos, tickets com busca e usuários seed. Métricas de folhas e progresso usam o domínio compartilhado. A interface identifica explicitamente “Ambiente local”, “JSON” e “sem autenticação”.

Usuários são registros seed com identidade, nome, email e cor para demonstrar múltiplos responsáveis. Não representam pessoas autenticadas nem autorizam operações.

## Consequências

A fila e o rename protegem escritas concorrentes e snapshots parciais **dentro de um único processo**. Não há locking multi-processo, isolamento relacional, migrações, réplicas ou recuperação transacional.

Produção exige outra implementação de `TreeRepository` com banco transacional, estratégia de concorrência e migrações. Autenticação, autorização, convites, auditoria e proteção do backoffice são próximos passos, não recursos atuais. A alternativa de expor o JSON como se fosse produção foi rejeitada.
