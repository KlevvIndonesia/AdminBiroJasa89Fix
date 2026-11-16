import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers/authHelper";

test.describe("E2E Tests 8, 11, 12: Security Enforcement & Cross-Module Synchronization", () => {
  test("E2E Test 8: Cross-Module Payment Synchronization across Finance and Order", async ({ page }) => {
    // 1. Login as Finance user (authorized for invoices & payments)
    await loginAs(page, "finance@birojasa.com", "finance123");
    await page.waitForTimeout(300);

    // Retrieve token
    const token = await page.evaluate(() => window.localStorage.getItem("auth_token"));
    expect(token).toBeTruthy();

    // 2. Query initial invoice & linked order via API
    const invRes = await page.request.get("http://localhost:3001/api/finance/invoices", {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(invRes.ok()).toBeTruthy();
    const invoices = (await invRes.json()).data;
    expect(invoices.length).toBeGreaterThan(0);

    // Pick an invoice with linked order that has outstanding balance
    const targetInvoice = invoices.find((inv: any) => inv.orderNo && inv.status !== "PAID" && (inv.sisa ?? 0) > 0) || invoices.find((inv: any) => inv.orderNo);
    expect(targetInvoice).toBeTruthy();

    // 3. Record payment on target invoice
    const payRes = await page.request.post(`http://localhost:3001/api/finance/invoices/${targetInvoice.id}/pay`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      data: { amount: targetInvoice.sisa > 0 ? targetInvoice.sisa : 50000, metode: "Transfer Bank" },
    });
    expect(payRes.ok()).toBeTruthy();

    // 4. Verify linked order received synchronized pending payment record in SQLite (two-step verification keeps dibayar at 0 until verify-payment)
    const orderRes = await page.request.get(`http://localhost:3001/api/orders/${targetInvoice.orderNo}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    expect(orderRes.ok()).toBeTruthy();
    const orderData = (await orderRes.json()).data;
    expect(Array.isArray(orderData.payment?.paymentRecords)).toBe(true);
    expect(orderData.payment.paymentRecords.length).toBeGreaterThan(0);
  });

  test("E2E Test 11: Role Security Matrix strictly enforced by Express server", async ({ page }) => {
    test.setTimeout(60000);

    // 1. Messenger token
    await loginAs(page, "budi.messenger@birojasa.com", "messenger123");
    await page.waitForTimeout(300);
    const messengerToken = await page.evaluate(() => window.localStorage.getItem("auth_token"));
    expect(messengerToken).toBeTruthy();

    // Messenger attempting back-office order creation -> 403 Forbidden
    const msgOrderRes = await page.request.post("http://localhost:3001/api/orders", {
      headers: {
        Authorization: `Bearer ${messengerToken}`,
      },
      data: { customer: "Illegal", nomorHP: "081234567890", layanan: "Pajak", nopol: "B 123 ILL" },
    });
    expect(msgOrderRes.status()).toBe(403);

    // 2. Finance token
    await loginAs(page, "finance@birojasa.com", "finance123");
    await page.waitForTimeout(300);
    const financeToken = await page.evaluate(() => window.localStorage.getItem("auth_token"));
    expect(financeToken).toBeTruthy();

    // Pick a real existing order from SQLite so RBAC returns 403 rather than 404
    const ordersListRes = await page.request.get("http://localhost:3001/api/orders", {
      headers: { Authorization: `Bearer ${financeToken}` },
    });
    expect(ordersListRes.ok()).toBeTruthy();
    const groupedOrders = (await ordersListRes.json()).data || {};
    const existingOrders = Object.values(groupedOrders).flat() as any[];
    expect(existingOrders.length).toBeGreaterThan(0);
    const existingOrderNo = existingOrders[0].orderNo;

    // Finance attempting operational stage advance (Stage 2 Penjadwalan) -> 403 Forbidden
    const finAdvanceRes = await page.request.post(`http://localhost:3001/api/orders/${existingOrderNo}/advance`, {
      headers: {
        Authorization: `Bearer ${financeToken}`,
      },
      data: { targetStage: "Penjadwalan", updates: {} },
    });
    expect(finAdvanceRes.status()).toBe(403);

    // 3. Admin token
    await loginAs(page, "admin@birojasa.com", "admin123");
    await page.waitForTimeout(300);
    const adminToken = await page.evaluate(() => window.localStorage.getItem("auth_token"));
    expect(adminToken).toBeTruthy();

    // Admin attempting Stage 6 Supervisi -> 403 Forbidden (SVP only)
    const adminSupervisiRes = await page.request.post(`http://localhost:3001/api/orders/${existingOrderNo}/advance`, {
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
      data: { stage: "Supervisi", targetStage: "Pengantaran", updates: {} },
    });
    expect(adminSupervisiRes.status()).toBe(403);
  });

  test("E2E Test 12: Security Headers and CORS Policy enforced on Browser Requests", async ({ page }) => {
    // Query health endpoint from browser context
    const response = await page.request.get("http://localhost:3001/api/health", {
      headers: { Origin: "http://localhost:3000" }
    });
    expect(response.status()).toBe(200);

    const headers = response.headers();
    // Security headers verified in actual HTTP response
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["x-powered-by"]).toBeUndefined();

    // CORS headers
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });
});
