import { loginSvp } from "./helpers/authHelper";
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3000";

test.describe("Phase 8.7: Global Table Layout & Employee Selectors", () => {
  test.beforeEach(async ({ page }) => {
    await loginSvp(page);
  });

  test("1. Global Table Layout: table container stretches to card bottom and anchors horizontal scrollbar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/finance/data-penjualan/mutasi-ld`);
    await page.waitForLoadState("domcontentloaded");

    const tableContainer = page.locator('[data-slot="table-container"]').first();
    await expect(tableContainer).toBeVisible();

    // Verify container has flex-1 and min-h-0 classes ensuring vertical stretch
    const className = await tableContainer.getAttribute("class");
    expect(className).toContain("flex-1");
    expect(className).toContain("min-h-0");
    expect(className).toContain("overflow-x-auto");

    // Check parent card bounds vs table container bounds
    const card = page.locator("div.border.bg-card").first();
    const cardBox = await card.boundingBox();
    const tableBox = await tableContainer.boundingBox();

    expect(cardBox).not.toBeNull();
    expect(tableBox).not.toBeNull();
    if (cardBox && tableBox) {
      expect(tableBox.height).toBeGreaterThan(150);
      expect(tableBox.y + tableBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 10);
    }
  });

  test("2. Kas Messenger: Dynamic messenger dropdown derived from active messengers only, sentence-case jenis", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/finance/kas-messenger`);
    await page.waitForLoadState("domcontentloaded");

    const tableContainer = page.locator('[data-slot="table-container"]');
    await expect(tableContainer).toBeVisible();

    // Open AddKasMessengerModal dialog
    await page.getByRole("button", { name: "Tambah" }).click();
    const dialog = page.locator("[role='dialog']").filter({ hasText: "Tambah Transaksi Kas Messenger" });
    await expect(dialog).toBeVisible();

    // Verify Jenis Kas select trigger has sentence-case options
    const jenisSelect = dialog.locator("button[role='combobox']").filter({ hasText: /Petty cash|Operasional|Biaya Samsat|Pilih jenis/ }).first();
    await expect(jenisSelect).toBeVisible();
    await jenisSelect.click();
    await expect(page.getByRole("option", { name: "Petty cash" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Operasional" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Biaya Samsat" })).toBeVisible();
    await page.getByRole("option", { name: "Petty cash" }).click();

    // Verify Nama Messenger combobox only lists live active messengers (never non-messengers)
    const messengerSelect = dialog.locator("button[role='combobox']").filter({ hasText: /Budi Santoso|Andi Pratama|Rudi Hartono|Pilih kurir/ }).first();
    await expect(messengerSelect).toBeVisible();
    await messengerSelect.click();
    await expect(page.getByRole("option", { name: "Budi Santoso" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Andi Pratama" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Admin Super (SVP)" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Finance User" })).toHaveCount(0);
    await page.getByRole("option", { name: "Budi Santoso" }).click();

    // Select Kas Masuk (Top-Up) with active Payment Method & submit cleanly against real backend
    await dialog.getByRole("button", { name: "Kas Masuk (Top-Up)" }).click();
    await dialog.locator("input[placeholder='0']").fill("75000");
    await dialog.locator("input[placeholder*='Top-up saldo']").fill("Top-up bensin operasional armada");

    const pmSelect = dialog.getByText("Pilih Metode Pembayaran (Tunai / Rekening Bank)...");
    await pmSelect.click();
    await page.getByRole("option").first().click();

    const createPromise = page.waitForResponse(
      (res) => res.url().includes("/api/finance/kas-messenger") && res.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: /Simpan Transaksi/i }).click();
    const createRes = await createPromise;
    expect(createRes.status()).toBe(201);
    await expect(dialog).toBeHidden({ timeout: 10000 });

    await expect(page.locator("table").getByText("Petty cash").first()).toBeVisible();
    await expect(page.locator("table").getByText("Budi Santoso").first()).toBeVisible();
  });

  test("3. Kas Kantor: Penanggung Jawab dropdown derived from non-messengers, historical '-' preservation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/finance/kas-kantor`);
    await page.waitForLoadState("domcontentloaded");

    const thPJ = page.getByRole("button", { name: /Penanggung jawab/i });
    await expect(thPJ).toBeVisible();

    // Open AddKasKantorModal dialog
    await page.getByRole("button", { name: "Tambah" }).click();
    const dialog = page.locator("[role='dialog']").filter({ hasText: "Tambah Transaksi Kas Kantor" });
    await expect(dialog).toBeVisible();

    // Verify Penanggung Jawab dropdown lists active non-messengers and excludes messengers
    const pjSelect = dialog.locator("button[role='combobox']").filter({ hasText: /Admin Super|Admin User|Finance User|Siti Nurhaliza|Pilih penanggung jawab/ }).first();
    await expect(pjSelect).toBeVisible();
    await pjSelect.click();
    await expect(page.getByRole("option", { name: "Admin Super (SVP)" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Finance User" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Budi Santoso" })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "Andi Pratama" })).toHaveCount(0);
    await page.getByRole("option", { name: "Admin Super (SVP)" }).click();

    // Fill transaction
    await dialog.getByRole("button", { name: "Debit (Masuk)" }).click();
    await dialog.locator("input[placeholder='0']").fill("150000");
    await dialog.locator("input[placeholder*='Penerimaan pembayaran']").fill("Penerimaan titipan berkas kantor");

    // Select Payment Method
    const pmSelect = dialog.getByText("Pilih Metode Pembayaran (Tunai / Rekening Bank)...");
    await pmSelect.click();
    await page.getByRole("option").first().click();

    await dialog.getByRole("button", { name: /Simpan Transaksi/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10000 });
    await expect(page.locator("table").getByText("Admin Super (SVP)").first()).toBeVisible();
  });

  test("4. Pengeluaran route consolidates into Kas Kantor Kredit with non-messenger Penanggung Jawab dropdown", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/finance/pengeluaran`);
    await page.waitForURL("**/finance/kas-kantor", { timeout: 10000 });
    await page.waitForLoadState("domcontentloaded");

    const thPJ = page.getByRole("button", { name: /Penanggung jawab/i });
    await expect(thPJ).toBeVisible();

    await page.getByRole("button", { name: "Tambah" }).click();
    const dialog = page.locator("[role='dialog']").filter({ hasText: "Tambah Transaksi Kas Kantor" });
    await expect(dialog).toBeVisible();

    // Verify non-messengers present, messengers excluded
    const pjSelect = dialog.locator("button[role='combobox']").filter({ hasText: /Admin Super|Admin User|Finance User|Siti Nurhaliza|Pilih penanggung jawab/ }).first();
    await pjSelect.click();
    await expect(page.getByRole("option", { name: "Finance User" })).toBeVisible();
    await expect(page.getByRole("option", { name: "Budi Santoso" })).toHaveCount(0);
    await page.getByRole("option", { name: "Finance User" }).click();

    // Record expense as Kredit (Keluar)
    await dialog.getByRole("button", { name: "Kredit (Keluar)" }).click();
    await dialog.locator("input[placeholder='0']").fill("250000");
    await dialog.locator("input[placeholder*='Penerimaan pembayaran']").fill("Pembelian token listrik kantor cabang");

    const pmSelect = dialog.getByText("Pilih Metode Pembayaran (Tunai / Rekening Bank)...");
    await pmSelect.click();
    await page.getByRole("option").first().click();

    await dialog.getByRole("button", { name: /Simpan Transaksi/i }).click();
    await expect(dialog).toBeHidden({ timeout: 10000 });
    await expect(page.locator("table").getByText("Finance User").first()).toBeVisible();
  });
});
