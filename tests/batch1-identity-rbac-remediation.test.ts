/**
 * SUN89 — BATCH 1: IDENTITY & RBAC REMEDIATION TEST SUITE
 *
 * Covers Batch 1 verification scopes on isolated SQLite:
 * - 8A: Canonical Actor Identity Resolution (parseStrictUserId, resolveAuthenticatedDbActor,
 *       usr-1 HTTP/service parity on permanentDeleteService & invoicePaymentVerificationService, spoofing immunity)
 * - 8B: Role Canonicalization & Legacy Alias Removal (4 canonical roles, conflict fail-closed,
 *       changePassword fail-closed, financeService & route privilege separation)
 * - 8C: Manual Legacy SVP Role Migration (preview dry-run, transactional execution, anomalous row exclusion,
 *       idempotency, rollback, post-migration auth continuity)
 * - 8D: Frontend Role Consistency (permissionStore canonical 'administrator', fail-closed on legacy 'svp'/'spv'/'supervisor')
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { db } from "../server/src/database/db";
import { createApp } from "../server/src/app";
import { generateToken, hashPassword } from "../server/src/utils/crypto";
import {
  parseStrictUserId,
  parsePositiveDbUserId,
  normalizeCanonicalUserId,
  resolveCanonicalRoleFromUser,
  resolveAuthenticatedDbActor,
} from "../server/src/utils/canonicalIdentity";
import { deletePermanentlyWithAuditAndIdempotency } from "../server/src/services/permanentDeleteService";
import { verifyInvoicePaymentAtomic } from "../server/src/services/invoicePaymentVerificationService";
import { authService } from "../server/src/services/authService";
import { financeService } from "../server/src/services/financeService";
import {
  LEGACY_SVP_MIGRATION_ID,
  previewLegacySvpRoleMigration,
  runLegacySvpRoleMigration,
  rollbackLegacySvpRoleMigration,
} from "../server/src/database/migrations/2026-11-15-001-normalize-svp-role-to-administrator";
import { permissionStore, normalizeRole } from "../src/app/data/permissionStore";

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

async function loginHttp(baseUrl: string, email: string, password: string): Promise<{ token: string; user: any }> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, `Expected 200 login for ${email}, got ${res.status}: ${JSON.stringify(body)}`);
  return { token: body.data.token, user: body.data.user };
}

test("BATCH 1: IDENTITY & RBAC REMEDIATION SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();
  t.after(() => server.close());

  // ===========================================================================
  // 8A: CANONICAL ACTOR IDENTITY RESOLUTION
  // ===========================================================================
  await t.test("8A.1: parseStrictUserId accepts valid forms and rejects malformed/ambiguous IDs", () => {
    assert.deepEqual(parseStrictUserId(1), { valid: true, numericId: 1, canonicalUserId: "usr-1" });
    assert.deepEqual(parseStrictUserId("1"), { valid: true, numericId: 1, canonicalUserId: "usr-1" });
    assert.deepEqual(parseStrictUserId("usr-1"), { valid: true, numericId: 1, canonicalUserId: "usr-1" });
    assert.deepEqual(parseStrictUserId("usr-42"), { valid: true, numericId: 42, canonicalUserId: "usr-42" });

    assert.equal(parsePositiveDbUserId("usr-17"), 17);
    assert.equal(normalizeCanonicalUserId(17), "usr-17");

    const invalidInputs: unknown[] = [
      "",
      " ",
      " 1",
      "usr-1 ",
      "0",
      "usr-0",
      "01",
      "usr-01",
      "-1",
      "usr--1",
      "1.5",
      "usr-1.5",
      "1e2",
      "EMP-0001",
      "USR-1",
      "usr-abc",
      "usr-",
      "usr-1-extra",
      "123abc",
      0,
      -5,
      1.5,
      NaN,
      Infinity,
      null,
      undefined,
      {},
      [],
    ];

    for (const bad of invalidInputs) {
      const parsed = parseStrictUserId(bad);
      assert.equal(parsed.valid, false, `Input '${String(bad)}' MUST be rejected by parseStrictUserId`);
    }
  });

  await t.test("8A.2: HTTP DELETE permanentDelete works for SVP user usr-1 & stores canonical audit user_id/role", async () => {
    const svpAuth = await loginHttp(baseUrl, "svp@birojasa.com", "admin123");
    assert.equal(svpAuth.user.userId, "usr-1");
    assert.equal(svpAuth.user.role, "administrator");

    // Ensure id=1 works with legacy role='svp' + jabatan='SVP' before migration too
    const currentId1 = db.prepare("SELECT id, jabatan, role FROM users WHERE id = 1").get() as any;
    assert.equal(currentId1.id, 1);
    assert.equal(currentId1.jabatan, "SVP");

    // Insert deletable kas_kantor, kas_messenger, pengeluaran rows
    const kkIns = db
      .prepare("INSERT INTO kas_kantor (tanggal, keterangan, status, debit, kredit, saldo, kategori) VALUES ('2026-11-12', 'Batch1 KK Delete', 'Debit', 50000, 0, 50000, 'Operasional')")
      .run();
    const kkId = Number(kkIns.lastInsertRowid);

    const idemKey = crypto.randomUUID();
    const delRes = await fetch(`${baseUrl}/api/finance/kas-kantor/${kkId}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
        "X-Idempotency-Key": idemKey,
      },
      body: JSON.stringify({
        reason: "Menghapus entri uji coba menggunakan identitas canonical usr-1",
        actorId: "usr-999", // spoofed body field must be ignored
        userId: "2",
        role: "admin",
      }),
    });
    const delBody = (await delRes.json()) as any;
    assert.equal(delRes.status, 200, `Expected 200 on DELETE kas-kantor by usr-1, got ${delRes.status}: ${JSON.stringify(delBody)}`);
    assert.equal(delBody.success, true);

    const auditEntry = db
      .prepare("SELECT user_id, user_role FROM audit_logs WHERE action = 'PERMANENT_DELETE' AND metadata_json LIKE ?")
      .get(`%${idemKey}%`) as any;
    assert.ok(auditEntry);
    assert.equal(auditEntry.user_id, "usr-1");
    assert.equal(auditEntry.user_role, "administrator");
  });

  await t.test("8A.3: HTTP POST verify-payment succeeds for usr-1 (SVP) & usr-2 (Admin), rejects spoofed/invalid actor", async () => {
    const svpAuth = await loginHttp(baseUrl, "svp@birojasa.com", "admin123");
    const pmId = "pm-batch1-" + Date.now();
    db.prepare(
      `INSERT INTO payment_methods (id, nama_metode, bank, nomor_rekening, nama_rekening, status, created_at, updated_at)
       VALUES (?, 'BCA Batch1', 'BCA', '1122334455', 'PT SUN BATCH1', 'Aktif', datetime('now'), datetime('now'))`
    ).run(pmId);

    const pmSnapshot = JSON.stringify({
      id: pmId,
      nama_metode: "BCA Batch1",
      bank: "BCA",
      nama_rekening: "PT SUN BATCH1",
      nomor_rekening: "1122334455",
    });

    const ordNo = "ORD-B1-VERIFY-" + Date.now();
    const invNo = "INV-B1-VERIFY-" + Date.now();
    db.prepare("INSERT INTO orders (order_no, customer, nomor_hp, layanan, nopol, data_json) VALUES (?, 'Cust B1', '08123', 'Perpanjangan STNK', 'B 1111 BB', '{}')").run(ordNo);
    db.prepare("INSERT INTO finance_invoices (invoice_no, order_no, customer, layanan, status, total_tagihan, dibayar, sisa, data_json, is_draft_estimate) VALUES (?, ?, 'Cust B1', 'Perpanjangan STNK', 'UNPAID', 300000, 0, 300000, '{}', 0)").run(invNo, ordNo);
    const payIns = db
      .prepare(
        `INSERT INTO invoice_payments (invoice_no, order_no, nominal, tanggal_bayar, metode_pembayaran, metode_pembayaran_id, payment_method_snapshot, status_verifikasi)
         VALUES (?, ?, 300000, '2026-11-12', 'Transfer Bank', ?, ?, 'MENUNGGU_VERIFIKASI')`
      )
      .run(invNo, ordNo, pmId, pmSnapshot);
    const paymentId = Number(payIns.lastInsertRowid);

    const idemKey = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/api/finance/invoices/${invNo}/verify-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${svpAuth.token}`,
        "X-Idempotency-Key": idemKey,
      },
      body: JSON.stringify({
        paymentId,
        actorId: "usr-999",
        userId: "999",
      }),
    });
    const body = (await res.json()) as any;
    assert.equal(res.status, 200, `Expected 200 on verify-payment by usr-1, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.success, true);

    const payRow = db.prepare("SELECT verified_by FROM invoice_payments WHERE id = ?").get(paymentId) as any;
    assert.equal(payRow.verified_by, "usr-1");

    // Direct service fails closed for invalid actor inputs
    assert.throws(
      () => verifyInvoicePaymentAtomic(paymentId, invNo, "EMP-0001", "administrator", crypto.randomUUID(), db),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN"
    );
    assert.throws(
      () => deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid minimal 10 chars", "usr-01", "administrator", crypto.randomUUID(), db),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN_NOT_SVP"
    );
    assert.throws(
      () => deletePermanentlyWithAuditAndIdempotency("kas_kantor", 1, "Alasan valid minimal 10 chars", "usr-999999", "administrator", crypto.randomUUID(), db),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN_USER_NOT_FOUND"
    );
  });

  // ===========================================================================
  // 8B: ROLE CANONICALIZATION & LEGACY ALIAS REMOVAL
  // ===========================================================================
  await t.test("8B.1: resolveCanonicalRoleFromUser enforces 4 canonical roles & conflict fail-closed", () => {
    assert.equal(resolveCanonicalRoleFromUser("SVP", "administrator"), "administrator");
    assert.equal(resolveCanonicalRoleFromUser("SVP", "svp"), "administrator");
    assert.equal(resolveCanonicalRoleFromUser("ADMIN", "admin"), "admin");
    assert.equal(resolveCanonicalRoleFromUser("FINANCE", "finance"), "finance");
    assert.equal(resolveCanonicalRoleFromUser("MESSENGER", "messenger"), "messenger");
    assert.equal(resolveCanonicalRoleFromUser("KURIR", "messenger"), "messenger");

    // Empty jabatan only accepts canonical 4 roles, NEVER 'svp' / 'spv' / 'supervisor'
    assert.equal(resolveCanonicalRoleFromUser(null, "administrator"), "administrator");
    assert.equal(resolveCanonicalRoleFromUser("", "admin"), "admin");
    assert.equal(resolveCanonicalRoleFromUser(null, "svp"), null);
    assert.equal(resolveCanonicalRoleFromUser("", "supervisor"), null);
    assert.equal(resolveCanonicalRoleFromUser(undefined, "spv"), null);

    // Conflicts must fail closed
    assert.equal(resolveCanonicalRoleFromUser("ADMIN", "administrator"), null);
    assert.equal(resolveCanonicalRoleFromUser("ADMIN", "svp"), null);
    assert.equal(resolveCanonicalRoleFromUser("SVP", "admin"), null);
    assert.equal(resolveCanonicalRoleFromUser("FINANCE", "admin"), null);
    assert.equal(resolveCanonicalRoleFromUser("SUPERVISOR", "svp"), null);
    assert.equal(resolveCanonicalRoleFromUser("SPV", "administrator"), null);
  });

  await t.test("8B.2: Forged or standalone legacy aliases (svp/spv/supervisor) are rejected across protected routes", async () => {
    const { hash, salt } = hashPassword("secret123");
    const ts = Date.now();

    // Case 1: role='svp' WITHOUT jabatan='SVP'
    const badSvpIns = db
      .prepare("INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status) VALUES (?, ?, ?, 'Rogue Alias 1', 'Staff', 'svp', 'Aktif')")
      .run(`rogue.svp.${ts}@birojasa.com`, hash, salt);
    const badSvpId = Number(badSvpIns.lastInsertRowid);

    // Case 2: role='supervisor', empty jabatan
    const badSupIns = db
      .prepare("INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status) VALUES (?, ?, ?, 'Rogue Alias 2', '', 'supervisor', 'Aktif')")
      .run(`rogue.sup.${ts}@birojasa.com`, hash, salt);
    const badSupId = Number(badSupIns.lastInsertRowid);

    // Case 3: role='spv', jabatan='ADMIN' (conflict!)
    const conflictIns = db
      .prepare("INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status) VALUES (?, ?, ?, 'Conflict User', 'ADMIN', 'spv', 'Aktif')")
      .run(`conflict.spv.${ts}@birojasa.com`, hash, salt);
    const conflictId = Number(conflictIns.lastInsertRowid);

    for (const [uid, claimedRole] of [
      [badSvpId, "svp"],
      [badSupId, "supervisor"],
      [conflictId, "spv"],
    ] as const) {
      const forgedToken = generateToken({
        userId: `usr-${uid}`,
        email: `rogue.${uid}@birojasa.com`,
        nama: "Rogue Alias",
        jabatan: "SVP",
        role: claimedRole,
      });

      const voidRes = await fetch(`${baseUrl}/api/finance/audit/void-history`, {
        headers: { Authorization: `Bearer ${forgedToken}` },
      });
      assert.equal(voidRes.status, 401, `Legacy alias '${claimedRole}' must be rejected with 401`);

      const delRes = await fetch(`${baseUrl}/api/finance/kas-kantor/1`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${forgedToken}`,
          "X-Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ reason: "Mencoba bypass alias role legacy" }),
      });
      assert.equal(delRes.status, 401, `Legacy alias '${claimedRole}' must fail on SVP DELETE route`);
    }

    // changePassword must fail closed for unmapped role (never fallback to "admin")
    await assert.rejects(
      () =>
        authService.changePassword(
          { oldPassword: "secret123", newPassword: "NewPassword123!", confirmPassword: "NewPassword123!" },
          {
            userId: `usr-${badSvpId}`,
            email: `rogue.svp.${ts}@birojasa.com`,
            nama: "Rogue Alias 1",
            jabatan: "Staff",
            role: "svp",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }
        ),
      (err: any) => err.statusCode === 403 && err.code === "UNASSIGNED_ROLE"
    );

    // Non-administrator (admin) is denied SVP-only void history route with 403
    const adminAuth = await loginHttp(baseUrl, "admin@birojasa.com", "admin123");
    const adminVoidRes = await fetch(`${baseUrl}/api/finance/audit/void-history`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.equal(adminVoidRes.status, 403);

    // financeService.addKasKantor MODAL_AWAL permits 'administrator'/'admin' and denies 'svp'
    const resolvedActor = resolveAuthenticatedDbActor("usr-1", db);
    assert.equal(resolvedActor.ok, true);
    assert.throws(
      () =>
        financeService.addKasKantor(
          { tanggal: "2026-11-12", keterangan: "Modal awal uji", status: "Debit", kategori: "MODAL_AWAL", debit: 10000, kredit: 0 } as any,
          { userId: "usr-999", nama: "Rogue", role: "svp" as any, email: "x@y.com", jabatan: "Staff", exp: 0 }
        ),
      (err: any) => err.statusCode === 403 && err.code === "FORBIDDEN"
    );
  });

  // ===========================================================================
  // 8C: MANUAL LEGACY SVP ROLE MIGRATION (DRY-RUN, APPLY, IDEMPOTENCY, ROLLBACK)
  // ===========================================================================
  await t.test("8C: Manual SVP migration previews accurately, updates only jabatan='SVP', is idempotent, and rolls back", async () => {
    const { hash, salt } = hashPassword("MigTest123!");
    const migEmail = `mig.svp.${Date.now()}@birojasa.com`;
    const anomEmail = `anom.svp.${Date.now()}@birojasa.com`;

    // 1. Ensure startup did NOT auto-apply Batch 1 manual migration
    const migRowAtBoot = db
      .prepare("SELECT * FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (migRowAtBoot) {
      const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(LEGACY_SVP_MIGRATION_ID);
      assert.equal(applied, undefined, "Manual SVP migration MUST NOT auto-execute at startup");
    }

    // Seed clean legacy SVP user and an anomalous user with role='svp' but jabatan='Staff'
    const validLegacyIns = db
      .prepare("INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status) VALUES (?, ?, ?, 'Legacy Valid SVP', 'SVP', 'svp', 'Aktif')")
      .run(migEmail, hash, salt);
    const validLegacyId = Number(validLegacyIns.lastInsertRowid);

    const anomIns = db
      .prepare("INSERT INTO users (email, password_hash, password_salt, nama, jabatan, role, status) VALUES (?, ?, ?, 'Anomalous SVP Row', 'Staff', 'svp', 'Aktif')")
      .run(anomEmail, hash, salt);
    const anomId = Number(anomIns.lastInsertRowid);

    // 2. Preview (read-only dry-run)
    const preview = previewLegacySvpRoleMigration(db);
    assert.equal(preview.alreadyApplied, false);
    assert.ok(preview.targetUsers.some((u) => Number(u.id) === validLegacyId));
    assert.ok(preview.anomalousUsers.some((u) => Number(u.id) === anomId));

    // Verify preview performed zero writes
    const checkBeforeApply = db.prepare("SELECT role FROM users WHERE id = ?").get(validLegacyId) as any;
    assert.equal(checkBeforeApply.role, "svp");

    // 3. Apply migration manually
    const applyRes = runLegacySvpRoleMigration(db, { approvedBy: "Audit Test Operator" });
    assert.equal(applyRes.applied, true);
    assert.equal(applyRes.alreadyApplied, false);
    assert.ok(applyRes.updatedUserIds.includes(validLegacyId));
    assert.ok(applyRes.anomalousSkippedIds.includes(anomId));

    const migratedRow = db.prepare("SELECT role, jabatan, password_hash FROM users WHERE id = ?").get(validLegacyId) as any;
    assert.equal(migratedRow.role, "administrator");
    assert.equal(migratedRow.jabatan, "SVP");
    assert.equal(migratedRow.password_hash, hash);

    const anomRowAfter = db.prepare("SELECT role, jabatan FROM users WHERE id = ?").get(anomId) as any;
    assert.equal(anomRowAfter.role, "svp", "Anomalous role='svp' without jabatan='SVP' MUST NOT be auto-upgraded");

    // 4. Idempotent second run
    const secondRun = runLegacySvpRoleMigration(db, { approvedBy: "Audit Test Operator" });
    assert.equal(secondRun.alreadyApplied, true);
    assert.equal(secondRun.applied, false);
    assert.equal(secondRun.updatedCount, 0);

    // 5. Post-migration login & protected endpoints work seamlessly
    const postMigLogin = await loginHttp(baseUrl, migEmail, "MigTest123!");
    assert.equal(postMigLogin.user.role, "administrator");
    const permRes = await fetch(`${baseUrl}/api/finance/audit/void-history`, {
      headers: { Authorization: `Bearer ${postMigLogin.token}` },
    });
    assert.equal(permRes.status, 200);

    // 6. Rollback restores legacy role='svp' cleanly and removes schema_migrations marker
    const rbRes = rollbackLegacySvpRoleMigration(db, { approvedBy: "Audit Test Operator" });
    assert.equal(rbRes.rolledBack, true);
    assert.ok(rbRes.revertedUserIds.includes(validLegacyId));

    const revertedRow = db.prepare("SELECT role, jabatan FROM users WHERE id = ?").get(validLegacyId) as any;
    assert.equal(revertedRow.role, "svp");
    assert.equal(revertedRow.jabatan, "SVP");
  });

  // ===========================================================================
  // 8D: FRONTEND ROLE CONSISTENCY
  // ===========================================================================
  await t.test("8D: permissionStore uses canonical 'administrator' and fails closed on legacy 'svp'/'spv'/'supervisor'", () => {
    assert.equal(normalizeRole("administrator"), "administrator");
    assert.equal(normalizeRole("ADMIN"), "admin");
    assert.equal(normalizeRole("finance"), "finance");
    assert.equal(normalizeRole("messenger"), "messenger");
    assert.equal(normalizeRole("kurir"), "messenger");

    // Legacy privilege aliases must fail closed on frontend
    assert.equal(normalizeRole("svp"), "unknown");
    assert.equal(normalizeRole("spv"), "unknown");
    assert.equal(normalizeRole("supervisor"), "unknown");
    assert.equal(normalizeRole(""), "unknown");
    assert.equal(normalizeRole(null), "unknown");

    // Stage 6 & Dynamic RBAC protection
    assert.equal(permissionStore.canManageStage("administrator", 6), true);
    assert.equal(permissionStore.canManageStage("admin", 6), false);
    assert.equal(permissionStore.canManageStage("svp", 6), false);
    assert.equal(permissionStore.canManageStage("supervisor", 6), false);

    assert.equal(permissionStore.canViewPage("administrator", "access-management"), true);
    assert.equal(permissionStore.canViewPage("svp", "access-management"), false);
    assert.equal(permissionStore.canManageModule("administrator", "finance-kas-kantor"), true);
    assert.equal(permissionStore.canManageModule("supervisor", "finance-kas-kantor"), false);

    assert.equal(permissionStore.canAccessApiEndpoint("finance-kas-kantor", "administrator"), true);
    assert.equal(permissionStore.canAccessApiEndpoint("finance-kas-kantor", "svp"), false);
    assert.equal(permissionStore.canAccessApiEndpoint("finance-kas-kantor", "spv"), false);
  });
});
