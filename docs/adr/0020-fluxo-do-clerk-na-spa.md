# ADR 0020 — Fluxo do Clerk dentro da SPA

**Status:** Aceita. **Data:** 2026-11-19.

## Contexto

No teste de entrada com Google pelo modal, a tarefa de organização abriu no Account Portal do Clerk em inglês. O TreePM precisa oferecer essa etapa e os formulários de entrada e cadastro na própria interface.

## Decisão

O Clerk recebe URLs locais explícitas para entrada, cadastro e a tarefa `choose-organization`. A SPA usa parâmetros de consulta para distinguir os destinos, deixando o hash para as etapas internas dos formulários do Clerk. Os formulários embutidos delegam ao Clerk o retorno do OAuth. Os componentes do Clerk recebem a localização pt-BR.

O portão renderiza a tarefa a partir da sessão, inclusive quando ela está pendente. O acesso ao mapa continua condicionado a uma sessão autenticada com organização ativa, conforme a ADR 0019.

## Verificação

Testado pela coordenação em 2026-11-19 com a instância de desenvolvimento (issue #1): entrada e cadastro em português, tarefa de organização aberta na origem do app para um usuário novo criado por e-mail de teste, retorno ao mapa, saída e `?demo` sem requisições ao Clerk. O retorno do Google para uma conta sem organização não foi exercitado, porque a conta Google usada já tinha organizações.
