import { setupTestDatabase } from "@treepm/db/testing";

export default async function setup(): Promise<void> {
  await setupTestDatabase();
}
