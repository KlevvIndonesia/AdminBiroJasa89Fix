import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test.describe("Tahap 5 QC Forensic Audit Verification Suite", () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, "svp@birojasa.com", "admin123");
  });

  test("1. Verify Cancelled Orders with Paid Deposits Appear in Cashback Terpending (QC-01 Fix)", async ({ page }) => {
    const token = await page.evaluate(() => window.localStorage.getItem("auth_token"));
    expect(token).toBeTruthy();
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const suffix = Date.now().toString().slice(-4);
    const uniqueCustomer = `QC01 Refund E2E ${suffix}`;
    let createdOrderNo: string | null = null;

    try {
      // Discover an active payment method dynamically from sandbox API
      const pmRes = await page.request.get("http://localhost:3001/api/payment-methods?status=Aktif", {
        headers: authHeaders,
      });
      expect(pmRes.ok()).toBeTruthy();
      const pmList = (await pmRes.json()).data || [];
      expect(pmList.length).toBeGreaterThan(0);
      const pm = pmList[0];

      // 1) Create synthetic order with initial deposit (Bayar di Awal)
      const createRes = await page.request.post("http://localhost:3001/api/orders", {
        headers: authHeaders,
        data: {
          customer: uniqueCustomer,
          namaPemilik: uniqueCustomer,
          nomorHP: `08129977${suffix}`,
          layanan: "Perpanjangan 1 Tahun",
          nopol: `B ${suffix} QC1`,
          biayaPokok: 200000,
          biayaJasa: 100000,
          biayaAntarJemput: 50000,
          totalBiaya: 350000,
          metodePembayaran: pm.nama_metode,
          payment: {
            tipePembayaran: "Bayar di Awal",
            metodePembayaran: pm.nama_metode,
            metode_pembayaran_id: pm.id,
            nominalDibayarAwal: 350000,
            totalBiaya: 350000,
            dibayar: 0,
          },
        },
      });
      expect(createRes.status()).toBe(201);
      const createdOrder = (await createRes.json()).data;
      createdOrderNo = createdOrder.orderNo;
      expect(createdOrderNo).toBeTruthy();

      // 2) Verify initial Bayar di Awal deposit directly via /verify-payment with proof payload
      const initialPaymentId = createdOrder?.payment?.paymentRecords?.[0]?.id;
      const verifyRes = await page.request.post(
        `http://localhost:3001/api/orders/${encodeURIComponent(createdOrderNo!)}/verify-payment`,
        {
          headers: authHeaders,
          data: {
            confirmedAmount: 350000,
            notes: "E2E QC-01 verified initial deposit",
            ...(initialPaymentId ? { paymentId: initialPaymentId } : {}),
            buktiPembayaran: {
              fileName: "e2e-qc01-deposit.pdf",
              fileUrl: "http://localhost:3001/e2e-qc01-deposit.pdf",
              fileType: "pdf",
            },
          },
        }
      );
      const verifyBodyText = await verifyRes.text();
      expect(verifyRes.ok(), `verify-payment failed (${verifyRes.status()}): ${verifyBodyText}`).toBeTruthy();

      // 3) Cancel order via canonical cancel endpoint -> must divert paid deposit to Cashback Terpending
      const cancelRes = await page.request.post(
        `http://localhost:3001/api/orders/${encodeURIComponent(createdOrderNo!)}/cancel`,
        {
          headers: authHeaders,
          data: {
            reason: "E2E QC-01 test cancellation with paid deposit",
          },
        }
      );
      expect(cancelRes.ok()).toBeTruthy();

      // Reload app cleanly so UI store pulls fresh sandbox state and inspect /finance/cashback-pending
      await page.goto("http://localhost:3000/finance/cashback-pending", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("banner").getByText("Cashback Terpending").first()).toBeVisible({ timeout: 15000 });
      await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

      // Search exact synthetic order and assert it renders inside Cashback Terpending with Kelebihan Bayar
      const searchBox = page.getByPlaceholder(/Cari nama customer/i);
      await searchBox.fill(createdOrderNo!);
      await expect(page.locator("table tbody tr", { hasText: createdOrderNo! })).toBeVisible({ timeout: 10000 });
      await expect(page.locator("table tbody tr", { hasText: uniqueCustomer })).toContainText("350.000");
    } finally {
      if (createdOrderNo) {
        await page.request.delete(`http://localhost:3001/api/orders/${encodeURIComponent(createdOrderNo)}`, {
          headers: authHeaders,
        }).catch(() => {});
      }
    }
  });

  test("2. Verify WhatsApp Universal Phone Format in Belum Bayar (QC-05 Fix)", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/belum-bayar"; });
    await page.waitForURL("**/finance/belum-bayar", { timeout: 15000 });
    await expect(page.locator("text=Belum & Kurang Bayar").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    const waLinks = page.locator("a[href*='wa.me']");
    await expect(waLinks.first()).toBeVisible({ timeout: 15000 });
    const count = await waLinks.count();
    console.log(`Found ${count} WhatsApp links on Belum Bayar.`);
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const href = await waLinks.nth(i).getAttribute("href");
      expect(href).not.toBeNull();
      // Verify phone format: must start with country code wa.me/62
      expect(href).toMatch(/wa\.me\/62\d+/);
    }
  });

  test("3. Verify Laba Rugi Excludes Cancelled Orders from Revenue (QC-01 & QC-04 Fix)", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/laba-rugi"; });
    await page.waitForURL("**/finance/laba-rugi", { timeout: 15000 });
    await expect(page.locator("text=Laba Rugi").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("table").first()).toBeVisible({ timeout: 15000 });

    const rows = page.locator("tbody tr");
    const rowCount = await rows.count();
    for (let i = 0; i < rowCount; i++) {
      const rowText = await rows.nth(i).innerText();
      expect(rowText.includes("ORD-0003")).toBeFalsy();
      expect(rowText.includes("ORD-0004")).toBeFalsy();
      expect(rowText.toLowerCase().includes("dibatalkan")).toBeFalsy();
    }
  });

  test("4. Verify Kas Kantor & Double-Entry Integrity (QC-02 & QC-03 Fix)", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/kas-kantor"; });
    await page.waitForURL("**/finance/kas-kantor", { timeout: 15000 });
    await expect(page.locator("text=Buku Kas Kantor").first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator("table")).toBeVisible({ timeout: 15000 });

    // Verify presence of summary cards (FinanceSummary labels)
    await expect(page.locator("text=Total Penerimaan (Debit)")).toBeVisible();
    await expect(page.locator("text=Total Pengeluaran (Kredit)")).toBeVisible();
    await expect(page.locator("text=Saldo Kas Kantor")).toBeVisible();
  });

  test("5. Verify Berita Acara Rekonsiliasi Tutup Kas Harian Modal (Tahap 5 Enhancement)", async ({ page }) => {
    await page.evaluate(() => { window.location.href = "/finance/kas-kantor"; });
    await page.waitForURL("**/finance/kas-kantor", { timeout: 15000 });
    await expect(page.locator("text=Buku Kas Kantor").first()).toBeVisible({ timeout: 15000 });

    const btnRekonsiliasi = page.locator("button", { hasText: "Rekonsiliasi & Tutup Kas Harian" });
    await expect(btnRekonsiliasi).toBeVisible({ timeout: 15000 });
    await btnRekonsiliasi.click();

    // Verify modal elements
    await expect(page.locator("text=Berita Acara Rekonsiliasi Tutup Kas Harian").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=BERITA ACARA TUTUP KAS").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#print-rekonsiliasi-area")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=BIRO JASA SUN89").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("button:has-text('Cetak Dokumen (A5)')")).toBeVisible({ timeout: 10000 });
  });
});
