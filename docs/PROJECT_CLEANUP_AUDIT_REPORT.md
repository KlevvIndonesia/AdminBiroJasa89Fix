# SUN89 — PROJECT CLEANUP & TECHNICAL DEBT AUDIT REPORT (DISCOVERY MODE 1)

**Project:** SUNBiroJasa / Admin SUN89  
**Workspace:** `D:\Admin\adminsunbirojasa`  
**Mode:** STRICT READ-ONLY DISCOVERY (Mode 1 — Zero Deletions, Zero Source Edits)  
**Date:** 2026-11-12  

---

## 1. EXECUTIVE SUMMARY

Audit menyeluruh terhadap seluruh repository **SUNBiroJasa / Admin SUN89** telah selesai dilaksanakan pada **742 file** (tidak termasuk `node_modules/` dan `.git/`). Audit mencakup inventaris file, struktur `package.json` & lockfiles, dependency graph `src/` dan `server/src/`, analisis ekspor mati (*dead exports*), pemeriksaan CSS tokens & stylesheet, klasifikasi 119 file dokumentasi di `docs/`, audit 38 script di `scripts/` serta 17 script di `scratch/`, dan verifikasi seluruh 66 package pada `package.json`.

### Ringkasan Kuantitatif (Terverifikasi dari Kondisi Aktual Repository)

| Metrik | Jumlah Aktual | Keterangan |
|---|---:|---|
| **Total files inspected** *(excl. `node_modules/`, `.git/`)* | **742** | `(root)` 21, `deploy` 6, `dist` 28, `docs` 119, `e2e` 20, `scratch` 17, `scripts` 38, `server` 170, `src` 174, `test-results` 3, `tests` 146 |
| **Empty files (0 bytes)** | **4** | `server/uploads/.gitkeep` (intentional), 3 empty `server/backups/*.sqlite-wal` |
| **Exact SHA-256 duplicate pairs** | **2 pasang (4 file)** | `scratch/patch-permissionStore.cjs` ≡ `.js`; `server/src/utils/samsatNaming.ts` ≡ `src/domain/pricing/samsatNaming.ts` |
| **Category A — Safe to Delete candidates** | **26 file (+ `dist/` opsional 28 file)** | `scratch/` (17), `test-results/` (3), root debug scripts (`check_db.js`, `scratch_inspect_db.js`), root generated dumps (`BUAT_ORDER_CONTEXT.md`, `PROJECT_CONTEXT.md`), `scripts/verification-results.json`, `scripts/audit_git_status.cjs` (atau `audit_git_categories.cjs`) *(plus 28 file `dist/` bila ingin reset build cache)* |
| **Category B — Needs Approval candidates** | **18 deps + 32 file source/CSS/scripts + 29 PNG audit + ~48 docs historis/rekap** | 18 npm packages tak terpakai, `MessengerTaskDetailModal.tsx` (52 KB), legacy CSS (`default_theme.css`, `theme.css`, `tailwind.css`, `default_shadcn_theme.css`), `bun.lock`, one-off verification scripts, screenshot audit, & arsip dokumentasi step-by-step |
| **Confirmed dead code source candidates** | **2 file utama + 1 file duplikat attributions** | `src/app/components/messenger/MessengerTaskDetailModal.tsx` (1.082 baris, 0 importer), `src/data/repositories/messengerRepository.ts` (0 consumer aktif), `src/app/Attributions.md` |
| **Dependency candidates (0 import di kode/CSS/config)** | **18 dari 66 package** | 11 `@radix-ui/react-*` unused, `cmdk`, `embla-carousel-react`, `input-otp`, `next-themes`, `react-hook-form`, `react-resizable-panels`, `vaul` *(sedangkan `react-is` wajib dipertahankan karena runtime dependency `recharts`)* |
| **Category C — Must Keep (Dilindungi Ketat)** | **550+ file** | Database operasional & backup SQLite (13 file), `server/uploads/` (51 file), `src/` aktif, `server/src/` aktif, `deploy/`, konfigurasi proyek, & dokumentasi operasional/arsitektur utama |

> [!IMPORTANT]
> **Compliance Mode 1:** Tidak ada satu pun file, folder, dependency, baris kode, atau data operasional yang dihapus/dimodifikasi selama penyusunan laporan ini.

---

## 2. REPOSITORY INVENTORY

### 2.1 Distribusi Direktori Utama

| Direktori / Lokasi | Jumlah File | Tracked Git / Ignored | Fungsi Utama |
|---|---:|---|---|
| `(root)` | 21 | Campuran | Konfigurasi (`package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `playwright.config.ts`, `postcss.config.mjs`, `.env*`, `.gitignore`, `index.html`) + file residu/eksperimen (`bun.lock`, `check_db.js`, `scratch_inspect_db.js`, `default_shadcn_theme.css`, `ATTRIBUTIONS.md`, `metadata.json`, `README.md`, `BUAT_ORDER_CONTEXT.md`, `PROJECT_CONTEXT.md`, `POST_REMEDIATION_VERIFICATION_REPORT.md`) |
| `src/` | 174 | Tracked `[T]` | Source frontend React/Vite/Tailwind (`app/`, `data/`, `domain/`, `styles/`, `main.tsx`) |
| `server/src/` | 105 (+1 `tsconfig.json`) | Tracked `[T]` | Backend Express + SQLite (`routes/`, `controllers/`, `services/`, `repositories/`, `database/`, `middleware/`, `storage/`, `utils/`, `testing/`) |
| `server/data/`, `server/backups/`, `server/uploads/` | 64 | Ignored (`.gitignore`) + `.gitkeep` | Database SQLite operasional (1), backup SQLite (12 incl. shm/wal), dokumen upload pengguna (50 + `.gitkeep`) |
| `tests/` | 146 | Tracked `[T]` (kecuali `phase-a-design-system.test.ts` baru) | Unit & integration test suite Node `--test` (`run-test-isolated.cjs`) |
| `e2e/` | 20 | Tracked `[T]` | Playwright E2E browser test specs (19 `.spec.ts` + 1 fixture PDF) |
| `scripts/` | 38 | Tracked `[T]` | Campuran script operasional (`dev-orchestrator.cjs`, `backup.ts`, `verify-dr.ts`, `smoke-test.ts`, `package-release.ts`, `run-test-isolated.cjs`, dll.) dan script verifikasi/migrasi historis satu kali |
| `scratch/` | 17 | Gitignored (`scratch/`) | Script patch dan investigasi ad-hoc Phase sebelumnya (`patch-*.cjs`, `fix-*.cjs`, `check-db.cjs`, dll.) |
| `docs/` | 119 | Sebagian Tracked `[T]`, sebagian baru `[U]` | Dokumentasi arsitektur, deployment, runbook, API specs, laporan audit Phase 1–4B & Frontend Audit, serta 30 screenshot |
| `deploy/` | 6 | Tracked `[T]` | Template systemd service, Nginx, Caddy, deploy & backup scripts |
| `dist/` | 28 | Gitignored (`dist/`) | Output Vite production build (~6.48 MB) |
| `test-results/` | 3 | Gitignored (`test-results/`) | Output kegagalan Playwright run sebelumnya |
| `public/` | 0 | Kosong | Direktori kosong (hanya placeholder static assets Vite) |

### 2.2 Temuan Duplikat Identik (SHA-256)

1. `scratch/patch-permissionStore.cjs` (2.356 B) ≡ `scratch/patch-permissionStore.js` (2.356 B) — 100% identik, script patch lama yang sudah selesai dijalankan.
2. `server/src/utils/samsatNaming.ts` (2.884 B) ≡ `src/domain/pricing/samsatNaming.ts` (2.884 B) — 100% identik; sengaja diduplikasi karena `tsconfig.json` (frontend) dan `server/tsconfig.json` (backend `rootDir: src`) terpisah untuk isolasi compile/release (`package-release.ts` menyalin hanya `server/src`). **Catatan:** Tidak aman dihapus begitu saja sebelum menyatukan shared domain packaging!

---

## 3. GIT WORKING TREE STATUS

Status aktual sebelum cleanup:
- **Modified (`M` — Implementasi Phase A Design System yang baru disetujui & selesai):**
  - `src/styles/index.css`, `src/styles/design-tokens.css`, `src/styles/globals.css`
  - `src/app/components/ui/{alert,badge,button,card,input,select,status-config,textarea}.{ts,tsx}`
  - `src/app/components/Dashboard.tsx`
- **Untracked (`??` — Deliverables Audit & Phase A):**
  - `docs/ADMIN_FRONTEND_AUDIT_REPORT.md`
  - `docs/PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md`
  - `docs/audits/screenshots/01-dashboard-desktop.png` s.d. `25-notifikasi-desktop.png` + `audit-metrics.json` (29 file)
  - `tests/phase-a-design-system.test.ts`
- Seluruh file di atas **HARUS DIPERTAHANKAN** (atau dikelola sesuai persetujuan).

---

## 4. DEAD CODE FINDINGS (DISCOVERY PHASE B)

Penelusuran graph import statis dan dinamis (`import()`, `lazy()`, routing, registry, dan string lookup) dari entry point `src/main.tsx` dan `server/src/server.ts` mengidentifikasi:

### 4.1 Komponen Frontend Orphan / Tidak Dirender
- **`src/app/components/messenger/MessengerTaskDetailModal.tsx`** (52.030 B, 1.082 baris)
  - **Bukti:** 0 import di `src/`, 0 di `tests/`, 0 di `e2e/`. Digantikan pada Phase 5 Messenger Consolidation oleh `MessengerMobileTaskDetail.tsx`, `MessengerSamsatView.tsx`, dan `MessengerJemputHasilDetailView.tsx`. `MessengerWorkspace.tsx` tidak pernah me-render komponen ini.

### 4.2 Legacy Barrel & Repository In-Memory
- **`src/data/repositories/messengerRepository.ts`** (44 baris) — Mendefinisikan `InMemoryMessengerRepository` & `messengerRepository`; 0 pemanggil di `src/` atau `tests/` (hanya di-reexport oleh `src/data/repositories/index.ts`).
- **`src/data/repositories/index.ts`** (12 baris) — Barrel file yang **tidak di-import oleh 1 file pun** di `src/` atau `tests/` (semua consumer meng-import langsung mis. `from "../../data/repositories/orderRepository"`).
- **`src/data/storage/index.ts`** (7 baris) — Barrel file tanpa consumer; `memoryStorage.ts` hanya dipakai langsung oleh `tests/fixtures/mock/mockUserProvider.ts`.
- **`src/domain/index.ts`** (13 baris), **`src/domain/customer/types.ts`** (431 B), **`src/domain/vehicle/types.ts`** (701 B) — Hanya `src/domain/index.ts` yang me-export keduanya; 0 file di `src/` atau `server/` meng-import `domain/index`, `customer/types`, atau `vehicle/types`. *(Catatan: Tetap masuk Category B / Needs Approval karena merupakan lapisan domain type kontrak).*

### 4.3 Exported Symbols Tanpa Consumer Eksternal (`src/` & `server/src/`)
Dari pemeriksaan **1.122 export** di `src/` dan `server/src/`, mayoritas "unused exports" hanyalah `interface Props` atau `class Service` yang instance singleton-nya dipakai (sehingga aman dipertahankan untuk TypeScript DX). Namun ditemukan simbol implementasi nyata yang benar-benar mati / legacy:
1. `src/app/utils/financeFormatters.tsx`:
   - `FinanceStatusBadge` (alias `PlainTextStatus` yang sudah distandardisasi ke `<Badge status=... />`, 0 pemanggil eksternal).
   - `formatDateIndonesian` (alias `formatDateDDMMYYYY`, 0 pemanggil eksternal).
2. `src/app/utils/auditLog.ts`:
   - `useAuditLog()` (0 pemanggil di luar `auditLog.ts`).
3. `src/app/components/buatOrder` -> `getMonthNameFromDate` (di `BuatOrder.tsx`, diekspor tanpa consumer eksternal).
4. `src/app/components/NotificationHistory.tsx`:
   - UI Tab `"email"` dan state filter `emailSearch` / `emailStatus` — masih aktif di UI Notification History padahal konfigurasi penerima email sudah dihapus total pada Phase 4B Settings Simplification.
5. `src/app/components/AccessManagement.tsx`:
   - Baris 92 & 94: key modul usang `finance-pengeluaran` dan `finance-tagihan` yang route-nya telah dihapus/dikonsolidasikan.

### 4.4 Backend (`server/src/`)
Seluruh **105 file** di `server/src/` terhubung ke runtime `server.ts`/`app.ts` atau dijalankan eksplisit oleh CLI migrasi (`server/src/database/migrations/*`), DR/backup (`backupRestore.ts`), pre-reset (`transactionResetService.ts`), dan test isolation helper (`testIsolationHelper.ts`). **Tidak ada file backend dead-code yang boleh dihapus otomatis.**

---

## 5. CSS & DESIGN SYSTEM CLEANUP FINDINGS (DISCOVERY PHASE C)

### 5.1 Stylesheet Tidak Terpakai (Legacy Template Scaffolds)
Keempat file berikut sudah **tidak di-import** oleh `src/styles/index.css` maupun komponen mana pun (diverifikasi hingga build Vite Phase A):
1. `default_shadcn_theme.css` (root, 4.409 B) — Header: `/* KEEP_IN_SYNC(fullscreen/resources/figmake/styles/globals.css) */`.
2. `src/styles/default_theme.css` (4.319 B) — Dikeluarkan dari `src/styles/index.css` pada Phase A karena membawa `--primary: #030213`. Hanya direferensikan oleh unit test `tests/phase-a-design-system.test.ts` yang mengecek `index.css` tidak meng-import-nya.
3. `src/styles/theme.css` (5.448 B) — Salinan `@theme inline` + `:root` template shadcn/Figma Make, 0 consumer.
4. `src/styles/tailwind.css` (98 B) — Duplikat 4-baris `@import 'tailwindcss'` & `tw-animate-css` milik `index.css`, 0 consumer.

### 5.2 Utility Class CSS Tanpa Consumer Saat Ini
- `src/styles/design-tokens.css`:
  - `.typography-page-title`, `.typography-section-title`, `.typography-card-title`, `.typography-label`, `.typography-body`, `.typography-table`, `.typography-table-head`, `.typography-caption`, `.typography-mono-num` (0 pemanggil langsung saat ini; **DISARANKAN KEEP** sebagai token/utility Phase B–D).
  - `.content-compact`, `.content-standard`, `.focus-ring`, `.form-input-error` (0 pemanggil di luar `design-tokens.css`).
- `src/styles/globals.css`:
  - `.glass-card`, `.gradient-card`, `.animate-shimmer`, `.finance-table__secondary`, `.finance-placeholder` (0 pemanggil di `src/`).

---

## 6. DOCUMENTATION CLEANUP FINDINGS (DISCOVERY PHASE D)

Dari **119 file di `docs/`** + **6 file markdown/teks di root & `src/app/`**:

1. **Current Documentation (MUST KEEP):**
   - `README.md` (atau perlu pembaruan nanti), `docs/deployment.md`, `docs/production-runbook.md`, `docs/PRICING_DATABASE_ARCHITECTURE.md`, `docs/public-api-spec.yaml` & `docs/public-api-spec.json`, `docs/ADMIN_FRONTEND_AUDIT_REPORT.md`, `docs/PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md`, serta `docs/audit_arsitektur_data/` (24 file arsitektur & ERD `.mmd`).
2. **Generated Context Dumps (Obsolete / Reproducible Temp — Safe to Delete):**
   - `BUAT_ORDER_CONTEXT.md` (262.868 B — dump source mentah hasil `scripts/extract_buat_order.py`).
   - `PROJECT_CONTEXT.md` (173.500 B — dump source & struktur mentah hasil `scripts/extract_project_context.py`, memuat snapshot lama sebelum Phase A/Cleanup).
3. **Duplicate Attribution Files:**
   - `ATTRIBUTIONS.md` (root, 290 B) vs `src/app/Attributions.md` (289 B) — isi sama persis dari Figma Make boilerplate.
   - `metadata.json` (root, 288 B) — metadata Figma Make / AI Studio manifest tidak dipakai runtime/Vite build.
4. **Historical Implementation & Audit Reports (Archive / Needs Approval):**
   - Terdapat **47 file laporan di `docs/audits/`** (di antaranya **10 file terpisah hanya untuk Phase 4B Batch 2B Step D**, **5 file untuk Step C**, **4 file untuk Step B**, **4 file untuk Batch 1**) serta **7 laporan closure di `docs/`** dan `POST_REMEDIATION_VERIFICATION_REPORT.md` di root. Dokumen-dokumen ini masih bernilai audit trail historis, namun struktur root/folder bisa dirapikan ke folder arsip (mis. `docs/archive/phases/`) dengan persetujuan user, bukan dihapus sembarangan.

---

## 7. GENERATED ARTIFACTS, TEMPORARY SCRIPTS & FILES (DISCOVERY PHASE E)

### A. Reproducible Artifacts & Temporary Files (Safe to Delete Candidates)
- `scratch/` (**17 file**, ~44 KB, gitignored): seluruhnya script patching & inspeksi satu kali (`patch-app.cjs`, `fix-server-ts.cjs`, `patch-permissionStore.cjs` & `.js`, `pre-batch1-baseline.cjs`, dll.).
- `test-results/` (**3 file**, ~21 KB, gitignored): `.last-run.json` & `error-context.md` sisa eksekusi Playwright test lama.
- `check_db.js` (662 B, root): script debug ad-hoc yang meng-import `better-sqlite3` (package yang bahkan tidak ada di `package.json`).
- `scratch_inspect_db.js` (1.529 B, root): script inspeksi SQLite ad-hoc di root.
- `scripts/verification-results.json` (4.453 B): output JSON hasil run `verify-production-runtime.cjs`.
- `dist/` (28 file, ~6,48 MB, gitignored): hasil `npm run build` yang sepenuhnya *reproducible*. (Tetap dibutuhkan sebelum menjalankan `npm run server:prod` atau `release:package`).

### B. Evidence Artifacts (Hold / Needs Approval to Archive or Delete)
- `docs/audits/screenshots/` (**30 file PNG + `audit-metrics.json`**): bukti visual audit UI & Admin Frontend Audit terbaru (29 file) + 1 screenshot Phase 4B (`01-form-kas-messenger-tiered-select.png`).
- `docs/audits/PHASE_*` & `docs/*REPORT.md`: bukti penutupan dan rekonsiliasi historis.

### C. Operational Data & Backups (MUST KEEP — Dilarang Keras Dihapus)
- `server/data/database.sqlite` (1,4 MB) — Database operasional aktif.
- `server/data/database.sqlite.bak-20261111-batch2b-payment-methods` & `.bak_pre_cleanup` (2 file).
- `server/backups/database_phase4b_*` (10 file incl. `-shm` & `-wal`).
- `server/uploads/` (51 file dokumen order & bukti pembayaran pelanggan + `.gitkeep`).

---

## 8. DEPENDENCY AUDIT (DISCOVERY PHASE F)

Pemeriksaan terhadap seluruh **66 packages** pada `package.json` (`51 dependencies`, `15 devDependencies`) dengan memverifikasi import graph JS/TS/CSS, `vite.config.ts`, `eslint.config.js`, `tsconfig.json`, `playwright.config.ts`, dan `node_modules/*/package.json`:

### 8.1 Dependencies Terbukti Tidak Digunakan (18 `dependencies`)
Ke-18 package berikut memiliki **0 import** di `src/`, `server/`, `tests/`, `e2e/`, `scripts/`, config, CSS, dan **0 referensi** sebagai transitive/peer dependency dari package lain yang aktif:

| Package (`dependencies`) | Versi di `package.json` | Asal / Bukti Tidak Dipakai | Risiko Penghapusan |
|---|---|---|---|
| `@radix-ui/react-accordion` | `npm:@radix-ui/react-accordion` | Sisa starter shadcn; tidak ada `accordion.tsx` di `src/app/components/ui/` (0 import) | Sangat Rendah |
| `@radix-ui/react-aspect-ratio` | `npm:@radix-ui/react-aspect-ratio` | Tidak ada `aspect-ratio.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-collapsible` | `npm:@radix-ui/react-collapsible` | Tidak ada `collapsible.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-context-menu` | `npm:@radix-ui/react-context-menu` | Tidak ada `context-menu.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-hover-card` | `npm:@radix-ui/react-hover-card` | Tidak ada `hover-card.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-menubar` | `npm:@radix-ui/react-menubar` | Tidak ada `menubar.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-navigation-menu` | `npm:@radix-ui/react-navigation-menu` | Tidak ada `navigation-menu.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-progress` | `npm:@radix-ui/react-progress` | Tidak ada `progress.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-slider` | `npm:@radix-ui/react-slider` | Tidak ada `slider.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-toggle` | `npm:@radix-ui/react-toggle` | Tidak ada `toggle.tsx` (0 import) | Sangat Rendah |
| `@radix-ui/react-toggle-group` | `npm:@radix-ui/react-toggle-group` | Tidak ada `toggle-group.tsx` (0 import) | Sangat Rendah |
| `cmdk` | `npm:cmdk` | Tidak ada `command.tsx` (0 import) | Sangat Rendah |
| `embla-carousel-react` | `npm:embla-carousel-react` | Tidak ada `carousel.tsx` (0 import) | Sangat Rendah |
| `input-otp` | `npm:input-otp` | Tidak ada `input-otp.tsx` (0 import) | Sangat Rendah |
| `next-themes` | `npm:next-themes` | Aplikasi memakai `ThemeProvider.tsx` custom berbasis `localStorage` (0 import `next-themes`) | Sangat Rendah |
| `react-hook-form` | `npm:react-hook-form` | Seluruh form memakai `React.useState` (0 import) | Sangat Rendah |
| `react-resizable-panels` | `npm:react-resizable-panels` | Tidak ada `resizable.tsx` (0 import) | Sangat Rendah |
| `vaul` | `npm:vaul` | Tidak ada `drawer.tsx` (0 import) | Sangat Rendah |

### 8.2 Dependencies Tanpa Import Langsung di `src/` Namun **WAJIB DIPERTAHANKAN (`MUST KEEP`)**
- `react-is` (`^19.3.1`): Diverifikasi di `node_modules/recharts/package.json` sebagai `peerDependencies` dan di-import internal oleh `recharts@3.10.1` saat runtime (`recharts uses react-is at runtime: true`). **Dilarang dihapus.**
- `tw-animate-css`: Di-import via `@import 'tw-animate-css';` di `src/styles/index.css`.
- `@types/*` (`@types/cors`, `@types/express`, `@types/multer`, `@types/node`, `@types/react`, `@types/react-dom`): Dibutuhkan `tsc --noEmit` & `tsc -p server/tsconfig.json`.
- `tailwindcss`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `vite`, `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `typescript`, `@playwright/test`: Seluruhnya aktif dipakai tooling build, lint, typecheck, dan E2E test.

### 8.3 Redundant Lockfile
- `bun.lock` (133.367 B): Repository memakai `npm` (`package-lock.json` diwajibkan oleh `scripts/package-release.ts` baris 75 & 81) dan tidak ada script `bun` dalam proyek.

---

## 9. CATEGORY A — SAFE TO DELETE (DENGAN BUKTI LENGKAP)

*(Seluruh item Category A hanya berupa temporary files, debug leftovers, dan context dump yang dapat direkonstruksi. Tetap menunggu persetujuan sebelum dieksekusi di Mode 2).*

| Path | Type | Purpose | References | Last Usage | Replacement | Risk | Verification | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `check_db.js` | Script (Root debug) | Script inspeksi SQLite lama memakai `better-sqlite3` (broken: package tidak terpasang) | Hanya disebut di `PROJECT_CONTEXT.md` (0 code/test refs) | Ad-hoc debugging awal | `node:sqlite` via CLI atau `scripts/monitor-health.ts` | Zero | `node -e` / `git status` | **Delete** |
| `scratch_inspect_db.js` | Script (Root debug) | Script cek orphan `finance_invoices` satu kali di root | Hanya disebut di `PROJECT_CONTEXT.md` (0 code/test refs) | Debugging pra-remedi | Sudah tercakup test & `reconcile-invoices.ts` | Zero | `git status` | **Delete** |
| `scratch/` (17 files: `check-db.cjs`, `execute-db-backup.cjs`, `fix-*.cjs`, `inspect-*.cjs`, `patch-*.cjs`, `patch-permissionStore.js`, `pre-batch1-baseline.cjs`, `verify-all-baselines.cjs`) | Script (Temporary, gitignored) | Script patch AST/string dan backup satu kali saat Phase 1–4 | 0 referensi dari `src/`, `server/`, `tests/`, `package.json`, `scripts/` | Eksperimen / patching pra-Phase 4B | Perubahan sudah masuk ke source tracked | Zero | `npm run typecheck && npm run build` | **Delete** |
| `test-results/` (3 files: `.last-run.json`, 2 `error-context.md`) | Artifact (Generated Playwright, gitignored) | Snapshot kegagalan run Playwright lama | 0 referensi di repo | Sisa run `playwright test` terdahulu | Dibuat ulang otomatis saat `npm run test:e2e` | Zero | Re-run Playwright jika perlu | **Delete** |
| `BUAT_ORDER_CONTEXT.md` | Documentation / Dump (263 KB) | Dump gabungan source `BuatOrder` dari `extract_buat_order.py` | 0 refs di app/tests; hanya output path di `extract_buat_order.py` | Dump konteks AI sebelum audit | Bisa digenerate ulang jika perlu dari source | Zero | Cek tidak ada script build memakainya | **Delete** |
| `PROJECT_CONTEXT.md` | Documentation / Dump (173 KB) | Dump seluruh source tree & isi file dari `extract_project_context.py` | 0 refs di app/tests/release | Dump konteks lama (outdated terhadap Phase A) | Bisa digenerate ulang via `extract_project_context.py` | Zero | Cek tidak ada script build memakainya | **Delete** |
| `scripts/verification-results.json` | Artifact (Generated test output) | Hasil JSON statis dari eksekusi `verify-production-runtime.cjs` | Hanya ditulis oleh `verify-production-runtime.cjs` | Run verifikasi runtime terdahulu | Dibuat ulang saat menjalankan `verify-production-runtime.cjs` | Zero | Cek `package-release.ts` | **Delete** |

---

## 10. CATEGORY B — NEEDS APPROVAL

### 10.1 Dead Code & Legacy Source / CSS

| Path | Type | Purpose | References | Last Usage | Replacement | Risk | Verification | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `src/app/components/messenger/MessengerTaskDetailModal.tsx` (1.082 baris) | Source (Component) | Modal detail tugas messenger generasi awal | 0 import di `src/`, `tests/`, `e2e/` (hanya disebut di laporan audit lama & `PROJECT_CONTEXT.md`) | Sebelum Phase 5 | `MessengerMobileTaskDetail.tsx` & view spesifik tab | Rendah | `npm run typecheck && npm run build` | **Approval Required (Delete)** |
| `src/data/repositories/messengerRepository.ts` | Source (Data layer) | Wrapper in-memory tugas messenger (`orderStore`) | Hanya di-export ulang oleh `src/data/repositories/index.ts`; 0 consumer di `src/` & `tests/` | Desain awal sebelum `messengerTaskAdapter` & API provider | `src/app/data/messengerTaskAdapter.ts` & `apiMessengerProvider.ts` | Rendah | `npm run typecheck && npm run test` | **Approval Required (Delete)** |
| `src/data/repositories/index.ts`, `src/data/storage/index.ts` | Source (Barrels) | Barrel `export *` repository/storage | 0 file di `src/` atau `tests/` meng-import kedua index barrel ini (import dilakukan langsung ke file spesifik) | Initial scaffold | Direct file imports yang sudah berjalan | Rendah | `npm run typecheck && npm run test` | **Approval Required (Delete / Keep as API surface)** |
| `src/app/Attributions.md` | Documentation (Duplicate) | Lisensi shadcn/unsplash Figma Make | Duplikat 289 B dari root `ATTRIBUTIONS.md` (290 B); 0 runtime import | Initial Figma Make export | `ATTRIBUTIONS.md` di root | Zero | `npm run build` | **Approval Required (Delete duplicate)** |
| `default_shadcn_theme.css` (root) | CSS (Legacy scaffold) | Template CSS awal Figma/Sinatra (`#030213`) | 0 import di CSS/JS/TS/HTML; hanya disebut di `PROJECT_CONTEXT.md` | Initial template | `src/styles/globals.css` + `design-tokens.css` | Zero | `npm run build` | **Approval Required (Delete)** |
| `src/styles/default_theme.css` | CSS (Legacy scaffold) | Template tema `#030213` yang sudah dikeluarkan dari `index.css` pada Phase A | 0 import CSS; disebut hanya di `tests/phase-a-design-system.test.ts` (pengecekan anti-import) & docs | Pra-Phase A | `src/styles/globals.css` | Rendah (perlu update 1 assertion di test Phase A bila dihapus) | `npm run build && npm run test` | **Approval Required (Delete)** |
| `src/styles/theme.css` & `src/styles/tailwind.css` | CSS (Unused duplicates) | Duplikat isi `default_theme.css` & `index.css` | 0 import CSS/JS/HTML | Initial template | `src/styles/index.css` & `globals.css` | Zero | `npm run build` | **Approval Required (Delete)** |
| `NotificationHistory.tsx` (tab Email Logs) & `AccessManagement.tsx` (key `finance-pengeluaran`, `finance-tagihan`) | Source (Dead UI branches) | UI log email & key permission untuk modul/tab yang sudah dihapus | UI internal masing-masing file | Sebelum Phase 4B Settings Simplification & Finance Redesign | Tab In-App Notifications & route finance terkini | Sedang (cek test & backend RBAC map sebelum ubah) | Test RBAC & Settings/Notif browser check | **Approval Required (Phase B UI cleanup)** |
| Simbol export tak terpakai di `financeFormatters.tsx` (`FinanceStatusBadge`, `formatDateIndonesian`), `auditLog.ts` (`useAuditLog`), `BuatOrder.tsx` (`getMonthNameFromDate`), `pricingReference.ts` (static price constants bila SSoT penuh) | Source (Unused exports) | Alias / helper legacy | 0 pemanggil eksternal di `src/`, `server/`, `tests/`, `e2e/` | Sebelum standardisasi `<Badge>` & DB SSoT | `<Badge status=... />`, `formatDateDDMMYYYY` | Rendah–Sedang (cek `mutasi-ld-pricing-ssot.test.ts` untuk `pricingReference.ts`) | `npm run typecheck && npm run test` | **Approval Required** |

### 10.2 Unused Dependencies & Redundant Lockfile

| Path | Type | Purpose | References | Last Usage | Replacement | Risk | Verification | Recommendation |
|---|---|---|---|---|---|---|---|---|
| 18 unused `package.json` `dependencies` (`@radix-ui/react-{accordion,aspect-ratio,collapsible,context-menu,hover-card,menubar,navigation-menu,progress,slider,toggle,toggle-group}`, `cmdk`, `embla-carousel-react`, `input-otp`, `next-themes`, `react-hook-form`, `react-resizable-panels`, `vaul`) | Dependency | Paket bawaan template shadcn/Figma Make yang komponennya tidak ada/tidak dipakai | 0 import di `src/`, `server/`, `tests/`, `e2e/`, `scripts/`, config, CSS, & 0 peerDep requirement dari package aktif | Initial template scaffold | Tidak perlu pengganti (`ThemeProvider.tsx` sudah custom, form memakai React state) | Rendah (mengurangi ukuran `node_modules` & waktu install) | `npm install` + `npm run typecheck && npm run build && npm run test` | **Approval Required (Remove via `npm uninstall`)** |
| `bun.lock` (133 KB) | Lockfile | Lockfile Bun runtime | 0 script `bun` di `package.json`; hanya di-exclude oleh `extract_project_context.py` | Setup awal | `package-lock.json` (wajib dipakai oleh `package-release.ts`) | Zero | `npm run release:package` | **Approval Required (Delete)** |
| `metadata.json` (root, 288 B) | Config / AI Studio metadata | Descriptor manifest Figma/AI Studio | Hanya disebut di `PROJECT_CONTEXT.md`; 0 refs runtime/Vite | Setup awal | `package.json` | Zero | `npm run build` | **Approval Required (Delete)** |

### 10.3 One-Off / Legacy Verification & Analysis Scripts (`scripts/`)

| Path | Type | Purpose | References | Last Usage | Replacement | Risk | Verification | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `scripts/analyze-bundle.mjs`, `scripts/analyze-imports.mjs` | Script | Helper statistik ukuran bundle & import | 0 refs di `package.json` / tests | Analisis ad-hoc awal | Vite build report | Zero | — | **Approval Required (Delete / Archive)** |
| `scripts/audit_git_categories.cjs`, `scripts/audit_git_status.cjs` | Script | Script pengelompokan `git status` saat audit Phase 4 | 0 refs | Audit Git historis | `git status` langsung | Zero | — | **Approval Required (Delete / Archive)** |
| `scripts/compare_db_hash_lineage.cjs`, `scripts/record_remediation_baseline.cjs` | Script | Perbandingan SHA-256 DB pra- dan pasca-Phase 4B | 0 refs | Audit Step B/C | Sudah di-record di laporan audit | Zero | — | **Approval Required (Archive / Delete)** |
| `scripts/extract_buat_order.py`, `scripts/extract_project_context.py` | Script (Python) | Generator `BUAT_ORDER_CONTEXT.md` & `PROJECT_CONTEXT.md` | 0 refs di JS/TS/package.json | Dump konteks | Tidak dibutuhkan di pipeline | Zero | — | **Approval Required (Delete / Archive)** |
| `scripts/verify_phase2_completion.ts`, `verify_phase3_completion.ts`, `verify_phase4_completion.ts`, `verify_erd_overhaul.ts`, `verify_order_documents.ts`, `verify_uploads_manifest.cjs`, `test_order_service_erd.ts`, `test-pengeluaran-direct.ts`, `verify_p0_stability.ts`, `verify_data_penjualan_e2e.ts`, `verify_edit_persistence.ts`, `run_seed_phase1.ts`, `start-test-backend.cjs`, `run-sandbox-server.cjs` | Script (Historical verification) | Script verifikasi CLI satu kali per fase historis | 0 refs di `package.json` & test suite (`tests/` sudah menggantikan cakupan verifikasi lewat `run-test-isolated.cjs`) | Phase 2–8 historis | `npm run test` & `npm run test:e2e` | Rendah | Pastikan tidak dipakai manual saat ops/QA | **Approval Required (Archive ke `scripts/archive/` atau Delete)** |
| `e2e/quick-check.spec.ts` (26 baris) | Test (E2E) | Smoke check cepat manual ke `/finance/kas-kantor` | Tidak dirujuk tempat lain | Debugging lokal | `e2e/modules-flow.spec.ts` & `e2e/business-financial-journey.spec.ts` | Rendah | `npx playwright test --list` | **Approval Required (Delete / Keep)** |

### 10.4 Dokumentasi Audit Historis & Screenshot (`docs/` & Root)

| Path | Type | Purpose | References | Last Usage | Replacement | Risk | Verification | Recommendation |
|---|---|---|---|---|---|---|---|---|
| `POST_REMEDIATION_VERIFICATION_REPORT.md` (root) & `docs/audits/PHASE_*` (46 laporan step/batch: 10 file `STEP_D`, 5 `STEP_C`, 4 `STEP_B`, 4 `BATCH_1`, dll.) + 7 laporan fase di `docs/` | Documentation (Historical Reports) | Jejak audit & verifikasi fase-fase implementasi terdahulu | Sebagian dirujuk antar-laporan; memiliki nilai audit trail historis | Phase 1–4B (Nov 2026) | — | Rendah jika dipindah, Tinggi kehilangan audit trail jika dihapus | Verifikasi link di `docs/` | **Approval Required — Archive ke `docs/archive/phases/` (JANGAN hapus semua jika audit trail dibutuhkan)** |
| `docs/audits/screenshots/` (29 untracked PNG Audit Frontend + `audit-metrics.json` + 1 tracked `01-form-kas-messenger-tiered-select.png`) | Evidence Artifacts | Bukti visual `ADMIN_FRONTEND_AUDIT_REPORT.md` | Dirujuk oleh laporan audit frontend | Audit Frontend 2026-11-12 | Sudah ada salinan di brain artifact/audit log | Rendah setelah evaluasi audit selesai | Cek `ADMIN_FRONTEND_AUDIT_REPORT.md` | **Approval Required (Archive / Delete setelah audit frontend dievaluasi)** |
| `docs/public-api-spec.json` vs `docs/public-api-spec.yaml` | Documentation (API Spec) | Spesifikasi OpenAPI 3.0.3 Public API dalam 2 format (JSON & YAML) | 0 test refs; dokumentasi API pelanggan | Phase Public API | Pilih satu format kanonis (`yaml` atau `json`) | Rendah | Cek apakah tools eksternal butuh JSON/YAML | **Approval Required (Keep both or remove duplicate format)** |

---

## 11. CATEGORY C — MUST KEEP (WAJIB DIPERTAHANKAN)

1. **Operational Data, Backups & Uploads (64 file):**
   - `server/data/database.sqlite` + `.bak-*` (historical safety snapshots).
   - `server/backups/database_phase4b_*` (10 file snapshot pre-migration).
   - `server/uploads/*` (51 file dokumen KYC/STNK/BPKB/invoice & `.gitkeep`).
2. **Active Application Source:**
   - `src/` aktif (`App.tsx`, seluruh page Admin & `messenger/MessengerWorkspace.tsx` + view aktifnya, semua UI components di `src/app/components/ui/` termasuk `pagination.tsx` yang masih dipakai `MessengerTask.tsx`, semua store/adapter/provider/repository/domain aktif).
   - `server/src/` (seluruh 105 file — routes, controllers, services, repositories, database schema/migrations/seed, middleware, storage, utils).
3. **Configuration, Release & Production Tooling:**
   - `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig.json`, `server/tsconfig.json`, `eslint.config.js`, `playwright.config.ts`, `postcss.config.mjs`, `.env`, `.env.example`, `.gitignore`, `index.html`.
   - `deploy/` (6 file deployment systemd, nginx, caddy, backup-offsite).
   - Active operational `scripts/`: `dev-orchestrator.cjs`, `patch-realpath.cjs`, `start-production.cjs`, `run-test-isolated.cjs`, `backup.ts`, `verify-dr.ts`, `smoke-test.ts`, `monitor-health.ts`, `package-release.ts`, `apply-operational-migrations.ts`, `reconcile-historical-inv-1126.ts`, `reconcile-invoices.ts`, `post-reset-operational-verification.ts`, `purge_sales_transactions.ts`, `verify-production-runtime.cjs`.
4. **Test Suites (`tests/` & `e2e/`):**
   - Seluruh 146 unit/integration test di `tests/` dan 19 spec aktif di `e2e/` (termasuk `tests/phase-a-design-system.test.ts`).
5. **Core Current Documentation:**
   - `README.md`, `ATTRIBUTIONS.md`, `docs/deployment.md`, `docs/production-runbook.md`, `docs/PRICING_DATABASE_ARCHITECTURE.md`, `docs/ADMIN_FRONTEND_AUDIT_REPORT.md`, `docs/PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md`, `docs/audit_arsitektur_data/` (arsitektur & ERD).
6. **Direct & Runtime Dependencies:**
   - Seluruh `dependencies` aktif termasuk `react-is` (`recharts` runtime dep), `tw-animate-css`, dan seluruh `devDependencies` (termasuk `@types/*`, `eslint*`, `typescript*`, `vite`, `@playwright/test`, `tailwindcss`).

---

## 12. POTENTIAL RISKS

1. **Deletion of `MessengerTaskDetailModal.tsx`:** Meskipun 0 consumer saat ini, pastikan tidak ada branch eksternal yang meng-import-nya sebelum dihapus (di repo ini hanya 1 commit, jadi aman setelah `typecheck` & `build`).
2. **Removal of `src/styles/default_theme.css`:** `tests/phase-a-design-system.test.ts` saat ini hanya memeriksa `index.css` tidak meng-import `default_theme.css` (bukan membaca file `default_theme.css` itu sendiri), sehingga penghapusan file aman; namun tetap jalankan `phase-a-design-system.test.ts` pasca-cleanup.
3. **Uninstalling the 18 npm dependencies:** Harus dijalankan lewat `npm uninstall ...` agar `package-lock.json` diperbarui konsisten (dibutuhkan oleh `scripts/package-release.ts`). Jangan pernah menghapus `react-is`!
4. **Database & Backup Protection:** File `.bak*` di `server/data/` dan `server/backups/` berukuran ~1,4 MB per file namun sangat krusial sebagai *audit/rollback snapshot*; jangan masukkan ke command clean otomatis.
5. **Dual `samsatNaming.ts`:** Identik SHA-256 antara `src/domain/pricing/samsatNaming.ts` dan `server/src/utils/samsatNaming.ts`, tetapi **TIDAK BOLEH** dihapus salah satunya tanpa refaktor `tsconfig.json` & `scripts/package-release.ts`.

---

## 13. RECOMMENDED CLEANUP ORDER (MODE 2 — SETELAH PERSETUJUAN)

1. **Step 1 (Category A — Zero-Risk Temp & Dump Cleanup):** Hapus `scratch/` (17 file), `test-results/` (3 file), `check_db.js`, `scratch_inspect_db.js`, `BUAT_ORDER_CONTEXT.md`, `PROJECT_CONTEXT.md`, `scripts/verification-results.json`. *(Opsional: hapus `dist/` jika tidak langsung menjalankan server:prod, atau biarkan ter-rebuild).*
2. **Step 2 (Dead Source & Legacy CSS):** Hapus `MessengerTaskDetailModal.tsx`, `messengerRepository.ts`, `src/app/Attributions.md`, `default_shadcn_theme.css`, `src/styles/{default_theme,theme,tailwind}.css` *(serta `bun.lock`, `metadata.json`, `repositories/index.ts`, `storage/index.ts` bila disetujui)*.
3. **Step 3 (Dependencies Cleanup):** Jalankan `npm uninstall` untuk 18 unused UI packages sehingga `package.json` dan `package-lock.json` bersih.
4. **Step 4 (Scripts & Docs Archiving):** Pindahkan laporan step/batch historis ke `docs/archive/` dan script investigasi lama ke `scripts/archive/` (atau hapus sesuai keputusan user).
5. **Step 5 (Full Verification Gate):** Jalankan `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, dan Playwright smoke check.

---

## 14. EXPECTED IMPACT

- **Pengurangan File Workspace:** ~25–30 file temp/dead langsung terhapus di Step 1–2 (ditambah ~70 file historis/screenshot bila diarsipkan/dihapus).
- **Ukuran Root & Repository Lebih Bersih:** Pengurangan langsung ~550+ KB markdown context dumps & dead modals di source tree, plus pengurangan ~18 package beserta sub-dependensinya dari `package.json`, `package-lock.json`, dan `node_modules/`.
- **Ketertelusuran Kode Lebih Tinggi:** Menghilangkan jebakan developer/AI untuk file CSS mati (`default_theme.css`, `theme.css`), modal messenger usang (`MessengerTaskDetailModal.tsx`), dan root DB scripts yang sudah rusak (`check_db.js`).

---

## 15. VERIFICATION PLAN (UNTUK MODE 2 PASCA-CLEANUP)

Setelah persetujuan dan eksekusi Mode 2, verifikasi wajib dijalankan secara berurutan:
1. `npm run typecheck` (`tsc --noEmit && tsc -p server/tsconfig.json --noEmit`) — pastikan 0 error akibat file/export yang dihapus.
2. `npm run lint` (`eslint .`) — pastikan 0 error baru.
3. `npm run build` — pastikan production Vite bundle selesai bersih (`dist/`).
4. `node scripts/run-test-isolated.cjs tests/phase-a-design-system.test.ts tests/master-layanan-ui-cleanup.test.ts tests/finance-ui-ux-consolidation.test.ts tests/messenger-task-ui-density-lock.test.ts tests/mock-provider.test.ts tests/release-engineering.test.ts` (atau full `npm run test`).
5. Health check server FE (`localhost:3000`) & BE (`localhost:3001/api/health/ready`) + navigasi rute kunci (`/dashboard`, `/finance/profit`, `/order/buat`, `/messenger`).
6. Pemeriksaan akhir `git status` & `git diff` + penyusunan `docs/PROJECT_CLEANUP_IMPLEMENTATION_REPORT.md`.

---

> **APPROVAL GATE:** Sesuai ketentuan Mode 1, pekerjaan dihentikan di sini. Silakan review dan beri persetujuan item mana dari **Category A** dan **Category B** yang boleh dieksekusi di Mode 2.
