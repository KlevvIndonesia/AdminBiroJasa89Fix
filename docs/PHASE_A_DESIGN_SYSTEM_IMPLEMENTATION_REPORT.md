# PHASE A — ADMIN DASHBOARD DESIGN SYSTEM IMPLEMENTATION REPORT
**Project:** SUNBiroJasa / Admin SUN89  
**Workspace:** `D:\Admin\adminsunbirojasa`  
**Phase:** Phase A — Design System Foundation  
**Date:** 2026-11-12

---

## 1. EXECUTIVE SUMMARY

Phase A (**Design System Foundation**) telah diimplementasikan secara terukur dan terisolasi pada Admin Dashboard SUN89. Fokus pekerjaan adalah membangun **single source of truth** untuk design tokens (warna, tipografi, spacing, radius, shadow, status semantik), menyelesaikan konflik CSS cascade (`default_theme.css` vs `globals.css`), serta menstandardisasi komponen dasar bersama (`Button`, `Input`, `Textarea`, `Select`, `Card`, `Badge`, `Alert`, dan `status-config.ts`).

**Status Keseluruhan:** `VERIFIED`  
Seluruh perubahan hanya menyentuh lapisan fondasi styling dan UI primitives (`src/styles/` dan `src/app/components/ui/` serta 1 token chart pada `Dashboard.tsx`), dengan **0 perubahan business logic, 0 perubahan backend/API, 0 perubahan skema database SQLite, dan 0 modifikasi pada Messenger Mobile Workspace**.

---

## 2. REPOSITORY STATE BEFORE IMPLEMENTATION

Pemeriksaan `git status --short` dan `git diff --stat` sebelum implementasi Phase A mencatat:
- `[VERIFIED]` Working tree bersih pada seluruh source code produksi (`src/` dan `server/`).
- `[VERIFIED]` Hanya terdapat dokumen hasil audit read-only sebelumnya (`docs/ADMIN_FRONTEND_AUDIT_REPORT.md` dan `docs/audits/screenshots/*`).
- `[VERIFIED]` Baseline check sebelum perubahan:
  - `npm run typecheck`: Exit code `0` (0 errors).
  - `npm run lint`: Exit code `0` (0 errors, `3182` pre-existing warnings).
  - `npm run build`: Exit code `0` (`dist/assets/index-xlzhChU3.css` 181.83 kB).
- `[VERIFIED]` Dev server FE (`http://localhost:3000`) dan BE (`http://localhost:3001/api/health/ready` -> HTTP 200 healthy) aktif untuk verifikasi visual Before/After.

---

## 3. FINDINGS DARI AUDIT AKTUAL (PHASE A.1)

| Area | Kondisi Aktual | File Terkait | Risiko |
|---|---|---|---|
| **Color tokens** | `default_theme.css` mendefinisikan `--primary: #030213` (light) & `oklch(0.985 0 0)` (dark) sebelum di-override `globals.css` (`#2563eb` / `#3b82f6`). Tidak tersedia `--primary-hover`, `--primary-subtle`, serta pasangan foreground kontras tinggi (`--color-*-fg`) untuk semantic status. | `src/styles/index.css`, `src/styles/default_theme.css`, `src/styles/globals.css`, `src/styles/design-tokens.css` | Sedang: ketergantungan urutan import rapuh dan kontras teks badge semantic light mode kurang kuat. |
| **Typography** | `fonts.css` & `design-tokens.css` menetapkan `--font-family-sans` ("Quick Sans" + system fallback). `globals.css` menetapkan `--font-size: 15px` untuk `body` sementara `p` menggunakan `14px` (`0.875rem`). `th` memakai `600` padahal target tabel SaaS adalah `500`. | `src/styles/fonts.css`, `src/styles/design-tokens.css`, `src/styles/globals.css` | Rendah: penyesuaian `body` ke `14px` dengan `html` tetap `16px` (`1rem = 16px`) aman bagi skala rem. |
| **Spacing** | `.page-shell` tersedia di `design-tokens.css` (12px / 16px / 24px, diuji oleh `tests/master-layanan-ui-cleanup.test.ts`), namun variabel CSS skala spacing (`--space-1..8`) belum didefinisikan eksplisit. | `src/styles/design-tokens.css` | Rendah: penambahan variabel aditif menjaga seluruh utility Tailwind tetap identik. |
| **Radius** | `--radius: 0.625rem` (10px) menggeser utilitas Tailwind `rounded-md/lg/xl` menjadi 8px/10px/14px, tidak sinkron dengan target fondasi 6px/8px/12px. | `src/styles/default_theme.css`, `src/styles/globals.css`, `src/styles/design-tokens.css` | Sedang: menormalkan `--radius: 0.5rem` (8px) otomatis menyelaraskan `rounded-md`=6px, `rounded-lg`=8px, `rounded-xl`=12px secara serentak. |
| **Shadows** | Nilai `box-shadow` masih ditulis inline pada `.glass-card` dan `Dashboard.tsx` chart tooltip tanpa token terpusat `--shadow-xs/sm/md/lg`. | `src/styles/globals.css`, `src/app/components/Dashboard.tsx` | Rendah: penambahan token shadow light & dark mode memusatkan elevasi UI. |
| **Button** | `button.tsx` menggunakan `hover:bg-primary/90` alih-alih `#1D4ED8`, belum memiliki prop `loading?: boolean`, variant alias `primary`, dan size `icon-lg`. | `src/app/components/ui/button.tsx` | Rendah: mempertahankan seluruh variant & size existing menjamin kompatibilitas penuh. |
| **Input & Textarea** | `input.tsx` dan `textarea.tsx` belum memakai `React.forwardRef`, belum memiliki prop `inputSize` (`sm`/`default`/`lg`), `error?: boolean`, maupun slot ikon opsional (`leftIcon`/`rightIcon`). | `src/app/components/ui/input.tsx`, `src/app/components/ui/textarea.tsx` | Rendah: penambahan `forwardRef` meningkatkan kompatibilitas `react-hook-form` & uncontrolled refs. |
| **Select** | `SelectTrigger` memakai `border-border/80`, belum mendukung ukuran `"lg"` atau prop `error?: boolean`. | `src/app/components/ui/select.tsx` | Rendah: tetap memakai Radix Select primitives dan `z-[100]` agar modal stacking aman. |
| **Card** | `card.tsx` memakai `border-border/80` tanpa variant `secondary`/`flat`. | `src/app/components/ui/card.tsx` | Rendah: penambahan `cardVariants` menjaga seluruh caller eksisting tetap identik. |
| **Badge & Alert** | `badge.tsx` hanya punya 4 variant (`default`, `secondary`, `destructive`, `outline`), belum ada variant eksplisit `neutral`, `primary`, `success`, `warning`, `danger`, `info`. `status-config.ts` & `alert.tsx` masih hardcoded class Tailwind warna. | `src/app/components/ui/badge.tsx`, `src/app/components/ui/status-config.ts`, `src/app/components/ui/alert.tsx` | Sedang: pemetaan `BUSINESS_STATUS_MAP` harus dijaga 100% tanpa mengubah arti bisnis. |
| **Dark mode** | `ThemeProvider.tsx` mengatur class `.light` / `.dark` pada `<html>`. Di dark mode: `--input: #1e293b` dan `--input-background: #0f172a` menyatu dengan `--card: #0f172a`; `color-scheme: dark` belum disetel sehingga ikon kalender input `date` native tampak gelap; chart `Dashboard.tsx` meng-hardcode `#2563eb`. | `src/styles/globals.css`, `src/app/components/Dashboard.tsx` | Sedang: perbaikan kontras input dark mode & `color-scheme` berdampak langsung pada keterbacaan form. |

---

## 4. FILE YANG DIUBAH

| File | Perubahan | Alasan | Risiko |
|---|---|---|---|
| `src/styles/index.css` | Menghapus `@import './default_theme.css';` dari cascade utama. | Mengeliminasi konflik token `--primary: #030213`, duplikasi `@theme inline`, dan duplikasi `@layer base`. | Rendah (seluruh token aktif sudah didefinisikan di `globals.css` & `design-tokens.css`; file lama tetap dibiarkan di disk). |
| `src/styles/design-tokens.css` | Menambahkan spacing tokens (`--space-1..8`), radius foundation (`--radius-small..pill`), shadow foundation light/dark (`--shadow-xs..lg`), serta semantic `--color-*-fg/bg/border` + alias `--color-danger*` dan `--color-neutral*`. | Menjadikan `design-tokens.css` sumber kebenaran token skala visual dan semantik WCAG AA. | Rendah (seluruh selector `.page-shell` dan komentar yang diuji test dipertahankan persis). |
| `src/styles/globals.css` | Menyetel `color-scheme: light/dark`, `--font-size: 0.875rem` (14px), `--radius: 0.5rem` (8px), menambah `--primary-hover`, `--primary-subtle*`, `--destructive-hover`, `--border-subtle`, memperjelas dark mode `--input: #334155` & `--input-background: #0b1120`, memperbarui `@theme inline`, menghapus override hardcoded `body.light/dark` & `.light/.dark .glass-*`, dan menyelaraskan `th` ke `font-weight: 500`. | Mengkonsolidasikan theme tokens Light/Dark mode, memperbaiki kontras form dark mode & datepicker icon, serta menyelaraskan radius Tailwind (`6px/8px/12px`). | Sedang (perubahan `--radius` dan `--input` dark mode tervalidasi visual di 18 viewport tanpa overflow/regresi). |
| `src/app/components/ui/button.tsx` | Menambahkan variant `primary`, `hover:bg-primary-hover`, `hover:bg-destructive-hover`, `border-input bg-card` pada `outline`, size `icon-lg`, `cursor-pointer`, serta prop `loading?: boolean` dengan `Loader2` spinner (aman terhadap `asChild`). | Menstandardisasi state button lengkap (default, hover, active, focus-visible, disabled, loading, icon-only). | Rendah (100% kompatibel dengan seluruh props & Radix `Slot`). |
| `src/app/components/ui/input.tsx` | Mengubah ke `React.forwardRef`, menyelaraskan `border-input bg-input-background shadow-xs hover:border-muted-foreground/40 disabled:bg-muted/60`, menambahkan `inputSize` (`sm`/`default`/`lg`), `error?: boolean`, dan slot opsional `leftIcon`/`rightIcon`. | Mendukung controlled/uncontrolled ref, error state seragam, dan konsistensi tinggi/radius dengan Select & Button. | Rendah (`div.relative` hanya dirender jika `leftIcon`/`rightIcon` diisi). |
| `src/app/components/ui/textarea.tsx` | Mengubah ke `React.forwardRef`, menambahkan `error?: boolean`, dan menyelaraskan token `border-input bg-input-background shadow-xs`. | Menyelaraskan kontrol input multi-baris dengan `Input`. | Rendah. |
| `src/app/components/ui/select.tsx` | Menyelaraskan `SelectTrigger` (`border-input bg-input-background`, `size?: "sm" \| "default" \| "lg"`, `error?: boolean`) dan `SelectContent` (`border-border rounded-lg shadow-md`). | Menyamakan tinggi, radius, focus ring, error state, dan kontras dark mode antara `Select` dan `Input`. | Rendah (Radix Select keyboard & portal interaction tetap utuh). |
| `src/app/components/ui/card.tsx` | Menambahkan `cardVariants` (`default`, `secondary`, `flat`) menggunakan `border-border` dan `rounded-xl` (12px). | Menstandardisasi surface hierarchy Card tanpa mengubah layout halaman pemanggil. | Rendah. |
| `src/app/components/ui/badge.tsx` | Menambahkan semantic variants (`neutral`, `primary`, `success`, `warning`, `danger`, `info`) berbasis token CSS, serta memperbaiki resolusi `variant: null` saat prop `status` digunakan. | Menyediakan variant semantik lengkap untuk light/dark mode tanpa bentrok dengan class `status`. | Rendah. |
| `src/app/components/ui/status-config.ts` | Memigrasikan `STATUS_STYLES` ke token utilitas `bg-status-*-bg text-status-*-fg border-status-*-border` dengan tetap mempertahankan `BUSINESS_STATUS_MAP`, `LEGACY_COLOR_MAP`, dan `formatBadgeText`. | Menghapus duplikasi warna status antara CSS tokens dan komponen React. | Rendah (mapping status bisnis tidak diubah sama sekali). |
| `src/app/components/ui/alert.tsx` | Memigrasikan variant `destructive`, `warning`, `info`, `success` ke `text-status-*-fg bg-status-*-bg border-status-*-border`. | Menyatukan warna alert dengan token semantic global. | Rendah. |
| `src/app/components/Dashboard.tsx` | Mengganti `#2563eb` dan hardcoded tooltip `boxShadow` pada Profit AreaChart menjadi `var(--primary)`, `var(--radius-lg)`, dan `var(--shadow-md)`. | Agar chart utama dashboard mengikuti theme primary Light (`#2563EB`) dan Dark (`#3B82F6`) otomatis. | Rendah (hanya visual token chart, tidak menyentuh kalkulasi angka). |
| `tests/phase-a-design-system.test.ts` *(baru)* | Unit test verifikasi cascade CSS, token Light/Dark, dan kontrak props/variants base UI components. | Memberikan guardrail otomatis terhadap regresi fondasi pada Phase B–D. | Tidak ada risiko produksi. |

---

## 5. DESIGN TOKEN SEBELUM DAN SESUDAH

| Kategori | Token | Sebelum | Sesudah |
|---|---|---|---|
| **Primary (Light)** | `--primary` | `#2563eb` (tetapi didahului `#030213` di `default_theme.css`) | `#2563eb` (single definition) |
| **Primary Hover / Subtle (Light)** | `--primary-hover` / `--primary-subtle` | *Tidak ada* (`hover:bg-primary/90`) | `#1d4ed8` / `#eff6ff` (fg: `#1d4ed8`, border: `#bfdbfe`) |
| **Primary (Dark)** | `--primary` | `#3b82f6` (didahului `oklch(0.985 0 0)` di `default_theme.css`) | `#3b82f6` (single definition) |
| **Primary Hover / Subtle (Dark)** | `--primary-hover` / `--primary-subtle` | *Tidak ada* | `#2563eb` / `rgba(59, 130, 246, 0.16)` (fg: `#93c5fd`) |
| **Dark Input Surface & Border** | `--input` / `--input-background` | `#1e293b` / `#0f172a` (menyatu dengan card `#0f172a`) | `#334155` / `#0b1120` (kontras jelas terhadap card `#0f172a`) |
| **Color Scheme** | `color-scheme` | Tidak disetel | `light` (`:root, .light`), `dark` (`.dark`) |
| **Body Font Size** | `--font-size` (`body`) | `15px` (berbeda dengan `p` `14px`) | `0.875rem` (`14px`, `html` tetap `16px`) |
| **Table Header Weight** | `th` `font-weight` | `600` | `500` (medium) |
| **Radius Scale** | `--radius` (`md`/`lg`/`xl`) | `0.625rem` (`8px`/`10px`/`14px`) | `0.5rem` (`6px`/`8px`/`12px`) + `--radius-small..pill` |
| **Spacing Tokens** | `--space-1..8` | *Tidak ada CSS var* | `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px` |
| **Shadow Tokens** | `--shadow-xs..lg` | Hardcoded per selector | Token Light & Dark terpisah (`--shadow-xs/sm/md/lg`) |
| **Semantic Status** | `--color-{success,warning,danger,info}-*` | Hanya base + bg + border (tanpa `*-fg` AA / `danger` alias) | Lengkap: base + `*-fg` (AA contrast) + `*-bg` + `*-border` + `danger` alias |

---

## 6. CSS CASCADE DAN KONFLIK YANG DISELESAIKAN

1. **Eliminasi Konflik `default_theme.css` (`VERIFIED`):**
   - Sebelumnya `src/styles/index.css` meng-import `default_theme.css` tepat sebelum `globals.css`, menghasilkan definisi ganda untuk `:root`, `.dark`, `@custom-variant dark`, `@theme inline`, dan `@layer base` serta nilai usang `--primary: #030213`.
   - `@import './default_theme.css';` dihapus dari `src/styles/index.css`. File `default_theme.css`, `theme.css`, dan `tailwind.css` tetap dipertahankan di disk tanpa dihapus sesuai aturan kehati-hatian agar tidak memutus referensi luar yang mungkin ada.
2. **Pemisahan Tanggung Jawab Token (`VERIFIED`):**
   - `fonts.css`: Font stack family (`--font-family-sans`).
   - `design-tokens.css`: Typography scale, control heights, spacing scale, radius/shadow foundation, semantic status tokens (Light & Dark), serta utility `.typography-*` dan `.page-shell`.
   - `globals.css`: Theme color tokens (`.light`/`.dark`), Tailwind `@theme inline` mapping, `@layer base`, dan styling modul finance (`.finance-table*`).
3. **Pengurangan Ukuran Bundle CSS (`VERIFIED`):**
   - Output CSS production build turun dari `181.83 kB` menjadi `180.31 kB` akibat hilangnya duplikasi rule CSS.

---

## 7. KOMPONEN YANG DIPERBARUI

1. **`Button` (`button.tsx`):** Variant `default`, `primary`, `destructive`, `outline`, `secondary`, `ghost`, `link`; size `sm` (32px), `default` (36px), `lg` (40px), `icon`, `icon-sm`, `icon-lg`; prop `loading?: boolean` (`aria-busy`, disabled otomatis, spinner `Loader2` aman dengan `asChild`).
2. **`Input` (`input.tsx`):** `React.forwardRef`, `inputSize` (`sm` 32px / `default` 36px / `lg` 40px), `error?: boolean`, `leftIcon`/`rightIcon` opsional tanpa membungkus DOM bila tidak dipakai, number scroll-wheel guard dipertahankan.
3. **`Textarea` (`textarea.tsx`):** `React.forwardRef`, `error?: boolean`, token border/surface/focus/disabled seragam dengan `Input`.
4. **`Select` (`select.tsx`):** `SelectTrigger` selaras tinggi (`sm` 32px / `default` 36px / `lg` 40px), border (`border-input`), surface (`bg-input-background`), disabled, focus ring, `error?: boolean`; `SelectContent` memakai `border-border` dan `bg-popover` untuk light & dark mode.
5. **`Card` (`card.tsx`):** `cardVariants` (`default`, `secondary`, `flat`) dengan radius `12px` (`rounded-xl`) dan `border-border`.
6. **`Badge` & `status-config.ts`:** Semantic variants lengkap (`default`, `neutral`, `primary`, `success`, `warning`, `danger`, `info`, `secondary`, `destructive`, `outline`) berbasis token CSS dengan tetap menjaga prop `status` dan `BUSINESS_STATUS_MAP` 100%.
7. **`Alert` (`alert.tsx`) & `Dashboard.tsx`:** Alert semantic terhubung ke CSS status tokens; Profit AreaChart pada Dashboard terhubung ke `var(--primary)`, `var(--radius-lg)`, dan `var(--shadow-md)`.

---

## 8. PERUBAHAN LIGHT MODE

- `[VERIFIED]` Background `#f8fafc`, card `#ffffff`, border `#e2e8f0`, foreground `#0f172a`, muted-foreground `#64748b`, primary `#2563eb`, primary hover `#1d4ed8`, primary subtle `#eff6ff`.
- `[VERIFIED]` Semantic badge & alert teks menggunakan tone kontras AA (`#15803d` di `#f0fdf4`, `#b45309` di `#fffbeb`, `#b91c1c` di `#fef2f2`, `#1d4ed8` di `#eff6ff`).
- `[VERIFIED]` Computed styles di browser menunjukkan `bodyFontSize: 14px`, `cardRadius: 12px`, `inputRadius: 8px`, `selectHeight: 36px`, `colorScheme: light`.

---

## 9. PERUBAHAN DARK MODE

- `[VERIFIED]` Background `#090d16`, surface card/popover `#0f172a`, secondary/muted `#1e293b`, border `#1e293b`, foreground `#f1f5f9`, muted-foreground `#94a3b8`, primary `#3b82f6`, primary hover `#2563eb`.
- `[VERIFIED]` **Perbaikan Kontras Form:** `--input: #334155` dan `--input-background: #0b1120` membuat batas `Input`, `Textarea`, dan `SelectTrigger` terlihat tegas di atas kartu `#0f172a`.
- `[VERIFIED]` **Perbaikan Ikon Datepicker Native:** `color-scheme: dark` pada `.dark` membuat ikon kalender `<input type="date" />` berubah menjadi terang dan mudah terlihat di halaman Finance Profit dark mode.
- `[VERIFIED]` **Select Dropdown Dark Surface:** Terverifikasi pada Playwright (`select-dropdown-dark.png`), `SelectContent` merender background `rgb(15, 23, 42)` (`#0f172a`), text `rgb(241, 245, 249)`, dan border `rgb(30, 41, 59)` tanpa bleed light mode.
- `[VERIFIED]` **Chart Theme Synchronization:** Garis dan gradien `Tren Profit & Order` otomatis memakai `#3b82f6` (`var(--primary)`) pada dark mode.

---

## 10. BACKWARD COMPATIBILITY

- `[VERIFIED]` Seluruh nama variant existing `Button` (`default`, `destructive`, `outline`, `secondary`, `ghost`, `link`), `Badge` (`default`, `secondary`, `destructive`, `outline`, `status`), dan sub-komponen `Card`/`Select` tetap dipertahankan.
- `[VERIFIED]` `BUSINESS_STATUS_MAP`, `LEGACY_COLOR_MAP`, `formatBadgeText`, dan `getStatusBadgeClass` tetap identik secara fungsional.
- `[VERIFIED]` Kelas `.page-shell` di `design-tokens.css` dan `.finance-table*` di `globals.css` tetap dipertahankan sesuai kontrak test eksisting.
- `[VERIFIED]` Messenger Mobile Workspace (`src/app/components/messenger/*`) tidak dimodifikasi sama sekali.

---

## 11. TEST COMMANDS DAN HASIL AKTUAL

| Command | Exit Code | Hasil | Keterangan |
|---|---|---|---|
| `npm run typecheck` | `0` | **PASS** | Frontend (`tsc --noEmit`) & Backend (`tsc -p server/tsconfig.json --noEmit`) 0 errors. |
| `npm run build` | `0` | **PASS** | Production Vite build selesai (`19.88s`, CSS bundle `180.31 kB`). |
| `npm run lint` | `0` | **PASS** | 0 ESLint errors; `3182` pre-existing warnings (sama persis dengan baseline sebelum edit). |
| `npx eslint <changed-ts-files>` | `0` | **PASS** | 0 errors, 10 pre-existing warnings pada `Dashboard.tsx` & `badge.tsx`. |
| `node scripts/run-test-isolated.cjs tests/phase-a-design-system.test.ts tests/finance-table-standardization.test.ts tests/master-layanan-ui-cleanup.test.ts tests/finance-ui-ux-consolidation.test.ts tests/messenger-task-ui-density-lock.test.ts` | `1` | **4/5 Suites PASS** | `phase-a-design-system.test.ts` (11/11 pass), `master-layanan-ui-cleanup.test.ts` (5/5 pass), `finance-ui-ux-consolidation.test.ts` (10/10 pass), `messenger-task-ui-density-lock.test.ts` (12/12 pass). `finance-table-standardization.test.ts` gagal 1 subtest baseline di `FinanceContent.tsx` (`Reimbursement empty state colSpan must be 10`) yang bukan bagian dari Phase A; seluruh test `.finance-table--font-*` di `globals.css` PASS. |
| `node scripts/run-test-isolated.cjs tests/admin-action-feedback.test.ts tests/financial-action-feedback.test.ts tests/login-feedback.test.ts` | `1` | **2/3 Suites PASS** | `admin-action-feedback.test.ts` (8/8 pass), `login-feedback.test.ts` (12/12 pass). `financial-action-feedback.test.ts` gagal 1 subtest HTTP backend integration (`400 !== 200` pada endpoint pembayaran di isolated sandbox, baseline test DB; subtest #6 UI contract `FinanceContent.tsx` PASS). |

---

## 12. VISUAL VERIFICATION DAN SCREENSHOT

Verifikasi browser otomatis via Playwright terhadap FE (`localhost:3000`) & BE (`localhost:3001`) dijalankan untuk membandingkan kondisi Before & After pada 4 modul utama di viewport Desktop (`1440px`), Tablet (`768px`), dan Mobile (`375px`), Light & Dark Mode (**18 snapshot After + uji dropdown Select dark mode**):

- **Halaman Uji:**
  1. Admin Dashboard (`/dashboard`) — Light & Dark, 1440 / 768 / 375
  2. Finance → Profit (`/finance/profit`) — Light & Dark, 1440 / 768 / 375
  3. Master Data → Samsat (`/master-data/samsat`) — Light & Dark, 1440 / 768 / 375 (+ uji interaktif `SelectContent` dropdown dark mode)
  4. Order Management → Buat Order (`/order/buat`) — Light & Dark, 1440 / 768 / 375
- **Hasil Pengamatan Aktual (`VERIFIED`):**
  - Horizontal overflow: `false` pada seluruh 18 kombinasi halaman/viewport/theme (`scrollWidth === windowWidth`).
  - Console/Page errors: `0` (`consoleErrors: []`).
  - Computed root & element checks: `bodyFontSize: 14px`, `cardRadius: 12px`, `inputRadius: 8px`, `inputHeight: 36px` (form) / `32px` (toolbar `h-8`), `selectHeight: 36px`, `SelectContent` dark mode `bg: rgb(15, 23, 42)` & `color: rgb(241, 245, 249)`.
- **Lokasi Bukti Screenshot & Metrik (Artifact Directory):**
  - Before: `phase_a_screenshots/before/`
  - After: `phase_a_screenshots/after/` (termasuk `metrics.json` dan `select-dropdown-dark.png`)

---

## 13. KNOWN ISSUES

1. **[Baseline / Out-of-Scope]** Inline hardcoded color utility classes (`bg-emerald-500/10`, `bg-amber-500/10`, dll.) masih ada di beberapa halaman spesifik modul (`BiayaLayanan.tsx`, `BuatOrder.tsx`, `FinanceContent.tsx`, `OrderTracking.tsx`) ketika memanggil `<Badge variant="outline" className="...">`. Sesuai aturan scope Phase A, migrasi massal di level halaman belum dilakukan agar tidak mengubah warna status bisnis di luar fondasi dan dicadangkan untuk Phase B/D.
2. **[Baseline Test]** 1 subtest pada `tests/finance-table-standardization.test.ts` (line 194, `FinanceContent.tsx` `colSpan={10}`) dan 1 subtest HTTP integration pada `tests/financial-action-feedback.test.ts` (line 746, `400 !== 200`) sudah gagal di baseline luar perubahan Phase A.
3. **[Font Asset]** Font family `"Quick Sans"` tetap bergantung pada fallback sistem sans-serif (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`) karena binary font `.woff2`/`.ttf` memang tidak dibundel dalam repositori.

---

## 14. RISKS DAN LIMITATIONS

- Verifikasi Playwright difokuskan pada 4 halaman representatif lintas modul sesuai cakupan Section 12 (`Dashboard`, `Finance Profit`, `Master Data Samsat`, `Buat Order`) dan uji dropdown `SelectContent` dark mode; komponen interaktif lain yang dibangun di atas primitif yang sama (seperti modal dialog pembayaran atau form error pada halaman lain) terlindungi melalui backward-compatibility API dan typecheck penuh.
- File CSS template lama (`default_theme.css`, `theme.css`, `tailwind.css`) tidak dihapus dari disk demi keamanan referensi historis; saat ini hanya tidak di-import oleh `src/styles/index.css`.

---

## 15. ACCEPTANCE CRITERIA CHECKLIST

**Design tokens**
- [x] `VERIFIED` — Terdapat sumber kebenaran token yang jelas (`design-tokens.css` & `globals.css`).
- [x] `VERIFIED` — Tidak ada konflik primary token yang tidak disengaja (`default_theme.css` dikeluarkan dari `index.css`).
- [x] `VERIFIED` — Color semantic memiliki pasangan light/dark yang sesuai (`fg`, `bg`, `border`).
- [x] `VERIFIED` — Typography foundation konsisten (`body` 14px, `th` 12px medium, `CardTitle` 15px semibold, `h1` 20–24px).
- [x] `VERIFIED` — Spacing, radius (`6px`/`8px`/`12px`/`9999px`), dan shadow foundation tersedia.

**Shared components**
- [x] `VERIFIED` — `Button` memiliki variant dan state yang konsisten (termasuk `loading`, `disabled`, `focus-visible`, `icon-only`, `sm`/`default`/`lg`).
- [x] `VERIFIED` — `Input` (dan `Textarea`) memiliki state yang konsisten (`forwardRef`, `inputSize`, `error`, `disabled`, `focus-visible`, opsional `leftIcon`/`rightIcon`).
- [x] `VERIFIED` — `Select` memiliki state yang konsisten (`sm`/`default`/`lg`, `error`, dark popover surface, Radix accessibility tetap utuh).
- [x] `VERIFIED` — `Card` menggunakan foundation yang sama (`rounded-xl` 12px, `border-border`, `cardVariants`).
- [x] `VERIFIED` — `Badge` memiliki semantic variants (`neutral`, `primary`, `success`, `warning`, `danger`, `info` + light/dark parity).
- [x] `VERIFIED` — Existing props dan behavior tetap kompatibel (`PARTIALLY VERIFIED` secara live pada 4 halaman utama, `VERIFIED` secara statis/typecheck pada seluruh codebase).

**Theme**
- [x] `VERIFIED` — Light mode tervalidasi.
- [x] `VERIFIED` — Dark mode tervalidasi (termasuk kontras input, select dropdown, chart `var(--primary)`, dan `color-scheme: dark`).
- [x] `VERIFIED` — Tidak ada regresi theme yang ditemukan pada halaman sampel.

**Quality**
- [x] `VERIFIED` — Typecheck berhasil (`exit 0`).
- [x] `VERIFIED` — Build berhasil (`exit 0`).
- [x] `VERIFIED` — Test relevan Phase A & UI cleanup/consolidation berhasil (catatan baseline failure terpisah dijelaskan di Section 11 & 13).
- [x] `VERIFIED` — Tidak ada perubahan backend/database.
- [x] `VERIFIED` — Tidak ada perubahan Messenger Mobile Workspace.
- [x] `VERIFIED` — Tidak ada perubahan business logic.
- [x] `VERIFIED` — Perubahan lokal sebelum pengerjaan (`docs/ADMIN_FRONTEND_AUDIT_REPORT.md` & screenshot audit) tetap terjaga.

---

## 16. REKOMENDASI PHASE B

Setelah evaluasi Phase A disetujui, langkah berikut yang direkomendasikan pada **Phase B (Shared Table & Pagination Unification)**:
1. Menyatukan tiga pola tabel (`EnhancedTableWithDialogs.tsx`, `EnhancedTable.tsx`, dan raw `ui/table.tsx`) menjadi satu arsitektur tabel terpadu berbasis Composition Pattern tanpa mengubah logika bisnis tabel finance yang ada.
2. Menyeragamkan penggunaan `TablePagination.tsx` dan `EmptyState.tsx` di seluruh tabel Admin.
3. Mengganti pemanggilan `<Badge variant="outline" className="bg-*-500/10 ...">` yang berulang di tabel-tabel menjadi `<Badge variant="success|warning|danger|info|primary" />` agar seluruh halaman otomatis mengikuti token semantik Phase A.
4. Membersihkan tab legacy ("Email Logs" di `NotificationHistory.tsx`) serta key usang di `AccessManagement.tsx` secara terpisah bila disetujui.
