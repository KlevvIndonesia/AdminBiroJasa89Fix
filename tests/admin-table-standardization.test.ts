import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('ADMIN FRONTEND AUDIT & TABLE STANDARDIZATION Suite', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf8');

  it('provides unified DataTable primitives in ui/data-table.tsx and avoids stacked border-t around TablePagination', () => {
    const dataTable = read('src/app/components/ui/data-table.tsx');
    assert.ok(dataTable.includes('export function DataTableShell'), 'Missing DataTableShell export');
    assert.ok(dataTable.includes('export function DataTableToolbar'), 'Missing DataTableToolbar export');
    assert.ok(dataTable.includes('export function DataTableEmptyRow'), 'Missing DataTableEmptyRow export');

    const tablePagination = read('src/app/components/ui/TablePagination.tsx');
    assert.ok(
      tablePagination.includes('border-t border-border/70'),
      'TablePagination already owns top divider border'
    );
    assert.strictEqual(
      dataTable.includes('border-t border-border'),
      false,
      'DataTableShell footer wrapper must not stack a duplicate border-t above TablePagination'
    );
  });

  it('removes dead ui/pagination.tsx duplicate and ensures zero stale imports remain', () => {
    assert.strictEqual(
      fs.existsSync(path.resolve('src/app/components/ui/pagination.tsx')),
      false,
      'Unused src/app/components/ui/pagination.tsx must be deleted'
    );

    const importers = walkTsFiles(path.resolve('src')).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('ui/pagination')
    );
    assert.deepStrictEqual(importers, [], 'No file in src/ should import deleted ui/pagination');
  });

  it('adopts shared DataTable primitives across paginated Admin operational tables', () => {
    const shellConsumers = [
      'src/app/components/EnhancedTable.tsx',
      'src/app/components/EnhancedTableWithDialogs.tsx',
      'src/app/components/WilayahSamsatManager.tsx',
      'src/app/components/AuditLog.tsx',
      'src/app/components/ManajemenPengguna.tsx',
      'src/app/components/OrderHistory.tsx',
      'src/app/components/NotificationHistory.tsx',
      'src/app/components/MessengerTask.tsx',
      'src/app/components/MessengerHistory.tsx',
    ];

    for (const rel of shellConsumers) {
      const src = read(rel);
      assert.ok(src.includes('DataTableShell'), `${rel} must use DataTableShell`);
      assert.ok(src.includes('DataTableEmptyRow'), `${rel} must use DataTableEmptyRow`);
    }

    const hargaDasar = read('src/app/components/HargaDasarSamsat.tsx');
    assert.ok(hargaDasar.includes('DataTableEmptyRow'), 'HargaDasarSamsat.tsx must use DataTableEmptyRow');
    assert.strictEqual(
      hargaDasar.includes('border-t border-border p-2 bg-muted/20'),
      false,
      'HargaDasarSamsat.tsx must not stack a duplicate border-t above TablePagination'
    );
  });

  it('eliminates raw HTML <table> in WilayahSamsatManager and FinanceContent Void History modal', () => {
    const wilayah = read('src/app/components/WilayahSamsatManager.tsx');
    assert.strictEqual(/<table\b/.test(wilayah), false, 'WilayahSamsatManager must use shared <Table> UI');

    const finance = read('src/app/components/FinanceContent.tsx');
    const voidSectionStart = finance.indexOf('voidHistoryTab === "payments"');
    const voidSectionEnd = finance.indexOf('Belum ada catatan pembatalan pencairan cashback (Void).');
    assert.ok(voidSectionStart > 0 && voidSectionEnd > voidSectionStart);
    const voidSection = finance.slice(voidSectionStart, voidSectionEnd);
    assert.strictEqual(/<table\b/.test(voidSection), false, 'Void History modal must use shared <Table>');

    // Raw text inputs replaced by shared <Input>
    const dataPenjualan = read('src/app/components/DataPenjualan.tsx');
    assert.strictEqual(/<input[\s\S]*value=\{deleteConfirmText\}/.test(dataPenjualan), false);
    assert.ok(dataPenjualan.includes('value={deleteConfirmText}'), 'DataPenjualan delete input preserved via <Input>');
    assert.strictEqual(/<input[\s\S]*value=\{reimbSearchQuery\}/.test(finance), false);
    assert.ok(finance.includes('value={reimbSearchQuery}'), 'FinanceContent search preserved via <Input>');
  });

  it('removes unreadable 9px micro-typography from operational Admin UI components', () => {
    const cleanOperationalFiles = [
      'src/app/components/WilayahSamsatManager.tsx',
      'src/app/components/ManajemenPengguna.tsx',
      'src/app/components/OrderHistory.tsx',
      'src/app/components/NotificationHistory.tsx',
      'src/app/components/HargaDasarSamsat.tsx',
      'src/app/components/MessengerTask.tsx',
      'src/app/components/MessengerHistory.tsx',
      'src/app/components/FinanceContent.tsx',
      'src/app/components/OrderTracking.tsx',
      'src/app/components/BiayaLayanan.tsx',
      'src/app/components/FinanceAddPage.tsx',
      'src/app/components/FinanceDetailPage.tsx',
      'src/app/components/estimation/CalculationExplanationModal.tsx',
      'src/app/components/estimation/EstimatorExtended.tsx',
      'src/app/components/estimation/EstimatorR4Tahunan.tsx',
    ];

    for (const rel of cleanOperationalFiles) {
      const src = read(rel);
      assert.strictEqual(
        src.includes('text-[9px]'),
        false,
        `${rel} still contains unreadable text-[9px] class`
      );
    }

    const buatOrder = read('src/app/components/BuatOrder.tsx');
    const buatOrderMatches = buatOrder.match(/text-\[9px\]/g) || [];
    assert.ok(
      buatOrderMatches.length <= 2,
      `BuatOrder.tsx should only retain QRIS slip text-[9px] (<=2), found ${buatOrderMatches.length}`
    );
  });

  it('standardizes shared Button and Form Controls across Admin modules without conflicting size/height classes', () => {
    const checkbox = read('src/app/components/ui/checkbox.tsx');
    const radio = read('src/app/components/ui/radio-group.tsx');
    const sw = read('src/app/components/ui/switch.tsx');
    assert.ok(checkbox.includes('border-input'), 'Checkbox should use border-input token');
    assert.ok(radio.includes('border-input'), 'RadioGroupItem should use border-input token');
    assert.ok(sw.includes('cursor-pointer'), 'Switch should apply cursor-pointer');

    const finance = read('src/app/components/FinanceContent.tsx');
    assert.strictEqual(/<select\b/.test(finance), false, 'FinanceContent modals must use shared <Select>');
    assert.strictEqual(finance.includes('value={isCashbackToday}'), false);
    assert.ok(finance.includes('<Checkbox'), 'FinanceContent must use shared <Checkbox>');

    const enhanced = read('src/app/components/EnhancedTableWithDialogs.tsx');
    const tracking = read('src/app/components/OrderTracking.tsx');
    assert.strictEqual(/<textarea\b/.test(enhanced), false, 'EnhancedTableWithDialogs must use shared <Textarea>');
    assert.strictEqual(/<textarea\b/.test(tracking), false, 'OrderTracking must use shared <Textarea>');

    const estManager = read('src/app/components/estimation/EstimationMasterManager.tsx');
    assert.ok(estManager.includes('aria-label={`Edit komponen'), 'Edit icon button must have aria-label');
    assert.ok(estManager.includes('aria-label={`Hapus komponen'), 'Delete icon button must have aria-label');

    const wilayah = read('src/app/components/WilayahSamsatManager.tsx');
    assert.ok(wilayah.includes('aria-label="Reset Filter"'), 'Reset icon button must have aria-label');

    const ctaConflictFiles = [
      'src/app/components/BiayaLayanan.tsx',
      'src/app/components/EnhancedTableWithDialogs.tsx',
      'src/app/components/HargaDasarSamsat.tsx',
      'src/app/components/MasterLayanan.tsx',
      'src/app/components/MetodePembayaranMaster.tsx',
      'src/app/components/NotificationHistory.tsx',
      'src/app/components/OrderHistory.tsx',
      'src/app/components/WilayahSamsatManager.tsx',
    ];
    for (const rel of ctaConflictFiles) {
      const src = read(rel);
      assert.strictEqual(
        /<Button\b[^>]*size="sm"[^>]*\bh-9\b/.test(src),
        false,
        `${rel} must not mix size="sm" with h-9 override on <Button>`
      );
    }

    // Icon-only accessibility & HargaDasarSamsat shared Checkbox check
    const hargaDasar = read('src/app/components/HargaDasarSamsat.tsx');
    assert.ok(hargaDasar.includes('<Checkbox'), 'HargaDasarSamsat filter must use shared <Checkbox>');
    assert.ok(read('src/app/components/FinanceDateFilter.tsx').includes('aria-label="Tahun sebelumnya"'));
    assert.ok(read('src/app/components/SearchableSamsatSelect.tsx').includes('aria-label="Hapus pencarian Samsat"'));
    assert.ok(read('src/app/components/ProvinsiFilterSelect.tsx').includes('aria-label="Reset filter provinsi"'));
    assert.ok(read('src/app/components/EnhancedTable.tsx').includes('aria-label="Edit data"'));
  });
});
