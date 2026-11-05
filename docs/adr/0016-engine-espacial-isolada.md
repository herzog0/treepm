# ADR 0016 — Reinício a partir da engine espacial

**Status:** Aceita

**Data:** 2026-11-04

## Contexto

O usuário decidiu recomeçar a implementação do produto, mantendo a mesma ideia e preservando a estrutura espacial já validada. A base passa a conter somente a engine, o fundo, a lógica de navegação e dados fictícios para demonstração.

## Decisão

A engine fica em `@treepm/engine`, um pacote TypeScript ESM sem React e sem modelos de negócio. A entrada é uma hierarquia genérica de nós identificados, com rótulos e cores. Permanecem índice hierárquico, layout retangular, bounds, LOD, culling, morph reversível e matemática da câmera.

A demo React em `apps/web` mantém fundo, controles, pan imediato, wheel ancorado, gestos simultâneos, seleção e foco explícito. Dados locais determinísticos substituem qualquer bootstrap remoto.

As implementações anteriores de produto, persistência, administração, integrações, experiências alternativas e suas dependências são removidas. A visão e o registro de ideias são apenas referências para reconstrução futura.

## Consequências

O workspace roda sem serviços ou credenciais. A engine pode ser usada por uma nova aplicação sem importar regras do produto anterior. Toda regra de negócio retomada deverá ser implementada explicitamente fora desse núcleo.

O estado anterior está preservado no Git pelo checkpoint `33c4702`. A extração recebe um commit separado, para permitir revisão e reversão da mudança.

## Validação da extração

O dataset local tem 1001 nós, seis regiões iniciais e profundidade máxima 7. A validação encontrou zero sobreposições nos 500.500 pares do layout e confirmou que todas as 746 folhas alcançam full/140 px. No navegador, a mesma identidade DOM foi mantida na ida e volta entre indicador e card; pan com wheel teve erro de âncora inferior a 0,003 px. Seleção, foco, cores, movimento reduzido e abertura mobile passaram, sem chamadas à API ou erros de console. O comando `pnpm dev` iniciou apenas o watch da engine e o Vite.
