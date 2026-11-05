# ADR 0018 — Separar geometria animada e semântica do renderer

**Status:** Aceita. **Data:** 2026-11-05.

## Contexto

O zoom na região Coral da demo reproduziu frames lentos mesmo com os corpos limitados à viewport e à margem de culling. A trajetória montou até 231 nós e 174 grupos em instantes diferentes. O perfil apontou criação/reconciliação de elementos React, escrita de estilos, layout e pintura; o cálculo isolado da cena ficou próximo de 0,03 ms por chamada no replay Node.

## Decisão

Separar propriedades geométricas animadas de propriedades semânticas dos elementos existentes. Geometria inclui posição, dimensões, escala, opacidade e progresso de morph. Conteúdo, identidade, seleção, classes, aparência, ARIA e callbacks continuam declarativos no React. O núcleo headless continua produzindo somente dados; não passa a conhecer DOM ou React.

A aplicação de geometria ocorre no commit, antes da pintura, com refs tipadas e comparação com o último snapshot commitado. Não ler layout, executar queries globais ou criar um segundo loop de animação. O markup inicial conserva uma seed de geometria para SSR/hidratação. Registros e caches pertencem a cada instância e precisam ser invalidados quando o host muda ou sai da cena. Render abortado não modifica DOM nem estado commitado.

Os quadrados agrupados usam uma única superfície nominal escalada, conservando o mesmo elemento semântico, seus membros e labels. A câmera mantém uma camada de translação; seus filhos usam translação 2D. Regiões de fundo também são filtradas pelo próprio retângulo, além da condição existente do corpo que as origina. Um pai fora da viewport continua podendo produzir descendentes visíveis.

## Consequências e limites

Uma atualização apenas geométrica pode reaproveitar conteúdo e estrutura. Mudanças semânticas precisam atualizar imediatamente; nenhuma otimização pode ignorar callbacks, renderers, classes ou payloads novos. Culling não vira um cache de todos os corpos do mapa, e agrupamento não perde IDs nem informações acessíveis.

Os custos de estilo, layout e pintura permanecem e exigem medição no navegador. Reduzir JSX ou visitas da engine não prova, por si só, uma redução de p95. Snapshots geométricos, pixels em escalas fixas e gestos precisam acompanhar os benchmarks. O cenário mais denso não recebe promessa de 60 fps em qualquer dispositivo ou modo de desenvolvimento.
