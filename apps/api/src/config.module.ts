import { Global, Module } from "@nestjs/common";
import { CONFIG, loadConfig } from "./config.js";

/** Configuração validada no boot; falha explícita se faltar variável obrigatória. */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig(process.env) }],
  exports: [CONFIG],
})
export class ConfigModule {}
