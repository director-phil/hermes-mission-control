# RT Dashboard — Production Audit Report

**Date:** 2026-06-16
**Scope:** RT Dashboard (reliable-tradies-ops), Railway-hosted
**URL:** https://rt-dashboard-production.up.railway.app
**DB:** PostgreSQL via gondola.proxy.rlwy.net:13337 (Railway)

---

## 1. Health & Availability

| Check | Result |
|-------|--------|
| `/api/health` | ✅ `{"ok":true,"db":"connected","warehouse":"connected"}` |
| Login page renders | ✅ Google OAuth + email/password forms |
| Authenticated API routes | ⚠️ All redirect to login (expected without session cookies) |
| Railway CLI access | ❌ Token invalid — deployment status unverifiable |
| DB connectivity (direct) | ✅ Confirmed via psql |

---

## 2. Security Audit

### 2.1 Authentication ✅
- **Password hashing:** PBKDF2, 100k iterations, SHA-512, 64-byte key
- **Session management:** Custom `auth_sessions` table, 30-day TTL, httpOnly/secure cookies
- **Timing-safe comparison:** `timingSafeEqual` used for password verification
- **User enumeration protection:** Dummy hash returned for non-existent emails
- **TOTP support:** Present in auth flow (TOTP-enabled users get pending MFA cookie)
- **Rate limiting:** 5 login attempts per IP per 15 minutes (in-memory Map)

### 2.2 Authorization ✅
- **RolePriority-based access control** across all routes:
  - `rolePriority >= 70` — admin/finance data
  - `rolePriority >= 80` — admin write operations
- **Employee scoping:** Non-admins restricted to own data (e.g., advances, commissions)
- **Permission-based grants:** `auth_user_effective_permissions` table for fine-grained access

### 2.3 SQL Injection ⚠️
- **Parameterized queries:** All primary routes use `$1, $2, $3` parameterization ✅
- **`sqlParam()` function** in `apps/web/app/commissions/page.tsx` (line 18-30):
  - Attempts basic sanitization but is **not a proper parameterizer**
  - Used for date values in SQL strings — could be bypassed
  - **Risk:** Low (dates are the only input type) but should be replaced with parameterized queries
- **`xero-reconcile/route.ts` (line 108):**
  - Uses string interpolation for `periodStart`/`periodEnd` in WHERE clause
  - These come from search params — should use `$1, $2` parameters
- **`commission-period-check/route.ts` (line 49-50):**
  - Uses `$1::date` and `$2::date` parameters — correct ✅
- **`xero-cash/route.ts` (line 386-394):**
  - Uses `$1, $2` parameters — correct ✅

### 2.4 Admin Route Safety ✅
- **`/api/admin/run-migration`:** Disabled by default (`ENABLE_RUN_MIGRATION_ROUTE` env flag). When enabled, migration filenames validated against `^[\w-]+$` regex — safe from path traversal.
- **`/api/admin/refresh`:** Placeholder only — returns `{message: "Refresh trigger placeholder"}`. No actual functionality.
- **`/api/admin/st-attribution-push`:** Properly protected (rolePriority >= 80), rate-limited internally (LIMIT 500 per pass).

### 2.5 Secret Management ⚠️
- **DB credentials stored in `~/.bashrc`:** Production DB password visible in shell profile
- **No Railway CLI access:** Token invalid — cannot verify deployment secrets
- **Environment variables:** Referenced in code (`SERVICETITAN_CLIENT_ID`, `SERVICETITAN_CLIENT_SECRET`, `SERVICETITAN_APP_KEY`, `SERVICETITAN_TENANT_ID`) — assumed stored in Railway env

---

## 3. Data Integrity

### 3.1 Commission System
- **`fact_commissions`:** Primary commission data table
- **`dim_commission_rule_version`:** Rule versioning for commission calculations
- **`dim_employee`:** Employee dimension with `managed_technician_eligible`, `active_flag`, `apprentice_flag` filters
- **`fact_estimates`:** Estimate-to-job linkage for sales commission
- **`fact_jobs`:** Job-level data with `salesman_employee_id` and `invoice_ex_gst`
- **`mart_job_economics`:** Materialized view for job economics (primary tech via `is_primary_tech = true`)
- **`dispatch_status_live`:** Webhook-driven real-time status (today-only)
- **`raw_servicetitan_jobs`:** Raw ServiceTitan job data
- **`raw_servicetitan_appointments`:** Raw ST appointments
- **`raw_servicetitan_appointment_assignments`:** Raw ST tech assignments
- **`commission_paid_records`:** Manual commission payment records
- **`commission_performance_bonuses`:** Performance bonus tracking

### 3.2 Xero Integration
- **`raw_xero_bank_accounts`:** Bank accounts (ACTIVE only)
- **`raw_xero_bank_statement_lines`:** Statement reconciliation
- **`raw_xero_balance_sheet`:** Tax liability data
- **`raw_xero_payroll_runs`:** Payroll data with payslip EarningsLines
- **`raw_xero_employees`:** Xero employee dimension
- **`raw_xero_invoices`:** Invoice data (ACCREC, AUTHORISED)
- **`xero_invoice_push_log`:** Invoice push tracking
- **`xero_payroll_sync_log`:** Payroll sync history

### 3.3 HR/Employee Data
- **`dim_employee`:** Full employee dimension (active, managed, apprentice flags)
- **`raw_xero_employees`:** Xero employee mapping
- **`settings_tech_profiles`:** Commission rate settings per employee
- **`auth_users`:** User authentication with role mapping
- **`auth_roles`:** Role definitions with priority levels
- **`auth_sessions`:** Active sessions
- **`auth_user_effective_permissions`:** Resolved permissions

---

## 4. Frontend Pages

| Page | Route | Notes |
|------|-------|-------|
| Login | `/login` | Google OAuth + email/password |
| Commissions | `/commissions` | Full commission system with gap-check, xero-reconcile |
| Xero Cash | `/xero-cash` | Bank accounts, unreconciled lines, tax obligations, cash forecast |
| Dispatch | `/dashboards/dispatch` | Today/tomorrow/week schedule with tech assignments |
| Employee | `/employee/*` | Employee management |
| Staff | `/staff/*` | Staff accountability features |
| Technician | `/technician-performance`, `/technician-scorecard`, `/technician-utilisation` | Tech performance dashboards |
| Admin | `/admin/*` | 70+ admin endpoints |
| HR | `/hr/*` | Leave, training, assets, safety, onboarding |

---

## 5. API Route Inventory

### Commission Routes (18 endpoints)
`/api/commissions/` — list, advances, approve, block-period, bonus, bonus-approve, cash-bank, deductions, fees-pool, gap-check, gifts, hold, leave-bank, mark-paid, mark-paid-bulk, override, paid, period-lock, push-to-bank, review, stc, xero-payslip, xero-reconcile

### Admin Routes (70+ endpoints)
`/api/admin/` — access-requests, action-log, ap, ar, attribution-diag, attribution-sync, bu-list, bu-mapping, call-diag, charge-out-snapshot, check-env, check-tomorrow-jobs, commission-diagnostic, commission-period-check, commission-refresh, config, cost-attribution, csr-commissions, csr-fix-all, csr-phones, csr-scorecard-refresh, diagnose-approved-comms, diagnose-csr-bookings, diagnose-csr-commissions, diagnose-locations, diagnose-split-fields, diagnose-zero-invoices, employees, estimate-close, fix-call-attribution, fix-csr-commissions, fix-inbound-attribution, fix-rc-extensions, geocode-employees, geocode-missing-locations, geotab, google-ads-landing-pages, google-ads-sync, google-config, invites, march-data-audit, march-reconciliation, onboarding, payroll-settings, podium-oauth, podium-payments-sync, podium-sync, rate-targets, rc-extensions, refresh, refresh-dim-location, ringcentral, roles, run-migration, scorecard-config, settings, slack-test, st-attribution-push, st-contacts-test, st-estimates-sync, st-jobs-fetch, st-jobs-sync, st-memberships-sync, st-pos-sync, staff, staff-contamination-check, sync-competitor-ads, sync-meta-ads, sync-meta-social, technician-scorecard-refresh, users, vehicles, verizon-connect, wildjar-auth-test, wildjar-sync, workforce, xero, xero-balance-sheet, xero-bank-sync, xero-bills-sync, xero-employees, xero-invoices-sync, xero-leave-sync, xero-payroll-sync, xero-pnl, xero-sync-all, xero-test, xero-tracking-sync

### HR Routes (9 endpoints)
`/api/hr/` — apprentices, assets, documents, leave, onboarding, reimbursements, safety, staff, training

### Other Routes
`/api/dispatch/` — dispatch data
`/api/xero-cash/` — Xero cash page data
`/api/csr/calls/staff/` — CSR call data
`/api/staff/submissions/` — Staff submissions

---

## 6. Issues & Recommendations

### Critical
1. **`ENABLE_RUN_MIGRATION_ROUTE` must remain disabled** — allows arbitrary SQL execution if enabled with admin access
2. **DB password in `~/.bashrc`** — should be in Railway env vars or a vault, not shell profile

### High
3. **SQL string interpolation in `xero-reconcile/route.ts` line 108** — periodStart/periodEnd from search params used in WHERE clause without parameterization
4. **`sqlParam()` in `commissions/page.tsx`** — custom sanitizer not a proper parameterizer; should use `$1, $2` params

### Medium
5. **Login rate limiter is in-memory only** — no persistence across deployments; ineffective under scale or after restarts
6. **`/api/admin/refresh` is a placeholder** — returns message but does nothing; may confuse operators expecting functionality
7. **Hardcoded commission payout date** (`2026-05-08` in `xero-cash/route.ts`) — needs periodic updates

### Low
8. **No CORS restrictions** on API routes — relies on auth for access control (acceptable for single-domain app)
9. **Railway CLI token invalid** — cannot verify deployment state or recent changes

---

## 7. Data Freshness Notes

- **`dispatch_status_live`**: Webhook-driven, today-only. Future dates excluded from live status to prevent bleeding.
- **`mart_job_economics`**: Materialized view with `is_primary_tech` flag. Multiple rows per (job, tech) possible (migration 428 edge case) — handled via LATERAL LIMIT 1.
- **`raw_servicetitan_appointments`**: Status filtering excludes Canceled/Cancelled/Done/Completed/Invoiced.
- **`dim_employee` filtering**: `managed_technician_eligible = true AND active_flag = true AND apprentice_flag = false` — strict gate for dispatch board.

---

*Report generated: 2026-06-16*
*Audit method: Code inspection + health check + direct DB connectivity verification*
