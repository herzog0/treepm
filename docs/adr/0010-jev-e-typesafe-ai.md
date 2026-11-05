# ADR 0010 — Jev e TypeSafe AI somente na API

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

Sugerir categoria e posição pode reduzir o trabalho de organizar tickets, mas uma classificação incerta ou incompleta não deve criar hierarquia silenciosamente. A credencial externa também não pode chegar ao frontend.

## Decisão

Somente `apps/api` usa `@typesafe-ai/sdk` **0.7.0** e `TYPESAFE_API_KEY`. Com credencial, `TypeSafeClient` usa `systemOne` e `Choice` com `defaultModel: "jev-latest"`:

1. Escolhe uma disciplina entre backend, frontend, design, produto e outro.
2. Percorre a hierarquia por nível, escolhendo o ramo mais específico ou `__stop__` para permanecer no pai atual.
3. Limita o percurso a seis níveis e a 20 candidatos por nível.
4. Resume a confiança pelo menor resultado do caminho.

Mais de 20 candidatos ou ramos além dos seis níveis analisáveis retornam `mode: unavailable` e `manualRequired: true`, explicando a limitação sem cortar ramos. Confiança abaixo de **0,65** também exige revisão manual. Falhas externas retornam `mode: error` e escolha manual.

A sugestão não cria nem altera tickets. A pessoa precisa confirmar o preenchimento e depois executar a criação pela rota normal. Sem chave, o fallback informa indisponibilidade e orienta seleção manual.

## Consequências

O frontend apresenta estados disponíveis, indisponíveis e erro sem presumir sucesso. Descrições e critérios são truncados antes da chamada, e IDs vêm dos tickets existentes, não da imaginação do modelo.

A chave nunca usa prefixo `VITE_` nem aparece em bundles. Apenas o fallback offline é verificável sem credencial; qualidade do modelo, taxonomias próprias e calibração do limiar continuam questões futuras em `docs/open-questions.md`.
