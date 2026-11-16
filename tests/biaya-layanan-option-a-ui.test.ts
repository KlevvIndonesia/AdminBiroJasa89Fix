import test from "node:test";
import assert from "node:assert/strict";
import {
  SERVICE_STANDARD_BASELINES,
  isRowCustomOrOverridden,
} from "../src/app/components/BiayaLayanan";

test("Biaya Layanan - Option A UI, Formula Display & Custom Tariff Filter", async (t) => {
  await t.test("1. Baselines defined for all canonical services", () => {
    const services = [
      "Perpanjangan 1 Tahun",
      "Perpanjangan 5 Tahun",
      "Mutasi Antar Samsat",
      "Mutasi Luar Daerah",
      "Balik Nama",
      "Tarik Berkas",
      "Duplikat STNK",
      "Lainnya",
    ];

    for (const s of services) {
      assert.ok(SERVICE_STANDARD_BASELINES[s], `Baseline should exist for ${s}`);
      assert.ok(typeof SERVICE_STANDARD_BASELINES[s].jasa === "number", `jasa should be number for ${s}`);
      assert.ok(typeof SERVICE_STANDARD_BASELINES[s].kurir === "number", `kurir should be number for ${s}`);
    }
  });

  await t.test("2. isRowCustomOrOverridden accurately detects default baseline rows", () => {
    const standardRow = {
      id: "row-1",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Samsat Jakarta Pusat",
      biayaJasaLengkap: 250000,
      biayaAntarJemput: 50000,
      pengurusanKhususEnabled: false,
      biayaLainnya: [],
    };

    assert.equal(isRowCustomOrOverridden(standardRow), false, "Standard baseline row should return false");
  });

  await t.test("3. isRowCustomOrOverridden detects custom Jasa or Kurir rates", () => {
    const customJasaRow = {
      id: "row-2",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Samsat Jakarta Timur",
      biayaJasaLengkap: 350000, // custom Jasa
      biayaAntarJemput: 50000,
      pengurusanKhususEnabled: false,
      biayaLainnya: [],
    };
    assert.equal(isRowCustomOrOverridden(customJasaRow), true, "Custom jasa should return true");

    const customKurirRow = {
      id: "row-3",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Samsat Kepulauan Seribu",
      biayaJasaLengkap: 250000,
      biayaAntarJemput: 100000, // custom Kurir
      pengurusanKhususEnabled: false,
      biayaLainnya: [],
    };
    assert.equal(isRowCustomOrOverridden(customKurirRow), true, "Custom kurir should return true");
  });

  await t.test("4. isRowCustomOrOverridden detects active Pengurusan Khusus or Biaya Lainnya", () => {
    const khususRow = {
      id: "row-4",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Samsat Bekasi",
      biayaJasaLengkap: 250000,
      biayaAntarJemput: 50000,
      pengurusanKhususEnabled: true, // Khusus active
      biayaLainnya: [],
    };
    assert.equal(isRowCustomOrOverridden(khususRow), true, "Active pengurusan khusus should return true");

    const extraFeesRow = {
      id: "row-5",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Samsat Depok",
      biayaJasaLengkap: 250000,
      biayaAntarJemput: 50000,
      pengurusanKhususEnabled: false,
      biayaLainnya: [
        { id: "bl-1", label: "Parkir Khusus Gedung", nominal: 10000, enabled: true },
      ],
    };
    assert.equal(isRowCustomOrOverridden(extraFeesRow), true, "Active extra custom fees should return true");
  });

  await t.test("5. Filtering logic correctly isolates only custom rows", () => {
    const dataset = [
      { id: "1", layanan: "Perpanjangan 1 Tahun", wilayah: "A", biayaJasaLengkap: 250000, biayaAntarJemput: 50000 },
      { id: "2", layanan: "Perpanjangan 1 Tahun", wilayah: "B", biayaJasaLengkap: 300000, biayaAntarJemput: 50000 },
      { id: "3", layanan: "Perpanjangan 1 Tahun", wilayah: "C", biayaJasaLengkap: 250000, biayaAntarJemput: 50000 },
      { id: "4", layanan: "Perpanjangan 1 Tahun", wilayah: "D", biayaJasaLengkap: 250000, biayaAntarJemput: 75000 },
    ];

    const customRows = dataset.filter((row) => isRowCustomOrOverridden(row));
    assert.equal(customRows.length, 2);
    assert.deepEqual(customRows.map((r) => r.id), ["2", "4"]);
  });

  await t.test("6. ISS-3: Motor (R2) standard rows do NOT false-flag as Tarif Khusus while overrides do", () => {
    // 1. R2 Perpanjangan 1 Tahun standard (biayaJasaR2 undefined & biayaJasa = R4 standard 250000) -> false
    const r2StandardImplicit = {
      id: "r2-std-1",
      layanan: "Perpanjangan 1 Tahun",
      wilayah: "Jakarta Barat",
      biayaJasa: 250000,
      biayaJasaLengkap: 250000,
      biayaJasaR4: 250000,
      biayaJasaR2: undefined,
      biayaAntarJemput: 50000,
    };
    assert.equal(
      isRowCustomOrOverridden(r2StandardImplicit, "Motor"),
      false,
      "Standard Motor R2 without explicit biayaJasaR2 must NOT be flagged Tarif Khusus"
    );

    // Explicitly matching R2 baseline Rp 200.000 -> false
    const r2StandardExplicit = {
      ...r2StandardImplicit,
      id: "r2-std-2",
      biayaJasaR2: 200000,
    };
    assert.equal(
      isRowCustomOrOverridden(r2StandardExplicit, "Motor"),
      false,
      "Standard Motor R2 with biayaJasaR2=200000 must NOT be flagged Tarif Khusus"
    );

    // 2. R2 Perpanjangan 1 Tahun explicit override -> true
    const r2Override = {
      ...r2StandardImplicit,
      id: "r2-ovr-1",
      biayaJasaR2: 240000,
    };
    assert.equal(
      isRowCustomOrOverridden(r2Override, "Motor"),
      true,
      "Motor R2 with overridden biayaJasaR2=240000 must be flagged Tarif Khusus"
    );

    // 3. R4 Perpanjangan 1 Tahun standard -> false
    assert.equal(
      isRowCustomOrOverridden(r2StandardImplicit, "Mobil"),
      false,
      "Standard Mobil R4 at Rp 250.000 must NOT be flagged Tarif Khusus"
    );

    // 4. R4 Perpanjangan 1 Tahun override -> true
    const r4Override = {
      ...r2StandardImplicit,
      id: "r4-ovr-1",
      biayaJasa: 350000,
      biayaJasaLengkap: 350000,
      biayaJasaR4: 350000,
    };
    assert.equal(
      isRowCustomOrOverridden(r4Override, "Mobil"),
      true,
      "Mobil R4 with overridden biayaJasaR4=350000 must be flagged Tarif Khusus"
    );

    // 5. Vehicle-specific filter count across 10 Samsat rows stays accurate
    const tenR2Rows = Array.from({ length: 10 }, (_, idx) => ({
      id: `samsat-${idx + 1}`,
      layanan: "Perpanjangan 1 Tahun",
      wilayah: `Samsat ${idx + 1}`,
      biayaJasa: idx === 0 ? 350000 : 250000, // Row 1 has R4 override only
      biayaJasaLengkap: idx === 0 ? 350000 : 250000,
      biayaJasaR4: idx === 0 ? 350000 : 250000,
      biayaJasaR2: undefined,
      biayaAntarJemput: 50000,
      khususR4Enabled: idx === 0 ? true : false,
    }));
    assert.equal(
      tenR2Rows.filter((r) => isRowCustomOrOverridden(r, "Motor")).length,
      0,
      "Filter count on Motor tab must be Berbeda 0 even if Mobil R4 has overrides"
    );
    assert.equal(
      tenR2Rows.filter((r) => isRowCustomOrOverridden(r, "Mobil")).length,
      1,
      "Filter count on Mobil tab must remain 1"
    );

    // 6. R2 change must NOT corrupt Mobil R4 classification
    assert.equal(
      isRowCustomOrOverridden(r2Override, "Mobil"),
      false,
      "Changing Motor R2 rate must NOT falsely flag standard Mobil R4 row as custom"
    );

    // 7. Per-Samsat override isolation on R2 (Jakarta Timur overridden, Jakarta Barat standard)
    const perSamsatDataset = [
      { ...r2StandardImplicit, id: "jaktim", wilayah: "Jakarta Timur", biayaJasaR2: 235000 },
      { ...r2StandardImplicit, id: "jakbar", wilayah: "Jakarta Barat", biayaJasaR2: undefined },
    ];
    const r2CustomOnly = perSamsatDataset.filter((r) => isRowCustomOrOverridden(r, "Motor"));
    assert.deepEqual(
      r2CustomOnly.map((r) => r.id),
      ["jaktim"],
      "Only Samsat with explicit R2 override should be matched on Motor custom filter"
    );
  });
});
