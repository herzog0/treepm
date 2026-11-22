import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AccessModule } from "../access/access.module.js";
import { CONFIG } from "../config.js";
import { TenantTransactions } from "./tenant-transactions.js";
import { TenantInterceptor } from "./tenant.interceptor.js";
import { PRISMA, PrismaShutdown, buildPrisma } from "./prisma.provider.js";

/**
 * O `PrismaClient` cru vive só aqui dentro e não é exportado. Controllers recebem o cliente transacional pelo
 * decorator `@Tx()` (ADR 0021); só o `TenantTransactions` sai, para as entradas sem sessão (ADR 0038).
 */
@Module({
  imports: [AccessModule],
  providers: [
    { provide: PRISMA, inject: [CONFIG], useFactory: buildPrisma },
    PrismaShutdown,
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    TenantTransactions,
  ],
  exports: [TenantTransactions],
})
export class DbModule {}
