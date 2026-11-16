import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test.describe("Tahap 3 & Tahap 4 Comprehensive Verification", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "svp@birojasa.com", "admin123");
  });

  test("Tahap 4: Verify SPV Void Audit History Modal and Log Display", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/belum-bayar"; });
    await page.waitForURL("**/finance/belum-bayar", { timeout: 15000 });

    // Check "Log Audit Void" button
    const voidLogBtn = page.getByRole("button", { name: /Log Audit Void/i });
    await expect(voidLogBtn).toBeVisible({ timeout: 10000 });
    await voidLogBtn.click();

    // Verify Log Audit dialog
    await expect(page.locator("text=Log Audit Pembatalan Transaksi (Void & Storno Kas)")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: /Void Pembayaran Invoice/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Void Pencairan Cashback/i })).toBeVisible();

    // Switch to Cashback Void tab
    await page.getByRole("button", { name: /Void Pencairan Cashback/i }).click();

    // Close dialog
    await page.keyboard.press("Escape");
  });

  test("Tahap 3: Verify Multi-termin Installment and Real-time Calculator in Pelunasan Modal", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/belum-bayar"; });
    await page.waitForURL("**/finance/belum-bayar", { timeout: 15000 });

    const bayarButtons = page.locator("button", { hasText: "Bayar / Lunasi" });
    const count = await bayarButtons.count();
    if (count > 0) {
      await bayarButtons.first().click();

      // Verify modal elements
      await expect(page.locator("text=Catat Pembayaran / Pelunasan Tagihan")).toBeVisible({ timeout: 10000 });

      // Check Multi-termin options
      const fullBtn = page.getByRole("button", { name: /Lunasi Penuh/i });
      const partialBtn = page.getByRole("button", { name: /Cicilan \/ Termin Sebagian/i });
      await expect(fullBtn).toBeVisible();
      await expect(partialBtn).toBeVisible();

      // Check dynamic calculator
      await expect(page.locator("text=Sisa Tagihan Setelah Pembayaran Ini:")).toBeVisible();

      // Click partial installment toggle
      await partialBtn.click();

      // Close modal
      await page.keyboard.press("Escape");
    }
  });

  test("Tahap 4: Verify Profit Terpending Closing & Handover Action", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/profit-pending"; });
    await page.waitForURL("**/finance/profit-pending", { timeout: 15000 });

    // Verify integrated CSV/PDF export inside Table Settings
    const settingsBtn = page.locator("button[aria-label='Pengaturan tabel']");
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();
    const openExportBtn = page.getByRole("button", { name: /Buka dialog ekspor/i });
    await expect(openExportBtn).toBeVisible();
    await openExportBtn.click();
    await expect(page.getByText("Ekspor Data Profit Terpending")).toBeVisible();
    await expect(page.getByText("CSV / Excel")).toBeVisible();
    await page.keyboard.press("Escape");

    // Verify "Closing & Selesai" button exists
    const closingButtons = page.locator("button", { hasText: "Closing & Selesai" });
    const count = await closingButtons.count();
    if (count > 0) {
      await closingButtons.first().click();

      // Verify Closing Dialog opens
      await expect(page.locator("text=Closing Berkas & Realisasi Laba")).toBeVisible({ timeout: 10000 });
      await expect(page.locator("text=Tahap 8: Penyerahan Dokumen Fisik ke Customer")).toBeVisible();
      await expect(page.locator("text=Nama Penerima Berkas Fisik")).toBeVisible();
      await expect(page.locator("text=Konsekuensi Transisi Akuntansi:")).toBeVisible();

      // Close dialog
      await page.keyboard.press("Escape");
    }
  });

  test("Tahap 3 & 4: Verify Cashback Terpending Toolbar and Voucher Actions", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/cashback-pending"; });
    await page.waitForURL("**/finance/cashback-pending", { timeout: 15000 });

    // Verify Log Audit Void button and integrated export in Table Settings
    await expect(page.getByRole("button", { name: /Log Audit Void/i })).toBeVisible({ timeout: 10000 });
    const settingsBtn = page.locator("button[aria-label='Pengaturan tabel']");
    await expect(settingsBtn).toBeVisible({ timeout: 10000 });
    await settingsBtn.click();
    await expect(page.getByRole("button", { name: /Buka dialog ekspor/i })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
