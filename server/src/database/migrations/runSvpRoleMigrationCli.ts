/**
 * Manual CLI Entry for Legacy SVP Role Normalization Migration
 * Usage:
 *   Dry-run preview (default, read-only):
 *     npx tsx server/src/database/migrations/runSvpRoleMigrationCli.ts --db <path-to-sqlite>
 *   Approved execution (writes require --execute --approve <operator-name>):
 *     npx tsx server/src/database/migrations/runSvpRoleMigrationCli.ts --db <path-to-sqlite> --execute --approve "<operator>"
 *   Rollback:
 *     npx tsx server/src/database/migrations/runSvpRoleMigrationCli.ts --db <path-to-sqlite> --rollback --approve "<operator>"
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  previewLegacySvpRoleMigration,
  runLegacySvpRoleMigration,
  rollbackLegacySvpRoleMigration,
} from "./2026-11-15-001-normalize-svp-role-to-administrator";

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function main(): void {
  const dbArg = getArgValue("--db");
  if (!dbArg) {
    console.error("ERROR: --db <sqlite-path> wajib ditentukan secara eksplisit. Tidak boleh dijalankan tanpa target DB eksplisit.");
    process.exit(1);
  }

  const resolvedDbPath = path.resolve(dbArg);
  const execute = process.argv.includes("--execute");
  const rollback = process.argv.includes("--rollback");
  const approvedBy = getArgValue("--approve");

  if ((execute || rollback) && !approvedBy) {
    console.error("ERROR: --approve <operator-name> wajib diisi untuk --execute atau --rollback.");
    process.exit(1);
  }

  const operationalDefault = path.resolve(process.cwd(), "server/data/database.sqlite");
  if ((execute || rollback) && resolvedDbPath === operationalDefault && !process.argv.includes("--confirm-operational-db")) {
    console.error("BLOCKED: Mutasi terhadap operational database memerlukan flag eksplisit --confirm-operational-db setelah backup diverifikasi.");
    process.exit(2);
  }

  const sqliteDb = new DatabaseSync(resolvedDbPath);
  try {
    sqliteDb.exec("PRAGMA foreign_keys = ON;");
    const preview = previewLegacySvpRoleMigration(sqliteDb);
    console.log("[PREVIEW]", JSON.stringify(preview, null, 2));

    if (!execute && !rollback) {
      console.log("[DRY-RUN] Tidak ada perubahan database dilakukan.");
      return;
    }

    if (rollback) {
      const rb = rollbackLegacySvpRoleMigration(sqliteDb, { approvedBy: approvedBy! });
      console.log("[ROLLBACK]", JSON.stringify(rb, null, 2));
      return;
    }

    const res = runLegacySvpRoleMigration(sqliteDb, { approvedBy: approvedBy! });
    console.log("[EXECUTED]", JSON.stringify(res, null, 2));
  } finally {
    sqliteDb.close();
  }
}

main();
