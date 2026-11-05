# TreePM — visão do projeto

## Ideia central

Projetos são árvores de trabalho e relações. A proposta do TreePM continua sendo permitir que uma pessoa navegue por essas estruturas com contexto, em uma experiência espacial inspirada no Prezi.

A hierarquia aparece pela posição, pela escala de cada geração e pela representação dos filhos diretos. Aproximar transforma os indicadores em nós legíveis; afastar reagrupa a estrutura pelo mesmo caminho. O mapa precisa responder imediatamente ao pan e permitir combinar arraste com zoom.

## Ponto de partida atual

O projeto recomeça por uma engine genérica e uma demonstração com dados fictícios. O foco agora é preservar e evoluir o layout, o fundo, os níveis de detalhe, as transições e os gestos, sem carregar decisões de implementação de produto.

A engine é independente de aplicação: recebe uma hierarquia identificada e atributos visuais, calcula a cena e permite navegá-la. Ela não define tarefas, pessoas, status de trabalho, persistência ou integrações.

## Direção futura

O produto será reconstruído a partir dessa base. O [business blueprint](product-blueprint.md) propõe trabalho hierárquico com múltiplas pessoas por ticket, contribuições e conversas por área, busca semântica que leva ao contexto, filtros e stand-up navegável. Clerk será o provedor de identidade; tenants, times, permissões e integrações pertencem ao produto, preservando a independência da engine.

O blueprint é um plano, não uma implementação da plataforma. A demo continua local e genérica. A pesquisa de [Clerk e Jev](research/platform-services.md) distingue capacidades confirmadas dos fornecedores e propostas de uso futuro.

O registro de ideias em [ideas.yaml](ideas.yaml) preserva as intenções discutidas para essa reconstrução. Uma ideia proposta não significa uma funcionalidade já implementada.
