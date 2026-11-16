import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  isValidCalendarDate,
  normalizeOrderCalendarDate,
  validateSamsatScheduleDates,
} from "../src/app/utils/orderDateUtils";

test("Order Date Normalization — WIB & Flexible Formats", async (t) => {
  await t.test("preserves pure calendar dates without timezone drift", () => {
    assert.equal(normalizeOrderCalendarDate("2026-11-14"), "2026-11-14");
    assert.equal(normalizeOrderCalendarDate("2026/11/7"), "2026-11-07");
    assert.equal(normalizeOrderCalendarDate("14/11/2026"), "2026-11-14");
    assert.equal(normalizeOrderCalendarDate("7-11-2026"), "2026-11-07");
    assert.equal(normalizeOrderCalendarDate("14/11/2026 09:30"), "2026-11-14");
  });

  await t.test("parses Indonesian and English named month dates", () => {
    assert.equal(normalizeOrderCalendarDate("13 Nov 2026"), "2026-11-13");
    assert.equal(normalizeOrderCalendarDate("17 Agt 2026"), "2026-08-17");
    assert.equal(normalizeOrderCalendarDate("1 Mei 2026"), "2026-05-01");
    assert.equal(normalizeOrderCalendarDate("25 Desember 2026"), "2026-12-25");
    assert.equal(normalizeOrderCalendarDate("Nov 14, 2026"), "2026-11-14");
  });

  await t.test("normalizes ISO UTC instants and SQLite timestamps to Asia/Jakarta (WIB)", () => {
    // 12:15 UTC -> 19:15 WIB same day
    assert.equal(normalizeOrderCalendarDate("2026-11-07T12:15:51.148Z"), "2026-11-07");
    // 17:30 UTC -> 00:30 WIB next day (fixes naive .split('T')[0] off-by-one bug)
    assert.equal(normalizeOrderCalendarDate("2026-11-07T17:30:00.000Z"), "2026-11-08");
    // SQLite UTC timestamp after 17:00 UTC
    assert.equal(normalizeOrderCalendarDate("2026-11-07 18:00:00"), "2026-11-08");
  });

  await t.test("rejects non-existent calendar dates and corrupt placeholders", () => {
    assert.equal(isValidCalendarDate(2026, 2, 29), false);
    assert.equal(isValidCalendarDate(2024, 2, 29), true);
    assert.equal(normalizeOrderCalendarDate("2026-02-30"), null);
    assert.equal(normalizeOrderCalendarDate("31/02/2026"), null);
    assert.equal(normalizeOrderCalendarDate("-"), null);
    assert.equal(normalizeOrderCalendarDate(""), null);
    assert.equal(normalizeOrderCalendarDate(null), null);
    assert.equal(normalizeOrderCalendarDate("not-a-date"), null);
  });
});

test("Stage 4 Samsat Schedule Date Validation", async (t) => {
  await t.test("accepts valid schedule date when tanggalMasukBerkas uses DD/MM/YYYY or ISO UTC", () => {
    const resDmy = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "07/11/2026",
      today: "2026-11-14",
    });
    assert.deepEqual(resDmy, {
      valid: true,
      normalizedProsesDate: "2026-11-14",
      normalizedMasukDate: "2026-11-07",
    });

    const resSqlite = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "2026-11-07 12:15:51",
      today: "2026-11-14",
    });
    assert.deepEqual(resSqlite, {
      valid: true,
      normalizedProsesDate: "2026-11-14",
      normalizedMasukDate: "2026-11-07",
    });
  });

  await t.test("allows empty/null/undefined tanggalMasukBerkas without fabricating a date", () => {
    for (const emptyVal of [undefined, null, "", "   "]) {
      const res = validateSamsatScheduleDates({
        tanggalProsesSamsat: "2026-11-14",
        tanggalMasukBerkas: emptyVal,
        today: "2026-11-14",
      });
      assert.deepEqual(res, {
        valid: true,
        normalizedProsesDate: "2026-11-14",
        normalizedMasukDate: null,
      });
    }
  });

  await t.test("fails explicitly when non-empty tanggalMasukBerkas is corrupt/invalid", () => {
    const res = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "31/02/2026",
      today: "2026-11-14",
    });
    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.match(res.message, /Format tanggal berkas diterima tidak valid/);
      assert.match(res.message, /31\/02\/2026/);
    }
  });

  await t.test("enforces WIB midnight boundary correctly against tanggalMasukBerkas", () => {
    // Received at 2026-11-13T18:00:00.000Z => 2026-11-14 01:00 WIB -> process on 2026-11-14 is valid
    const sameWibDay = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "2026-11-13T18:00:00.000Z",
      today: "2026-11-14",
    });
    assert.equal(sameWibDay.valid, true);

    // Received at 2026-11-14T18:00:00.000Z => 2026-11-15 01:00 WIB -> scheduling for 2026-11-14 fails!
    const beforeWibDay = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "2026-11-14T18:00:00.000Z",
      today: "2026-11-14",
    });
    assert.equal(beforeWibDay.valid, false);
    if (!beforeWibDay.valid) {
      assert.match(beforeWibDay.message, /2026-11-15/);
    }
  });

  await t.test("rejects past date, empty target date, or date earlier than tanggalMasukBerkas", () => {
    const missing = validateSamsatScheduleDates({
      tanggalProsesSamsat: "",
      tanggalMasukBerkas: "2026-11-01",
      today: "2026-11-14",
    });
    assert.equal(missing.valid, false);

    const beforeToday = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-13",
      tanggalMasukBerkas: "2026-11-01",
      today: "2026-11-14",
    });
    assert.equal(beforeToday.valid, false);
    if (!beforeToday.valid) {
      assert.match(beforeToday.message, /tidak boleh sebelum hari ini/);
    }

    const beforeBerkas = validateSamsatScheduleDates({
      tanggalProsesSamsat: "2026-11-14",
      tanggalMasukBerkas: "20/11/2026",
      today: "2026-11-14",
    });
    assert.equal(beforeBerkas.valid, false);
    if (!beforeBerkas.valid) {
      assert.match(beforeBerkas.message, /2026-11-20/);
    }
  });
});

test("OrderTracking Workflow Popup Cleanup & Transition Invariants", () => {
  const orderTrackingPath = path.resolve(
    process.cwd(),
    "src/app/components/OrderTracking.tsx"
  );
  const src = fs.readFileSync(orderTrackingPath, "utf8");

  // Stage 2: removed note field & direct advance button inside popup; kept scheduling fields & table pickup gate
  assert.equal(src.includes("Catatan Penjemputan (Opsional)"), false);
  assert.equal(src.includes("Simpan Jadwal & Lanjut ke Verifikasi Dokumen"), false);
  assert.equal(src.includes("handleSaveScheduleAndAdvance"), false);
  assert.ok(src.includes("Tanggal Jemput Dokumen"));
  assert.ok(src.includes("Tugaskan Messenger"));
  assert.ok(src.includes("Simpan Jadwal"));
  assert.ok(src.includes("handleAdvanceFromPickup(order)"));
  assert.ok(
    src.includes('order.pickupCompleted || order.messengerTaskStatus === "Dokumen Sudah Tersedia"'),
    "Stage 2 list advancement must remain gated on messenger pickup completion"
  );

  // Stage 4: removed Samsat scheduling note input; kept Samsat pickup notes on Stage 4b untouched
  assert.equal(src.includes("Catatan / Instruksi Samsat (Opsional)"), false);
  assert.ok(src.includes("Tanggal Mulai Proses Samsat"));
  assert.ok(src.includes("Tugaskan Messenger Samsat"));
  assert.ok(src.includes("Simpan Jadwal Samsat"));
  assert.ok(src.includes("Catatan / Instruksi Pengambilan (Opsional)"));
  assert.ok(src.includes("validateSamsatScheduleDates"));

  // Stage 5 & 6 (Verifikasi Ulang & Supervisi): removed document verification note inputs
  assert.equal(src.includes("Catatan Verifikasi Dokumen (Opsional)"), false);
  assert.equal(src.includes("Catatan Supervisor (Opsional)"), false);
  assert.ok(src.includes("Alasan / Sumber Status Pembayaran"));
  // Historical read-only notes preserved
  assert.ok(src.includes("docApprovalDetails.stage5Notes"));
  assert.ok(src.includes("docApprovalDetails.stage6Notes"));

  // Stage 7 (Pengantaran): removed delivery & direct handover note inputs; historical read-only display kept
  assert.equal(src.includes("Catatan Pengantaran (Opsional)"), false);
  assert.equal(src.includes("Catatan Serah Terima (Opsional)"), false);
  assert.ok(src.includes("Tanggal Pengantaran"));
  assert.ok(src.includes("selectedOrder.deliveryHandover?.notes"));
});
