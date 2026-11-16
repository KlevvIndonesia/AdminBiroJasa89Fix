# SUNBIROJASA — ADMIN FRONTEND COMPREHENSIVE AUDIT REPORT
**Project:** SUNBiroJasa / Admin SUN89  
**Workspace:** `D:\Admin\adminsunbirojasa`  
**Execution Mode:** STRICT READ-ONLY  
**Visual Direction:** Modern Professional SaaS  
**Target Scope:** Admin Dashboard ONLY (Messenger Mobile Workspace Strictly Excluded)  
**Audit Date:** 12 November 2026  
**Auditor:** Antigravity AI Engineering Assistant  

---

## 1. EXECUTIVE SUMMARY

Audit frontend komprehensif ini dilakukan terhadap seluruh antarmuka web **Admin Dashboard SUN89** dengan pendekatan **Strict Read-Only**. Audit bertujuan membedah arsitektur frontend aktual, memetakan seluruh inventaris halaman dan komponen, mengidentifikasi inkonsistensi visual & UX, mengevaluasi kesiapan responsif & aksesibilitas, serta menyusun spesifikasi **Design System Modern Professional SaaS** yang siap diimplementasikan secara berjenjang tanpa risiko regresi.

### Ringkasan Temuan Utama:
1. **Frontend Architecture & Tooling:** Dibangun di atas stack modern: **React 18.3.1**, **Vite 6.3.5**, **Tailwind CSS v4.1.12** (`@tailwindcss/vite`), **React Router (v7 library structure)**, dan **Radix UI primitives**. Sistem routing menggunakan client-side SPA berbasis `BrowserRouter` dengan pemisahan tegas antara Admin Shell dan Messenger Dedicated Workspace (`src/app/App.tsx#L376-L390`).
2. **Duplikasi & Fragmentasi Styling Token:** Terdapat konflik token CSS antar file. File `src/styles/default_theme.css` mendefinisikan `--primary: #030213` (hampir hitam), namun dioverride oleh `src/styles/globals.css` menjadi `--primary: #2563eb` (Royal Blue). Selain itu, terdapat file `src/styles/theme.css` dan `src/styles/tailwind.css` yang tidak terhubung ke build pipeline.
3. **Fragmentasi Paradigma Komponen Tabel:** Ditemukan tiga implementasi tabel yang berbeda:
   - *Monolithic EnhancedTableWithDialogs* (88 KB): Menggabungkan tabel, filter modal, column visibility modal, export dialog, dan form CRUD dalam satu komponen raksasa.
   - *Lightweight EnhancedTable* (14 KB): Tabel terpisah dengan filter dan pagination.
   - *Raw UI Table Primitives* (`ui/table.tsx`): Tabel manual dengan markup terpisah di berbagai halaman (seperti `OrderTracking.tsx`, `AuditLog.tsx`, `BiayaLayanan.tsx`, `ProfitReconciliationView.tsx`).
4. **Variasi Kontrol Input & Date Filter:** Ditemukan 3 pola pemilihan tanggal yang berbeda: browser native `<input type="date" />`, custom popover `FinanceDateFilter.tsx` (mode hari/minggu/bulan/tahun), dan button presets (*Bulan Ini*, *Bulan Lalu*, *Tahun Ini*).
5. **Kesiapan Responsif:** Layar desktop (1440px) tertata rapi. Namun pada breakpoint tablet (768px) dan mobile (375px), beberapa tabel operasional dengan lebih dari 8 kolom mengalami pemadatan informasi yang membutuhkan standarisasi horizontal scroll container dan priority column hiding.

---

## 2. VERIFIED FRONTEND ARCHITECTURE

### 2.1 Technology Stack & Tooling

| Lapisan | Teknologi / Library | Versi | Status Verifikasi |
|---|---|---|:---:|
| **Runtime & Core** | React, React DOM | `^18.3.1` | `[VERIFIED]` `package.json#L66-L67` |
| **Build Tool / Bundler** | Vite | `6.3.5` | `[VERIFIED]` `package.json#L92` |
| **CSS Engine** | Tailwind CSS v4, `@tailwindcss/vite` | `4.1.12` | `[VERIFIED]` `package.json#L79, L89` |
| **Routing** | React Router | `^7.1.5` / `react-router` | `[VERIFIED]` `package.json#L69` |
| **UI Component Primitives** | Radix UI (Slot, Dialog, Select, Tabs, Popover, Switch, dll.) | `1.1.x` | `[VERIFIED]` `package.json#L25-L50` |
| **Icons** | Lucide React | `^0.475.0` | `[VERIFIED]` `package.json#L59` |
| **Animations** | Motion (`motion/react`) | `^12.4.4` | `[VERIFIED]` `package.json#L60` |
| **Charts** | Recharts | `^2.15.1` | `[VERIFIED]` `package.json#L70` |
| **Notifications / Toasts** | Sonner | `^2.0.1` | `[VERIFIED]` `package.json#L71` |
| **Utility** | `clsx`, `tailwind-merge`, `class-variance-authority` | `Latest` | `[VERIFIED]` `package.json#L51-L53, L72` |

### 2.2 Entry Point & Style Loading Cascade

1. **HTML Entry:** `index.html`  
   Memuat `<div id="root"></div>` dan mengeksekusi `<script type="module" src="/src/main.tsx"></script>`.  
   Terdapat style inline pencegah overscroll dan penonaktifan spinner pada `input[type="number"]` (`index.html#L11-L32`).
2. **TypeScript Entry:** `src/main.tsx`  
   Membungkus aplikasi dengan `<BrowserRouter>` dan mengimpor file induk style `./styles/index.css` (`src/main.tsx#L1-L10`).
3. **CSS Cascade Tree (`src/styles/index.css`):**
   ```css
   @import 'tailwindcss' source(none);
   @source '../../**/*.{js,ts,jsx,tsx}';
   @import 'tw-animate-css';
   @import './fonts.css';          /* Fallback font token */
   @import './design-tokens.css';  /* Typography & status variables */
   @import './default_theme.css';  /* Theme tokens baseline */
   @import './globals.css';        /* Final theme override & SaaS rules */
   ```
   - `[VERIFIED]` File `theme.css` dan `tailwind.css` di `src/styles/` merupakan file residu dan tidak diimpor dalam `index.css`.

### 2.3 Boundary: Admin Dashboard vs. Messenger Dedicated Workspace

Berdasarkan arsitektur pada `src/app/App.tsx#L376-L390`, terdapat pemisahan arsitektur yang sangat tegas:

```typescript
// Dedicated Messenger Workspace for Messenger Role
if (userRole === 'messenger') {
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <MessengerWorkspace
        onLogout={handleLogout}
        currentUser={{ userId, userName, role: 'messenger', employeeId: employeeId || '' }}
      />
    </Suspense>
  );
}
```

- **Messenger Workspace (`src/app/components/messenger/MessengerWorkspace.tsx`):**  
  Merupakan portal operasional lapangan khusus kurir (mobile webapp).  
  **Status Scope: DIKECUALIKAN SECARA KETAT DARI AUDIT & REDESIGN ADMIN.**
- **Admin Messenger Views (`/messenger/tasks` & `/messenger/history`):**  
  Komponen `MessengerTask.tsx` dan `MessengerHistory.tsx` berada di dalam **Admin Shell** (`src/app/App.tsx#L786-L787`), digunakan oleh Admin Operasional / SVP untuk mendisposisikan tugas ke kurir dan memverifikasi biaya reimbursement lapangan.  
  **Status Scope: MASUK DALAM SCOPE ADMIN.**

---

## 3. ADMIN ROUTE INVENTORY

Inventarisasi lengkap seluruh rute Admin berdasarkan `src/app/App.tsx` dan `src/app/config/routeConfig.ts`:

| Route Path | Permission ID | Route Title | Breadcrumbs | Komponen Utama | Keterangan / Redireksi |
|---|---|---|---|---|---|
| `/dashboard` | `dashboard` | Dashboard | Dashboard | `Dashboard.tsx` | Ringkasan operasional & finansial |
| `/order/buat` | `buat-order` | Buat Order | Order > Buat Order | `BuatOrder.tsx` | Wizard 3-step pembuatan pesanan |
| `/order/tracking` | `order-tracking` | Order Tracking | Order > Order Tracking | `OrderTracking.tsx` | Pelacakan proses 6-stage & modal kerja |
| `/order/rekap` | `order-history` | Rekap Order | Order > Rekap Order | `OrderHistory.tsx` | Arsip data transaksi & invoice selesai |
| `/finance/profit` | `finance-profit` | Profit | Finance > Profit | `ProfitReconciliationView.tsx` | Rekonsiliasi profit per jenis layanan |
| `/finance/kas-messenger` | `finance-kas-messenger` | Kas Messenger | Finance > Kas Messenger | `FinanceContent.tsx` (tab) | Petty cash kurir & reimbursement |
| `/finance/kas-kantor` | `finance-kas-kantor` | Kas Kantor | Finance > Kas Kantor | `FinanceContent.tsx` (tab) | Arus kas debit/kredit operasional kantor |
| `/finance/pengeluaran` | `finance-kas-kantor` | — | — | Redirect | `[VERIFIED]` 301/Redirect ke `/finance/kas-kantor` |
| `/finance/data-penjualan` | `finance-penjualan` | Data Penjualan | Finance > Data Penjualan | Redirect | Otomatis redirect ke category default |
| `/finance/data-penjualan/:category` | `finance-penjualan` | Data Penjualan - :category | Finance > Data Penjualan > :category | `DataPenjualan.tsx` | Rekapitulasi per 8 jenis layanan |
| `/finance/belum-bayar` | `finance-belum-bayar` | Belum & Kurang Bayar | Finance > Belum & Kurang Bayar | `FinanceContent.tsx` (tab) | Piutang customer & pelunasan |
| `/finance/profit-pending` | `finance-profit-pending` | Profit Terpending | Finance > Profit Terpending | `FinanceContent.tsx` (tab) | Berkas pending verifikasi SKKP Samsat |
| `/finance/cashback-pending` | `finance-cashback-pending` | Cashback Terpending | Finance > Cashback Terpending | `FinanceContent.tsx` (tab) | Saldo lebih bayar rekanan/biro |
| `/finance/tagihan` | `finance-belum-bayar` | — | — | Redirect | `[VERIFIED]` Redirect ke `/finance/belum-bayar` |
| `/finance/laba-rugi` | `finance-laba-rugi` | Laba Rugi | Finance > Laba Rugi | `LabaRugiStatementView.tsx` | Laporan laba rugi 3-sumber transaksi |
| `/master-data/layanan` | `master-layanan` | Master Layanan | Master Data > Layanan | `MasterLayanan.tsx` | Katalog layanan & persyaratan |
| `/master-data/samsat` | `master-samsat` | Data Samsat | Master Data > Samsat | `WilayahSamsatManager.tsx` | Master kantor Samsat per wilayah/provinsi |
| `/master-data/metode-pembayaran` | `master-metode-pembayaran` | Metode Pembayaran | Master Data > Metode Pembayaran | `MetodePembayaranMaster.tsx` | Master bank rekening & metode kas |
| `/master-data/biaya-layanan` | `master-biaya-layanan` | Biaya Layanan | Master Data > Biaya Layanan | `BiayaLayanan.tsx` | Katalog tarif & biaya jasa 8 layanan |
| `/master-data/biaya-layanan/:service` | `master-biaya-layanan` | Biaya Layanan - :service | Master Data > Biaya Layanan > :service | `BiayaLayanan.tsx` | Filter spesifik per jenis pengurusan |
| `/master-data/harga-dasar` | `master-harga-dasar-samsat` | Harga Dasar Samsat | Master Data > Harga Dasar Samsat | `HargaDasarSamsat.tsx` | Standar tarif PNBP & tarif dasar resmi |
| `/manajemen/karyawan` | `manajemen-karyawan` | Karyawan | Manajemen > Karyawan | `MasterDataContent.tsx` (tab) | Manajemen data staf & kurir |
| `/manajemen/pengguna` | `manajemen-pengguna` | Pengguna | Manajemen > Pengguna | `ManajemenPengguna.tsx` | Akun pengguna sistem & kredensial |
| `/manajemen/hak-akses` | `access-management` | Hak Akses | Manajemen > Hak Akses | `AccessManagement.tsx` | Matriks perizinan role & modul |
| `/manajemen/riwayat-aktivitas` | `audit-log` | Riwayat Aktivitas | Manajemen > Riwayat Aktivitas | `AuditLog.tsx` | Audit trail & security activity log |
| `/messenger/tasks` | `messenger-task` | Messenger Task | Messenger > Messenger Task | `MessengerTask.tsx` | Disposisi penugasan kurir oleh Admin |
| `/messenger/history` | `messenger-history` | Messenger History | Messenger > Messenger History | `MessengerHistory.tsx` | Riwayat penyelesaian kurir & bukti struk |
| `/settings` | `settings` | Pengaturan | Pengaturan | `Settings.tsx` | Notifikasi sistem & keamanan kata sandi |
| `/profile` | `profile` | Profil Saya | Profil Saya | `Profile.tsx` | Profil akun pengguna aktif |
| `/notifikasi` | `notifikasi` | Riwayat Notifikasi | Notifikasi | `NotificationHistory.tsx` | Log notifikasi sistem |

---

## 4. PAGE AND COMPONENT INVENTORY

Berikut adalah hasil audit mendalam terhadap setiap halaman Admin Dashboard:

### 4.1 Modul Dashboard (`/dashboard`)
- **Komponen Utama:** `Dashboard.tsx` (`src/app/components/Dashboard.tsx`)
- **Layout:** Standard Page Shell (`content-fluid`, grid 3-kolom responsif)
- **Komponen UI Dominan:** `Card`, `AreaChart`, `PieChart`, `Calendar`, `Select`, `Badge`, `Button`
- **Pola Interaksi:** Filter periode cepat (*Per Hari, Per Minggu, Per Bulan, Per Tahun*), pemilihan tanggal kalender untuk filter reminder, tooltip hover chart interaktif.
- **Kondisi Responsif:** Grid 3-kolom otomatis berubah menjadi 1-kolom pada breakpoint tablet dan mobile (`grid-cols-1 sm:grid-cols-3` & `grid-cols-1 lg:grid-cols-3`).
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Warna chart di-hardcode ke `#2563eb` pada `AreaChart` (`Dashboard.tsx#L204, L232`).
  - `[VISUALLY OBSERVED]` Kalender pada kolom kanan saat dibuka di layar laptop 13 inci agak padat dengan font tanggal kecil.
- **Prioritas:** `P2`

### 4.2 Modul Order Management
#### A. Buat Order (`/order/buat`)
- **Komponen Utama:** `BuatOrder.tsx` (4.543 baris)
- **Layout:** Multi-step Stepper Form (Step 1: Klien & Kendaraan, Step 2: Dokumen & Pembayaran, Step 3: Konfirmasi/Invoice)
- **Komponen UI Dominan:** `Input`, `Select`, `Popover`, `PlateNumberInput`, `SearchableSamsatSelect`, `TieredPaymentMethodSelect`, `Card`, `Button`
- **Pola Interaksi:** Stepper wizard berurutan dengan validasi ketat per tahap, kalkulator pajak Samsat otomatis, upload berkas foto dengan drag & drop dan kompresi client-side.
- **Kondisi Responsif:** Pada layar tablet dan mobile, form terbagi menjadi 1 kolom vertikal panjang. Stepper bar tetap terlihat di atas.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Ukuran file sangat besar (4.543 baris) yang menggabungkan logic perhitungan pajak, state form, validasi, dan rendering modal dalam satu file.
  - `[VISUALLY OBSERVED]` Step 1 memiliki lebih dari 15 input fields dalam satu layar yang dapat menimbulkan beban kognitif tinggi bagi petugas loket.
- **Prioritas:** `P1`

#### B. Order Tracking (`/order/tracking`)
- **Komponen Utama:** `OrderTracking.tsx` (8.396 baris)
- **Layout:** Kanban-style 6-Stage Process Pipeline + Table/Card View
- **Komponen UI Dominan:** `Badge`, `Dialog`, `AlertDialog`, `Button`, `Input`, `DocumentPreviewModal`
- **Pola Interaksi:** Filter status tahap operasional (Stage 1 s.d Stage 6), filter Samsat, input nopol cepat, aksi update progres (verifikasi bayar, jadwal Samsat, jemput berkas, input biaya riil SKKP, arsip berkas).
- **Kondisi Responsif:** Horizontal scrolling diaktifkan saat melihat pipeline tahapan order pada layar laptop dan tablet.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Terlalu banyak modal lokal (6 dialog berbeda) di dalam satu komponen tanpa abstraksi controller terpusat.
  - `[POTENTIAL RISK]` Rendemen rendering ulang (*re-renders*) terjadi di seluruh baris saat salah satu status berkas diperbarui.
- **Prioritas:** `P1`

#### C. Rekap Order (`/order/rekap`)
- **Komponen Utama:** `OrderHistory.tsx` (1.241 baris)
- **Layout:** Data Table dengan Filter Header dan Pagination
- **Komponen UI Dominan:** `Table`, `TablePagination`, `Input` (search), `Dialog` (`InvoiceDialog`), `Badge`
- **Pola Interaksi:** Pencarian instan nopol/customer, filter rentang tanggal, pembukaan modal pratinjau invoice, unduh invoice/kwitansi.
- **Kondisi Responsif:** Tabel memiliki wrapper overflow-x-auto.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Menggunakan primitive `ui/table.tsx` secara langsung dengan baris custom daripada shared table wrapper.
- **Prioritas:** `P2`

### 4.3 Modul Finance
#### A. Profit (`/finance/profit`)
- **Komponen Utama:** `ProfitReconciliationView.tsx` (Refined di Phase 4B)
- **Layout:** 3-Section Layout: Section 1 (Filter), Section 2 (Tabel Rekapitulasi 12 Kolom), Section 3 (KPI Ringkasan)
- **Komponen UI Dominan:** `Card`, `Table`, `Badge`, `Button`, `Export CSV/PDF/Cetak`
- **Pola Interaksi:** Expand/collapse rincian metode pembayaran dan rekening bank per jenis layanan, filter tanggal preset (*Semua Data, Bulan Ini, Bulan Lalu, Tahun Ini*), export data utuh.
- **Kondisi Responsif:** Tabel beradaptasi baik di 1440px. Pada mobile (<640px), kolom rincian otomatis tergulung dan dapat diekspansi tanpa merusak grid.
- **Prioritas:** `P3` (Sudah distandarisasi)

#### B. Kas Messenger (`/finance/kas-messenger`)
- **Komponen Utama:** `FinanceContent.tsx` (`tab === "kas-messenger"`)
- **Layout:** Dual Tabs: *Buku Kas Messenger* dan *Pengajuan Biaya Operasional / Reimbursement*
- **Komponen UI Dominan:** `EnhancedTableWithDialogs`, `AddKasMessengerModal`, `TieredPaymentMethodSelect`, `Badge`
- **Pola Interaksi:** Tambah top-up petty cash kurir, verifikasi pencairan reimbursement bukti struk, void transaksi kas kurir.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Masih terdapat teks kosong raw: `"Tidak ada data pengajuan reimbursement yang sesuai filter"` pada baris tabel daripada menggunakan komponen `<EmptyState />` (`FinanceContent.tsx#L2541`).
- **Prioritas:** `P1`

#### C. Kas Kantor (`/finance/kas-kantor`)
- **Komponen Utama:** `FinanceContent.tsx` (`tab === "kas-kantor"`)
- **Layout:** Single Ledger View dengan kartu ringkasan saldo debit/kredit
- **Komponen UI Dominan:** `EnhancedTableWithDialogs`, `AddKasKantorModal`, `TieredPaymentMethodSelect`, `RekonsiliasiKasModal`
- **Pola Interaksi:** Tambah transaksi kas masuk/keluar, tutup kas harian (cetak A5), drilldown mutasi rekening bank vs kas fisik.
- **Prioritas:** `P2`

#### D. Data Penjualan (`/finance/data-penjualan/:category`)
- **Komponen Utama:** `DataPenjualan.tsx`
- **Layout:** Header dropdown switcher layanan + Tabel Rekapitulasi Penjualan
- **Komponen UI Dominan:** `EnhancedTableWithDialogs`, `DropdownMenu`, `Badge`
- **Pola Interaksi:** Pemilihan sub-kategori layanan Samsat via header dropdown, filter tanggal cepat, drilldown invoice order.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` Kolom tabel sangat lebar (>10 kolom) dan mengandalkan `EnhancedTableWithDialogs` yang memiliki dialog bawaan yang sebagian tidak digunakan.
- **Prioritas:** `P2`

#### E. Belum & Kurang Bayar (`/finance/belum-bayar`)
- **Komponen Utama:** `FinanceContent.tsx` (`tab === "belum-bayar"`)
- **Layout:** Summary Cards (Total Piutang Murni, Total Kurang Bayar, Grand Total) + Table Piutang
- **Komponen UI Dominan:** `EnhancedTableWithDialogs`, `Badge`, `Button` pelunasan, modal input pembayaran cicilan.
- **Pola Interaksi:** Filter status pembayaran (*Belum Bayar, Kurang Bayar*), klik aksi untuk pelunasan dengan pemilihan metode pembayaran aktual.
- **Prioritas:** `P2`

#### F. Profit Terpending & Cashback Terpending
- **Komponen Utama:** `FinanceContent.tsx` (`tab === "profit-pending"`, `tab === "cashback-pending"`)
- **Layout:** KPI Metric Cards + Data Table Pending
- **Komponen UI Dominan:** `EnhancedTableWithDialogs`, `Badge`, `Button` verifikasi/cairkan
- **Pola Interaksi:** Verifikasi selisih kas Samsat, pencairan cashback rekanan biro dengan snapshot rekening tujuan.
- **Prioritas:** `P2`

#### G. Laba Rugi (`/finance/laba-rugi`)
- **Komponen Utama:** `LabaRugiStatementView.tsx` (Redesigned di Phase 4B)
- **Layout:** 3-Source Summary Table (*Data Penjualan, Kas Kantor, Kas Messenger*) + Toggles Komponen Pending + KPI Surplus/Defisit
- **Komponen UI Dominan:** `Card`, `Table`, `Switch` (filter komponen), `Dialog` (drilldown transaksi pembentuk), `Export CSV/PDF/Cetak`
- **Pola Interaksi:** Klik nominal pada sel tabel untuk membuka dialog drilldown pembentuk angka, toggle independen komponen pending.
- **Prioritas:** `P3` (Sudah distandarisasi)

### 4.4 Modul Master Data
- **Halaman:** Layanan (`MasterLayanan.tsx`), Samsat (`WilayahSamsatManager.tsx`), Metode Pembayaran (`MetodePembayaranMaster.tsx`), Biaya Layanan (`BiayaLayanan.tsx`), Harga Dasar Samsat (`HargaDasarSamsat.tsx`).
- **Layout Dominan:** Master Table + Toolbar (Tambah, Cari, Filter) + Dialog Form CRUD.
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` `BiayaLayanan.tsx` memiliki duplikasi tab layanan horizontal di dalam page sementara sub-layanan sudah dapat diakses via URL `/master-data/biaya-layanan/:service`.
  - `[VERIFIED]` `MetodePembayaranMaster.tsx` menggunakan `EnhancedTable` sedangkan `WilayahSamsatManager.tsx` menggunakan raw `Table`.
- **Prioritas:** `P2`

### 4.5 Modul Manajemen & Utilitas
- **Halaman:** Karyawan, Pengguna (`ManajemenPengguna.tsx`), Hak Akses (`AccessManagement.tsx`), Riwayat Aktivitas (`AuditLog.tsx`), Pengaturan (`Settings.tsx`), Profil Saya (`Profile.tsx`), Riwayat Notifikasi (`NotificationHistory.tsx`).
- **Masalah Visual / UX Ditemukan:**
  - `[VERIFIED]` `AccessManagement.tsx#L92, L94` masih mencantumkan label legacy `finance-pengeluaran` dan `finance-tagihan` yang sudah usang.
  - `[VERIFIED]` `NotificationHistory.tsx#L39` masih memuat tab "Email Logs" padahal seluruh modul konfigurasi email telah dihapus dari sistem pada Phase 4B.
- **Prioritas:** `P1` (Pembersihan inkonsistensi terminologi & tab)

---

## 5. EXISTING DESIGN SYSTEM

### 5.1 Typography Hierarchy

| Elemen | Ukuran Aktual (CSS) | Weight | Line Height | Kepatuhan SaaS | Status & Rekomendasi |
|---|---|---|---|:---:|---|
| **Page Title (Header)** | `1.25rem` (20px) sm:`1.375rem` (22px) | `600` | `1.25` | Baik | Gunakan konsisten di semua page shell |
| **Section Title** | `1.0625rem` (17px) | `600` | `1.35` | Cukup | Standardisasi ke `16px` (`1rem`) |
| **Card Title** | `0.9375rem` (15px) | `600` | `1.4` | Baik | Pertahankan `15px` / `font-semibold` |
| **Body Text** | `0.875rem` (14px) | `400` | `1.55` | Standar | Pertahankan |
| **Form Label** | `0.8125rem` (13px) | `500` | `1.4` | Sangat Baik | Standardisasi wajib di seluruh input form |
| **Table Header (`th`)** | `0.75rem` (12px) | `600` | `1.2` | Baik | Pastikan uppercase & letter-spacing seragam |
| **Table Body (`td`)** | `0.8125rem` (13px) | `400` | `1.4` | Sangat Baik | Pertahankan |
| **Finance Table Body** | `10px` / `12px` / `14px` (Modifier 1-3) | `400-500` | `1.15-1.35` | Baik | Aturan spesifik modul finance |
| **Nominal Finansial** | Variasi `tabular-nums` dan plain text | `500-700` | — | Perlu Standardisasi | `[RECOMMENDATION]` Wajib `tabular-nums font-mono` |

### 5.2 Color System & Token Integrity

#### A. Core Palette Invariant
- **Primary Brand:** `#2563eb` (Blue 600 - Light) / `#3b82f6` (Blue 500 - Dark)
- **Background:** `#f8fafc` (Slate 50 - Light) / `#090d16` (Deep Charcoal - Dark)
- **Surface / Card:** `#ffffff` (White - Light) / `#0f172a` (Slate 900 - Dark)
- **Border:** `#e2e8f0` (Slate 200 - Light) / `#1e293b` (Slate 800 - Dark)
- **Text Primary:** `#0f172a` (Slate 900 - Light) / `#f1f5f9` (Slate 100 - Dark)
- **Text Secondary:** `#64748b` (Slate 500 - Light) / `#94a3b8` (Slate 400 - Dark)

#### B. Status Colors
- **Success:** Emerald `#16a34a` (bg: `#f0fdf4`, border: `#bbf7d0`)
- **Warning:** Amber `#d97706` (bg: `#fffbeb`, border: `#fde68a`)
- **Error / Danger:** Red/Rose `#ef4444` (bg: `#fef2f2`, border: `#fecaca`)
- **Info:** Blue `#2563eb` (bg: `#eff6ff`, border: `#bfdbfe`)
- **Neutral / Role:** Slate `#64748b` (bg: `#f1f5f9`, border: `#e2e8f0`)

### 5.3 Spacing, Grid & Sizing

- **Sidebar Width:**
  - Expanded: `280px` (`w-[280px]`)
  - Collapsed: `80px` (`w-[80px]`)
  - Mobile Drawer: `280px` (max `85vw`)
- **Header Height:** `h-14` (56px) atau `py-2.5 sm:py-3`
- **Page Container Padding (`page-shell`):**
  - Mobile (<640px): `0.75rem` (12px - `p-3`)
  - Tablet (640px - 767px): `1rem` (16px - `sm:p-4`)
  - Desktop (≥768px): `1.5rem` (24px - `md:p-6`)
- **Control Heights:**
  - Small / Toolbar: `h-8` (32px)
  - Default: `h-9` (36px)
  - Large / Hero: `h-10` (40px)
- **Border Radius:**
  - Button & Input: `rounded-lg` (8px)
  - Card & Container: `rounded-xl` (12px)
  - Badge & Tags: `rounded-md` (6px)
  - Toggle / Avatar: `rounded-full` (9999px)

---

---

## 6. VISUAL INCONSISTENCY FINDINGS

### 6.1 CSS & Design Token Conflicts
1. `[VERIFIED]` **Konflik default_theme.css:** Mendefinisikan `--primary: #030213` yang bertabrakan dengan brand blue `#2563eb` di `globals.css`.
2. `[VERIFIED]` **Hardcoded Recharts colors:** `Dashboard.tsx#L204, L232` mendefinisikan warna heksadesimal statis `#2563eb` alih-alih merujuk ke CSS variables `var(--primary)`.
3. `[VERIFIED]` **Hardcoded Badges di beberapa tabel:** Ditemukan penggunaan class seperti `text-emerald-600 bg-emerald-50` secara inline alih-alih memanfaatkan properti `status="success"` pada komponen `<Badge />`.

### 6.2 Table Visual Divergence
- `[VERIFIED]` Ditemukan tiga implementasi tabel berbeda: `EnhancedTableWithDialogs` (88 KB), `EnhancedTable` (14 KB), dan raw `table.tsx`.
- Perbedaan padding cell, header font weight, dan penanganan badge status.

### 6.3 Residual Stale UI Elements
- `[VERIFIED]` Tab "Email Logs" pada `NotificationHistory.tsx#L39` masih aktif padahal modul konfigurasi email telah dihapus.
- `[VERIFIED]` Menu hak akses `AccessManagement.tsx#L92, L94` masih merujuk route usang `finance-pengeluaran` dan `finance-tagihan`.


---

## 7. UX FINDINGS

1. **Efisiensi Pengisian Buat Order:**
   - `[VISUALLY OBSERVED]` Formulir Buat Order memuat dropdown berjenjang (Provinsi → Samsat Asal → Samsat Tujuan) dan kalkulator estimasi yang responsif terhadap perubahan input plat nomor dan tipe kendaraan.
   - `[POTENTIAL RISK]` Jika terjadi kesalahan validasi di Step 1, pengguna harus menggulir cukup jauh untuk menemukan input yang error. Diperlukan ringkasan error (*error summary banner*) di bagian atas tombol aksi "Lanjutkan".
2. **Table Density & Readability:**
   - Modul Finance memiliki typography table yang sangat baik (font size 11-13px dengan pemisahan warna uang masuk hijau dan uang keluar merah).
   - Namun pada tabel Master Data (`WilayahSamsatManager`), aksi edit/hapus di ujung kanan sering terpotong jika resolusi browser di bawah 1280px tanpa horizontal scroll indicator yang jelas.
3. **Modal & Feedback Experience:**
   - Semua modal dialog di `ui/dialog.tsx` telah distandarisasi menggunakan overlay solid `backdrop-blur-[2px] bg-black/40` tanpa efek blur bertumpuk di dalam modal.
   - Semua mutasi penting (simpan, update, hapus) telah terhubung ke notifikasi `toast` via Sonner dengan pesan berbahasa Indonesia yang jelas.


---

## 8. RESPONSIVE FINDINGS

Berdasarkan pemindaian visual headless automated scanner pada 25 route Admin:

1. **Desktop Viewport (1440px):**
   - `[VISUALLY OBSERVED]` Seluruh 25 route berhasil di-render tanpa horizontal overflow (`windowWidth: 1440`, `bodyScrollWidth: 1440`, `hasHorizontalOverflow: false`).
   - Layout grid dashboard, rekap tabel finance, dan drawer sidebar berfungsi optimal.

2. **Tablet Viewport (768px):**
   - `[VISUALLY OBSERVED]` Sidebar otomatis menyusut atau berpindah ke drawer sheet (`w-[280px]` modal).
   - `[POTENTIAL RISK]` Pada tabel Data Penjualan dan Wilayah Samsat, kolom aksi edit/hapus di ujung kanan memerlukan horizontal scroll. Diperlukan scroll indicator yang lebih intuitif.

3. **Mobile Viewport (375px):**
   - `[VISUALLY OBSERVED]` Hamburger navigation sheet beroperasi dengan baik (`backdrop-blur-sm`).
   - `[POTENTIAL RISK]` Formulir `BuatOrder.tsx` memiliki scroll vertikal yang sangat panjang. Pemecahan ke dalam 3 langkah wizard independen sangat disarankan untuk mengurangi beban kognitif di layar kecil.


---

## 9. ACCESSIBILITY FINDINGS

1. **Keyboard Navigation & Focus Rings:**
   - `[VERIFIED]` Komponen Button dan Input telah memiliki class `focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:ring-[2px]` yang menjamin indikator fokus terlihat jelas saat navigasi keyboard (Tab).
   - `[VERIFIED]` Sidebar mobile dapat ditutup menggunakan tombol `Escape` (`src/app/App.tsx#L225-L235`).
2. **Form Label Association:**
   - Sebagian besar form input telah menggunakan komponen `<Label htmlFor="...">` yang berpasangan dengan `<Input id="...">`.
   - `[POTENTIAL RISK]` Beberapa search bar di tabel toolbar tidak memiliki atribut `aria-label` eksplisit (hanya mengandalkan `placeholder="Cari..."`).
3. **Contrast Ratio:**
   - Teks utama (`#0f172a` pada background `#ffffff` atau `#f8fafc`) memiliki rasio kontras > 12:1 (Lolos AAA).
   - Teks sekunder (`#64748b` pada background `#ffffff`) memiliki rasio kontras 4.6:1 (Lolos AA).
   - Badge soft status memiliki warna teks gelap di atas latar belakang pastel lembut yang menjamin keterbacaan tinggi.

---

---

## 10. PROPOSED PROFESSIONAL SAAS DESIGN SYSTEM

Berdasarkan audit arsitektur dan identitas visual SUN89 yang sudah berjalan, berikut adalah spesifikasi standarisasi **Modern Professional SaaS**:

### 7.1 Design Tokens Specification

```css
/* Proposed Unified SaaS Tokens */
:root {
  /* Brand Primary */
  --primary: #2563eb;           /* Blue 600 */
  --primary-hover: #1d4ed8;     /* Blue 700 */
  --primary-foreground: #ffffff;
  --primary-subtle: #eff6ff;    /* Blue 50 */

  /* Neutral Surfaces */
  --background: #f8fafc;        /* Slate 50 */
  --card: #ffffff;              /* Solid Pure White */
  --card-foreground: #0f172a;   /* Slate 900 */
  --popover: #ffffff;
  --popover-foreground: #0f172a;
  --border: #e2e8f0;            /* Slate 200 */
  --border-subtle: #f1f5f9;     /* Slate 100 */
  --input-background: #ffffff;
  
  /* Typography Text Colors */
  --foreground: #0f172a;        /* Text Primary */
  --muted-foreground: #64748b;  /* Text Secondary / Placeholder */
  --muted: #f1f5f9;             /* Light Gray Fill */

  /* Shadows (Restrained, Crisp) */
  --shadow-xs: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-sm: 0 1px 3px 0 rgba(0, 0, 0, 0.08), 0 1px 2px -1px rgba(0, 0, 0, 0.08);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 2px 4px -2px rgba(0, 0, 0, 0.06);

  /* Corner Radius */
  --radius-sm: 6px;             /* Badges, inner tags */
  --radius-md: 8px;             /* Buttons, Inputs, Selects */
  --radius-lg: 12px;            /* Cards, Modals, Popovers */
  --radius-full: 9999px;        /* Avatars, Status Pills */
}
```

### 7.2 UI Component Standardization Rules

1. **Tombol (Button):**
   - *Primary:* `bg-primary hover:bg-primary-hover text-white shadow-xs h-9 rounded-lg px-3.5`
   - *Secondary / Outline:* `border border-border bg-card hover:bg-muted text-foreground shadow-xs h-9 rounded-lg px-3.5`
   - *Ghost / Action:* `hover:bg-muted/60 text-muted-foreground hover:text-foreground h-8 w-8 p-0`
   - *Destructive:* `bg-rose-600 hover:bg-rose-700 text-white shadow-xs h-9 rounded-lg`
   - Selalu sertakan state `disabled:opacity-50 disabled:cursor-not-allowed` dan spinner loading `Loader2 className="animate-spin"`.
2. **Form Controls (Input, Select):**
   - Ketinggian seragam: `h-9` (36px) untuk standar form, `h-8` (32px) untuk filter/toolbar.
   - Latar belakang: Solid `#ffffff` (Light) / `#0f172a` (Dark).
   - Label: Wajib `text-[13px] font-medium text-foreground mb-1.5`.
   - Error feedback: Menggunakan border `border-rose-500` dan pesan text di bawah input `text-xs text-rose-600 flex items-center gap-1`.
3. **Data Tables:**
   - Container: `border border-border rounded-xl bg-card overflow-hidden shadow-xs`.
   - Header (`thead`): Background `bg-muted/40 border-b border-border text-[12px] font-semibold text-muted-foreground uppercase tracking-wider py-2.5 px-3`.
   - Body Row (`tr`): `border-b border-border/60 hover:bg-muted/30 transition-colors h-11 text-[13px]`.
   - Nominal Keuangan: Selalu gunakan `font-mono tabular-nums font-semibold`.
   - Pagination: Selalu gunakan satu komponen standar `TablePagination.tsx`.
4. **Modals & Dialogs:**
   - Max width standar: `sm:max-w-md` untuk konfirmasi, `sm:max-w-lg` untuk form tunggal, `sm:max-w-2xl` untuk formulir multi-section.
   - Header: Icon kategori di kiri judul, judul `text-base font-semibold`, subtitle `text-xs text-muted-foreground`.
   - Footer: Tombol Batal di kiri/secondary, tombol aksi utama di kanan/primary.

---

## 11. PRIORITIZED REMEDIATION ROADMAP

Temuan dikelompokkan ke dalam 4 tingkatan prioritas:

### Priority 0 (P0) — Critical UX & Operational Blockers
*Tidak ditemukan bug fungsional yang merusak data saat ini (seluruh kalkulasi dan transaksi aman). Namun terdapat potensi hambatan operasional berikut:*
1. **Penyatuan dan Isolasi Dialog Konfirmasi Keluar (Navigation Guard):** Pastikan peringatan unsaved changes di `BuatOrder.tsx` dan modul finance selalu aktif sebelum pengguna tidak sengaja berpindah menu samping.

### Priority 1 (P1) — Global Consistency & Structural Debt
1. **Refactor & Split Komponen Monolitik:**
   - Pecah `BuatOrder.tsx` (4.543 baris) menjadi 3 sub-komponen wizard modular: `BuatOrderStep1.tsx`, `BuatOrderStep2.tsx`, `BuatOrderStep3.tsx`.
   - Pecah `OrderTracking.tsx` (8.396 baris) dengan memisahkan dialog-dialog operasional (Samsat schedule, pickup, final cost) ke dalam folder `src/app/components/order/dialogs/`.
2. **Pembersihan CSS Token & Penghapusan File Residu:**
   - Hapus konflik `--primary: #030213` dari `default_theme.css`.
   - Hapus file tak terpakai: `src/styles/theme.css` dan `src/styles/tailwind.css`.
3. **Konsolidasi Shared Table Component:**
   - Standardisasi `EnhancedTableWithDialogs`, `EnhancedTable`, dan raw table menjadi satu pattern arsitektur terpadu berbasis komposisi (Composition Pattern).
4. **Pembersihan Terminologi Legacy:**
   - Perbarui `AccessManagement.tsx` agar membuang key modul usang (`finance-pengeluaran` & `finance-tagihan`) dan sinkron dengan route finance terkini.
   - Hapus tab "Email Logs" pada `NotificationHistory.tsx` agar konsisten dengan penghapusan fitur email di halaman Pengaturan.

### Priority 2 (P2) — Visual & Interaction Polish per Module
1. **Standardisasi Date Pickers:**
   - Gunakan satu komponen Date Range Picker terpadu untuk modul Finance, Order History, dan Audit Log.
2. **Standardisasi Empty States:**
   - Ganti teks raw "tidak ada data" pada tabel-tabel Finance dan Karyawan dengan komponen `<EmptyState />` yang konsisten.
3. **Penyempurnaan Recharts Dashboard:**
   - Ganti warna hardcoded `#2563eb` di `Dashboard.tsx` dengan variabel CSS tema agar otomatis beradaptasi pada mode gelap (Dark Mode).

### Priority 3 (P3) — Micro-interactions & Refinements
1. Standardisasi transisi tombol icon `hover:bg-muted/60 active:scale-95`.
2. Penambahan skeleton loader seragam saat transisi antar tab.
3. Optimasi padding tabel pada viewport tablet 768px-1024px.

---

## 12. RECOMMENDED IMPLEMENTATION PHASES

Untuk meminimalkan risiko regresi dan memastikan sistem tetap berjalan stabil (0 downtime & 0 data error), redesign harus dieksekusi secara berurutan:

```
┌────────────────────────────────────────────────────────┐
│ Phase A: Design Tokens & Base Primitives (Foundational)│
│ - Bersihkan CSS tokens & konsolidasikan variabel warna │
│ - Standardisasi Button, Input, Select, Badge, Card     │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase B: Shared Table & Pagination Unification         │
│ - Bangun UnifiedDataTable dengan TablePagination &     │
│   EmptyState terpadu                                   │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase C: Form & Dialog Decomposition                   │
│ - Dekomposisi BuatOrder.tsx & OrderTracking.tsx        │
│ - Standardisasi Dialog & Modal Shell                   │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ Phase D: Per-Module Visual Polish (Page-by-Page)       │
│ - Dashboard, Finance Views, Master Data, Manajemen    │
│ - Pengujian responsif tablet & mobile                  │
└────────────────────────────────────────────────────────┘
```

---

## 13. RISKS AND REGRESSION CONSIDERATIONS

1. **Immutable Snapshot & Financial Calculations (STRICT):**
   - Redesign visual pada modul Finance (`Profit`, `Kas Kantor`, `Kas Messenger`, `Laba Rugi`, `Data Penjualan`) **DILARANG KERAS** mengubah kalkulator kanonis (`canonicalCalculators.ts`), perhitungan margin, atau mutasi data transaksi.
2. **Idempotency & Atomic Payments:**
   - Formulir pelunasan di `OrderTracking` dan `FinanceContent` terhubung langsung ke backend atomic endpoint. Pengubahan markup input tidak boleh mengubah payload key yang dikirim ke server.
3. **Zero Database Schema Change:**
   - Seluruh perbaikan visual frontend tidak boleh menuntut perubahan kolom SQLite atau migrasi database baru.
4. **Dark Mode Fidelity:**
   - Setiap komponen baru wajib diuji di bawah selector `.dark` untuk memastikan kontras teks dan warna permukaan kartu tidak menjadi terlalu terang atau tidak terbaca.

---

## 14. AUDIT CONCLUSION & NEXT STEPS

Laporan audit ini telah merangkum seluruh kondisi nyata frontend Admin Dashboard SUN89.  
**Sesuai instruksi STRICT READ-ONLY, tidak ada baris kode produksi atau database yang diubah selama proses audit ini.**

Pekerjaan dihentikan di sini untuk menunggu evaluasi dan arahan prioritas dari pengguna sebelum fase implementasi / redesign dimulai.
