import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_STATES } from "./stateMachine";

const sql = readFileSync(join(__dirname, "..", "..", "db", "migrations", "001_init.sql"), "utf8");

describe("001_init.sql", () => {
  it("lists exactly the states of the state machine", () => {
    const block = sql.match(/state\s+text NOT NULL DEFAULT 'draft' CHECK \(state IN \(([\s\S]*?)\)\),/);
    expect(block).not.toBeNull();
    const inSql = [...block![1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...ALL_STATES].sort());
  });

  it("allows at most one live capture per milestone part", () => {
    expect(sql).toMatch(/UNIQUE INDEX captures_one_live_per_part[\s\S]*status IN \('requested', 'confirmed'\)/);
  });

  it("makes the event log append-only", () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON events/);
  });
});
