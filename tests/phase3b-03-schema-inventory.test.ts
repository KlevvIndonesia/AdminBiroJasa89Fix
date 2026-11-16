/**
 * Phase 3B Step D — Schema Inventory & Semantic Diff Comparison Tests
 * Verifies rich catalog capture (tables, columns, types, nullability, defaults,
 * primary keys, foreign keys, unique constraints, indexes, triggers, views, PRAGMAs)
 * and proves negative diff detection for all structural regressions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  captureSchemaInventory,
  compareSchemas,
  formatSchemaDiffReport,
} from "../server/src/database/schemaInventory";
import { createIsolatedTempDb } from "../server/src/database/testing/isolatedDbHarness";

function createReferenceSchema(ddlSetup: (sqlExec: (sql: string) => void) => void) {
  const handle = createIsolatedTempDb({ suitePrefix: "stepd-schema-inv" });
  try {
    ddlSetup((sql) => handle.db.exec(sql));
    return captureSchemaInventory(handle.db);
  } finally {
    handle.cleanup();
  }
}

const BASELINE_TEST_DDL = `
  CREATE TABLE config_sets (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'ACTIVE'
  );

  CREATE TABLE items (
    tenant_id TEXT NOT NULL,
    item_code TEXT NOT NULL,
    config_id TEXT NOT NULL REFERENCES config_sets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    PRIMARY KEY (tenant_id, item_code)
  );

  CREATE INDEX idx_items_config ON items(config_id);
  CREATE UNIQUE INDEX idx_items_note_active ON items(tenant_id, note) WHERE note IS NOT NULL;

  CREATE TRIGGER trg_config_immutable_code
  BEFORE UPDATE OF code ON config_sets
  BEGIN
    SELECT RAISE(ABORT, 'Immutable code');
  END;

  CREATE VIEW v_active_configs AS
  SELECT id, code FROM config_sets WHERE status = 'ACTIVE';
`;

describe("Phase 3B Step D — Schema Inventory & Comparator", () => {
  it("D.1 Captures full SQLite metadata including tables, composite PKs, FKs, unique constraints, partial indexes, triggers, views, and PRAGMAs", () => {
    const inv = createReferenceSchema((exec) => exec(BASELINE_TEST_DDL));

    assert.equal(inv.pragmas.foreignKeys, 1);
    assert.equal(inv.pragmas.journalMode, "wal");

    const cfg = inv.tables.find((t) => t.name === "config_sets");
    const items = inv.tables.find((t) => t.name === "items");
    assert.ok(cfg && items);

    assert.deepEqual(items.primaryKey.columns, ["tenant_id", "item_code"]);
    assert.equal(items.foreignKeys.length, 1);
    assert.equal(items.foreignKeys[0].table, "config_sets");
    assert.equal(items.foreignKeys[0].onDelete, "RESTRICT");
    assert.equal(items.foreignKeys[0].onUpdate, "CASCADE");

    const defaultCol = cfg.columns.find((c) => c.name === "status");
    assert.equal(defaultCol?.defaultValue, "'ACTIVE'");
    assert.equal(defaultCol?.notnull, true);

    assert.ok(cfg.uniqueConstraints.some((u) => u.columns.includes("code")));
    assert.ok(items.indexes.some((i) => i.name === "idx_items_config" && !i.unique));
    assert.ok(items.indexes.some((i) => i.name === "idx_items_note_active" && i.unique && i.partial));

    assert.equal(inv.triggers.length, 1);
    assert.equal(inv.triggers[0].name, "trg_config_immutable_code");
    assert.equal(inv.views.length, 1);
    assert.equal(inv.views[0].name, "v_active_configs");

    const selfDiff = compareSchemas(inv, inv);
    assert.equal(selfDiff.equal, true, formatSchemaDiffReport(selfDiff));
  });

  it("D.2 Captures real SUN89 application baseline schema on isolated temp DB cleanly", () => {
    const handle = createIsolatedTempDb({
      suitePrefix: "stepd-app-baseline",
      initializeAppSchema: true,
    });
    try {
      const appInv = captureSchemaInventory(handle.db);
      const tableMap = new Map(appInv.tables.map((t) => [t.name, t]));

      assert.ok(tableMap.has("orders"));
      assert.ok(tableMap.has("finance_invoices"));
      assert.ok(tableMap.has("invoice_payments"));
      assert.ok(tableMap.has("samsat_pricing"));
      assert.ok(tableMap.has("samsat_operational_tariffs"));

      const fi = tableMap.get("finance_invoices")!;
      assert.ok(fi.columns.length >= 20);
      assert.ok(fi.indexes.length > 0);
    } finally {
      handle.cleanup();
    }
  });

  it("D.3 Detects missing columns, unexpected columns, missing indexes, missing FKs, missing triggers, incorrect nullability, and incorrect PK definitions", () => {
    const expected = createReferenceSchema((exec) => exec(BASELINE_TEST_DDL));

    // 1. Missing column (`note` omitted) + Unexpected column (`rogue_col` added)
    const diffCols = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(
          BASELINE_TEST_DDL.replace("note TEXT,", "rogue_col TEXT,")
            .replace("CREATE UNIQUE INDEX idx_items_note_active ON items(tenant_id, note) WHERE note IS NOT NULL;", "")
        )
      )
    );
    assert.equal(diffCols.equal, false);
    assert.ok(diffCols.differences.some((d) => d.kind === "MISSING_COLUMN" && d.objectName === "note"));
    assert.ok(diffCols.differences.some((d) => d.kind === "UNEXPECTED_COLUMN" && d.objectName === "rogue_col"));
    assert.ok(diffCols.differences.some((d) => d.kind === "MISSING_INDEX" && d.objectName === "idx_items_note_active"));

    // 2. Missing index (`idx_items_config` omitted)
    const diffMissingIndex = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(BASELINE_TEST_DDL.replace("CREATE INDEX idx_items_config ON items(config_id);", ""))
      )
    );
    assert.ok(
      diffMissingIndex.differences.some((d) => d.kind === "MISSING_INDEX" && d.objectName === "idx_items_config")
    );

    // 3. Missing foreign key (`REFERENCES config_sets(id)...` omitted)
    const diffMissingFk = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(
          BASELINE_TEST_DDL.replace(
            "config_id TEXT NOT NULL REFERENCES config_sets(id) ON DELETE RESTRICT ON UPDATE CASCADE,",
            "config_id TEXT NOT NULL,"
          )
        )
      )
    );
    assert.ok(diffMissingFk.differences.some((d) => d.kind === "MISSING_FOREIGN_KEY" && d.tableName === "items"));

    // 4. Missing trigger (`trg_config_immutable_code` omitted)
    const diffMissingTrigger = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(
          BASELINE_TEST_DDL.replace(
            /CREATE TRIGGER trg_config_immutable_code[\s\S]*?END;/,
            ""
          )
        )
      )
    );
    assert.ok(
      diffMissingTrigger.differences.some(
        (d) => d.kind === "MISSING_TRIGGER" && d.objectName === "trg_config_immutable_code"
      )
    );

    // 5. Incorrect nullability (`amount REAL NOT NULL DEFAULT 0` -> `amount REAL DEFAULT 0`)
    const diffNullability = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(BASELINE_TEST_DDL.replace("amount REAL NOT NULL DEFAULT 0,", "amount REAL DEFAULT 0,"))
      )
    );
    assert.ok(
      diffNullability.differences.some(
        (d) => d.kind === "COLUMN_NULLABILITY_MISMATCH" && d.tableName === "items" && d.objectName === "amount"
      )
    );

    // 6. Incorrect primary key definition (`PRIMARY KEY (tenant_id, item_code)` -> `PRIMARY KEY (item_code)`)
    const diffPk = compareSchemas(
      expected,
      createReferenceSchema((exec) =>
        exec(BASELINE_TEST_DDL.replace("PRIMARY KEY (tenant_id, item_code)", "PRIMARY KEY (item_code)"))
      )
    );
    assert.ok(
      diffPk.differences.some(
        (d) => d.kind === "PRIMARY_KEY_DEFINITION_MISMATCH" && d.tableName === "items"
      )
    );
    assert.ok(
      diffPk.differences.some(
        (d) => d.kind === "COLUMN_PK_MISMATCH" && d.tableName === "items"
      )
    );
  });

  it("D.4 Supports additive migration preservation mode while catching baseline regressions", () => {
    const baseline = createReferenceSchema((exec) => exec(BASELINE_TEST_DDL));
    const additiveActual = createReferenceSchema((exec) => {
      exec(BASELINE_TEST_DDL);
      exec("CREATE TABLE m1_pricing_revisions (id TEXT PRIMARY KEY, version INTEGER NOT NULL);");
    });

    const strictDiff = compareSchemas(baseline, additiveActual);
    assert.equal(strictDiff.equal, false);
    assert.ok(
      strictDiff.differences.some(
        (d) => d.kind === "UNEXPECTED_TABLE" && d.objectName === "m1_pricing_revisions"
      )
    );

    const allowedAdditiveDiff = compareSchemas(baseline, additiveActual, {
      allowUnexpectedTables: ["m1_pricing_revisions"],
    });
    assert.equal(allowedAdditiveDiff.equal, true, formatSchemaDiffReport(allowedAdditiveDiff));
  });
});
