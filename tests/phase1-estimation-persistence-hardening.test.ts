/**
 * Phase 1 Regression & Hardening Test Suite
 * Dynamic Estimation: Configuration Persistence Stabilization & Canonical Fee Alignment
 *
 * Covers Workstreams A through F:
 *  - A: Pure domain template sanitizer (src/domain/estimation/templateSanitizer.ts)
 *  - B: Zero Mutation-on-GET & Mutasi Luar Daerah custom biayaJasa preservation
 *  - C: Strict PUT /api/estimation/templates/:id payload validation (400, zero DB/audit write)
 *  - D: EstimationStore HTTP rollback, unified General Rules coordinator (single PUT, partial success, error surfacing)
 *  - E: Canonical Perpanjangan 1 Tahun R2 service fee = Rp 200.000 & preserved Samsat overrides
 *  - F: Ringkasan fixed parameter component lookup & CalculationExplanationModal canonical template ID resolution
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createApp } from "../server/src/app";
import { db } from "../server/src/database/db";
import {
  resolveTemplateIdByService,
  sanitizeComponentDescription,
  sanitizeEstimationTemplate,
} from "../src/domain/estimation/templateSanitizer";
import {
  DEFAULT_R4_ANNUAL_TEMPLATE,
  DEFAULT_R2_ANNUAL_TEMPLATE,
  DEFAULT_R4_5YEAR_TEMPLATE,
  DEFAULT_R4_BBN_TEMPLATE,
  DEFAULT_R4_MUTASI_AS_TEMPLATE,
  DEFAULT_R4_MUTASI_LD_TEMPLATE,
  DEFAULT_R2_MUTASI_LD_TEMPLATE,
} from "../src/domain/estimation/defaultTemplates";
import { EstimationTemplateConfig } from "../src/domain/estimation/types";
import { calculateEstimation } from "../src/domain/estimation/estimationEngine";
import {
  ALL_DEFAULT_TEMPLATES,
  estimationStore,
  EstimationSaveResult,
} from "../src/app/data/estimationStore";
import {
  SERVICE_STANDARD_BASELINES,
  getStandardJasa,
  resolveServiceFee,
} from "../src/domain/pricing/pricingResolver";
import { pricingStore } from "../src/app/data/pricingStore";
import { ApiPricingProvider } from "../src/data/api/apiPricingProvider";
import { pricingRepository } from "../src/data/repositories/pricingRepository";
import {
  buildTemplateFromVehicleDraft,
  executeGeneralRulesSave,
  findSummaryComponentRule,
  VehicleFormulaDraft,
} from "../src/app/components/BiayaLayanan";

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

async function loginAsSvp(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "svp@birojasa.com", password: "admin123" }),
  });
  assert.strictEqual(res.status, 200, "SVP login must succeed");
  const body = (await res.json()) as any;
  assert.ok(body?.data?.token, "SVP login must return Bearer token");
  return body.data.token;
}

function cloneJson<T>(val: T): T {
  return JSON.parse(JSON.stringify(val));
}

function buildDraftFromTemplate(
  tpl: EstimationTemplateConfig,
  overrides: Partial<VehicleFormulaDraft> = {}
): VehicleFormulaDraft {
  const koefStr =
    tpl.koefisienDenda <= 1
      ? Math.round(tpl.koefisienDenda * 100).toString()
      : tpl.koefisienDenda.toString();
  const savedIncludesInTotal: Record<string, boolean> = {};
  for (const comp of tpl.components) {
    savedIncludesInTotal[comp.id] = comp.includesInTotal ?? true;
  }
  return {
    koefDenda: koefStr,
    pembagiBulan: String(tpl.pembagiBulan ?? 12),
    kelipatanPembulatan: String(tpl.kelipatanPembulatan ?? 1000),
    swdklljPokok: String(tpl.swdklljPokok ?? 0),
    dendaSwdkllj: String(tpl.dendaSwdklljPokok ?? 0),
    biayaCetakSkp: String(tpl.biayaCetakSkp ?? 0),
    adminStnk: String(tpl.adminStnk ?? 0),
    adminTnkb: String(tpl.adminTnkb ?? 0),
    components: tpl.components.map((c) => ({ ...c })),
    savedIncludesInTotal,
    ...overrides,
  };
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

test("PHASE 1: ESTIMATION CONFIGURATION PERSISTENCE & REGRESSION SUITE", async (t) => {
  const { server, baseUrl } = await startTestServer();
  const prevToken = process.env.AUTH_TOKEN;

  try {
    const token = await loginAsSvp(baseUrl);
    process.env.AUTH_TOKEN = token;
    estimationStore.setBaseUrl(`${baseUrl}/api`);
    const apiPricing = new ApiPricingProvider(`${baseUrl}/api`);
    await apiPricing.initFromApi();
    pricingRepository.setProvider(apiPricing);
    await pricingStore.initFromApi();

    const authHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // 1. WORKSTREAM A: Pure Domain Sanitizer & Template ID Resolution
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("A. Pure domain sanitizer strips Excel hints without overriding business values", () => {
      assert.strictEqual(
        sanitizeComponentDescription("PKB Dasar × Koefisien Denda (Cell F15)"),
        "PKB Dasar × Koefisien Denda"
      );
      assert.strictEqual(
        sanitizeComponentDescription("ROUNDUP(X; -3) Sheet PJK"),
        "X, dibulatkan ke kelipatan Rp 1.000"
      );

      const customMutasiLd = cloneJson(DEFAULT_R4_MUTASI_LD_TEMPLATE);
      customMutasiLd.biayaJasa = 1850000;
      const sanitized = sanitizeEstimationTemplate(customMutasiLd);
      assert.strictEqual(
        sanitized.biayaJasa,
        1850000,
        "Sanitizer must NEVER force-override persisted biayaJasa"
      );

      const r2Custom = cloneJson(DEFAULT_R2_MUTASI_LD_TEMPLATE);
      r2Custom.biayaJasa = 675000;
      assert.strictEqual(sanitizeEstimationTemplate(r2Custom).biayaJasa, 675000);

      // Verify estimationService no longer imports estimationStore
      const serviceSrc = fs.readFileSync(
        path.resolve(currentDir, "../server/src/services/estimationService.ts"),
        "utf8"
      );
      assert.ok(
        !serviceSrc.includes("estimationStore"),
        "Backend estimationService.ts must import pure templateSanitizer, not frontend estimationStore"
      );
      assert.ok(
        serviceSrc.includes("templateSanitizer"),
        "Backend estimationService.ts must import templateSanitizer"
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. WORKSTREAM B: Zero Mutation-on-GET & Custom Mutasi LD Preservation
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("B. GET /api/estimation/templates & :id perform 0 SQLite writes and preserve Mutasi LD fees", async () => {
      // Customize Mutasi LD R4 and R2 via PUT
      const r4Payload = cloneJson(DEFAULT_R4_MUTASI_LD_TEMPLATE);
      r4Payload.biayaJasa = 1850000;
      const r4JasaComp = r4Payload.components.find(
        (c) => c.category === "JASA" || c.ruleId === "PROSES_DAN_JASA_MUTASI"
      );
      if (r4JasaComp) r4JasaComp.defaultValue = 1850000;

      const r2Payload = cloneJson(DEFAULT_R2_MUTASI_LD_TEMPLATE);
      r2Payload.biayaJasa = 650000;
      const r2JasaComp = r2Payload.components.find(
        (c) => c.category === "JASA" || c.ruleId === "PROSES_DAN_JASA_MUTASI"
      );
      if (r2JasaComp) r2JasaComp.defaultValue = 650000;

      try {
        const r4Id = DEFAULT_R4_MUTASI_LD_TEMPLATE.id;
        const r2Id = DEFAULT_R2_MUTASI_LD_TEMPLATE.id;

        const putR4 = await fetch(`${baseUrl}/api/estimation/templates/${r4Id}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(r4Payload),
        });
        assert.strictEqual(putR4.status, 200, "Custom Mutasi LD R4 PUT must succeed");

        const putR2 = await fetch(`${baseUrl}/api/estimation/templates/${r2Id}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(r2Payload),
        });
        assert.strictEqual(putR2.status, 200, "Custom Mutasi LD R2 PUT must succeed");

        // Record SQLite updated_at timestamps & audit log count BEFORE GET requests
        const timestampsBefore = db
          .prepare("SELECT id, updated_at, data_json FROM estimation_templates ORDER BY id ASC")
          .all() as Array<{ id: string; updated_at: string; data_json: string }>;
        const auditBefore = (
          db.prepare("SELECT COUNT(*) as cnt FROM audit_logs").get() as { cnt: number }
        ).cnt;

        // Perform multiple GET list & detail reads
        const getListRes = await fetch(`${baseUrl}/api/estimation/templates`, {
          headers: authHeaders,
        });
        assert.strictEqual(getListRes.status, 200);
        const listJson = (await getListRes.json()) as any;
        const listR4 = (listJson.data as EstimationTemplateConfig[]).find(
          (t) => t.id === r4Id
        );
        const listR2 = (listJson.data as EstimationTemplateConfig[]).find(
          (t) => t.id === r2Id
        );
        assert.strictEqual(listR4?.biayaJasa, 1850000, "GET list must return persisted Mutasi LD R4 biayaJasa");
        assert.strictEqual(listR2?.biayaJasa, 650000, "GET list must return persisted Mutasi LD R2 biayaJasa");

        const getDetailR4 = await fetch(
          `${baseUrl}/api/estimation/templates/${r4Id}`,
          { headers: authHeaders }
        );
        assert.strictEqual(getDetailR4.status, 200);
        const detailR4Json = (await getDetailR4.json()) as any;
        assert.strictEqual(detailR4Json?.data?.biayaJasa, 1850000);

        const getDetailR2 = await fetch(
          `${baseUrl}/api/estimation/templates/${r2Id}`,
          { headers: authHeaders }
        );
        assert.strictEqual(getDetailR2.status, 200);
        const detailR2Json = (await getDetailR2.json()) as any;
        assert.strictEqual(detailR2Json?.data?.biayaJasa, 650000);

        // Verify store re-init also preserves custom fees
        estimationStore.resetLocalToCanonicalDefaultsForTest();
        await estimationStore.initFromBackend({ force: true });
        assert.strictEqual(
          estimationStore.getTemplate(r4Id).biayaJasa,
          1850000,
          "Reloading estimationStore from backend must preserve custom Mutasi LD R4 fee"
        );
        assert.strictEqual(
          estimationStore.getTemplate(r2Id).biayaJasa,
          650000,
          "Reloading estimationStore from backend must preserve custom Mutasi LD R2 fee"
        );

        // Record SQLite updated_at & audit log count AFTER GET requests -> strictly identical!
        const timestampsAfter = db
          .prepare("SELECT id, updated_at, data_json FROM estimation_templates ORDER BY id ASC")
          .all() as Array<{ id: string; updated_at: string; data_json: string }>;
        const auditAfter = (
          db.prepare("SELECT COUNT(*) as cnt FROM audit_logs").get() as { cnt: number }
        ).cnt;

        assert.deepStrictEqual(
          timestampsAfter,
          timestampsBefore,
          "GET endpoints must perform 0 SQLite writes to estimation_templates"
        );
        assert.strictEqual(
          auditAfter,
          auditBefore,
          "GET endpoints must write 0 audit log entries"
        );
      } finally {
        await fetch(`${baseUrl}/api/estimation/templates/${DEFAULT_R4_MUTASI_LD_TEMPLATE.id}/reset`, {
          method: "POST",
          headers: authHeaders,
        });
        await fetch(`${baseUrl}/api/estimation/templates/${DEFAULT_R2_MUTASI_LD_TEMPLATE.id}/reset`, {
          method: "POST",
          headers: authHeaders,
        });
        await estimationStore.initFromBackend({ force: true });
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. WORKSTREAM C: Strict Payload Validation on PUT /api/estimation/templates/:id
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("C. Strict backend PUT validation rejects invalid payloads with HTTP 400 and zero DB/audit writes", async () => {
      const targetId = "template-pajak-tahunan-r4";
      try {
        // First confirm a valid PUT persists across store re-init
        const validPayload = cloneJson(DEFAULT_R4_ANNUAL_TEMPLATE);
        validPayload.koefisienDenda = 0.5;
        validPayload.pembagiBulan = 12;
        validPayload.biayaCetakSkp = 125000;

        const validPutRes = await fetch(`${baseUrl}/api/estimation/templates/${targetId}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(validPayload),
        });
        assert.strictEqual(validPutRes.status, 200, "Valid PUT must return 200");

        estimationStore.resetLocalToCanonicalDefaultsForTest();
        await estimationStore.initFromBackend({ force: true });
        assert.strictEqual(estimationStore.getTemplate(targetId).biayaCetakSkp, 125000);

        const rowBefore = db
          .prepare("SELECT updated_at, data_json FROM estimation_templates WHERE id = ?")
          .get(targetId) as { updated_at: string; data_json: string };
        const auditBefore = (
          db.prepare("SELECT COUNT(*) as cnt FROM audit_logs").get() as { cnt: number }
        ).cnt;

        const base = cloneJson(DEFAULT_R4_ANNUAL_TEMPLATE);
        const invalidCases: Array<{ name: string; mutate: (p: any) => void }> = [
          { name: "koefisienDenda null (JSON NaN/Infinity)", mutate: (p) => (p.koefisienDenda = null) },
          { name: "koefisienDenda negative", mutate: (p) => (p.koefisienDenda = -0.1) },
          { name: "koefisienDenda > max", mutate: (p) => (p.koefisienDenda = 5.5) },
          { name: "koefisienDenda string", mutate: (p) => (p.koefisienDenda = "0.48") },
          { name: "pembagiBulan 0", mutate: (p) => (p.pembagiBulan = 0) },
          { name: "pembagiBulan float", mutate: (p) => (p.pembagiBulan = 12.5) },
          { name: "pembagiBulan > 60", mutate: (p) => (p.pembagiBulan = 61) },
          { name: "kelipatanPembulatan 0", mutate: (p) => (p.kelipatanPembulatan = 0) },
          { name: "kelipatanPembulatan float", mutate: (p) => (p.kelipatanPembulatan = 100.5) },
          { name: "negative biayaJasa", mutate: (p) => (p.biayaJasa = -1000) },
          { name: "null swdklljPokok", mutate: (p) => (p.swdklljPokok = null) },
          { name: "negative adminStnk", mutate: (p) => (p.adminStnk = -500) },
          { name: "components non-array", mutate: (p) => (p.components = { bad: true }) },
          { name: "components empty array", mutate: (p) => (p.components = []) },
          {
            name: "duplicate component id",
            mutate: (p) => {
              p.components.push({ ...p.components[0] });
            },
          },
          {
            name: "missing component name",
            mutate: (p) => {
              p.components[0].name = "   ";
            },
          },
          {
            name: "non-boolean isActive",
            mutate: (p) => {
              p.components[0].isActive = "true";
            },
          },
          {
            name: "negative component defaultValue",
            mutate: (p) => {
              p.components[0].defaultValue = -1;
            },
          },
          {
            name: "minAmount > maxAmount",
            mutate: (p) => {
              p.components[0].minAmount = 50000;
              p.components[0].maxAmount = 10000;
            },
          },
          {
            name: "unknown ruleId",
            mutate: (p) => {
              p.components[0].ruleId = "NON_EXISTENT_RULE_XYZ";
            },
          },
          { name: "accIdRates empty object", mutate: (p) => (p.accIdRates = {}) },
          { name: "accIdRates empty key", mutate: (p) => (p.accIdRates = { "": 100000 }) },
          { name: "accIdRates negative value", mutate: (p) => (p.accIdRates = { "DKI Jakarta": -5000 }) },
          { name: "accIdRates null value", mutate: (p) => (p.accIdRates = { "DKI Jakarta": null }) },
        ];

        for (const testCase of invalidCases) {
          const payload = cloneJson(base);
          testCase.mutate(payload);
          const badRes = await fetch(`${baseUrl}/api/estimation/templates/${targetId}`, {
            method: "PUT",
            headers: authHeaders,
            body: JSON.stringify(payload),
          });
          assert.strictEqual(
            badRes.status,
            400,
            `Invalid payload (${testCase.name}) must return HTTP 400`
          );
          const badJson = (await badRes.json()) as any;
          assert.strictEqual(badJson.success, false, `Response success must be false for ${testCase.name}`);
        }

        const rowAfter = db
          .prepare("SELECT updated_at, data_json FROM estimation_templates WHERE id = ?")
          .get(targetId) as { updated_at: string; data_json: string };
        const auditAfter = (
          db.prepare("SELECT COUNT(*) as cnt FROM audit_logs").get() as { cnt: number }
        ).cnt;

        assert.strictEqual(rowAfter.updated_at, rowBefore.updated_at, "Rejected PUTs must not alter updated_at");
        assert.strictEqual(rowAfter.data_json, rowBefore.data_json, "Rejected PUTs must not alter data_json");
        assert.strictEqual(auditAfter, auditBefore, "Rejected PUTs must not insert audit log rows");
      } finally {
        await fetch(`${baseUrl}/api/estimation/templates/${targetId}/reset`, {
          method: "POST",
          headers: authHeaders,
        });
        await estimationStore.initFromBackend({ force: true });
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. WORKSTREAM D: EstimationStore HTTP Rollback & Unified Coordinator
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("D1. EstimationStore awaits HTTP response and rolls back in-memory template on failure", async () => {
      await estimationStore.initFromBackend({ force: true });
      const baseline = cloneJson(estimationStore.getTemplate("template-pajak-tahunan-r4"));
      const originalFetch = globalThis.fetch;

      try {
        // 1. Server validation failure (400) via real backend
        const failRes = await estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", {
          pembagiBulan: 0,
        });
        assert.strictEqual(failRes.success, false);
        assert.strictEqual(failRes.statusCode, 400);
        assert.strictEqual(
          estimationStore.getTemplate("template-pajak-tahunan-r4").pembagiBulan,
          baseline.pembagiBulan,
          "In-memory store must remain at confirmed baseline after HTTP 400"
        );

        // 2. Simulated 500 server error during save -> rolls back and surfaces error
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({ success: false, message: "Database temporarily read-only" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })) as typeof fetch;

        const err500Res = await estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", {
          biayaCetakSkp: 999999,
        });
        assert.strictEqual(err500Res.success, false);
        assert.strictEqual(err500Res.statusCode, 500);
        assert.ok(err500Res.error && err500Res.error.includes("Database temporarily read-only"));
        assert.strictEqual(
          estimationStore.getTemplate("template-pajak-tahunan-r4").biayaCetakSkp,
          baseline.biayaCetakSkp,
          "In-memory store must roll back biayaCetakSkp after HTTP 500"
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    await t.test("D2. General Rules Save Coordinator executes 1 PUT per template, handles partial success, and never clobbers baselines", async () => {
      const r4Tpl = cloneJson(DEFAULT_R4_ANNUAL_TEMPLATE);
      const r2Tpl = cloneJson(DEFAULT_R2_ANNUAL_TEMPLATE);
      const mobilDraft = buildDraftFromTemplate(r4Tpl, { biayaCetakSkp: "110000" });
      const motorDraft = buildDraftFromTemplate(r2Tpl, { biayaCetakSkp: "30000" });

      const r2BaselineBefore = SERVICE_STANDARD_BASELINES["Perpanjangan 1 Tahun"].jasaR2;

      // Scenario 1: Happy path -> strictly 1 PUT per template ID & applyBiayaLayanan: false
      const putCounts: Record<string, number> = {};
      let samsatSyncCalled = 0;
      let capturedOptions: any = null;
      const okRes = await executeGeneralRulesSave({
        currentLayanan: "Perpanjangan 1 Tahun",
        mobilBaseTemplate: r4Tpl,
        motorBaseTemplate: r2Tpl,
        mobilDraft,
        motorDraft,
        selectedComponents: {},
        deps: {
          updateTemplateAsync: async (tpl): Promise<EstimationSaveResult> => {
            putCounts[tpl.id] = (putCounts[tpl.id] || 0) + 1;
            return { success: true, template: tpl };
          },
          applyConfigToAllSamsats: async (_svc, _cfg, opts) => {
            samsatSyncCalled++;
            capturedOptions = opts;
          },
        },
      });
      assert.strictEqual(okRes.success, true);
      assert.strictEqual(okRes.shouldCloseModal, true);
      assert.strictEqual(putCounts["template-pajak-tahunan-r4"], 1, "Strictly 1 PUT for Mobil");
      assert.strictEqual(putCounts["template-pajak-tahunan-r2"], 1, "Strictly 1 PUT for Motor");
      assert.strictEqual(samsatSyncCalled, 1);
      assert.strictEqual(capturedOptions.applyBiayaLayanan, false, "Modal 1 must not clobber Samsat Jasa");
      assert.strictEqual(
        SERVICE_STANDARD_BASELINES["Perpanjangan 1 Tahun"].jasaR2,
        r2BaselineBefore,
        "Saving General Rules must not mutate global SERVICE_STANDARD_BASELINES"
      );

      // Scenario 2: Both PUTs fail -> modal stays open, zero Samsat sync
      let bothFailSamsatCalls = 0;
      const bothFailRes = await executeGeneralRulesSave({
        currentLayanan: "Perpanjangan 1 Tahun",
        mobilBaseTemplate: r4Tpl,
        motorBaseTemplate: r2Tpl,
        mobilDraft,
        motorDraft,
        selectedComponents: {},
        deps: {
          updateTemplateAsync: async () => ({ success: false, error: "Server Error 500" }),
          applyConfigToAllSamsats: async () => {
            bothFailSamsatCalls++;
          },
        },
      });
      assert.strictEqual(bothFailRes.success, false);
      assert.strictEqual(bothFailRes.shouldCloseModal, false);
      assert.strictEqual(bothFailSamsatCalls, 0);
      assert.ok(bothFailRes.errorMessage?.includes("Server Error 500"));

      // Scenario 3: Partial success (Mobil succeeds, Motor fails) -> clear partial message, modal stays open
      let partialSamsatCalls = 0;
      const partialRes = await executeGeneralRulesSave({
        currentLayanan: "Perpanjangan 1 Tahun",
        mobilBaseTemplate: r4Tpl,
        motorBaseTemplate: r2Tpl,
        mobilDraft,
        motorDraft,
        selectedComponents: {},
        deps: {
          updateTemplateAsync: async (tpl) =>
            tpl.id.includes("-r4")
              ? { success: true, template: tpl }
              : { success: false, error: "Validasi Motor gagal" },
          applyConfigToAllSamsats: async () => {
            partialSamsatCalls++;
          },
        },
      });
      assert.strictEqual(partialRes.success, false);
      assert.strictEqual(partialRes.shouldCloseModal, false);
      assert.strictEqual(partialRes.mobilResult?.success, true);
      assert.strictEqual(partialRes.motorResult?.success, false);
      assert.strictEqual(partialSamsatCalls, 0);
      assert.ok(partialRes.partialSuccessMessage?.includes("Mobil berhasil disimpan"));
      assert.ok(partialRes.partialSuccessMessage?.includes("Validasi Motor gagal"));

      // Scenario 4: Both templates succeed, Samsat batch replication throws -> modal stays open with honest message
      const samsatFailRes = await executeGeneralRulesSave({
        currentLayanan: "Perpanjangan 1 Tahun",
        mobilBaseTemplate: r4Tpl,
        motorBaseTemplate: r2Tpl,
        mobilDraft,
        motorDraft,
        selectedComponents: {},
        deps: {
          updateTemplateAsync: async (tpl) => ({ success: true, template: tpl }),
          applyConfigToAllSamsats: async () => {
            throw new Error("Batch replicate failed on Samsat Depok");
          },
        },
      });
      assert.strictEqual(samsatFailRes.success, false);
      assert.strictEqual(samsatFailRes.shouldCloseModal, false);
      assert.strictEqual(samsatFailRes.samsatSyncError, "Batch replicate failed on Samsat Depok");

      // Scenario 5: Client draft validation rejects out-of-range pembagiBulan without hitting API
      let apiHitCount = 0;
      const badDraftRes = await executeGeneralRulesSave({
        currentLayanan: "Perpanjangan 1 Tahun",
        mobilBaseTemplate: r4Tpl,
        motorBaseTemplate: r2Tpl,
        mobilDraft: buildDraftFromTemplate(r4Tpl, { pembagiBulan: "99" }),
        motorDraft,
        selectedComponents: {},
        deps: {
          updateTemplateAsync: async (tpl) => {
            apiHitCount++;
            return { success: true, template: tpl };
          },
          applyConfigToAllSamsats: async () => {
            apiHitCount++;
          },
        },
      });
      assert.strictEqual(badDraftRes.success, false);
      assert.strictEqual(badDraftRes.shouldCloseModal, false);
      assert.strictEqual(apiHitCount, 0, "Invalid draft must fail before issuing any PUT request");

      // buildTemplateFromVehicleDraft must preserve JASA component fee without baseline overwrite
      const draftWithEditedJasa = buildDraftFromTemplate(DEFAULT_R2_MUTASI_LD_TEMPLATE);
      const mutasiLdJasaComp = draftWithEditedJasa.components.find((c) => c.category === "JASA");
      if (mutasiLdJasaComp) mutasiLdJasaComp.defaultValue = 620000;
      const builtMutasi = buildTemplateFromVehicleDraft(DEFAULT_R2_MUTASI_LD_TEMPLATE, draftWithEditedJasa);
      assert.strictEqual(builtMutasi.error, undefined);
      assert.strictEqual(builtMutasi.template?.biayaJasa, 620000);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. WORKSTREAM E: Canonical R2 Annual Fee (Rp 200.000 — PO Decision 2)
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("E. Canonical Perpanjangan 1 Tahun R2 service fee = Rp 200.000 & overrides preserved", async () => {
      assert.strictEqual(DEFAULT_R2_ANNUAL_TEMPLATE.biayaJasa, 200000);
      assert.strictEqual(SERVICE_STANDARD_BASELINES["Perpanjangan 1 Tahun"].jasaR2, 200000);
      assert.strictEqual(getStandardJasa("Perpanjangan 1 Tahun", "Motor"), 200000);
      assert.strictEqual(getStandardJasa("Perpanjangan 1 Tahun", "Mobil"), 250000);
      assert.strictEqual(DEFAULT_R4_ANNUAL_TEMPLATE.biayaJasa, 250000);
      assert.strictEqual(DEFAULT_R4_MUTASI_LD_TEMPLATE.biayaJasa, 1500000);
      assert.strictEqual(DEFAULT_R2_MUTASI_LD_TEMPLATE.biayaJasa, 500000);

      // Exact BuatOrder R2 Perpanjangan 1 Tahun fee + estimation calculation path uses canonical Rp 200.000
      const freshFeeConfig = pricingStore.getServiceFeeConfig("Perpanjangan 1 Tahun", "samsat-r2-canonical-fresh");
      const r2Template = estimationStore.getTemplate("template-pajak-tahunan-r2") || DEFAULT_R2_ANNUAL_TEMPLATE;
      const standardBaselineR2 = getStandardJasa("Perpanjangan 1 Tahun", "Motor");
      const resolvedDefault = resolveServiceFee({
        serviceName: "Perpanjangan 1 Tahun",
        vehicleType: "Motor",
        samsatName: "Samsat Baru",
        feeConfig: freshFeeConfig,
        kondisiBerkas: "LENGKAP",
        templateBiayaJasa: r2Template.biayaJasa,
        standardBaselineJasa: standardBaselineR2,
      });
      assert.strictEqual(resolvedDefault.effectiveJasa, 200000, "Default R2 Annual service fee must be Rp 200.000");

      const buatOrderR2Estimation = calculateEstimation(
        {
          serviceType: "Tahunan",
          vehicleType: "Motor",
          pkb: 250000,
          dueDate: "2026-10-01",
          estimateDate: "2026-10-01",
          programSamsat: "NORMAL",
          kondisiBerkas: "LENGKAP",
          wilayahAccId: "NON ACC ID",
          overrideBiayaJasa: resolvedDefault.effectiveJasa,
        },
        r2Template
      );
      const jasaCompResult = buatOrderR2Estimation.items.find((c) => c.category === "JASA");
      assert.strictEqual(
        jasaCompResult?.amount,
        200000,
        "BuatOrder R2 Annual estimation JASA must equal canonical Rp 200.000"
      );

      // Valid custom Samsat R2 override MUST still override cleanly
      const customSamsatConfig = pricingStore.getServiceFeeConfig("perpanjangan-1-tahun", "samsat-jakarta-timur");
      const customResolved = resolveServiceFee({
        serviceName: "Perpanjangan 1 Tahun",
        vehicleType: "Motor",
        templateBiayaJasa: r2Template.biayaJasa,
        standardBaselineJasa: standardBaselineR2,
        feeConfig: {
          ...customSamsatConfig,
          biayaJasaR2: 235000,
          jasaR2Enabled: true,
        },
      });
      assert.strictEqual(customResolved.effectiveJasa, 235000, "Custom per-Samsat R2 fee must still be honored");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. WORKSTREAM F: Ringkasan Parameter Lookups & CalculationExplanationModal IDs
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("F. Ringkasan lookups match real component ruleIds & CalculationExplanationModal uses canonical IDs", () => {
      const checkTemplates = [
        { tpl: DEFAULT_R4_ANNUAL_TEMPLATE, expectAdminStnk: false },
        { tpl: DEFAULT_R2_ANNUAL_TEMPLATE, expectAdminStnk: false },
        { tpl: DEFAULT_R4_5YEAR_TEMPLATE, expectAdminStnk: true },
        { tpl: DEFAULT_R4_BBN_TEMPLATE, expectAdminStnk: true },
        { tpl: DEFAULT_R4_MUTASI_AS_TEMPLATE, expectAdminStnk: true },
        { tpl: DEFAULT_R4_MUTASI_LD_TEMPLATE, expectAdminStnk: true },
      ];

      for (const { tpl, expectAdminStnk } of checkTemplates) {
        const cloned = cloneJson(tpl);
        const swdRule = findSummaryComponentRule(cloned.components, "SWDKLLJ_POKOK");
        assert.ok(swdRule, `${tpl.id} must resolve SWDKLLJ_POKOK rule`);
        swdRule.isActive = false;
        swdRule.includesInTotal = false;
        const foundSwdAfter = findSummaryComponentRule(cloned.components, "SWDKLLJ_POKOK");
        assert.strictEqual(foundSwdAfter?.isActive, false);
        assert.strictEqual(foundSwdAfter?.includesInTotal, false);

        if (tpl.biayaCetakSkp > 0) {
          const skpRule = findSummaryComponentRule(cloned.components, "CETAK_SKP");
          assert.ok(skpRule, `${tpl.id} must resolve CETAK_SKP rule`);
          skpRule.isActive = false;
          assert.strictEqual(findSummaryComponentRule(cloned.components, "CETAK_SKP")?.isActive, false);
        }

        if (expectAdminStnk) {
          const stnkRule = findSummaryComponentRule(cloned.components, "ADMIN_STNK");
          const tnkbRule = findSummaryComponentRule(cloned.components, "ADMIN_TNKB");
          assert.ok(stnkRule, `${tpl.id} must resolve ADMIN_STNK rule`);
          assert.ok(tnkbRule, `${tpl.id} must resolve ADMIN_TNKB rule`);
          stnkRule.includesInTotal = false;
          tnkbRule.isActive = false;
          assert.strictEqual(findSummaryComponentRule(cloned.components, "ADMIN_STNK")?.includesInTotal, false);
          assert.strictEqual(findSummaryComponentRule(cloned.components, "ADMIN_TNKB")?.isActive, false);
        }
      }

      // Verify canonical resolution across all 5 service types x Mobil/Motor
      const canonicalPairs: Array<[string, "Mobil" | "Motor", string]> = [
        ["Perpanjangan 1 Tahun", "Mobil", "template-pajak-tahunan-r4"],
        ["Perpanjangan 1 Tahun", "Motor", "template-pajak-tahunan-r2"],
        ["Perpanjangan 5 Tahun", "Mobil", "template-pajak-5-tahun-r4"],
        ["Perpanjangan 5 Tahun", "Motor", "template-pajak-5-tahun-r2"],
        ["Balik Nama", "Mobil", "template-bbn-r4"],
        ["Balik Nama", "Motor", "template-bbn-r2"],
        ["Mutasi Antar Samsat", "Mobil", "template-mutasi-as-r4"],
        ["Mutasi Antar Samsat", "Motor", "template-mutasi-as-r2"],
        ["Mutasi Luar Daerah", "Mobil", "template-mutasi-ld-r4"],
        ["Mutasi Luar Daerah", "Motor", "template-mutasi-ld-r2"],
      ];
      const validIds = new Set(ALL_DEFAULT_TEMPLATES.map((t) => t.id));
      for (const [svc, veh, expectedId] of canonicalPairs) {
        const resolved = resolveTemplateIdByService(svc, veh);
        assert.strictEqual(resolved, expectedId);
        assert.ok(validIds.has(resolved), `${resolved} must exist in ALL_DEFAULT_TEMPLATES`);
      }

      // Ensure CalculationExplanationModal no longer contains any legacy typo template IDs
      const modalSrc = fs.readFileSync(
        path.resolve(currentDir, "../src/app/components/estimation/CalculationExplanationModal.tsx"),
        "utf8"
      );
      for (const typo of [
        "template-5-tahunan",
        "template-mutasi-antar-samsat",
        "template-mutasi-luar-r",
      ]) {
        assert.ok(!modalSrc.includes(typo), `CalculationExplanationModal must not contain typo ID '${typo}'`);
      }
      assert.ok(
        modalSrc.includes("resolveTemplateIdByService"),
        "CalculationExplanationModal must use canonical resolveTemplateIdByService"
      );
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. WORKSTREAM G (ISS-1): Pricing Config Hydration & Defensive Components
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("G. ISS-1: Pricing hydration preserves valid components[] and survives undefined/malformed API rows", async () => {
      const savedProvider = pricingRepository;
      void savedProvider;
      const originalSyncConfigs = apiPricing.getServiceConfigs();

      try {
        // Test 1: API returns rows with components === undefined -> falls back to default array (both empty-default 1th & multi-component mutasi)
        const rowUndefinedComponents = cloneJson(
          originalSyncConfigs.find((c: any) => c.serviceId === "svc-perp-1th") || {
            id: "cfg-iss1-1",
            serviceId: "svc-perp-1th",
            serviceName: "Perpanjangan 1 Tahun",
            samsatId: "samsat-jakarta-timur",
            wilayah: "Jakarta Timur",
            biayaJasa: 250000,
            biayaAntarJemput: 50000,
          }
        );
        delete rowUndefinedComponents.components;

        const rowMutasiUndefinedComponents = {
          ...cloneJson(rowUndefinedComponents),
          id: "svc-mut-antar:samsat-jakarta-timur",
          serviceId: "mutasi-antar-samsat",
          serviceName: "Mutasi Antar Samsat",
          samsatId: "samsat-jakarta-timur",
          wilayah: "Jakarta Timur",
          biayaJasa: 800000,
        };
        delete rowMutasiUndefinedComponents.components;

        // Test 2: API returns row with explicit custom components[] -> preserved intact
        const customComps = [
          { pricingItemId: "item-pajak-1th", enabled: true, required: true },
          { pricingItemId: "item-cetak-stnk", enabled: true, required: false },
        ];
        const rowCustomComponents = {
          ...cloneJson(rowUndefinedComponents),
          id: "perpanjangan-5-tahun:samsat-jakarta-barat",
          serviceId: "perpanjangan-5-tahun",
          serviceName: "Perpanjangan 5 Tahun",
          samsatId: "samsat-jakarta-barat",
          wilayah: "Jakarta Barat",
          biayaJasa: 500000,
          components: customComps,
        };

        // Test 3: API returns row with malformed non-array components -> sanitized fallback array
        const rowMalformedComponents: any = {
          ...cloneJson(rowUndefinedComponents),
          id: "balik-nama:samsat-bekasi",
          serviceId: "balik-nama",
          serviceName: "Balik Nama",
          samsatId: "samsat-bekasi",
          wilayah: "Bekasi",
          biayaJasa: 1200000,
          components: "corrupted-non-array",
        };

        // Test 4: Re-sync preserves Samsat price overrides alongside normalized components
        const rowCustomSamsatOverride = {
          ...cloneJson(rowUndefinedComponents),
          id: "perpanjangan-1-tahun:samsat-depok",
          serviceId: "perpanjangan-1-tahun",
          serviceName: "Perpanjangan 1 Tahun",
          samsatId: "samsat-depok",
          wilayah: "Depok",
          biayaJasa: 310000,
          biayaJasaR4: 310000,
          biayaJasaR2: 245000,
          biayaAntarJemput: 65000,
          components: undefined,
        };

        const mockProvider = Object.assign(
          Object.create(Object.getPrototypeOf(apiPricing)),
          apiPricing,
          {
            getServiceConfigs: () => [
              rowUndefinedComponents,
              rowMutasiUndefinedComponents,
              rowCustomComponents,
              rowMalformedComponents,
              rowCustomSamsatOverride,
            ],
          }
        ) as any;
        pricingRepository.setProvider(mockProvider);
        pricingStore.syncFromRepository();

        // Assertions for Cases 1-4
        const rawStoredLegacy = (pricingStore as any).serviceConfigs.get(rowUndefinedComponents.id);
        assert.ok(rawStoredLegacy && Array.isArray(rawStoredLegacy.components), "Case 1a: legacy DB row components must be normalized array when API omits components");

        const hydrated1 = pricingStore.getServiceFeeConfig(
          rowUndefinedComponents.serviceId,
          rowUndefinedComponents.samsatId
        );
        assert.ok(hydrated1 && Array.isArray(hydrated1.components), "Case 1b: getServiceFeeConfig components must be array");

        const hydratedMutasi = pricingStore.getServiceFeeConfig("mutasi-antar-samsat", "samsat-jakarta-timur");
        assert.ok(hydratedMutasi && Array.isArray(hydratedMutasi.components) && hydratedMutasi.components.length > 0, "Case 1c: Mutasi default components must be populated when API omits components");

        const hydrated2 = pricingStore.getServiceFeeConfig("perpanjangan-5-tahun", "samsat-jakarta-barat");
        assert.ok(hydrated2 && Array.isArray(hydrated2.components));
        assert.deepStrictEqual(
          hydrated2.components.map((c) => c.pricingItemId),
          ["item-pajak-1th", "item-cetak-stnk"],
          "Case 2: explicit custom API components[] must NOT be overwritten"
        );

        const hydrated3 = pricingStore.getServiceFeeConfig("balik-nama", "samsat-bekasi");
        assert.ok(hydrated3 && Array.isArray(hydrated3.components) && hydrated3.components.length > 0, "Case 3: malformed non-array components must fall back cleanly to valid array");

        const hydrated4 = pricingStore.getServiceFeeConfig("perpanjangan-1-tahun", "samsat-depok");
        assert.ok(hydrated4 && Array.isArray(hydrated4.components));
        assert.strictEqual(hydrated4.biayaJasa, 310000);
        assert.strictEqual(hydrated4.biayaJasaR2, 245000);
        assert.strictEqual(hydrated4.biayaAntarJemput, 65000);

        // Test 5: Store consumers & BiayaLayanan component resolution stay crash-free
        const samsatComps = pricingStore.getSamsatComponentsForService("svc-perp-1th", "samsat-depok");
        assert.ok(Array.isArray(samsatComps) && samsatComps.length > 0, "Case 5a: getSamsatComponentsForService works after hydration");

        assert.doesNotThrow(() => {
          pricingStore.toggleComponent("svc-perp-1th", "samsat-depok", pricingStore.getMasterPricingItems()[0]?.id || "pkb", true);
          pricingStore.calculateOrderCost({
            serviceId: "svc-perp-1th",
            samsatId: "samsat-depok",
            vehicleType: "Motor",
          });
        }, "Case 5b: toggleComponent and calculateOrderCost must never crash on undefined components");

        // Test 6: applyConfigToAllSamsats handles corrupted in-memory config & preserves custom R2 overrides
        const targetCfg = pricingStore.getServiceFeeConfig("svc-perp-1th", "samsat-depok");
        assert.ok(targetCfg);
        (targetCfg as any).components = undefined; // force legacy runtime corruption
        const batchRes = await pricingStore.applyConfigToAllSamsats(
          "Perpanjangan 1 Tahun",
          {
            biayaJasaLengkap: 250000,
            jasaLengkapEnabled: true,
            biayaJasaNembak: 0,
            jasaNembakEnabled: false,
            biayaAntarJemput: 50000,
            antarJemputEnabled: true,
            nominalSwdkllj: 143000,
            swdklljEnabled: true,
            components: { [pricingStore.getMasterPricingItems()[0]?.id || "pkb"]: true },
          },
          {
            applyBiayaLayanan: true,
            applyBiayaTambahan: true,
            applyKomponenSamsat: true,
            applyBiayaLainnya: false,
          },
          "PRESERVE_EXISTING_CUSTOM"
        );
        assert.ok(batchRes.totalCount > 0);
        assert.strictEqual(
          pricingStore.getServiceFeeConfig("svc-perp-1th", "samsat-depok")?.biayaJasaR2,
          245000,
          "Case 6: PRESERVE_EXISTING_CUSTOM must preserve Samsat with custom R2 rate"
        );

        // Test 7: Simulated Modal 1 / Samsat Draft open + General Rules save flow after API hydration (no crash)
        const cfgAfter = pricingStore.getServiceFeeConfig(
          rowUndefinedComponents.serviceId,
          rowUndefinedComponents.samsatId
        );
        const selectedMap: Record<string, boolean> = {};
        for (const item of pricingStore.getMasterPricingItems()) {
          const matched = (Array.isArray(cfgAfter?.components) ? cfgAfter.components : []).find(
            (sc) => sc.pricingItemId === item.id
          );
          selectedMap[item.id] = matched ? matched.enabled : false;
        }
        const openAndSaveRes = await executeGeneralRulesSave({
          currentLayanan: "Perpanjangan 1 Tahun",
          mobilBaseTemplate: estimationStore.getTemplate("template-pajak-tahunan-r4"),
          motorBaseTemplate: estimationStore.getTemplate("template-pajak-tahunan-r2"),
          mobilDraft: buildDraftFromTemplate(estimationStore.getTemplate("template-pajak-tahunan-r4")),
          motorDraft: buildDraftFromTemplate(estimationStore.getTemplate("template-pajak-tahunan-r2")),
          selectedComponents: selectedMap,
          deps: {
            updateTemplateAsync: async (tpl) => ({ success: true, template: tpl }),
            applyConfigToAllSamsats: async () => undefined,
          },
        });
        assert.strictEqual(openAndSaveRes.success, true, "Case 7: General Rules open & save works seamlessly after API hydration without components");
      } finally {
        pricingRepository.setProvider(apiPricing);
        await apiPricing.initFromApi();
        await pricingStore.initFromApi();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. WORKSTREAM H (ISS-2): EstimationStore Concurrent Write Queue Serialization
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("H. ISS-2: EstimationStore serializes concurrent writes per templateId with zero lost updates", async () => {
      const originalFetch = globalThis.fetch;

      const createDeferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      };

      const makeMockServerState = () => {
        const state = new Map<string, EstimationTemplateConfig>();
        for (const tpl of ALL_DEFAULT_TEMPLATES) {
          state.set(tpl.id, cloneJson(tpl));
        }
        return state;
      };

      try {
        // Scenario 1: Concurrent 3-field writes on same templateId -> maxConcurrentPuts===1 & all 3 preserved
        {
          await estimationStore.resetToDefaultAsync("template-pajak-tahunan-r4");
          const serverDb = makeMockServerState();
          let inFlight = 0;
          let maxConcurrentPuts = 0;
          const p1Gate = createDeferred();
          let putIndex = 0;

          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            const method = (init?.method || "GET").toUpperCase();
            if (method === "PUT" && url.includes("/api/estimation/templates/")) {
              const id = decodeURIComponent(url.split("/api/estimation/templates/")[1]);
              inFlight++;
              maxConcurrentPuts = Math.max(maxConcurrentPuts, inFlight);
              const thisCall = ++putIndex;
              if (thisCall === 1) {
                await p1Gate.promise;
              } else {
                await new Promise((r) => setTimeout(r, 10));
              }
              const payload = JSON.parse(String(init?.body || "{}"));
              serverDb.set(id, payload);
              inFlight--;
              return new Response(JSON.stringify({ success: true, data: payload }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return originalFetch(input, init);
          }) as typeof fetch;

          const p1 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { koefisienDenda: 0.6 });
          const p2 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 333000 });
          const p3 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaCetakSkp: 222000 });

          await new Promise((r) => setTimeout(r, 15));
          assert.strictEqual(putIndex, 1, "Scenario 1: PUT #2 and #3 must wait in queue while PUT #1 is in flight");
          p1Gate.resolve();

          const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
          assert.ok(r1.success && r2.success && r3.success);
          assert.strictEqual(maxConcurrentPuts, 1, "Scenario 1: maxConcurrentPuts for same templateId must equal 1");
          assert.strictEqual(putIndex, 3);

          const finalStoreTpl = estimationStore.getTemplate("template-pajak-tahunan-r4");
          const finalServerTpl = serverDb.get("template-pajak-tahunan-r4")!;
          for (const target of [finalStoreTpl, finalServerTpl]) {
            assert.strictEqual(target.koefisienDenda, 0.6, "P1 koefisienDenda must survive");
            assert.strictEqual(target.biayaJasa, 333000, "P2 biayaJasa must survive");
            assert.strictEqual(target.biayaCetakSkp, 222000, "P3 biayaCetakSkp must survive");
          }
        }

        // Scenario 2: Independent templateIds do NOT block each other
        {
          const completionOrder: string[] = [];
          const r4Gate = createDeferred();

          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            const method = (init?.method || "GET").toUpperCase();
            if (method === "PUT" && url.includes("/api/estimation/templates/")) {
              const id = decodeURIComponent(url.split("/api/estimation/templates/")[1]);
              if (id === "template-pajak-tahunan-r4") {
                await r4Gate.promise;
              }
              const payload = JSON.parse(String(init?.body || "{}"));
              completionOrder.push(id);
              return new Response(JSON.stringify({ success: true, data: payload }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return originalFetch(input, init);
          }) as typeof fetch;

          const pR4 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 265000 });
          const pR2 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r2", { biayaJasa: 215000 });

          const r2Res = await pR2;
          assert.ok(r2Res.success, "Scenario 2: independent R2 write must complete without waiting for R4");
          assert.deepStrictEqual(completionOrder, ["template-pajak-tahunan-r2"]);
          r4Gate.resolve();
          const r4Res = await pR4;
          assert.ok(r4Res.success);
          assert.deepStrictEqual(completionOrder, ["template-pajak-tahunan-r2", "template-pajak-tahunan-r4"]);
        }

        // Scenario 3: Failed P1 followed by succeeding P2 recovers cleanly without poisoning queue
        {
          let callIdx = 0;
          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            callIdx++;
            if (callIdx === 1) {
              return new Response(JSON.stringify({ success: false, message: "Injected 500 failure" }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              });
            }
            const payload = JSON.parse(String(init?.body || "{}"));
            return new Response(JSON.stringify({ success: true, data: payload }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch;

          const failP1 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 999000 });
          const okP2 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 345000 });
          const [res1, res2] = await Promise.all([failP1, okP2]);
          assert.strictEqual(res1.success, false, "Scenario 3: failed P1 must report failure");
          assert.strictEqual(res2.success, true, "Scenario 3: queued P2 must still execute and succeed");
          assert.strictEqual(estimationStore.getTemplate("template-pajak-tahunan-r4").biayaJasa, 345000);
          assert.strictEqual(estimationStore.isSaving(), false, "isSaving must clear after queue drains");
        }

        // Scenario 4: Sequential overlapping updates to the SAME field -> deterministic FIFO winner
        {
          let concurrent = 0;
          let maxConcurrent = 0;
          globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.toString();
            const method = (init?.method || "GET").toUpperCase();
            if (method === "PUT" && url.includes("/api/estimation/templates/")) {
              concurrent++;
              maxConcurrent = Math.max(maxConcurrent, concurrent);
              await new Promise((r) => setTimeout(r, concurrent === 1 ? 20 : 5));
              concurrent--;
              const payload = JSON.parse(String(init?.body || "{}"));
              return new Response(JSON.stringify({ success: true, data: payload }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch;

          const s1 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 280000 });
          const s2 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { biayaJasa: 320000 });
          await Promise.all([s1, s2]);
          assert.strictEqual(maxConcurrent, 1);
          assert.strictEqual(estimationStore.getTemplate("template-pajak-tahunan-r4").biayaJasa, 320000, "Scenario 4: FIFO second update must be final value");
        }

        // Scenario 5: Mixed concurrent param + component toggle + component rule update -> zero lost updates
        {
          const tplBefore = estimationStore.getTemplate("template-pajak-tahunan-r4");
          const firstCompId = tplBefore.components[0]?.id;
          const secondCompId = tplBefore.components[1]?.id || firstCompId;
          const expectedActiveAfterToggle = !tplBefore.components[0].isActive;

          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            await new Promise((r) => setTimeout(r, 8));
            const payload = JSON.parse(String(init?.body || "{}"));
            return new Response(JSON.stringify({ success: true, data: payload }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch;

          const m1 = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", { pembagiBulan: 10 });
          const m2 = estimationStore.toggleComponentAsync("template-pajak-tahunan-r4", firstCompId);
          const m3 = estimationStore.updateComponentRuleAsync("template-pajak-tahunan-r4", secondCompId, { defaultValue: 99000 });

          const [mr1, mr2, mr3] = await Promise.all([m1, m2, m3]);
          assert.ok(mr1.success && mr2.success && mr3.success);
          const merged = estimationStore.getTemplate("template-pajak-tahunan-r4");
          assert.strictEqual(merged.pembagiBulan, 10, "Scenario 5: param update preserved");
          assert.strictEqual(
            merged.components.find((c) => c.id === firstCompId)?.isActive,
            expectedActiveAfterToggle,
            "Scenario 5: component toggle preserved"
          );
          assert.strictEqual(
            merged.components.find((c) => c.id === secondCompId)?.defaultValue,
            99000,
            "Scenario 5: component rule update preserved"
          );
        }

        // Scenario 6: Failed P2 must NOT roll back / clobber already-committed P1
        {
          let step = 0;
          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            step++;
            if (step === 1) {
              const payload = JSON.parse(String(init?.body || "{}"));
              return new Response(JSON.stringify({ success: true, data: payload }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({ success: false, message: "DB error" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }) as typeof fetch;

          const pOk = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", {
            koefisienDenda: 0.55,
            biayaJasa: 250000,
          });
          const pErr = estimationStore.updateTemplateParamsAsync("template-pajak-tahunan-r4", {
            biayaJasa: 999999,
          });
          const [rOk, rErr] = await Promise.all([pOk, pErr]);
          assert.strictEqual(rOk.success, true);
          assert.strictEqual(rErr.success, false);
          const stable = estimationStore.getTemplate("template-pajak-tahunan-r4");
          assert.strictEqual(stable.koefisienDenda, 0.55, "Scenario 6: earlier committed koefisienDenda must NOT be rolled back");
          assert.strictEqual(stable.biayaJasa, 250000, "Scenario 6: rejected P2 value must NOT remain in store");
        }
      } finally {
        globalThis.fetch = originalFetch;
        await estimationStore.resetToDefaultAsync();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. WORKSTREAM I (Limited UI Lock): Saving Locks Across Config Views
    // ─────────────────────────────────────────────────────────────────────────
    await t.test("I. UI saving locks guard close, vehicle tabs, inputs & switches during async saves", () => {
      const biayaSrc = fs.readFileSync(
        path.resolve(currentDir, "../src/app/components/BiayaLayanan.tsx"),
        "utf8"
      );
      assert.ok(
        biayaSrc.includes("if (!isSavingGeneralRules) setIsGeneralRulesOpen(open)"),
        "BiayaLayanan Modal 1 Dialog must block close while saving"
      );
      assert.ok(
        biayaSrc.includes("disabled={isSavingGeneralRules}"),
        "BiayaLayanan Modal 1 controls must lock while saving"
      );

      const r4Src = fs.readFileSync(
        path.resolve(currentDir, "../src/app/components/estimation/EstimatorR4Tahunan.tsx"),
        "utf8"
      );
      assert.ok(r4Src.includes("if (!isSavingConfig) setIsConfigOpen(open)"));
      assert.ok(r4Src.includes("disabled={isSavingConfig}"));

      const r2Src = fs.readFileSync(
        path.resolve(currentDir, "../src/app/components/estimation/EstimatorR2Tahunan.tsx"),
        "utf8"
      );
      assert.ok(r2Src.includes("if (!isSavingConfig) setIsConfigOpen(open)"));
      assert.ok(r2Src.includes("disabled={isSavingConfig}"));

      const masterSrc = fs.readFileSync(
        path.resolve(currentDir, "../src/app/components/estimation/EstimationMasterManager.tsx"),
        "utf8"
      );
      assert.ok(masterSrc.includes("const [isSaving, setIsSaving] = useState(false)"));
      assert.ok(masterSrc.includes("disabled={isSaving}"));
    });
  } finally {
    process.env.AUTH_TOKEN = prevToken;
    pricingRepository.setProvider(new ApiPricingProvider());
    server.close();
  }
});
