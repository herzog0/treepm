import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { createPrismaClient } from "@treepm/db";
import type { PrismaClient } from "@treepm/db";
import type { AppConfig } from "../config.js";

/** Token INTERNO ao módulo de banco: o `DbModule` não o exporta. */
export const PRISMA = Symbol("PRISMA");

/** Cria o cliente com `DATABASE_URL` (papel `treepm_app`). */
export function buildPrisma(config: AppConfig): PrismaClient {
  return createPrismaClient(config.DATABASE_URL);
}

@Injectable()
export class PrismaShutdown implements OnApplicationShutdown {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
