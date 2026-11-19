import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AccessModule } from "../access/access.module.js";
import { CONFIG } from "../config.js";
import { TenantInterceptor } from "./tenant.interceptor.js";
import { PRISMA, PrismaShutdown, buildPrisma } from "./prisma.provider.js";

/**
 * Nada é exportado: o `PrismaClient` cru vive só aqui dentro. Controllers
 * recebem o cliente transacional pelo decorator `@Tx()` (ADR 0021).
 */
@Module({
  imports: [AccessModule],
  providers: [
    { provide: PRISMA, inject: [CONFIG], useFactory: buildPrisma },
    PrismaShutdown,
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
  ],
})
export class DbModule {}
