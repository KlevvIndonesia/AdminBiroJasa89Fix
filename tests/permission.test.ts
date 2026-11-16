import test from "node:test";
import assert from "node:assert";
import { permissionStore } from "../src/app/data/permissionStore";

test("Permission - Administrator and SVP have full authority over all 8 stages", () => {
  for (let stage = 1; stage <= 8; stage++) {
    assert.strictEqual(
      permissionStore.canManageStage("administrator", stage),
      true,
      `Administrator should be allowed to manage stage ${stage}`
    );
    assert.strictEqual(
      permissionStore.canManageStage("svp", stage),
      false,
      `Legacy 'svp' alias must fail closed on stage ${stage}`
    );
  }
});

test("Permission - Admin role has full Order, Order Tracking (Stages 1-5, 7-8), and Rekap Order authority, with Stage 6 strictly SVP-only", () => {
  // Admin can manage Stages 1-5 & 7-8; Stage 6 (Supervisi) is strictly SVP-only
  for (let stage = 1; stage <= 8; stage++) {
    const expected = stage !== 6;
    assert.strictEqual(
      permissionStore.canManageStage("admin", stage),
      expected,
      `Admin Stage ${stage} authority should be ${expected}`
    );
  }

  // Order & Rekap Order modules are full view+manage
  for (const mod of ["buat-order", "order-menu", "order-tracking", "order-history"] as const) {
    assert.strictEqual(permissionStore.canViewPage("admin", mod), true, `Admin can view ${mod}`);
    assert.strictEqual(permissionStore.canManageModule("admin", mod), true, `Admin can manage ${mod}`);
  }

  // Admin stays distinct from SVP globally: Access Management & Finance reports remain restricted
  assert.strictEqual(permissionStore.canViewPage("admin", "access-management"), false, "Admin cannot view access-management");
  assert.strictEqual(permissionStore.canManageModule("admin", "access-management"), false, "Admin cannot manage access-management");
  assert.strictEqual(permissionStore.canViewPage("admin", "finance-profit"), false, "Admin cannot view finance-profit");
});

test("Permission - Finance role can verify payment at Stage 1, but cannot manage operational stages 2-8", () => {
  // Finance can verify payment at Stage 1
  assert.strictEqual(
    permissionStore.canManageStage("finance", 1),
    true,
    "Finance can manage Stage 1 (Verifikasi Pembayaran)"
  );

  // Operational stages 2 through 8 are restricted for Finance
  for (let stage = 2; stage <= 8; stage++) {
    assert.strictEqual(
      permissionStore.canManageStage("finance", stage),
      false,
      `Finance should not manage operational workflow stage ${stage}`
    );
  }
});

test("Permission - Messenger role is restricted from Order Tracking stages, but authorized for Messenger Task", () => {
  // In Order Tracking, Messenger cannot mutate stages directly
  for (let stage = 1; stage <= 8; stage++) {
    assert.strictEqual(
      permissionStore.canManageStage("messenger", stage),
      false,
      `Messenger cannot manage Order Tracking stage ${stage} directly`
    );
  }

  // But Messenger has full manage permission for messenger-task module
  assert.strictEqual(
    permissionStore.canManageModule("messenger", "messenger-task"),
    true,
    "Messenger can manage messenger-task module"
  );
  assert.strictEqual(
    permissionStore.canManageModule("messenger", "order-tracking"),
    false,
    "Messenger cannot manage order-tracking module"
  );
});

test("Permission - Invalid stage numbers are rejected", () => {
  assert.strictEqual(permissionStore.canManageStage("admin", 0), false);
  assert.strictEqual(permissionStore.canManageStage("admin", 9), false);
  assert.strictEqual(permissionStore.canManageStage("admin", 99), false);
});
