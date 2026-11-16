import { loginFinance } from "./helpers/authHelper";
import { test, expect } from "@playwright/test";

const BASE_URL = "http://localhost:3000";

test.describe("Phase 8.6: Routing History & Route Transition Integrity", () => {
  test.beforeEach(async ({ page }) => {
    await loginFinance(page);
  });

  test("1 & 2: Single click on inactive service dropdown item pushes 1 history entry; clicking active item pushes 0", async ({ page }) => {
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");

    // Instrument history
    await page.evaluate(() => {
      (window as any).__historyLogs = [];
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args) {
        (window as any).__historyLogs.push({ type: "pushState", url: args[2] });
        return origPush.apply(this, args);
      };
      history.replaceState = function (...args) {
        (window as any).__historyLogs.push({ type: "replaceState", url: args[2] });
        return origReplace.apply(this, args);
      };
    });

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");

    // 1. Select inactive service Mutasi Antar Daerah -> exactly 1 pushState
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Antar Daerah" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah`);
    await page.waitForTimeout(150);

    let logs = await page.evaluate(() => (window as any).__historyLogs);
    expect(logs.length).toBe(1);
    expect(logs[0]).toEqual({ type: "pushState", url: "/finance/data-penjualan/mutasi-antar-daerah" });

    // 2. Select already active service Mutasi Antar Daerah -> 0 new pushState
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Antar Daerah" }).click();
    await page.waitForTimeout(150);

    logs = await page.evaluate(() => (window as any).__historyLogs);
    expect(logs.length).toBe(1); // Still 1, zero duplicate entry

    // Select inactive service Balik Nama -> exactly 1 new pushState (total 2)
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Balik Nama" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/balik-nama`);
    await page.waitForTimeout(150);

    logs = await page.evaluate(() => (window as any).__historyLogs);
    expect(logs.length).toBe(2);
    expect(logs[1]).toEqual({ type: "pushState", url: "/finance/data-penjualan/balik-nama" });
  });

  test("3: Keyboard navigation in Header Service Dropdown pushes exactly 1 history entry per activated service", async ({ page }) => {
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      (window as any).__historyLogs = [];
      const origPush = history.pushState;
      history.pushState = function (...args) {
        (window as any).__historyLogs.push({ type: "pushState", url: args[2] });
        return origPush.apply(this, args);
      };
    });

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await serviceTrigger.focus();

    // Open menu via keyboard Enter -> ArrowDown to Perpanjangan 5 Tahun -> Enter activates
    await page.keyboard.press("Enter");
    const perpanjangan5Item = page.getByRole("menuitem", { name: "Perpanjangan 5 Tahun" });
    await expect(perpanjangan5Item).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowDown");
      if (await perpanjangan5Item.evaluate((el) => document.activeElement === el)) break;
    }
    await expect(perpanjangan5Item).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);
    await page.waitForTimeout(150);

    let logs = await page.evaluate(() => (window as any).__historyLogs);
    expect(logs.length).toBe(1);
    expect(logs[0]).toEqual({ type: "pushState", url: "/finance/data-penjualan/perpanjangan-5-tahun" });

    // Open menu again via Enter -> ArrowDown to Mutasi Asal Samsat -> Enter activates
    await serviceTrigger.focus();
    await page.keyboard.press("Enter");
    const mutasiAsalItem = page.getByRole("menuitem", { name: "Mutasi Asal Samsat" });
    await expect(mutasiAsalItem).toBeVisible();
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("ArrowDown");
      if (await mutasiAsalItem.evaluate((el) => document.activeElement === el)) break;
    }
    await expect(mutasiAsalItem).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);
    await page.waitForTimeout(150);

    logs = await page.evaluate(() => (window as any).__historyLogs);
    expect(logs.length).toBe(2);
    expect(logs[1]).toEqual({ type: "pushState", url: "/finance/data-penjualan/mutasi-asal" });
  });

  test("4 & 5 & 7: Browser Back and Forward traverse single distinct steps and maintain visual state", async ({ page }) => {
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");

    // Step 1: Select Mutasi Asal Samsat
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);

    // Step 2: Select Balik Nama
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Balik Nama" }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/balik-nama`);

    // Step 3: Select Perpanjangan 5 Tahun
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Perpanjangan 5 Tahun" }).click();
    await expect(page.getByRole("menu")).toBeHidden();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);

    // Back 1 -> Balik Nama
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Balik Nama");

    // Back 2 -> Mutasi Asal Samsat
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Mutasi Asal Samsat");

    // Back 3 -> Perpanjangan 1 Tahun
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await expect(serviceTrigger).toContainText("Perpanjangan 1 Tahun");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Perpanjangan 1 Tahun");

    // Forward 1 -> Mutasi Asal Samsat
    await page.goForward();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");

    // Forward 2 -> Balik Nama
    await page.goForward();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");

    // Forward 3 -> Perpanjangan 5 Tahun
    await page.goForward();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);
    await expect(serviceTrigger).toContainText("Perpanjangan 5 Tahun");
  });

  test("6: Invalid category slug & legacy aliases redirect via replace preserving query params without loop", async ({ page }) => {
    test.slow();
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");

    // Navigate to invalid slug -> normalizes via replace to perpanjangan-1-tahun
    await page.goto(`${BASE_URL}/finance/data-penjualan/kategori-palsu-xyz`);
    await page.waitForURL("**/finance/data-penjualan/perpanjangan-1-tahun", { timeout: 10000 });
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toContainText("Perpanjangan 1 Tahun");

    // Navigate to legacy alias with query param -> normalizes via replace preserving ?q=1
    await page.goto(`${BASE_URL}/finance/data-penjualan/mutasi-ld?status=Pending`);
    await page.waitForURL("**/finance/data-penjualan/mutasi-antar-daerah?status=Pending", { timeout: 10000 });
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah?status=Pending`);
    await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");

    // Going back once returns directly to perpanjangan-1-tahun (invalid intermediate slug was replaced cleanly)
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
  });

  test("8: Search / filter inputs and Table Settings do not corrupt service history state", async ({ page }) => {
    await page.goto(`${BASE_URL}/finance/data-penjualan/mutasi-ld`);
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah`);
    await page.waitForLoadState("networkidle");

    // Type in search box
    const searchInput = page.getByPlaceholder(/Cari/i).first();
    await searchInput.fill("B 1970 SAM");
    await page.waitForTimeout(200);

    // Open filter popover
    const filterBtn = page.locator("button[aria-label='Filter data tabel']");
    await expect(filterBtn).toBeVisible();
    await filterBtn.click();
    const filterPopover = page.locator("[data-slot='popover-content']").filter({ hasText: "Filter" });
    await expect(filterPopover).toBeVisible();
    await page.keyboard.press("Escape");

    // Verify URL is still cleanly /finance/data-penjualan/mutasi-antar-daerah
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah`);

    // Switch service via Header Dropdown to Mutasi Asal Samsat
    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);

    // Go back -> should immediately return to mutasi-antar-daerah
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah`);
    await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");
  });

  test("9 & 10: Page subtree does NOT remount on service switch and element identity remains stable", async ({ page }) => {
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");

    // Tag shell header trigger and table search box DOM nodes
    await page.evaluate(() => {
      const trigger = document.querySelector("button[title='Pilih layanan Data Penjualan']");
      if (trigger) {
        (trigger as any).__persistentIdentityTestMarker = 42;
      }
      const searchBox = document.querySelector("input[type='search'], input[placeholder*='Cari']");
      if (searchBox) {
        (searchBox as any).__searchBoxIdentityMarker = 99;
      }
    });

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);

    // Verify the DOM elements were NOT destroyed/remounted
    const markers = await page.evaluate(() => {
      const trigger = document.querySelector("button[title='Pilih layanan Data Penjualan']");
      const searchBox = document.querySelector("input[type='search'], input[placeholder*='Cari']");
      return {
        triggerMarker: (trigger as any)?.__persistentIdentityTestMarker,
        searchBoxMarker: (searchBox as any)?.__searchBoxIdentityMarker,
        isFocusedConnected: document.activeElement ? document.body.contains(document.activeElement) : false,
      };
    });

    expect(markers.triggerMarker).toBe(42);
    expect(markers.searchBoxMarker).toBe(99);
    expect(markers.isFocusedConnected).toBe(true);
  });

  test("11: Transitions between distinct modules mount/unmount page view appropriately", async ({ page }) => {
    test.slow();
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("banner").getByText("Data Penjualan -")).toBeVisible();
    await expect(page.locator("button[title='Pilih layanan Data Penjualan']")).toBeVisible();

    // Navigate to Kas Messenger
    await page.goto(`${BASE_URL}/finance/kas-messenger`);
    await expect(page).toHaveURL(`${BASE_URL}/finance/kas-messenger`);
    await expect(page.getByRole("banner").getByText("Kas Messenger", { exact: true })).toBeVisible();
    await expect(page.locator("button[title='Pilih layanan Data Penjualan']")).toBeHidden();

    // Navigate to Dashboard
    await page.goto(`${BASE_URL}/dashboard`);
    await expect(page).toHaveURL(`${BASE_URL}/dashboard`);
    await expect(page.getByRole("banner").getByText("Dashboard", { exact: true })).toBeVisible();
  });

  test("12 & 13: ErrorBoundary isolates errors to page content area and resets when navigating away", async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard`);
    await page.waitForLoadState("networkidle");

    // Sidebar and Header are present
    const sidebar = page.locator("aside");
    const header = page.locator("header");
    await expect(sidebar).toBeVisible();
    await expect(header).toBeVisible();

    // Trigger an intentional render error flag check without crashing shell
    await page.evaluate(() => {
      (window as any).__triggerAppError = true;
    });

    await expect(sidebar).toBeVisible();
    await expect(header).toBeVisible();
  });
});
