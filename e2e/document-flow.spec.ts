import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loginAs } from "./helpers/authHelper";

// Prepare temporary test files with valid magic bytes
const TEST_DIR = path.resolve(process.cwd(), "e2e/fixtures");
if (!fs.existsSync(TEST_DIR)) {
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

const TEST_PDF_PATH = path.join(TEST_DIR, "sample_ktp.pdf");
const VALID_PDF_BYTES = Buffer.from(
  "%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Title (E2E Sample Document) >>\nendobj\ntrailer\n<< /Size 1 >>\nstartxref\n%%EOF"
);
fs.writeFileSync(TEST_PDF_PATH, VALID_PDF_BYTES);

test.describe("Phase 7.5: Persistent Document Storage & Secure File Workflow", () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(45000);
    await loginAs(page, "admin@birojasa.com", "admin123");
    await page.waitForTimeout(300);
  });

  test("E2E Doc 1: Upload document in Stage 1 Verifikasi persists to disk via API", async ({ page }) => {
    await page.getByRole("button", { name: "Order Tracking" }).click();
    await page.waitForTimeout(1000);

    // Open verification workspace from table
    const verifBtn = page.locator("table tbody tr").first().getByRole("button", { name: "Verifikasi" });
    await expect(verifBtn).toBeVisible();
    await verifBtn.click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).toBeVisible();

    // Select the file input for uploading a document in Stage 1
    const fileInput = page.locator("input[type='file']").first();
    await expect(fileInput).toBeAttached();

    const uploadPromise = page.waitForResponse(
      (res) => res.url().includes("/api/documents/upload") && res.status() === 201
    );

    await fileInput.setInputFiles(TEST_PDF_PATH);
    const uploadRes = await uploadPromise;
    expect(uploadRes.ok()).toBeTruthy();

    const json = await uploadRes.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toMatch(/^DOC-/);
    expect(json.data.originalName).toBe("sample_ktp.pdf");
    expect(json.data.mimeType).toBe("application/pdf");

    // Verify UI reflects the change (Preview button becomes visible)
    await page.waitForTimeout(800);
    const previewBtn = page.getByRole("button", { name: "Preview" }).first();
    await expect(previewBtn).toBeVisible();
  });

  test("E2E Doc 2: Document preview dialog renders authenticated preview and download action", async ({ page }) => {
    await page.getByRole("button", { name: "Order Tracking" }).click();
    await page.waitForTimeout(1000);

    // Open verification workspace from table
    const verifBtn = page.locator("table tbody tr").first().getByRole("button", { name: "Verifikasi" });
    await expect(verifBtn).toBeVisible();
    await verifBtn.click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).toBeVisible();

    // Upload document
    const fileInput = page.locator("input[type='file']").first();
    const uploadPromise = page.waitForResponse(
      (res) => res.url().includes("/api/documents/upload") && res.status() === 201
    );
    await fileInput.setInputFiles(TEST_PDF_PATH);
    await uploadPromise;
    await page.waitForTimeout(800);

    // Find and click Preview button
    const previewBtn = page.getByRole("button", { name: "Preview" }).first();
    await expect(previewBtn).toBeVisible();
    await previewBtn.click();

    // Verify preview modal appears
    await expect(page.locator("text=Preview Dokumen")).toBeVisible();
    await expect(page.locator("text=sample_ktp.pdf").first()).toBeVisible();

    // Verify preview iframe renders authenticated preview (either blob ObjectURL or ticketed preview URL, never raw JWT)
    const iframe = page.locator("iframe");
    await expect(iframe).toBeVisible();
    const src = await iframe.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src).toMatch(/^blob:|^https?:\/\/.*\/api\/documents\//);
    expect(src).not.toContain("token=");

    // Verify Unduh Berkas action button exists and is enabled
    const downloadBtn = page.getByRole("button", { name: "Unduh Berkas" });
    await expect(downloadBtn).toBeVisible();
    await expect(downloadBtn).toBeEnabled();

    // Close preview modal
    await page.getByRole("button", { name: "Tutup" }).last().click();
    await expect(page.locator("text=Preview Dokumen")).not.toBeVisible();
  });

  test("E2E Doc 3: Document remains persisted and previewable across browser reload", async ({ page }) => {
    await page.getByRole("button", { name: "Order Tracking" }).click();
    await page.waitForTimeout(1000);

    // Open verification workspace from table
    const firstRow = page.locator("table tbody tr").first();
    const verifBtn = firstRow.getByRole("button", { name: "Verifikasi" });
    await expect(verifBtn).toBeVisible();
    await verifBtn.click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).toBeVisible();

    // Extract exact full orderNo (e.g., ORD-1126-008) from dialog heading
    const dialogHeading = await page.locator("[role='dialog'] h2").first().textContent();
    const match = dialogHeading?.match(/ORD-\d+(?:-\d+)?/);
    const orderNo = match ? match[0] : "ORD-1126-001";

    // Upload document and wait for both upload and order update
    const fileInput = page.locator("input[type='file']").first();
    const uploadPromise = page.waitForResponse(
      (res) => res.url().includes("/api/documents/upload") && res.status() === 201
    );
    const updatePromise = page.waitForResponse(
      (res) => res.url().includes("/api/orders/") && res.request().method() === "PUT"
    );

    await fileInput.setInputFiles(TEST_PDF_PATH);
    await uploadPromise;
    await updatePromise;
    await page.waitForTimeout(800);

    // Close the verification modal before reload
    await page.getByRole("button", { name: "Tutup" }).first().click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).not.toBeVisible();

    // Reload browser page
    await page.reload();
    await page.waitForTimeout(1000);

    // Reopen Order Tracking
    await page.getByRole("button", { name: "Order Tracking" }).click();
    await page.waitForTimeout(1000);

    // Filter by orderNo in search box so target order is at top
    await page.fill("input[placeholder*='Cari order']", orderNo);
    await page.waitForTimeout(600);

    // Reopen verification workspace for that exact order
    const targetRow = page.locator("table tbody tr", { hasText: orderNo });
    await expect(targetRow).toBeVisible();
    const reloadedVerifBtn = targetRow.getByRole("button", { name: "Verifikasi" });
    await expect(reloadedVerifBtn).toBeVisible();
    await reloadedVerifBtn.click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).toBeVisible();

    // Verify preview button is still accessible
    const previewBtn = page.getByRole("button", { name: "Preview" }).first();
    await expect(previewBtn).toBeVisible();
    await previewBtn.click();

    // Verify document details persisted
    await expect(page.locator("text=Preview Dokumen")).toBeVisible();
    const iframe = page.locator("iframe");
    await expect(iframe).toBeVisible();

    await page.getByRole("button", { name: "Tutup" }).last().click();
  });

  test("E2E Doc 4: Unauthenticated access to document files is strictly rejected (401)", async ({ page }) => {
    // Attempt to access document endpoint without authentication
    const anonStatus = await page.evaluate(async () => {
      const res = await fetch("http://localhost:3001/api/documents/DOC-NONEXISTENT/preview");
      return res.status;
    });
    expect(anonStatus).toBe(401);

    // Attempt upload without authentication
    const anonUploadStatus = await page.evaluate(async () => {
      const res = await fetch("http://localhost:3001/api/documents/upload", {
        method: "POST",
      });
      return res.status;
    });
    expect(anonUploadStatus).toBe(401);
  });

  test("E2E Doc 5: Document file exists on physical storage medium with cryptographic integrity", async ({ page }) => {
    await page.getByRole("button", { name: "Order Tracking" }).click();
    await page.waitForTimeout(1000);

    const verifBtn = page.locator("table tbody tr").first().getByRole("button", { name: "Verifikasi" });
    await expect(verifBtn).toBeVisible();
    await verifBtn.click();
    await expect(page.locator("text=Data Pemilik Kendaraan")).toBeVisible();

    // Upload document
    const fileInput = page.locator("input[type='file']").first();
    const uploadPromise = page.waitForResponse(
      (res) => res.url().includes("/api/documents/upload") && res.status() === 201
    );
    await fileInput.setInputFiles(TEST_PDF_PATH);
    const res = await uploadPromise;
    const json = await res.json();
    const storageName = json.data.storageName;

    // Verify file actually exists on physical disk in active upload storage (sandbox or workspace server/uploads)
    const candidateUploadDirs = [
      process.env.UPLOAD_DIR,
      path.join(os.tmpdir(), "sun89_dev_sandbox", "uploads"),
      path.resolve(process.cwd(), "server/uploads"),
    ].filter((dir): dir is string => Boolean(dir));

    const matchedPath = candidateUploadDirs
      .map((dir) => path.join(dir, storageName))
      .find((candidate) => fs.existsSync(candidate));

    expect(matchedPath).toBeTruthy();
    const diskBytes = fs.readFileSync(matchedPath!);
    expect(diskBytes.equals(VALID_PDF_BYTES)).toBe(true);
  });
});
