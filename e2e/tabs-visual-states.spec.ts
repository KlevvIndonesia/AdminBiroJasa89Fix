import { test, expect, Page, Locator, Browser } from "@playwright/test";
import * as path from "path";
import { loginAs } from "./helpers/authHelper";

/**
 * Tab Visual-State & Service Navigation System Verification.
 *
 * Validates the live UI architecture:
 * - Shared `<Tabs>` visual-state contracts (`ui/tabs.tsx`) on `/settings`,
 *   `/notifikasi`, and the `/master-data/harga-dasar` Standard Tariff dialog.
 * - Header Service Dropdown URL-driven navigation & history integrity on
 *   `/finance/data-penjualan/*` and `/master-data/biaya-layanan/*` (which
 *   retired horizontal sub-tabs per `tests/data-penjualan-redundant-tabs.test.ts`).
 */

const BASE_URL = "http://localhost:3000";
const DP = `${BASE_URL}/finance/data-penjualan`;
const EVIDENCE_DIR = process.env.TAB_EVIDENCE_DIR;

// Live light-theme tokens (src/styles/globals.css)
const PRIMARY = "rgb(37, 99, 235)"; // --primary #2563eb
const MUTED_FG = "rgb(100, 116, 139)"; // --muted-foreground #64748b
const FOREGROUND = "rgb(15, 23, 42)"; // --foreground #0f172a
const WHITE = "rgb(255, 255, 255)"; // white text on active primary tab

async function login(page: Page, email: string, password: string) {
  await loginAs(page, email, password);
}

const loginFinance = (page: Page) => login(page, "finance@birojasa.com", "finance123");
const loginSvp = (page: Page) => login(page, "svp@birojasa.com", "admin123");

async function shot(target: Page | Locator, name: string) {
  if (!EVIDENCE_DIR) return;
  await target.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
}

type TabStyle = {
  color: string;
  bg: string;
  borderColor: string;
  shadow: string;
  opacity: string;
  indicator: string;
  fontWeight: string;
  ariaSelected: string | null;
  state: string | null;
  tabIndex: number;
};

function readStyle(loc: Locator): Promise<TabStyle> {
  return loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    const after = getComputedStyle(el, "::after");
    const hasIndicator = after.content !== "none" && after.content !== "normal" && after.content !== '""';
    return {
      color: cs.color,
      bg: cs.backgroundColor,
      borderColor: cs.borderTopColor,
      shadow: cs.boxShadow,
      opacity: cs.opacity,
      indicator: hasIndicator ? after.opacity : "0",
      fontWeight: cs.fontWeight,
      ariaSelected: el.getAttribute("aria-selected"),
      state: el.getAttribute("data-state"),
      tabIndex: (el as HTMLElement).tabIndex,
    };
  });
}

const tab = (page: Page, name: string | RegExp) => page.getByRole("tab", { name });

/** Waits for colour/opacity transitions to settle on the given tab. */
async function settledStyle(loc: Locator, predicate: (s: TabStyle) => boolean): Promise<TabStyle> {
  let last!: TabStyle;
  await expect
    .poll(async () => {
      last = await readStyle(loc);
      return predicate(last);
    }, { timeout: 4000 })
    .toBe(true);
  return last;
}

/** Geometry checks for a tab list: clipping, overlap, container overflow. */
async function measureTabList(page: Page, listIndex = 0) {
  return page.getByRole("tablist").nth(listIndex).evaluate((list) => {
    const triggers = Array.from(list.querySelectorAll<HTMLElement>("[role='tab']"));
    const rects = triggers.map((t) => ({
      text: (t.innerText || "").trim(),
      r: t.getBoundingClientRect(),
      scrollW: t.scrollWidth,
      clientW: t.clientWidth,
      afterOpacity: getComputedStyle(t, "::after").opacity,
      state: t.getAttribute("data-state"),
    }));
    const hostRect = list.getBoundingClientRect();
    const clipped = rects
      .filter((x) => x.scrollW > x.clientW + 2)
      .map((x) => ({ text: x.text, scrollW: x.scrollW, clientW: x.clientW }));
    const overlaps: Array<[string, string]> = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r;
        const b = rects[j].r;
        const overlapX = a.right > b.left + 1 && a.left < b.right - 1;
        const overlapY = a.bottom > b.top + 1 && a.top < b.bottom - 1;
        if (overlapX && overlapY) {
          overlaps.push([rects[i].text, rects[j].text]);
        }
      }
    }
    const active = rects.find((x) => x.state === "active");
    return {
      count: rects.length,
      viewport: window.innerWidth,
      hostWidth: Math.round(hostRect.width),
      hostRight: Math.round(hostRect.right),
      clipped,
      overlaps,
      activeIndicator: active?.afterOpacity ?? "missing",
    };
  });
}

test.describe("Phase 8.3 & Closure: Tab & Header-Service Navigation Visual System", () => {
  test.describe.configure({ mode: "serial" });

  test("1. Settings Tabs: default active vs inactive computed styles", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSvp(page);
    await page.goto(`${BASE_URL}/settings`);

    const active = tab(page, "Notifikasi");
    const inactive = tab(page, "Keamanan Akun");

    const a = await settledStyle(active, (s) => s.bg === PRIMARY);
    const i = await readStyle(inactive);

    // Semantics
    expect(a.ariaSelected).toBe("true");
    expect(a.state).toBe("active");
    expect(i.ariaSelected).toBe("false");
    expect(i.state).toBe("inactive");
    const listTabIndex = await page.getByRole("tablist").first().evaluate((el) => (el as HTMLElement).tabIndex);
    expect(listTabIndex === 0 || a.tabIndex === 0).toBe(true);
    expect(i.tabIndex).toBe(-1);

    // ACTIVE: solid primary background, white text, shadow, no ::after indicator
    expect(a.color).toBe(WHITE);
    expect(a.bg).toBe(PRIMARY);
    expect(a.shadow).not.toBe("none");
    expect(a.indicator).toBe("0");

    // INACTIVE: muted text at FULL opacity, no shadow, no indicator
    expect(i.color).toBe(MUTED_FG);
    expect(i.opacity).toBe("1");
    expect(i.indicator).toBe("0");
    expect(i.shadow).toBe("none");

    // Font weight consistency (no jitter)
    expect(a.bg).not.toBe(i.bg);
    expect(a.fontWeight).toBe(i.fontWeight);

    await shot(page.getByRole("tablist").first(), "settings-1440-default-active");
  });

  test("2. Settings Tabs: hover communicates interactivity without adopting active cues", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSvp(page);
    await page.goto(`${BASE_URL}/settings`);

    const inactive = tab(page, "Keamanan Akun");
    const before = await readStyle(inactive);
    await inactive.hover();
    const hovered = await settledStyle(inactive, (s) => s.color === FOREGROUND);

    expect(hovered.color).toBe(FOREGROUND);
    expect(hovered.bg).not.toBe(before.bg);
    expect(hovered.indicator).toBe("0");
    expect(hovered.shadow).toBe("none");
    expect(hovered.color).not.toBe(PRIMARY);
    expect(hovered.ariaSelected).toBe("false");

    const active = tab(page, "Notifikasi");
    await active.hover();
    const activeHovered = await settledStyle(active, (s) => s.bg === PRIMARY);
    expect(activeHovered.color).toBe(WHITE);
    expect(activeHovered.bg).toBe(PRIMARY);
  });

  test("3. Data Penjualan & Header Dropdown Routing Integrity: URL sync, refresh, deep link, Back/Forward", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginFinance(page);

    // Default redirect -> perpanjangan-1-tahun
    await page.goto(DP);
    await expect(page).toHaveURL(`${DP}/perpanjangan-1-tahun`, { timeout: 10000 });

    const serviceTrigger = page.locator("button[title='Pilih layanan Data Penjualan']");
    await expect(serviceTrigger).toContainText("Perpanjangan 1 Tahun");

    // Switch via Header Dropdown to Mutasi Asal Samsat
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Mutasi Asal Samsat" }).click();
    await expect(page).toHaveURL(`${DP}/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");

    // Switch again to Balik Nama
    await serviceTrigger.click();
    await page.getByRole("menuitem", { name: "Balik Nama" }).click();
    await expect(page).toHaveURL(`${DP}/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");

    // Refresh preserves selection
    await page.reload();
    await expect(page).toHaveURL(`${DP}/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");

    // Back / Forward integrity
    await page.goBack();
    await expect(page).toHaveURL(`${DP}/mutasi-asal`);
    await expect(serviceTrigger).toContainText("Mutasi Asal Samsat");

    await page.goForward();
    await expect(page).toHaveURL(`${DP}/balik-nama`);
    await expect(serviceTrigger).toContainText("Balik Nama");

    // Deep link alias /mutasi-ld resolves cleanly
    await page.goto(`${DP}/mutasi-ld`);
    await expect(serviceTrigger).toContainText("Mutasi Antar Daerah");
  });

  test("4. Settings Tabs: Keyboard navigation (ArrowRight/ArrowLeft) and focus-visible ring", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSvp(page);
    await page.goto(`${BASE_URL}/settings`);

    const firstTab = tab(page, "Notifikasi");
    const secondTab = tab(page, "Keamanan Akun");

    await firstTab.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(firstTab).toBeFocused();

    expect(await firstTab.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
    const focusState = await settledStyle(firstTab, (s) => s.borderColor === PRIMARY);
    expect(focusState.shadow).not.toBe("none");
    expect(focusState.bg).toBe(PRIMARY);
    expect(focusState.color).toBe(WHITE);

    // ArrowRight moves selection to Keamanan Akun
    await page.keyboard.press("ArrowRight");
    await expect(secondTab).toHaveAttribute("aria-selected", "true");
    await settledStyle(secondTab, (s) => s.color === WHITE && s.bg === PRIMARY);

    // ArrowLeft navigates back to Notifikasi
    await page.keyboard.press("ArrowLeft");
    await expect(firstTab).toHaveAttribute("aria-selected", "true");
    await settledStyle(firstTab, (s) => s.color === WHITE && s.bg === PRIMARY);

    // Mouse click must not leave :focus-visible stuck true
    await secondTab.click();
    const mouseFv = await secondTab.evaluate((el) => el.matches(":focus-visible"));
    expect(mouseFv).toBe(false);
  });

  test("5. Disabled treatment on shared TabsTrigger", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSvp(page);
    await page.goto(`${BASE_URL}/settings`);
    const target = page.getByRole("tab").nth(1);
    await expect(target).toHaveAttribute("data-state", "inactive");

    const inactiveStyle = await readStyle(target);
    await target.evaluate((el) => el.setAttribute("disabled", ""));
    const disabled = await settledStyle(target, (s) => s.opacity === "0.5");
    const pe = await target.evaluate((el) => getComputedStyle(el).pointerEvents);
    await target.evaluate((el) => el.removeAttribute("disabled"));

    expect(inactiveStyle.opacity).toBe("1");
    expect(disabled.opacity).toBe("0.5");
    expect(disabled.indicator).toBe("0");
    expect(pe).toBe("none");
  });

  test("6. Dark theme keeps active/inactive distinction", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginSvp(page);
    await page.goto(`${BASE_URL}/settings`);
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.body.classList.add("dark");
    });

    const PRIMARY_DARK = "rgb(59, 130, 246)";
    const a = await settledStyle(tab(page, "Notifikasi"), (s) => (s.bg === PRIMARY_DARK || s.bg === PRIMARY) && s.color === WHITE);
    const i = await readStyle(tab(page, "Keamanan Akun"));
    expect(a.color).toBe(WHITE);
    expect(a.bg === PRIMARY_DARK || a.bg === PRIMARY).toBe(true);
    expect(a.color).not.toBe(i.color);
    expect(a.bg).not.toBe(i.bg);
    expect(i.opacity).toBe("1");
    await shot(page.getByRole("tablist").first(), "settings-1440-dark");
  });

  for (const width of [320, 375, 768, 1024, 1440, 1920]) {
    test(`7. Responsive @ ${width}px: Notification & Settings tabs have zero clipping/overlap`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await loginSvp(page);
      await page.goto(`${BASE_URL}/notifikasi`);
      await expect(page.getByRole("tablist").first()).toBeVisible();

      const m = await measureTabList(page);
      expect(m.count).toBe(2);
      expect(m.clipped).toEqual([]);
      expect(m.overlaps).toEqual([]);
      expect(m.hostRight).toBeLessThanOrEqual(m.viewport + 1);

      const emailTab = tab(page, /Riwayat Pengiriman Email/i);
      await emailTab.scrollIntoViewIfNeeded();
      await emailTab.click();
      await expect(emailTab).toHaveAttribute("aria-selected", "true");
    });
  }

  const ZOOMS = [50, 75, 100, 125, 150, 200, 300];
  test("8. Emulated browser zoom 50%-300%: Settings & Notification tabs remain unclipped", async ({ browser }: { browser: Browser }) => {
    test.slow();
    for (const z of ZOOMS) {
      const ctx = await browser.newContext({
        viewport: { width: Math.round((1440 * 100) / z), height: Math.round((900 * 100) / z) },
        deviceScaleFactor: z / 100,
      });
      const page = await ctx.newPage();
      await loginSvp(page);
      await page.goto(`${BASE_URL}/settings`);
      await expect(tab(page, "Notifikasi")).toHaveAttribute("aria-selected", "true");
      const m = await measureTabList(page);
      expect(m.count, `zoom ${z}%`).toBe(2);
      expect(m.clipped, `zoom ${z}%`).toEqual([]);
      expect(m.overlaps, `zoom ${z}%`).toEqual([]);
      expect(m.hostRight, `zoom ${z}%`).toBeLessThanOrEqual(m.viewport + 1);
      await ctx.close();
    }
  });

  test("9. Consistency across active multi-tab modules (Settings, Notifikasi, Harga Dasar Modal, Biaya Layanan Dropdown)", async ({ page }) => {
    test.slow();
    await loginSvp(page);
    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 900 });

      // 1) /settings tabs follow canonical primary visual state
      await page.goto(`${BASE_URL}/settings`);
      const settingsList = page.getByRole("tablist").first();
      await expect(settingsList).toBeVisible();
      const sActive = settingsList.locator("[role='tab'][data-state='active']");
      const sInactive = settingsList.locator("[role='tab'][data-state='inactive']").first();
      const sa = await settledStyle(sActive, (s) => s.bg === PRIMARY && s.color === WHITE);
      const si = await readStyle(sInactive);
      expect(sa.color).toBe(WHITE);
      expect(sa.bg).toBe(PRIMARY);
      expect(si.color).toBe(MUTED_FG);
      expect(si.opacity).toBe("1");
      const sm = await measureTabList(page);
      expect(sm.clipped).toEqual([]);
      expect(sm.overlaps).toEqual([]);

      // 2) /notifikasi segmented tabs remain unclipped & switch cleanly
      await page.goto(`${BASE_URL}/notifikasi`);
      const notifList = page.getByRole("tablist").first();
      await expect(notifList).toBeVisible();
      const nm = await measureTabList(page);
      expect(nm.clipped).toEqual([]);
      expect(nm.overlaps).toEqual([]);

      // 3) /master-data/harga-dasar standard dialog tabs (Mutasi Keluar / Mutasi Masuk)
      await page.goto(`${BASE_URL}/master-data/harga-dasar`);
      await page.getByRole("button", { name: "Atur Harga Standar" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const modalTabList = dialog.getByRole("tablist").first();
      await expect(modalTabList).toBeVisible();
      const modalTab2 = dialog.getByRole("tab", { name: /Mutasi Masuk/i });
      await modalTab2.click();
      await expect(modalTab2).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Escape");

      // 4) /master-data/biaya-layanan header service dropdown remains accessible
      await page.goto(`${BASE_URL}/master-data/biaya-layanan`);
      const biayaTrigger = page.locator("button[title='Pilih layanan Biaya Layanan']");
      await expect(biayaTrigger).toBeVisible();
    }
  });
});
