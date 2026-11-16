# SUN89 — SAFE SELECTIVE GIT CHECKPOINT PLAN (STAGE 1)
## Phase A + Mode 2 Cleanup + Audit & Validation Reports

**Project:** SUNBiroJasa / Admin SUN89  
**Workspace:** `D:\Admin\adminsunbirojasa`  
**Date:** 2026-11-12  
**Current Authorization:** **STAGE 1 ONLY (READ-ONLY INSPECTION & STAGING PLAN)**  
**Git Staging / Commit Executed:** **NONE** (`0` files staged, `0` commits created)

---

## 1. Current Git Status Summary

Inspected directly via `git status --short -uall`, `git diff --name-status`, `git diff --stat`, and `git diff --check` (HEAD: `f383581 initian coomit`):

| Metric | Count Before Plan Doc | Count With `SAFE_GIT_CHECKPOINT_PLAN.md` | Notes |
|---|---:|---:|---|
| **Tracked Modified (`M`)** | **12** | **12** | `+341` / `-151` lines (Phase A Design System Foundation) |
| **Tracked Deleted (`D`)** | **14** | **14** | `4` Batch 1 + `10` Batch 2 (`-10,796` lines) |
| **Combined `git diff --stat`** | **26 files** | **26 files** | `26 files changed, 341 insertions(+), 10947 deletions(-)` |
| **`git diff --check`** | Exit `0` | Exit `0` | Zero whitespace errors or conflict markers |
| **Untracked (`??`)** | **38** | **39** | `9` docs/tests (with this plan) + `30` `docs/audits/screenshots/*` |
| **Staged (`git diff --cached`)** | **0** | **0** | Clean index — nothing staged |
| **`.gitignore`d Generated Artifacts** | `test-results/` (`46` entries), `server/data/` (`3`), `server/backups/` (`10`), `server/uploads/` (`51`), `scratch/` (`0`) | Same | Never staged |

---

## 2. Classification & Exact File Inventory (`A`–`F`)

### Category A — Phase A Design System Foundation Deliverables (`14` files: `12 M` + `2 ??`)

#### A.1 Exact 12 Modified Tracked Files (`M`)
| # | File Path | Status | Diff Stat (vs HEAD) | Rationale for Inclusion |
|---:|---|---:|---|---|
| 1 | `src/app/components/Dashboard.tsx` | `M` | `10 +-` | Recharts tooltip/gradient tokens migrated from `#2563eb`/hardcoded radius/shadow to CSS variables (`var(--primary)`, `var(--radius-lg)`, `var(--shadow-md)`). |
| 2 | `src/app/components/ui/alert.tsx` | `M` | `12 +-` | Phase A semantic alert variant styling aligned to design tokens. |
| 3 | `src/app/components/ui/badge.tsx` | `M` | `18 +-` | Phase A badge token variants (`status-config` compatible). |
| 4 | `src/app/components/ui/button.tsx` | `M` | `66 +-` | Phase A standardized button sizing/variants/focus rings. |
| 5 | `src/app/components/ui/card.tsx` | `M` | `29 +-` | Added `cardVariants` (`default`, `secondary`, `flat`) preserving `rounded-xl border`. |
| 6 | `src/app/components/ui/input.tsx` | `M` | `107 +-` | Phase A input token & focus/disabled state standardization. |
| 7 | `src/app/components/ui/select.tsx` | `M` | `12 +-` | Phase A select trigger/content semantic surface tokens. |
| 8 | `src/app/components/ui/status-config.ts` | `M` | `16 +-` | Phase A semantic status badge mapping aligned with design tokens. |
| 9 | `src/app/components/ui/textarea.tsx` | `M` | `43 +-` | Phase A textarea token & focus state standardization. |
| 10 | `src/styles/design-tokens.css` | `M` | `79 +-` | Canonical design token scale (colors, surfaces, radius, shadows). |
| 11 | `src/styles/globals.css` | `M` | `99 +-` | Semantic token mapping (`:root` & `.dark`) and typography/base layer. |
| 12 | `src/styles/index.css` | `M` | `1 -` | Removed legacy `default_theme.css` import (`-1` line), leaving single canonical CSS cascade. |

#### A.2 Phase A Untracked Verification & Implementation Deliverables (`2 ??`)
| # | File Path | Status | Rationale for Inclusion |
|---:|---|---:|---|
| 13 | `tests/phase-a-design-system.test.ts` | `??` | Automated unit test suite (`11/11 PASS`) verifying Phase A CSS cascade and UI component contracts. |
| 14 | `docs/PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md` | `??` | Official implementation & verification report for Phase A. |

---

### Category B — Mode 2 Safe Cleanup Tracked Deletions (`14 D`)

| # | File Path | Batch | Lines Removed | Rationale for Inclusion |
|---:|---|---|---:|---|
| 1 | `BUAT_ORDER_CONTEXT.md` | Batch 1 | `-4,822` | Generated context dump approved for deletion (`263 KB`). |
| 2 | `PROJECT_CONTEXT.md` | Batch 1 | `-4,338` | Obsolete generated context dump approved for deletion (`173 KB`). |
| 3 | `check_db.js` | Batch 1 | `-19` | Broken ad-hoc DB script (`better-sqlite3` absent), 0 references. |
| 4 | `scratch_inspect_db.js` | Batch 1 | `-37` | Ad-hoc SQLite inspection script in root, 0 references. |
| 5 | `default_shadcn_theme.css` | Batch 2 | `-121` | Unused root scaffold CSS template (`#030213`), 0 imports. |
| 6 | `metadata.json` | Batch 2 | `-6` | Unused Figma Make / AI Studio manifest, 0 runtime/build consumers. |
| 7 | `src/app/Attributions.md` | Batch 2 | `-3` | Duplicate attribution file (`ATTRIBUTIONS.md` remains at root). |
| 8 | `src/app/components/messenger/MessengerTaskDetailModal.tsx` | Batch 2 | `-1,082` | Dead 1,082-line component with 0 active imports. No regression directly attributable to this deletion was identified in the post-cleanup regression validation. The full test and E2E suites still contain unresolved failures. |
| 9 | `src/data/repositories/index.ts` | Batch 2 | `-12` | Unused repository barrel file (0 consumers). |
| 10 | `src/data/repositories/messengerRepository.ts` | Batch 2 | `-44` | Obsolete in-memory repository wrapper (0 consumers). |
| 11 | `src/data/storage/index.ts` | Batch 2 | `-7` | Unused storage barrel file (`memoryStorage.ts` retained). |
| 12 | `src/styles/default_theme.css` | Batch 2 | `-120` | Legacy scaffold CSS disconnected in Phase A; verified excluded via `phase-a-design-system.test.ts`. |
| 13 | `src/styles/tailwind.css` | Batch 2 | `-4` | Unused 4-line duplicate of `index.css`. |
| 14 | `src/styles/theme.css` | Batch 2 | `-181` | Unused duplicate of `default_theme.css`. |

---

### Category C — Cleanup Audit Reports (`4 ??` + `1 ??` Pre-Phase-A Audit Spec)

| # | File Path | Status | Classification | Rationale for Inclusion |
|---:|---|---:|---|---|
| 1 | `docs/PROJECT_CLEANUP_AUDIT_REPORT.md` | `??` | Category C | Mode 1 Discovery audit inventory & safe deletion classification. |
| 2 | `docs/PROJECT_CLEANUP_IMPLEMENTATION_REPORT.md` | `??` | Category C | Mode 2 (Batch 1 + Batch 2) execution report (with corrected `14` tracked deletions in §1.2). |
| 3 | `docs/PROJECT_CLEANUP_CLOSURE_AUDIT.md` | `??` | Category C | Strict read-only closure audit (DB lineage, failed pattern-check diagnosis, count audit). |
| 4 | `docs/PROJECT_CLEANUP_FINAL_CLOSURE.md` | `??` | Category C | Final documentation reconciliation (`37` untracked derivation + authentic `3,182 -> 3,171` ESLint logs). |
| 5 | `docs/ADMIN_FRONTEND_AUDIT_REPORT.md` | `??` | Category C / F (Prerequisite Spec) | Created during the pre-Phase-A Admin Frontend Audit (`2026-11-12`) and explicitly cited as the foundational specification by `PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md` & `PROJECT_CLEANUP_AUDIT_REPORT.md`. **Recommended INCLUDE** (markdown doc, 0 binary bloat; see §4 on ownership clarity). |

---

### Category D — Regression Validation & Checkpoint Planning Reports (`2 ??`)

| # | File Path | Status | Rationale for Inclusion / Option |
|---:|---|---:|---|
| 1 | `docs/POST_CLEANUP_REGRESSION_VALIDATION_REPORT.md` | `??` | Full post-cleanup validation report (`134` unit suites + `110` E2E tests + DB/upload invariance + Phase B `READY WITH CONDITIONS`). **Recommended INCLUDE.** |
| 2 | `docs/SAFE_GIT_CHECKPOINT_PLAN.md` | `??` | This Stage 1 staging plan. **Optional / Recommended INCLUDE** if you want the checkpoint rationale committed alongside the reports (or exclude if you prefer keeping planning docs out of the commit). |

---

### Category E — Excluded Temporary / Generated Artifacts (DO NOT STAGE)

| Group | Exact File List / Count | Size / Location | Rationale for Exclusion |
|---|---|---:|---|
| **Visual Audit Screenshots & Metrics (`30 ??`)** | `docs/audits/screenshots/01-dashboard-desktop.png`<br>`docs/audits/screenshots/01-dashboard-mobile-375.png`<br>`docs/audits/screenshots/01-dashboard-tablet-768.png`<br>`docs/audits/screenshots/02-buat-order-desktop.png`<br>`docs/audits/screenshots/02-buat-order-mobile-375.png`<br>`docs/audits/screenshots/03-order-tracking-desktop.png`<br>`docs/audits/screenshots/04-order-rekap-desktop.png`<br>`docs/audits/screenshots/05-finance-profit-desktop.png`<br>`docs/audits/screenshots/05-finance-profit-mobile-375.png`<br>`docs/audits/screenshots/06-finance-kas-messenger-desktop.png`<br>`docs/audits/screenshots/07-finance-kas-kantor-desktop.png`<br>`docs/audits/screenshots/08-finance-data-penjualan-desktop.png`<br>`docs/audits/screenshots/09-finance-belum-bayar-desktop.png`<br>`docs/audits/screenshots/10-finance-profit-pending-desktop.png`<br>`docs/audits/screenshots/11-finance-cashback-pending-desktop.png`<br>`docs/audits/screenshots/12-finance-laba-rugi-desktop.png`<br>`docs/audits/screenshots/13-master-samsat-desktop.png`<br>`docs/audits/screenshots/14-master-metode-pembayaran-desktop.png`<br>`docs/audits/screenshots/15-master-biaya-layanan-desktop.png`<br>`docs/audits/screenshots/16-master-harga-dasar-desktop.png`<br>`docs/audits/screenshots/17-manajemen-karyawan-desktop.png`<br>`docs/audits/screenshots/18-manajemen-pengguna-desktop.png`<br>`docs/audits/screenshots/19-manajemen-hak-akses-desktop.png`<br>`docs/audits/screenshots/20-manajemen-riwayat-aktivitas-desktop.png`<br>`docs/audits/screenshots/21-messenger-tasks-admin-desktop.png`<br>`docs/audits/screenshots/22-messenger-history-admin-desktop.png`<br>`docs/audits/screenshots/23-settings-desktop.png`<br>`docs/audits/screenshots/24-profile-desktop.png`<br>`docs/audits/screenshots/25-notifikasi-desktop.png`<br>`docs/audits/screenshots/audit-metrics.json` | **`30` untracked files** (`1,855,236 B`) in `docs/audits/screenshots/` | Explicitly classified in `PROJECT_CLEANUP_AUDIT_REPORT.md` (§10.4) & `PROJECT_CLEANUP_IMPLEMENTATION_REPORT.md` (§3) as temporary pre-Phase-A audit visual evidence slated for **Batch 4 archival/deletion**. Staging `1.85 MB` of temporary PNG binaries into Git history would cause permanent binary repo bloat. *(Note: pre-existing tracked `docs/audits/screenshots/01-form-kas-messenger-tiered-select.png` remains cleanly tracked and untouched.)* |
| **Playwright Generated Test Results (`46` entries)** | `test-results/.last-run.json` + `45` `<spec>-chromium/error-context.md` directories | `.gitignore:52` (`test-results/`) | Generated during `npm run test:e2e` validation. Strictly excluded per `.gitignore` and task safety rules. |
| **Operational & Sandbox Local Files** | `server/data/` (`3` files), `server/backups/` (`10` files), `server/uploads/` (`51` files), `scratch/` (`0` files) | `.gitignore:102-106` | Protected operational/gitignored assets. Never staged or touched. |

---

### Category F — Unrelated or Uncertain Files

- **Count:** `0` unexpected code/config files; **`1` prerequisite audit document** (`docs/ADMIN_FRONTEND_AUDIT_REPORT.md`) flagged explicitly: it predated Phase A by one step on `2026-11-12` as the read-only Admin Frontend Audit specification that drove Phase A. Included in the Stage 2 proposal below (Category C/A prerequisite), with explicit option to omit if you want a separate commit solely for the frontend audit.

---

## 3. Total Expected Staged Files by Category (Stage 2 Proposal)

| Category | Status | File Count | Included in Proposed `git add`? |
|---|---|---:|:---:|
| **A. Phase A Deliverables** | `12 M` + `2 ??` | **14** | **YES** |
| **B. Mode 2 Cleanup Deletions** | `14 D` | **14** | **YES** |
| **C. Cleanup Audit Reports** *(incl. `ADMIN_FRONTEND_AUDIT_REPORT.md`)* | `5 ??` | **5** | **YES** *(4 Mode 1/2 reports + 1 prerequisite Phase A spec)* |
| **D. Regression Validation Reports** *(incl. `SAFE_GIT_CHECKPOINT_PLAN.md`)* | `2 ??` | **2** | **YES** *(or `1` if omitting `SAFE_GIT_CHECKPOINT_PLAN.md`)* |
| **TOTAL PROPOSED TO STAGE** | **`12 M` + `14 D` + `9 ??`** | **35** | **Clean source + deletion + docs checkpoint** |
| **E. Excluded Artifacts** | `30 ??` + `46` gitignored + `64` operational/ignored | **140** | **NO (Strictly Excluded)** |

*(Remaining `??` in working tree after staging those 35 files will be **exactly 30** files under `docs/audits/screenshots/` awaiting Batch 4 archival/deletion decision.)*

---

## 4. Potential Risks & Unresolved Ownership Notes

1. **`docs/audits/screenshots/*` (`30 ??`, `1,855,236 B`) Remains Untracked After Staging:** Intentional so binary audit screenshots don't enter permanent Git history before Batch 4 decides archive vs delete. Take care not to run `git clean -fd` or `git add .` afterward.
2. **Ownership Choice on `docs/ADMIN_FRONTEND_AUDIT_REPORT.md` & `docs/SAFE_GIT_CHECKPOINT_PLAN.md`:** Both are safe markdown files (`??`). If you prefer keeping this checkpoint strictly limited to post-audit implementation/cleanup/validation artifacts, drop either or both paths from the Stage 2 list before approving.
3. **Working Tree `test-results/` (`46` gitignored entries):** Generated by `npm run test:e2e`; stays safely ignored by `.gitignore` and excluded from staging.
4. **CRLF Warning Notice (`LF will be replaced by CRLF`):** Windows Git `core.autocrlf` notice observed on 11 modified files; `git diff --check` exits `0` with zero whitespace/conflict issues.

---

## 5. Proposed Exact `git add -- <paths>` Commands for Stage 2 (**NOT EXECUTED**)

> **DO NOT EXECUTE UNTIL EXPLICIT USER APPROVAL OF THE EXACT FILE LIST.**  
> Zero wildcards; every single approved file path is enumerated explicitly.

```powershell
# A. Phase A Design System Foundation (12 modified + 2 untracked)
git add -- `
  src/app/components/Dashboard.tsx `
  src/app/components/ui/alert.tsx `
  src/app/components/ui/badge.tsx `
  src/app/components/ui/button.tsx `
  src/app/components/ui/card.tsx `
  src/app/components/ui/input.tsx `
  src/app/components/ui/select.tsx `
  src/app/components/ui/status-config.ts `
  src/app/components/ui/textarea.tsx `
  src/styles/design-tokens.css `
  src/styles/globals.css `
  src/styles/index.css `
  tests/phase-a-design-system.test.ts `
  docs/PHASE_A_DESIGN_SYSTEM_IMPLEMENTATION_REPORT.md

# B. Mode 2 Safe Cleanup Batch 1 + Batch 2 Deletions (14 tracked deletions)
git add -- `
  BUAT_ORDER_CONTEXT.md `
  PROJECT_CONTEXT.md `
  check_db.js `
  scratch_inspect_db.js `
  default_shadcn_theme.css `
  metadata.json `
  src/app/Attributions.md `
  src/app/components/messenger/MessengerTaskDetailModal.tsx `
  src/data/repositories/index.ts `
  src/data/repositories/messengerRepository.ts `
  src/data/storage/index.ts `
  src/styles/default_theme.css `
  src/styles/tailwind.css `
  src/styles/theme.css

# C. Audit & Mode 2 Cleanup Reports (5 untracked markdown files)
git add -- `
  docs/ADMIN_FRONTEND_AUDIT_REPORT.md `
  docs/PROJECT_CLEANUP_AUDIT_REPORT.md `
  docs/PROJECT_CLEANUP_IMPLEMENTATION_REPORT.md `
  docs/PROJECT_CLEANUP_CLOSURE_AUDIT.md `
  docs/PROJECT_CLEANUP_FINAL_CLOSURE.md

# D. Regression Validation & Checkpoint Reports (2 untracked markdown files)
git add -- `
  docs/POST_CLEANUP_REGRESSION_VALIDATION_REPORT.md `
  docs/SAFE_GIT_CHECKPOINT_PLAN.md
```

---

**Stage 1 Complete — Awaiting explicit user approval of the exact 35-file staging list before executing Stage 2 (`git add` only, no commit).**
