# Perguntas realmente em aberto

As decisões já tomadas para a primeira fatia estão registradas em `vision.md` e `architecture.md`. Restam perguntas de produto e escala que não devem ser presumidas pelo código atual.

1. **Estado bloqueado.** “Bloqueado” deve ser um novo status de folha, uma flag independente ou uma dependência com regra de impedimento? Como ele afeta o agregado e o que pode ser pego agora?
2. **Permissões e identidade.** Quais papéis existirão por organização, projeto e backoffice? Como convites, autenticação e auditoria serão modelados?
3. **Escala do canvas.** A partir de quantos tickets são necessários layout incremental, workers, agregação adaptativa ao viewport e paginação? A cena atual recalcula o contexto em foco e interpola focos no gesto; os limites semânticos são heurísticos de produto, não uma resposta final de performance para árvores enormes.
4. **Semântica de dependência.** Dependências impedem iniciar/concluir folhas ou apenas comunicam relação? São permitidas entre projetos no futuro?
5. **Peso do trabalho.** O progresso igual por folha é intencional nesta fatia. No futuro, estimativas ou esforço devem ponderar o agregado? Como evitar que quebrar uma tarefa em mais folhas distorça a percepção?
6. **Qualidade do Jev.** Qual limiar de confiança por caso de uso e quais métricas de aceite/correção devem calibrar o atual 0,65? Categorias fixas serão suficientes ou projetos terão taxonomias próprias?
7. **Persistência de produção.** Qual banco e estratégia de transação/versionamento otimista atenderão colaboração, múltiplas instâncias e histórico de arestas/tickets?
8. **Exclusão e histórico.** A exclusão recursiva atual é destrutiva e local. Produto real exigirá soft delete, lixeira ou trilha de auditoria e política de retenção?
