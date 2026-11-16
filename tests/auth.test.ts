import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createApp } from "../server/src/app";
import { UserRepository } from "../src/data/repositories/userRepository";
import { ApiUserProvider } from "../src/data/api/apiUserProvider";
import { loginRateLimiter } from "../server/src/middleware/rateLimiter";

function startTestServer(): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const app = createApp();
    const server = http.createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

test("Authentication - Valid credentials authenticate against SQLite with canonical roles", async () => {
  loginRateLimiter.reset();
  const { server, baseUrl } = await startTestServer();
  try {
    const repo = new UserRepository(new ApiUserProvider(`${baseUrl}/api`));

    // 1. Superadmin (SVP) login
    const svpRes = await repo.authenticate("svp@birojasa.com", "admin123");
    assert.ok(svpRes !== null, "SVP login should succeed");
    assert.strictEqual(svpRes?.role, "administrator");
    assert.strictEqual(svpRes?.name, "Admin Super (SVP)");

    // 2. Finance login
    const financeRes = await repo.authenticate("finance@birojasa.com", "finance123");
    assert.ok(financeRes !== null, "Finance login should succeed");
    assert.strictEqual(financeRes?.role, "finance");

    // 3. Admin login
    const adminRes = await repo.authenticate("admin@birojasa.com", "admin123");
    assert.ok(adminRes !== null, "Admin login should succeed");
    assert.strictEqual(adminRes?.role, "admin");
    assert.strictEqual(adminRes?.name, "Adrian Adhari");

    // 4. Messenger login (canonical linked employee required)
    const messengerRes = await repo.authenticate("budi.messenger@birojasa.com", "messenger123");
    assert.ok(messengerRes !== null, "Messenger login should succeed");
    assert.strictEqual(messengerRes?.role, "messenger");
    assert.ok(messengerRes?.employeeId, "Messenger session must include employeeId");
  } finally {
    server.close();
  }
});

test("Authentication - Invalid credentials and empty payloads are rejected returning null", async () => {
  loginRateLimiter.reset();
  const { server, baseUrl } = await startTestServer();
  try {
    const repo = new UserRepository(new ApiUserProvider(`${baseUrl}/api`));

    // Wrong password
    const wrongPass = await repo.authenticate("admin@birojasa.com", "wrongpass");
    assert.strictEqual(wrongPass, null, "Wrong password should return null");

    // Unknown email
    const wrongEmail = await repo.authenticate("unknown@domain.com", "password");
    assert.strictEqual(wrongEmail, null, "Unknown email should return null");

    // Empty credentials
    const emptyRes = await repo.authenticate("", "");
    assert.strictEqual(emptyRes, null, "Empty credentials should return null");
  } finally {
    server.close();
  }
});

test("Authentication - Session token is verified by /api/auth/me and rejects invalid tokens", async () => {
  loginRateLimiter.reset();
  const { server, baseUrl } = await startTestServer();
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "svp@birojasa.com", password: "admin123" }),
    });
    assert.strictEqual(loginRes.status, 200);
    const loginBody = (await loginRes.json()) as any;
    const token = loginBody.data?.token;
    assert.ok(token, "JWT token should be issued by backend");

    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(meRes.status, 200);
    const meBody = (await meRes.json()) as any;
    assert.strictEqual(meBody.data?.role, "administrator");
    assert.strictEqual(meBody.data?.email, "svp@birojasa.com");

    const badMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: "Bearer invalid.jwt.token" },
    });
    assert.strictEqual(badMeRes.status, 401);
  } finally {
    server.close();
  }
});
