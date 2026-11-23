# ADR 0050 — O servidor comprime as respostas HTTP

- **Data:** 2026-11-23
- **Estado:** decisão da coordenação, por delegação de Teodoro em 2026-11-23; implementada (`TREEPM-255`).

## Contexto

A medição com projeto grande (`docs/medicoes/2026-11-22-projeto-grande.md`) mostrou a lista de um projeto de 20 000 tickets com 13 MB sem compressão. Nada era comprimido pelo servidor, nem os arquivos da web que a API serve em produção, e a documentação de publicação não diz se o proxy da Fly comprime.

## Decisão

- O servidor comprime, por negociação (`Accept-Encoding`), respostas de texto, JSON, JavaScript e SVG acima de 1 KB, com **brotli no nível 4** ou **gzip no nível 4**. Medido na lista de 20 000 tickets: 13,4 MB viram 1,0 MB (brotli) ou 1,5 MB (gzip), por cerca de 70 ms de CPU. O nível seguinte custa quase o dobro de CPU por 9% a menos de bytes.
- **Nunca comprime:** nada sob `/api/mcp` nem qualquer resposta em fluxo (`text/event-stream`); respostas com `Cache-Control: no-transform`; respostas parciais; imagens e fontes; respostas abaixo do limiar.
- **Respostas que carregam segredo ficam sem compressão**, para a compressão não virar um canal de vazamento quando segredo e entrada de quem ataca caem na mesma resposta: a criação de token de acesso (o token é mostrado uma vez, junto do nome escolhido pela pessoa) e as duas respostas da ligação com o GitHub (endereço com `state` assinado). Resposta nova que devolva segredo entra nessa lista.
- A resposta condicional da lista (ADR 0046) continua igual: o `ETag` fraco vale para qualquer codificação e o `304` segue sem corpo.
- Se o proxy da publicação também comprimir, ele não recomprime o que já vem codificado.

## Alternativas descartadas

- **Deixar para o proxy.** Depende de uma configuração que não controlamos nem conseguimos conferir antes do deploy, e não cobre o servidor local nem outra hospedagem.
- **Nível mais alto.** Mais CPU a cada carga do mapa por pouco ganho de bytes.

## Em aberto

1. Conferir `content-encoding` na publicação depois do deploy (o comando está em `docs/deploy.md`).
2. Baixar para o nível 3 de brotli se o processador da publicação apertar.
