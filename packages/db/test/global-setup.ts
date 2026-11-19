import { setupTestDatabase } from "./setup-database.js";

export default async function setup(): Promise<void> {
  await setupTestDatabase();
}
