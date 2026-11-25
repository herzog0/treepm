# Documentos legais

**Estado:** publicados em 2026-11-25, em `https://treepm.ai/termos` e `https://treepm.ai/privacidade`. Teodoro aprovou os textos em 2026-11-24, informou os dados da empresa e decidiu publicar sem revisão jurídica. A decisão sobre o mecanismo de aceite está na [ADR 0039](../adr/0039-termos-privacidade-e-aceite-por-organizacao.md).

- [Termos de uso](termos-de-uso.md)
- [Política de privacidade](politica-de-privacidade.md)

## Como mudar

1. Mude o texto aqui e a data de "Versão" no topo dos dois documentos.
2. Copie os dois arquivos para `apps/web/src/legal/content/pt-BR/` (`termos.md` e `privacidade.md`). Um teste confere que a cópia é idêntica, e outro recusa marcadores de rascunho.
3. Se a mudança tocar no que é enviado a provedores de IA, mude também `AI_CONSENT_VERSION` em `packages/domain/src/ai-consent.ts`: os aceites anteriores deixam de valer e o assistente fica desligado em cada organização até um administrador aceitar de novo.

## O que foi decidido para esta versão

- Responsável, endereço, e-mail de contato, público (empresas, profissionais e pessoas físicas), foro (São Paulo/SP) e prazo de resposta a titulares (15 dias): informados por Teodoro em 2026-11-24.
- Guarda de até 30 dias depois do encerramento da organização, registros técnicos por até 90 dias, o mesmo e-mail de contato para pedidos de titulares e serviço sem cobrança por ora: propostas da coordenação, aceitas por Teodoro em 2026-11-25.
- Não há tradução: vale o texto em português do Brasil, e a página avisa disso nos outros idiomas.

## Pendências conhecidas

- Não houve revisão por advogado. As cláusulas de responsabilidade, a base legal de cada tratamento e a transferência internacional foram escritas pela coordenação.
- O adendo de tratamento de dados da Voyage AI (`voyageai.com/dpa`) não foi lido.
- O apagamento em 30 dias depois do encerramento e o descarte de registros em 90 dias são compromissos sem mecanismo automático: hoje dependem de operação manual.

## De onde vêm as afirmações sobre terceiros

Consultadas em 2026-11-21 (Voyage AI em 2026-11-23), nas páginas dos próprios provedores; os endereços estão na ADR 0039. Se um provedor mudar os termos dele, a política precisa ser revista.
