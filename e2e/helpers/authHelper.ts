import * as fs from "fs";
import * as path from "path";

const BASE_URL = "http://localhost:3000";
const API_BASE_URL = "http://localhost:3001/api";
const CACHE_FILE = path.resolve("e2e/.auth-cache.json");

const memoryCache: Record<string, { token: string; user: any }> = {};

function readDiskCache(): Record<string, { token: string; user: any }> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeDiskCache(cache: Record<string, { token: string; user: any }>) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch {}
}

/**
 * Obtain an authoritative session token directly via the API or persistent cache.
 * Completely eliminates repeated bcrypt overhead and rate-limit exhaustion.
 */
export async function getAuthSession(email = "admin@birojasa.com", password = "admin123") {
  const cacheKey = `${email}:${password}`;

  if (memoryCache[cacheKey]) {
    return memoryCache[cacheKey];
  }

  const diskCache = readDiskCache();
  if (diskCache[cacheKey]?.token) {
    memoryCache[cacheKey] = diskCache[cacheKey];
    return diskCache[cacheKey];
  }

  const res = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[loginAs] Direct API login failed for ${email}: HTTP ${res.status} ${errText}`);
  }

  const payload = await res.json();
  if (!payload?.data?.token) {
    throw new Error(`[loginAs] Invalid auth payload for ${email}: ${JSON.stringify(payload)}`);
  }

  const sessionData = {
    token: payload.data.token,
    user: payload.data.user,
  };

  memoryCache[cacheKey] = sessionData;
  diskCache[cacheKey] = sessionData;
  writeDiskCache(diskCache);

  return sessionData;
}

/**
 * Log in as a given user by injecting valid session tokens into localStorage.
 * Avoids browser UI login form overhead, bcrypt delays, and rate-limiting.
 */
export async function loginAs(page: any, email = "admin@birojasa.com", password = "admin123") {
  const { token, user } = await getAuthSession(email, password);

  // Pre-seed localStorage before any scripts on subsequent navigations
  await page.addInitScript(
    ({ token, user }: { token: string; user: any }) => {
      window.localStorage.setItem("auth_token", token);
      window.localStorage.setItem("auth_user", JSON.stringify(user));
    },
    { token, user }
  );

  // If page is currently at a real document, also inject immediately into active context
  try {
    await page.evaluate(
      ({ token, user }: { token: string; user: any }) => {
        window.localStorage.setItem("auth_token", token);
        window.localStorage.setItem("auth_user", JSON.stringify(user));
      },
      { token, user }
    );
  } catch {}

  const isMessenger =
    email.toLowerCase().includes("messenger") || user?.role === "messenger";
  const defaultTarget = isMessenger
    ? `${BASE_URL}/messenger/workspace`
    : `${BASE_URL}/dashboard`;

  const currentUrl = page.url();
  if (!currentUrl || currentUrl === "about:blank" || currentUrl.includes("/login")) {
    await page.goto(defaultTarget);
    await page.waitForLoadState("domcontentloaded");
  }
}

export async function loginFinance(page: any) {
  return loginAs(page, "finance@birojasa.com", "finance123");
}

export async function loginSvp(page: any) {
  return loginAs(page, "svp@birojasa.com", "admin123");
}

export async function loginAdmin(page: any) {
  return loginAs(page, "admin@birojasa.com", "admin123");
}

export async function loginMessenger(page: any) {
  return loginAs(page, "budi.messenger@birojasa.com", "messenger123");
}
