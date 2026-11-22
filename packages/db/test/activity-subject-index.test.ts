import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownerPool } from "./helpers.js";

let owner: pg.Pool;
beforeAll(() => {
  owner = ownerPool();
});
afterAll(async () => {
  await owner.end();
});

describe("migration 0014: índice por assunto em activity_events", () => {
  it("indexes (org_id, subject_type, subject_id, occurred_at), in this order", async () => {
    const r = await owner.query<{ cols: string[] }>(
      `select array(
         select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         order by k.ord) as cols
       from pg_index i join pg_class c on c.oid = i.indrelid
       where c.relname = 'activity_events' and not i.indisprimary`,
    );
    expect(r.rows.map((row) => row.cols)).toContainEqual(["org_id", "subject_type", "subject_id", "occurred_at"]);
  });
});
