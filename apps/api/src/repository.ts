import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Database } from "@treepm/domain";
import { createSeed } from "./seed.js";

export interface TreeRepository {
  snapshot(): Promise<Database>;
  mutate<T>(operation: (database: Database) => T | Promise<T>): Promise<T>;
}

export class JsonTreeRepository implements TreeRepository {
  private database: Database | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<Database> {
    const database = await this.load();
    return structuredClone(database);
  }

  async mutate<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const database = await this.load();
      const draft = structuredClone(database);
      const result = await operation(draft);
      await this.persist(draft);
      this.database = draft;
      return result;
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<Database> {
    if (this.database) return this.database;
    try {
      this.database = JSON.parse(await readFile(this.filePath, "utf8")) as Database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.database = createSeed();
      await this.persist(this.database);
    }
    return this.database;
  }

  private async persist(database: Database): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

export function createRepository(): TreeRepository {
  return new JsonTreeRepository(resolve(process.env.TREEPM_DATA_FILE ?? "./data/treepm.json"));
}
