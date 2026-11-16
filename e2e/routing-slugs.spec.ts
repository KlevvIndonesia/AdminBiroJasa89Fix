import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test.describe("Phase 8.1: Routing & Canonical Slugs E2E Test Suite", () => {
  const BASE_URL = "http://localhost:3000";

  test("1. Root URL redirects to /dashboard", async ({ page }) => {
    // Authenticate as Admin first
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Navigate to root /
    await page.goto(`${BASE_URL}/`);
    await page.waitForURL("**/dashboard", { timeout: 10000 });
    expect(page.url()).toBe(`${BASE_URL}/dashboard`);
    await expect(page.getByRole("banner").getByText("Dashboard", { exact: true })).toBeVisible();
  });

  test("2. Direct navigation and deep linking to /finance/kas-messenger (Finance Role)", async ({ page }) => {
    // Set authenticated session for Finance
    await loginAs(page, "finance@birojasa.com", "finance123");

    // Directly navigate to /finance/kas-messenger
    await page.goto(`${BASE_URL}/finance/kas-messenger`);
    await expect(page).toHaveURL(`${BASE_URL}/finance/kas-messenger`);
    await expect(page.getByRole("banner").getByText("Kas Messenger", { exact: true })).toBeVisible();
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Finance");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Kas Messenger");
  });

  test("3. Direct navigation to /order/tracking (Admin Role)", async ({ page }) => {
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Direct navigation
    await page.goto(`${BASE_URL}/order/tracking`);
    await expect(page).toHaveURL(`${BASE_URL}/order/tracking`);
    await expect(page.getByRole("banner").getByText("Order Tracking", { exact: true })).toBeVisible();
    await expect(page.getByText("Verifikasi", { exact: true }).first()).toBeVisible();
  });

  test("4. Data Penjualan root automatically redirects to /finance/data-penjualan/perpanjangan-1-tahun", async ({ page }) => {
    // Login as Finance
    await loginAs(page, "finance@birojasa.com", "finance123");

    // Navigate to /finance/data-penjualan without category
    await page.goto(`${BASE_URL}/finance/data-penjualan`);
    await page.waitForURL("**/finance/data-penjualan/perpanjangan-1-tahun", { timeout: 10000 });
    expect(page.url()).toBe(`${BASE_URL}/finance/data-penjualan/perpanjangan-1-tahun`);

    // Verify Header Service Dropdown reflects Perpanjangan 1 Tahun
    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toContainText("Perpanjangan 1 Tahun");
  });

  test("5. Data Penjualan Header Service Dropdown switching updates browser URL", async ({ page }) => {
    await loginAs(page, "finance@birojasa.com", "finance123");

    // Visit legacy alias mutasi-ld -> normalizes to mutasi-antar-daerah
    await page.goto(`${BASE_URL}/finance/data-penjualan/mutasi-ld`);
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-antar-daerah`);

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");

    // Switch via Header Dropdown -> Mutasi Asal Samsat
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Mutasi Asal Samsat");

    // Switch via Header Dropdown -> Balik Nama
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Balik Nama" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Balik Nama");
  });

  test("6. Data Penjualan refresh persistence preserves active category", async ({ page }) => {
    await loginAs(page, "finance@birojasa.com", "finance123");

    // Direct navigate to /finance/data-penjualan/perpanjangan-5-tahun
    await page.goto(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);
    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toContainText("Perpanjangan 5 Tahun");

    // Reload the page (F5)
    await page.reload();
    await expect(page).toHaveURL(`${BASE_URL}/finance/data-penjualan/perpanjangan-5-tahun`);
    await expect(serviceTrigger).toContainText("Perpanjangan 5 Tahun");
    await expect(page.locator("nav[aria-label='Breadcrumb']")).toContainText("Perpanjangan 5 Tahun");
  });

  test("7. Browser Back and Forward traversal", async ({ page }) => {
    test.slow();
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Step 1: Dashboard
    expect(page.url()).toBe(`${BASE_URL}/dashboard`);

    // Step 2: Navigate to Order Tracking
    await page.goto(`${BASE_URL}/order/tracking`);
    await expect(page).toHaveURL(`${BASE_URL}/order/tracking`);
    await expect(page.getByRole("banner").getByText("Order Tracking", { exact: true })).toBeVisible();

    // Step 3: Navigate to Buat Order
    await page.goto(`${BASE_URL}/order/buat`);
    await expect(page).toHaveURL(`${BASE_URL}/order/buat`);
    await expect(page.getByRole("banner").getByText("Buat Order", { exact: true })).toBeVisible();

    // Step 4: Browser Back -> should be /order/tracking
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/order/tracking`);
    await expect(page.getByRole("banner").getByText("Order Tracking", { exact: true })).toBeVisible();

    // Step 5: Browser Back -> should be /dashboard
    await page.goBack();
    await expect(page).toHaveURL(`${BASE_URL}/dashboard`);
    await expect(page.getByRole("banner").getByText("Dashboard", { exact: true })).toBeVisible();

    // Step 6: Browser Forward -> should be /order/tracking
    await page.goForward();
    await expect(page).toHaveURL(`${BASE_URL}/order/tracking`);
    await expect(page.getByRole("banner").getByText("Order Tracking", { exact: true })).toBeVisible();
  });

  test("8. Settings route /settings renders with correct header title", async ({ page }) => {
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Click settings button in header
    await page.locator("header button[aria-label='Pengaturan sistem']").click();
    await expect(page).toHaveURL(`${BASE_URL}/settings`);

    // Verify header title does NOT fallback to "Dashboard"
    await expect(page.getByRole("banner").getByText("Pengaturan", { exact: true })).toBeVisible();
    await expect(page.locator("header p", { hasText: "Kelola preferensi dan konfigurasi sistem" })).toBeVisible();
  });

  test("9. Profile route /profile renders with correct header title", async ({ page }) => {
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Click profile button in header
    await page.locator("header button[aria-label='Buka profil admin']").click();
    await expect(page).toHaveURL(`${BASE_URL}/profile`);

    // Verify header title does NOT fallback to "Dashboard"
    await expect(page.getByRole("banner").getByText("Profil Saya", { exact: true })).toBeVisible();
  });

  test("10. Unknown route renders 404 Not Found page", async ({ page }) => {
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Navigate to an unknown path
    await page.goto(`${BASE_URL}/halaman-tidak-dikenal-12345`);
    await expect(page.locator("text=Halaman Tidak Ditemukan")).toBeVisible();
    await expect(page.locator("text=Error 404")).toBeVisible();

    // Click return to dashboard button
    await page.click("button:has-text('Kembali ke Dashboard')");
    await expect(page).toHaveURL(`${BASE_URL}/dashboard`);
  });

  test("11. Unauthenticated access to protected route redirects to /login", async ({ page }) => {
    // Clear localStorage to simulate unauthenticated visitor
    await page.goto(`${BASE_URL}/login`);
    await page.evaluate(() => window.localStorage.clear());

    // Attempt direct navigation to protected /order/tracking
    await page.goto(`${BASE_URL}/order/tracking`);
    await page.waitForURL("**/login", { timeout: 10000 });
    expect(page.url()).toContain("/login");
    await expect(page.locator("button[type='submit']", { hasText: "Masuk ke Sistem" })).toBeVisible();
  });

  test("12. Role-restricted route behavior enforces access boundaries", async ({ page }) => {
    // Login as Admin
    await loginAs(page, "admin@birojasa.com", "admin123");

    // Admin is NOT allowed to view Finance modules (/finance/profit)
    await page.goto(`${BASE_URL}/finance/profit`);
    await expect(page.locator("h2", { hasText: "Akses Ditolak" })).toBeVisible();
    await expect(page.locator("text=Anda tidak memiliki izin untuk mengakses halaman ini")).toBeVisible();

    // Click return to dashboard
    await page.click("button:has-text('Kembali ke Dashboard')");
    await expect(page).toHaveURL(`${BASE_URL}/dashboard`);
  });
});
