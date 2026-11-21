import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { CONFIG, githubEnabled } from "../config.js";
import type { AppConfig } from "../config.js";
import { CodeController } from "./code.controller.js";
import { CodeService } from "./code.service.js";
import { GithubEnabledGuard } from "./github-enabled.guard.js";
import { GithubController } from "./github.controller.js";
import { GithubService } from "./github.service.js";
import { OctokitRepositoryProvider } from "./octokit-repository-provider.js";
import { REPOSITORY_PROVIDER } from "./ports.js";
import { ProjectRepositoriesController } from "./project-repositories.controller.js";

@Module({
  imports: [AccessModule],
  controllers: [GithubController, ProjectRepositoriesController, CodeController],
  providers: [
    ActivityService,
    GithubService,
    CodeService,
    GithubEnabledGuard,
    {
      provide: REPOSITORY_PROVIDER,
      inject: [CONFIG],
      // Sem as cinco variáveis do app a ligação fica desligada e não existe provedor (a API sobe normalmente).
      useFactory: (config: AppConfig) =>
        githubEnabled(config) && config.GITHUB_APP_ID && config.GITHUB_APP_SLUG && config.GITHUB_APP_CLIENT_ID && config.GITHUB_APP_CLIENT_SECRET && config.GITHUB_APP_PRIVATE_KEY
          ? new OctokitRepositoryProvider({
              appId: config.GITHUB_APP_ID,
              slug: config.GITHUB_APP_SLUG,
              clientId: config.GITHUB_APP_CLIENT_ID,
              clientSecret: config.GITHUB_APP_CLIENT_SECRET,
              privateKey: config.GITHUB_APP_PRIVATE_KEY,
            })
          : null,
    },
  ],
})
export class GithubModule {}
