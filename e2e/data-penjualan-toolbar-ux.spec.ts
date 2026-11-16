import { loginFinance } from "./helpers/authHelper";
import { test, expect, Browser } from "@playwright/test";
import * as path from "path";

const BASE_URL = "http://localhost:3000";
const DP = `${BASE_URL}/finance/data-penjualan`;
const EVIDENCE_DIR = "C:\\Users\\mahes\\.gemini\\antigravity\\brain\\4869b8c1-4be9-45c8-ac32-b2a933495169\\responsive_evidence";

test.describe("Phase 8.5: Data Penjualan Toolbar & Interaction UX Refinement", () => {
  test.beforeEach(async ({ page }) => {
    await loginFinance(page);
  });

  test("1-5. Header Service Dropdown & URL Sync: Default perpanjangan-1-tahun, active highlight, URL sync & reload persistence", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(DP);
    await expect(page).toHaveURL(`${DP}/perpanjangan-1-tahun`, { timeout: 10000 });

    // 1. Header service dropdown reflects active service
    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toBeVisible();
    await expect(serviceTrigger).toContainText("Perpanjangan 1 Tahun");

    // 2. Opening dropdown lists all 8 canonical sales services and marks the current selection
    await serviceTrigger.click();
    const menuItems = page.getByRole("menuitem");
    await expect(menuItems).toHaveCount(8);
    const currentItem = page.getByRole("menuitem", { name: "Perpanjangan 1 Tahun" });
    await expect(currentItem).toHaveClass(/text-primary/);

    // 3. Selecting another canonical service navigates URL and updates trigger label
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page).toHaveURL(`${DP}/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");

    // 4. Reload preserves URL-driven active service state
    await page.reload();
    await expect(page).toHaveURL(`${DP}/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");

    // 5. Legacy alias slug (/mutasi-ld) still resolves cleanly to canonical Mutasi Antar Daerah
    await page.goto(`${DP}/mutasi-ld`);
    await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");

    // Capture screenshot
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "phase85-active-tab-solid-blue.png"),
    });
  });

  test("6-9. Filter UX: Contained date control, no standalone date button, working filter & reset", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DP}/mutasi-ld`);
    await page.waitForLoadState("domcontentloaded");

    // 8. Verify NO duplicate standalone date button on the main toolbar
    // The main toolbar should only have: Tambah (optional), Filter, Pengaturan tabel, Search
    const toolbar = page.locator(".finance-table-container").first();
    const standaloneDateButtons = toolbar.locator("> div:first-child button:has-text('Pilih tanggal')");
    await expect(standaloneDateButtons).toHaveCount(0);

    // 6. Filter button opens the filter interaction
    const filterBtn = toolbar.locator("button[aria-label='Filter data tabel']");
    await expect(filterBtn).toBeVisible();
    await filterBtn.click();

    // Filter popover is visible
    const filterPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Filter" });
    await expect(filterPopover).toBeVisible();

    // 7. Date control exists INSIDE the filter interaction
    const dateControlInsideFilter = filterPopover.locator("button:has-text('Pilih tanggal')");
    await expect(dateControlInsideFilter).toBeVisible();

    // 9. Existing filter behavior still works: verify category filter & apply/reset buttons
    const resetButton = filterPopover.locator("button:has-text('Reset')").last();
    const applyButton = filterPopover.locator("button:has-text('Terapkan')");
    await expect(resetButton).toBeVisible();
    await expect(applyButton).toBeVisible();

    // Clicking Terapkan closes the filter popover
    await applyButton.click();
    await expect(filterPopover).not.toBeVisible();

    // Reopen and check Reset
    await filterBtn.click();
    await expect(filterPopover).toBeVisible();
    await resetButton.click();
    await expect(filterPopover).not.toBeVisible();

    // Capture screenshot
    await filterBtn.click();
    await expect(filterPopover).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "phase85-filter-popover-with-date.png"),
    });
    await applyButton.click();
  });

  test("10-12. Table Settings & Export: Reachable through settings, retains all export features", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DP}/mutasi-ld`);
    await page.waitForLoadState("domcontentloaded");

    // Verify standalone export button is NOT on the main toolbar
    const toolbar = page.locator(".finance-table-container").first();
    const standaloneExport = toolbar.locator("> div:first-child > div:first-child > button:has-text('Ekspor')");
    await expect(standaloneExport).toHaveCount(0);

    // 10. Table Settings opens successfully
    const settingsBtn = toolbar.locator("button[aria-label='Pengaturan tabel']");
    await expect(settingsBtn).toBeVisible();
    await settingsBtn.click();

    const settingsPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Pengaturan tabel" });
    await expect(settingsPopover).toBeVisible();

    // Verify settings controls: font size, column checkboxes
    await expect(settingsPopover.locator("text=Ukuran teks")).toBeVisible();
    await expect(settingsPopover.locator("text=Kolom yang ditampilkan")).toBeVisible();

    // 11. Export remains reachable through Table Settings
    const exportBtnInsideSettings = settingsPopover.locator("button:has-text('Buka dialog ekspor')");
    await expect(exportBtnInsideSettings).toBeVisible();

    // 12. Existing export functionality works: clicking opens export dialog
    await exportBtnInsideSettings.click();

    // Export dialog should appear
    const exportDialog = page.locator("[data-slot='dialog-content']").filter({ hasText: "Ekspor Data" });
    await expect(exportDialog).toBeVisible();

    // Verify CSV / PDF options and period select exist
    await expect(exportDialog.locator("text=CSV / Excel")).toBeVisible();
    await expect(exportDialog.locator("text=PDF / Cetak")).toBeVisible();
    await expect(exportDialog.locator("text=Pilihan Periode")).toBeVisible();

    // Close export dialog
    await page.keyboard.press("Escape");
    await expect(exportDialog).not.toBeVisible();

    // Capture screenshot
    await settingsBtn.click();
    await expect(settingsPopover).toBeVisible();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "phase85-table-settings-with-export.png"),
    });
    await page.keyboard.press("Escape");
  });

  test("13-15. Responsive at 320px: Toolbar, Filter with date, and Table Settings are all usable", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(`${DP}/mutasi-ld`);
    await page.waitForLoadState("domcontentloaded");

    // 13. Toolbar is usable at 320px
    const toolbar = page.locator(".finance-table-container").first();
    const filterBtn = toolbar.locator("button[aria-label='Filter data tabel']");
    const settingsBtn = toolbar.locator("button[aria-label='Pengaturan tabel']");
    await expect(filterBtn).toBeVisible();
    await expect(settingsBtn).toBeVisible();

    // Verify no document horizontal overflow
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow).toBe(false);

    // 14. Filter UI is usable at 320px
    await filterBtn.click();
    const filterPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Filter" });
    await expect(filterPopover).toBeVisible();
    const fBox = await filterPopover.boundingBox();
    expect(fBox).not.toBeNull();
    if (fBox) {
      expect(fBox.width).toBeLessThanOrEqual(320);
    }
    // Date control is inside and visible
    const dateBtn = filterPopover.locator("button:has-text('Pilih tanggal')");
    await expect(dateBtn).toBeVisible();
    await page.keyboard.press("Escape");

    // 15. Table Settings UI is usable at 320px
    await settingsBtn.click();
    const settingsPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Pengaturan tabel" });
    await expect(settingsPopover).toBeVisible();
    const sBox = await settingsPopover.boundingBox();
    expect(sBox).not.toBeNull();
    if (sBox) {
      expect(sBox.width).toBeLessThanOrEqual(320);
    }
    await page.keyboard.press("Escape");

    // Capture screenshot at 320px
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "phase85-toolbar-320px.png"),
    });
  });

  test("16. Browser Zoom 200% & 300%: Toolbar, popovers, and tabs remain fully operational", async ({ browser }: { browser: Browser }) => {
    test.slow();
    for (const z of [200, 300]) {
      const ctx = await browser.newContext({
        viewport: { width: Math.round((1440 * 100) / z), height: Math.round((900 * 100) / z) },
        deviceScaleFactor: z / 100,
      });
      const page = await ctx.newPage();
      await loginFinance(page);
      await page.goto(`${DP}/mutasi-antar-daerah`);
      await page.waitForLoadState("domcontentloaded");

      // Header service dropdown remains visible and active
      const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
      await expect(serviceTrigger).toBeVisible();
      await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");

      // Filter button check
      const filterBtn = page.locator("button[aria-label='Filter data tabel']");
      await expect(filterBtn).toBeVisible();
      await filterBtn.click();
      const filterPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Filter" });
      await expect(filterPopover).toBeVisible();
      await page.keyboard.press("Escape");

      // Settings button check
      const settingsBtn = page.locator("button[aria-label='Pengaturan tabel']");
      await expect(settingsBtn).toBeVisible();

      // Screenshot at zoom
      await page.screenshot({
        path: path.join(EVIDENCE_DIR, `phase85-zoom-${z}.png`),
      });

      await ctx.close();
    }
  });
});
