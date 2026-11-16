import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test("Quick check with domcontentloaded", async ({ page }) => {
  test.setTimeout(60000);
  await loginAs(page, "svp@birojasa.com", "admin123");

  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });

  await page.goto("http://localhost:3000/finance/kas-kantor", { waitUntil: "domcontentloaded" });
  await expect(page.locator("text=Buku Kas Kantor").first()).toBeVisible({ timeout: 15000 });

  const btnRekonsiliasi = page.locator("button", { hasText: "Rekonsiliasi & Tutup Kas Harian" });
  await expect(btnRekonsiliasi).toBeVisible({ timeout: 15000 });
  await btnRekonsiliasi.click();

  await expect(page.locator("text=Berita Acara Rekonsiliasi Tutup Kas Harian").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("text=BERITA ACARA TUTUP KAS").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("#print-rekonsiliasi-area")).toBeVisible({ timeout: 10000 });
});
