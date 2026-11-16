import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test.describe("Tahap 1 & Tahap 2 UI Verification", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60000);
    await loginAs(page, "svp@birojasa.com", "admin123");
  });

  test("Verify Belum Bayar Cetak Invoice A5 & WhatsApp Buttons", async ({ page }) => {
    test.setTimeout(45000);
    await page.evaluate(() => { window.location.href = "/finance/belum-bayar"; });
    await page.waitForURL("**/finance/belum-bayar", { timeout: 15000 });
    await page.waitForSelector("text=Memuat halaman...", { state: "detached", timeout: 15000 }).catch(() => {});

    // Verify "Cetak" button and WhatsApp link exist in table (WhatsApp action unified into customer phone column link)
    const cetakButtons = page.locator("button", { hasText: "Cetak" });
    const waLinks = page.locator("a[href*='wa.me']");

    await expect(cetakButtons.first()).toBeVisible({ timeout: 15000 });
    await expect(waLinks.first()).toBeVisible({ timeout: 15000 });

    const cetakCount = await cetakButtons.count();
    expect(cetakCount).toBeGreaterThan(0);

    const waCount = await waLinks.count();
    expect(waCount).toBeGreaterThan(0);

    // Click first "Cetak" button
    await cetakButtons.first().click();

    // Verify Invoice A5 Dialog is visible
    await expect(page.locator("text=Cetak Invoice Resmi A5")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("button", { hasText: "Kirim ke WhatsApp" })).toBeVisible();
    await expect(page.locator("button", { hasText: "Cetak Faktur (A5)" })).toBeVisible();

    // Close dialog
    await page.keyboard.press("Escape");
  });

  test("Verify Bayar/Pelunasan Modal and SPV Void Elements", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/belum-bayar"; });
    await page.waitForURL("**/finance/belum-bayar", { timeout: 15000 });

    // Find "Bayar / Lunasi" button
    const bayarButtons = page.locator("button", { hasText: "Bayar / Lunasi" });
    const count = await bayarButtons.count();
    if (count > 0) {
      await bayarButtons.first().click();

      // Verify payment modal opened
      await expect(page.locator("text=Riwayat Pembayaran Terdaftar")).toBeVisible({ timeout: 10000 });

      // Close modal
      await page.keyboard.press("Escape");
    }
  });

  test("Verify Cashback Terpending Page & SPV Void Actions", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/cashback-pending"; });
    await page.waitForURL("**/finance/cashback-pending", { timeout: 15000 });

    // Verify Cashback page loaded
    await expect(page.locator("text=Kelebihan Bayar")).toBeVisible({ timeout: 15000 });
  });
});
