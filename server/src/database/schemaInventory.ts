/**
 * Phase 3B Step 1 — Schema Inventory & Semantic Diff Comparator
 * Admin SUN89 — Biro Jasa Management System
 *
 * Inspects live SQLite schema state via system catalogs and PRAGMAs without mutating
 * data, and produces deterministic structural comparisons between expected and actual schemas.
 */

import { DatabaseSync } from "node:sqlite";

export interface ColumnInventory {
  cid: number;
  name: string;
  type: string;
  normalizedType: string;
  notnull: boolean;
  defaultValue: string | null;
  pk: number;
  hidden: number;
}

export interface PrimaryKeyInventory {
  columns: string[];
}

export interface ForeignKeyMapping {
  seq: number;
  from: string;
  to: string;
}

export interface ForeignKeyInventory {
  id: number;
  table: string;
  onUpdate: string;
  onDelete: string;
  match: string;
  mappings: ForeignKeyMapping[];
  signature: string;
}

export interface IndexColumnInventory {
  seqno: number;
  cid: number;
  name: string | null;
  desc: boolean;
  coll: string;
  key: boolean;
}

export interface IndexInventory {
  name: string;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: IndexColumnInventory[];
  sql: string | null;
  signature: string;
}

export interface UniqueConstraintInventory {
  origin: string;
  indexName: string;
  columns: string[];
  partial: boolean;
  sql: string | null;
  signature: string;
}

export interface TableInventory {
  name: string;
  sql: string | null;
  columns: ColumnInventory[];
  primaryKey: PrimaryKeyInventory;
  foreignKeys: ForeignKeyInventory[];
  indexes: IndexInventory[];
  uniqueConstraints: UniqueConstraintInventory[];
}

export interface TriggerInventory {
  name: string;
  tableName: string;
  sql: string;
}

export interface ViewInventory {
  name: string;
  sql: string;
}

export interface SqliteConfigInventory {
  sqliteVersion: string;
  foreignKeys: number;
  journalMode: string;
  busyTimeout: number | null;
  recursiveTriggers: number | null;
  userVersion: number;
  encoding: string;
}

export interface SchemaInventory {
  capturedAt: string;
  pragmas: SqliteConfigInventory;
  tables: TableInventory[];
  triggers: TriggerInventory[];
  views: ViewInventory[];
}

export type SchemaDiffKind =
  | "MISSING_TABLE"
  | "UNEXPECTED_TABLE"
  | "MISSING_COLUMN"
  | "UNEXPECTED_COLUMN"
  | "COLUMN_TYPE_MISMATCH"
  | "COLUMN_NULLABILITY_MISMATCH"
  | "COLUMN_DEFAULT_MISMATCH"
  | "COLUMN_PK_MISMATCH"
  | "PRIMARY_KEY_DEFINITION_MISMATCH"
  | "MISSING_FOREIGN_KEY"
  | "UNEXPECTED_FOREIGN_KEY"
  | "MISSING_INDEX"
  | "UNEXPECTED_INDEX"
  | "INDEX_MISMATCH"
  | "MISSING_UNIQUE_CONSTRAINT"
  | "UNEXPECTED_UNIQUE_CONSTRAINT"
  | "MISSING_TRIGGER"
  | "UNEXPECTED_TRIGGER"
  | "TRIGGER_MISMATCH"
  | "MISSING_VIEW"
  | "UNEXPECTED_VIEW"
  | "VIEW_MISMATCH"
  | "PRAGMA_MISMATCH";

export interface SchemaDifference {
  kind: SchemaDiffKind;
  objectType: "table" | "column" | "primary_key" | "foreign_key" | "index" | "unique_constraint" | "trigger" | "view" | "pragma";
  tableName?: string;
  objectName: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface SchemaDiffReport {
  equal: boolean;
  summary: string;
  differences: SchemaDifference[];
}

export interface CompareSchemaOptions {
  /** Skip listed table names in comparison (e.g. `schema_migrations`). */
  ignoreTables?: string[];
  /** When true, unexpected extra tables are not reported as failures (useful for additive migration preservation checks). */
  allowUnexpectedTables?: boolean | string[];
  /** When true or table map provided, unexpected extra columns are allowed. */
  allowUnexpectedColumns?: boolean | Record<string, string[]>;
  /** When true, compares SQLite PRAGMA configuration (`foreignKeys`, `journalMode`, `recursiveTriggers`, `userVersion`). */
  comparePragmas?: boolean;
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function normalizeSql(sql: string | null | undefined): string {
  if (!sql) return "";
  return sql.replace(/\s+/g, " ").trim();
}

function extractWhereClause(sql: string | null): string {
  if (!sql) return "";
  const match = sql.match(/\bWHERE\b([\s\S]+)$/i);
  return match ? normalizeSql(match[1]) : "";
}

function buildForeignKeySignature(
  table: string,
  onUpdate: string,
  onDelete: string,
  match: string,
  mappings: ForeignKeyMapping[]
): string {
  const fromCols = mappings.map((m) => m.from).join(", ");
  const toCols = mappings.map((m) => m.to || "<PK>").join(", ");
  return `(${fromCols}) -> ${table}(${toCols}) [ON DELETE ${onDelete}, ON UPDATE ${onUpdate}, MATCH ${match}]`;
}

function buildIndexSignature(
  unique: boolean,
  partial: boolean,
  columns: IndexColumnInventory[],
  sql: string | null
): string {
  const colSpec = columns
    .map((c) => `${c.name ?? `<expr:${c.cid}>`}${c.desc ? " DESC" : " ASC"}${c.coll ? ` COLLATE ${c.coll}` : ""}`)
    .join(", ");
  const whereClause = partial ? ` WHERE ${extractWhereClause(sql)}` : "";
  const rawExpr = sql && columns.some((c) => c.cid === -2) ? ` | SQL=${normalizeSql(sql)}` : "";
  return `${unique ? "UNIQUE " : ""}(${colSpec})${whereClause}${rawExpr}`;
}

function readPragmaNumber(targetDb: DatabaseSync, pragmaName: string): number | null {
  try {
    const row = targetDb.prepare(`PRAGMA ${pragmaName}`).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const firstKey = Object.keys(row)[0];
    if (!firstKey) return null;
    const val = Number(row[firstKey]);
    return Number.isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

function readPragmaString(targetDb: DatabaseSync, pragmaName: string): string {
  try {
    const row = targetDb.prepare(`PRAGMA ${pragmaName}`).get() as Record<string, unknown> | undefined;
    if (!row) return "";
    const firstKey = Object.keys(row)[0];
    return firstKey ? String(row[firstKey] ?? "") : "";
  } catch {
    return "";
  }
}

/**
 * Captures a complete, deterministic SQLite schema inventory from `targetDb`.
 */
export function captureSchemaInventory(targetDb: DatabaseSync): SchemaInventory {
  const versionRow = targetDb.prepare("SELECT sqlite_version() AS v").get() as { v: string } | undefined;

  const pragmas: SqliteConfigInventory = {
    sqliteVersion: String(versionRow?.v ?? ""),
    foreignKeys: readPragmaNumber(targetDb, "foreign_keys") ?? 0,
    journalMode: readPragmaString(targetDb, "journal_mode").toLowerCase(),
    busyTimeout: readPragmaNumber(targetDb, "busy_timeout"),
    recursiveTriggers: readPragmaNumber(targetDb, "recursive_triggers"),
    userVersion: readPragmaNumber(targetDb, "user_version") ?? 0,
    encoding: readPragmaString(targetDb, "encoding"),
  };

  const masterRows = targetDb
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type ASC, name ASC`
    )
    .all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;

  const indexSqlByName = new Map<string, string | null>();
  for (const row of masterRows) {
    if (row.type === "index") {
      indexSqlByName.set(row.name, row.sql);
    }
  }

  const tables: TableInventory[] = [];

  for (const row of masterRows) {
    if (row.type !== "table") continue;
    const tableName = row.name;
    const quotedTable = quoteIdent(tableName);

    const rawCols = targetDb.prepare(`PRAGMA table_xinfo(${quotedTable})`).all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>;

    const columns: ColumnInventory[] = rawCols.map((c) => ({
      cid: Number(c.cid),
      name: String(c.name),
      type: String(c.type ?? ""),
      normalizedType: String(c.type ?? "").trim().toUpperCase(),
      notnull: Number(c.notnull) === 1,
      defaultValue: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
      pk: Number(c.pk),
      hidden: Number(c.hidden ?? 0),
    }));

    const primaryKeyColumns = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);

    const rawFks = targetDb.prepare(`PRAGMA foreign_key_list(${quotedTable})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
      match: string;
    }>;

    const fkGroups = new Map<
      number,
      {
        id: number;
        table: string;
        onUpdate: string;
        onDelete: string;
        match: string;
        mappings: ForeignKeyMapping[];
      }
    >();

    for (const fk of rawFks) {
      const id = Number(fk.id);
      let group = fkGroups.get(id);
      if (!group) {
        group = {
          id,
          table: String(fk.table),
          onUpdate: String(fk.on_update ?? "NO ACTION").toUpperCase(),
          onDelete: String(fk.on_delete ?? "NO ACTION").toUpperCase(),
          match: String(fk.match ?? "NONE").toUpperCase(),
          mappings: [],
        };
        fkGroups.set(id, group);
      }
      group.mappings.push({
        seq: Number(fk.seq),
        from: String(fk.from),
        to: String(fk.to ?? ""),
      });
    }

    const foreignKeys: ForeignKeyInventory[] = Array.from(fkGroups.values())
      .map((group) => {
        const sortedMappings = [...group.mappings].sort((a, b) => a.seq - b.seq);
        return {
          id: group.id,
          table: group.table,
          onUpdate: group.onUpdate,
          onDelete: group.onDelete,
          match: group.match,
          mappings: sortedMappings,
          signature: buildForeignKeySignature(
            group.table,
            group.onUpdate,
            group.onDelete,
            group.match,
            sortedMappings
          ),
        };
      })
      .sort((a, b) => a.signature.localeCompare(b.signature));

    const rawIndexList = targetDb.prepare(`PRAGMA index_list(${quotedTable})`).all() as Array<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;

    const indexes: IndexInventory[] = [];
    const uniqueConstraints: UniqueConstraintInventory[] = [];

    for (const idx of rawIndexList) {
      const idxName = String(idx.name);
      const rawIdxCols = targetDb.prepare(`PRAGMA index_xinfo(${quoteIdent(idxName)})`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>;

      const keyColumns = rawIdxCols
        .filter((c) => Number(c.key) === 1)
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => ({
          seqno: Number(c.seqno),
          cid: Number(c.cid),
          name: c.name === null || c.name === undefined ? null : String(c.name),
          desc: Number(c.desc) === 1,
          coll: String(c.coll ?? "BINARY"),
          key: true,
        }));

      const idxSql = indexSqlByName.get(idxName) ?? null;
      const isUnique = Number(idx.unique) === 1;
      const isPartial = Number(idx.partial) === 1;
      const origin = String(idx.origin ?? "c");
      const signature = buildIndexSignature(isUnique, isPartial, keyColumns, idxSql);

      // Capture named/explicit indexes (skip sqlite_autoindex for named-index list, track them in uniqueConstraints)
      if (!idxName.startsWith("sqlite_autoindex_")) {
        indexes.push({
          name: idxName,
          unique: isUnique,
          origin,
          partial: isPartial,
          columns: keyColumns,
          sql: idxSql,
          signature,
        });
      }

      if (isUnique && origin !== "pk") {
        uniqueConstraints.push({
          origin,
          indexName: idxName,
          columns: keyColumns.map((c) => c.name ?? `<expr:${c.cid}>`),
          partial: isPartial,
          sql: idxSql,
          signature,
        });
      }
    }

    indexes.sort((a, b) => a.name.localeCompare(b.name));
    uniqueConstraints.sort((a, b) => a.signature.localeCompare(b.signature));

    tables.push({
      name: tableName,
      sql: row.sql,
      columns,
      primaryKey: { columns: primaryKeyColumns },
      foreignKeys,
      indexes,
      uniqueConstraints,
    });
  }

  const triggers: TriggerInventory[] = masterRows
    .filter((r) => r.type === "trigger")
    .map((r) => ({
      name: r.name,
      tableName: r.tbl_name,
      sql: String(r.sql ?? ""),
    }));

  const views: ViewInventory[] = masterRows
    .filter((r) => r.type === "view")
    .map((r) => ({
      name: r.name,
      sql: String(r.sql ?? ""),
    }));

  return {
    capturedAt: new Date().toISOString(),
    pragmas,
    tables,
    triggers,
    views,
  };
}

function isExtraTableAllowed(tableName: string, opt: CompareSchemaOptions["allowUnexpectedTables"]): boolean {
  if (opt === true) return true;
  if (Array.isArray(opt)) return opt.includes(tableName);
  return false;
}

function isExtraColumnAllowed(
  tableName: string,
  colName: string,
  opt: CompareSchemaOptions["allowUnexpectedColumns"]
): boolean {
  if (opt === true) return true;
  if (opt && typeof opt === "object") {
    return Array.isArray(opt[tableName]) && opt[tableName].includes(colName);
  }
  return false;
}

/**
 * Performs a semantic structural comparison between `expected` and `actual` schema inventories.
 * Detects missing/unexpected objects as well as column types, nullability, defaults, PKs, FKs,
 * unique constraints, indexes, triggers, views, and optionally PRAGMAs.
 */
export function compareSchemas(
  expected: SchemaInventory,
  actual: SchemaInventory,
  options: CompareSchemaOptions = {}
): SchemaDiffReport {
  const differences: SchemaDifference[] = [];
  const ignoredTables = new Set(options.ignoreTables ?? []);

  if (options.comparePragmas) {
    const pragmaKeys: Array<keyof SqliteConfigInventory> = [
      "foreignKeys",
      "journalMode",
      "recursiveTriggers",
      "userVersion",
    ];
    for (const key of pragmaKeys) {
      if (expected.pragmas[key] !== actual.pragmas[key]) {
        differences.push({
          kind: "PRAGMA_MISMATCH",
          objectType: "pragma",
          objectName: String(key),
          expected: expected.pragmas[key],
          actual: actual.pragmas[key],
          message: `PRAGMA '${String(key)}' mismatch: expected '${expected.pragmas[key]}', got '${actual.pragmas[key]}'.`,
        });
      }
    }
  }

  const expectedTables = new Map(
    expected.tables.filter((t) => !ignoredTables.has(t.name)).map((t) => [t.name, t])
  );
  const actualTables = new Map(
    actual.tables.filter((t) => !ignoredTables.has(t.name)).map((t) => [t.name, t])
  );

  for (const [tableName, expTable] of expectedTables) {
    const actTable = actualTables.get(tableName);
    if (!actTable) {
      differences.push({
        kind: "MISSING_TABLE",
        objectType: "table",
        tableName,
        objectName: tableName,
        expected: tableName,
        actual: null,
        message: `Missing expected table '${tableName}'.`,
      });
      continue;
    }

    // 1. Primary Key Definition Check
    const expPk = expTable.primaryKey.columns;
    const actPk = actTable.primaryKey.columns;
    if (JSON.stringify(expPk) !== JSON.stringify(actPk)) {
      differences.push({
        kind: "PRIMARY_KEY_DEFINITION_MISMATCH",
        objectType: "primary_key",
        tableName,
        objectName: `${tableName}.PRIMARY_KEY`,
        expected: expPk,
        actual: actPk,
        message: `Primary key mismatch on table '${tableName}': expected [${expPk.join(", ")}], got [${actPk.join(", ")}].`,
      });
    }

    // 2. Column-by-column Checks
    const expCols = new Map(expTable.columns.map((c) => [c.name, c]));
    const actCols = new Map(actTable.columns.map((c) => [c.name, c]));

    for (const [colName, expCol] of expCols) {
      const actCol = actCols.get(colName);
      if (!actCol) {
        differences.push({
          kind: "MISSING_COLUMN",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: expCol,
          actual: null,
          message: `Missing column '${tableName}.${colName}'.`,
        });
        continue;
      }

      if (expCol.normalizedType !== actCol.normalizedType) {
        differences.push({
          kind: "COLUMN_TYPE_MISMATCH",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: expCol.type,
          actual: actCol.type,
          message: `Column type mismatch on '${tableName}.${colName}': expected '${expCol.type}', got '${actCol.type}'.`,
        });
      }

      if (expCol.notnull !== actCol.notnull) {
        differences.push({
          kind: "COLUMN_NULLABILITY_MISMATCH",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: expCol.notnull,
          actual: actCol.notnull,
          message: `Nullability mismatch on '${tableName}.${colName}': expected NOT NULL=${expCol.notnull}, got NOT NULL=${actCol.notnull}.`,
        });
      }

      if ((expCol.defaultValue ?? null) !== (actCol.defaultValue ?? null)) {
        differences.push({
          kind: "COLUMN_DEFAULT_MISMATCH",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: expCol.defaultValue,
          actual: actCol.defaultValue,
          message: `Default value mismatch on '${tableName}.${colName}': expected ${JSON.stringify(expCol.defaultValue)}, got ${JSON.stringify(actCol.defaultValue)}.`,
        });
      }

      if (expCol.pk !== actCol.pk) {
        differences.push({
          kind: "COLUMN_PK_MISMATCH",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: expCol.pk,
          actual: actCol.pk,
          message: `Column PK ordinal mismatch on '${tableName}.${colName}': expected pk=${expCol.pk}, got pk=${actCol.pk}.`,
        });
      }
    }

    for (const [colName, actCol] of actCols) {
      if (!expCols.has(colName) && !isExtraColumnAllowed(tableName, colName, options.allowUnexpectedColumns)) {
        differences.push({
          kind: "UNEXPECTED_COLUMN",
          objectType: "column",
          tableName,
          objectName: colName,
          expected: null,
          actual: actCol,
          message: `Unexpected column '${tableName}.${colName}' found.`,
        });
      }
    }

    // 3. Foreign Key Checks (by canonical signature multiset)
    const expFkSigs = new Set(expTable.foreignKeys.map((fk) => fk.signature));
    const actFkSigs = new Set(actTable.foreignKeys.map((fk) => fk.signature));

    for (const fk of expTable.foreignKeys) {
      if (!actFkSigs.has(fk.signature)) {
        differences.push({
          kind: "MISSING_FOREIGN_KEY",
          objectType: "foreign_key",
          tableName,
          objectName: fk.signature,
          expected: fk,
          actual: null,
          message: `Missing foreign key on '${tableName}': ${fk.signature}.`,
        });
      }
    }

    for (const fk of actTable.foreignKeys) {
      if (!expFkSigs.has(fk.signature)) {
        differences.push({
          kind: "UNEXPECTED_FOREIGN_KEY",
          objectType: "foreign_key",
          tableName,
          objectName: fk.signature,
          expected: null,
          actual: fk,
          message: `Unexpected foreign key on '${tableName}': ${fk.signature}.`,
        });
      }
    }

    // 4. Named Index Checks
    const expIndexes = new Map(expTable.indexes.map((i) => [i.name, i]));
    const actIndexes = new Map(actTable.indexes.map((i) => [i.name, i]));

    for (const [idxName, expIdx] of expIndexes) {
      const actIdx = actIndexes.get(idxName);
      if (!actIdx) {
        differences.push({
          kind: "MISSING_INDEX",
          objectType: "index",
          tableName,
          objectName: idxName,
          expected: expIdx,
          actual: null,
          message: `Missing index '${idxName}' on '${tableName}' (${expIdx.signature}).`,
        });
        continue;
      }
      if (expIdx.signature !== actIdx.signature) {
        differences.push({
          kind: "INDEX_MISMATCH",
          objectType: "index",
          tableName,
          objectName: idxName,
          expected: expIdx.signature,
          actual: actIdx.signature,
          message: `Index '${idxName}' on '${tableName}' mismatch: expected '${expIdx.signature}', got '${actIdx.signature}'.`,
        });
      }
    }

    for (const [idxName, actIdx] of actIndexes) {
      if (!expIndexes.has(idxName)) {
        differences.push({
          kind: "UNEXPECTED_INDEX",
          objectType: "index",
          tableName,
          objectName: idxName,
          expected: null,
          actual: actIdx,
          message: `Unexpected index '${idxName}' on '${tableName}' (${actIdx.signature}).`,
        });
      }
    }

    // 5. Unique Constraint Checks (catches inline UNIQUE changes whose autoindex names are positional)
    const expUniqueSigs = new Set(expTable.uniqueConstraints.map((u) => u.signature));
    const actUniqueSigs = new Set(actTable.uniqueConstraints.map((u) => u.signature));

    for (const uc of expTable.uniqueConstraints) {
      if (!actUniqueSigs.has(uc.signature)) {
        differences.push({
          kind: "MISSING_UNIQUE_CONSTRAINT",
          objectType: "unique_constraint",
          tableName,
          objectName: uc.signature,
          expected: uc,
          actual: null,
          message: `Missing UNIQUE constraint on '${tableName}': ${uc.signature}.`,
        });
      }
    }

    for (const uc of actTable.uniqueConstraints) {
      if (!expUniqueSigs.has(uc.signature)) {
        differences.push({
          kind: "UNEXPECTED_UNIQUE_CONSTRAINT",
          objectType: "unique_constraint",
          tableName,
          objectName: uc.signature,
          expected: null,
          actual: uc,
          message: `Unexpected UNIQUE constraint on '${tableName}': ${uc.signature}.`,
        });
      }
    }
  }

  for (const [tableName, actTable] of actualTables) {
    if (!expectedTables.has(tableName) && !isExtraTableAllowed(tableName, options.allowUnexpectedTables)) {
      differences.push({
        kind: "UNEXPECTED_TABLE",
        objectType: "table",
        tableName,
        objectName: tableName,
        expected: null,
        actual: actTable.name,
        message: `Unexpected table '${tableName}' found.`,
      });
    }
  }

  // 6. Trigger Checks
  const expTriggers = new Map(expected.triggers.map((t) => [t.name, t]));
  const actTriggers = new Map(actual.triggers.map((t) => [t.name, t]));

  for (const [trigName, expTrig] of expTriggers) {
    const actTrig = actTriggers.get(trigName);
    if (!actTrig) {
      differences.push({
        kind: "MISSING_TRIGGER",
        objectType: "trigger",
        tableName: expTrig.tableName,
        objectName: trigName,
        expected: expTrig,
        actual: null,
        message: `Missing trigger '${trigName}' on table '${expTrig.tableName}'.`,
      });
    } else if (normalizeSql(expTrig.sql) !== normalizeSql(actTrig.sql)) {
      differences.push({
        kind: "TRIGGER_MISMATCH",
        objectType: "trigger",
        tableName: expTrig.tableName,
        objectName: trigName,
        expected: normalizeSql(expTrig.sql),
        actual: normalizeSql(actTrig.sql),
        message: `Trigger SQL mismatch for '${trigName}'.`,
      });
    }
  }

  for (const [trigName, actTrig] of actTriggers) {
    if (!expTriggers.has(trigName)) {
      differences.push({
        kind: "UNEXPECTED_TRIGGER",
        objectType: "trigger",
        tableName: actTrig.tableName,
        objectName: trigName,
        expected: null,
        actual: actTrig,
        message: `Unexpected trigger '${trigName}' on table '${actTrig.tableName}'.`,
      });
    }
  }

  // 7. View Checks
  const expViews = new Map(expected.views.map((v) => [v.name, v]));
  const actViews = new Map(actual.views.map((v) => [v.name, v]));

  for (const [viewName, expView] of expViews) {
    const actView = actViews.get(viewName);
    if (!actView) {
      differences.push({
        kind: "MISSING_VIEW",
        objectType: "view",
        objectName: viewName,
        expected: expView,
        actual: null,
        message: `Missing view '${viewName}'.`,
      });
    } else if (normalizeSql(expView.sql) !== normalizeSql(actView.sql)) {
      differences.push({
        kind: "VIEW_MISMATCH",
        objectType: "view",
        objectName: viewName,
        expected: normalizeSql(expView.sql),
        actual: normalizeSql(actView.sql),
        message: `View SQL mismatch for '${viewName}'.`,
      });
    }
  }

  for (const [viewName, actView] of actViews) {
    if (!expViews.has(viewName)) {
      differences.push({
        kind: "UNEXPECTED_VIEW",
        objectType: "view",
        objectName: viewName,
        expected: null,
        actual: actView,
        message: `Unexpected view '${viewName}'.`,
      });
    }
  }

  const summary =
    differences.length === 0
      ? "Schemas match semantically across all inspected tables, columns, keys, indexes, unique constraints, triggers, and views."
      : `Detected ${differences.length} schema difference(s): ${differences
          .slice(0, 5)
          .map((d) => `${d.kind}(${d.tableName ? `${d.tableName}.` : ""}${d.objectName})`)
          .join(", ")}${differences.length > 5 ? ` (+${differences.length - 5} more)` : ""}`;

  return {
    equal: differences.length === 0,
    summary,
    differences,
  };
}

export function formatSchemaDiffReport(report: SchemaDiffReport): string {
  if (report.equal) return report.summary;
  const lines = [report.summary];
  for (const diff of report.differences) {
    lines.push(` - [${diff.kind}] ${diff.message}`);
  }
  return lines.join("\n");
}
