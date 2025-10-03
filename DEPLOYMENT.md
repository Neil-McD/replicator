# Deployment Guide: Unified Job Queue for Slicing

## Summary of Changes

This deployment unifies slicing (print check / quote generation) into the existing `export_jobs` queue infrastructure, fixing the "stuck slicing" issue and creating a single source of truth for all worker jobs.

### Files Changed

**Database Migrations:**
- `supabase/migrations/20251002_slice_jobs.sql` - Extends export_jobs table
- `supabase/migrations/20251002_claim_rpcs.sql` - Adds atomic claim RPC

**API Routes:**
- `web/app/api/orders/[id]/slice/route.ts` - Now creates export_jobs instead of setting status

**Worker:**
- `worker/main.py` - Three functions modified/added:
  - `claim_next_export_job()` - Now handles both export and slice jobs
  - `process_export_job()` - Dispatcher for job types
  - `_process_sized_export_job()` - Refactored existing logic
  - `_process_slice_job()` - NEW: Wraps process_slicing in job lifecycle

**Frontend:**
- `web/components/Stage.tsx` - Binds slice status to export_jobs array

---

## Deployment Steps

### 1. Apply Database Migrations

```bash
# Option A: Using Supabase CLI
cd /home/neilmcd/replicator
supabase db push

# Option B: Manual application
psql $DATABASE_URL -f supabase/migrations/20251002_slice_jobs.sql
psql $DATABASE_URL -f supabase/migrations/20251002_claim_rpcs.sql
```

**Verify migrations:**
```sql
-- Check new columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'export_jobs'
AND column_name IN ('job_type', 'quote_json');

-- Check RPC function exists
SELECT routine_name
FROM information_schema.routines
WHERE routine_name = 'claim_i23d_task';
```

### 2. Deploy Worker Changes

```bash
# Stop worker
sudo systemctl stop replicator-worker
# OR
pm2 stop worker

# Pull latest code (if using git)
cd /home/neilmcd/replicator/worker
git pull origin main

# Restart worker
sudo systemctl start replicator-worker
# OR
pm2 start worker

# Monitor worker logs
sudo journalctl -u replicator-worker -f
# OR
pm2 logs worker
```

**Expected log output on startup:**
```
[export] claimed slice job <job-id>
[slice] job <job-id> starting
```

### 3. Deploy Web/API Changes

```bash
cd /home/neilmcd/replicator/web
npm run build
# OR if using PM2/Next.js standalone:
pm2 restart web
# OR if using Vercel:
vercel --prod
```

---

## Testing Checklist

### Test 1: Fresh Slice Request (Happy Path)
1. Load order with `repaired_stl` asset
2. Click "Retry print check" button
3. **Expected:**
   - Network request to `/api/orders/:id/slice` returns `{ jobId: "...", status: "pending" }`
   - Within 2s, worker logs: `[export] claimed slice job ...`
   - Within 30-60s, Bambu CLI completes, logs: `[slice] job ... succeeded`
   - UI shows quote: "Ready to print — 73 min · 41 g · $18.40"
   - Buy button becomes enabled

### Test 2: Idempotent Retry
1. While slice job is `pending` or `processing`
2. Click "Retry print check" again
3. **Expected:**
   - API returns `{ jobId: "...", status: "processing", reused: true }`
   - NO new worker task spawned
   - Existing job completes normally

### Test 3: Slice Failure Recovery
1. Edit `BAMBU_STUDIO_CLI` env var to invalid path
2. Restart worker
3. Click "Retry print check"
4. **Expected:**
   - Worker logs: `[slice] job ... failed: ...`
   - UI shows amber warning: "Print check failed: ..."
   - "Retry print check" button remains visible
5. Fix `BAMBU_STUDIO_CLI`, restart worker
6. Click "Retry print check" again
7. **Expected:** New job succeeds

### Test 4: Size Change Workflow
1. Complete initial slice (quote visible)
2. Resize model to 150mm, click "Prepare new size STL"
3. **Expected:** Export job (`job_type='export'`) created
4. Wait for sized STL to appear
5. Click "Retry print check"
6. **Expected:**
   - NEW slice job created (`job_type='slice'`)
   - Slices the latest `repaired_stl` (which may be sized or base)
   - Quote updates

### Test 5: I23D Backoff Fix
1. Trigger materialize (image→3D) workflow
2. **Expected:**
   - Worker logs: `[export] claimed i23d task ...` (no backoff warnings)
   - NO more "[claim] claim_i23d_task RPC failed; backing off" messages

---

## Rollback Procedure

If critical issues arise:

### 1. Rollback Database
```sql
BEGIN;
  ALTER TABLE export_jobs DROP COLUMN IF EXISTS job_type;
  ALTER TABLE export_jobs DROP COLUMN IF EXISTS quote_json;
  DROP INDEX IF EXISTS export_jobs_type_status_idx;
  DROP FUNCTION IF EXISTS claim_i23d_task;
COMMIT;
```

### 2. Rollback Code
```bash
# Worker
cd /home/neilmcd/replicator
git revert <commit-hash>
sudo systemctl restart replicator-worker

# Web
cd web
git revert <commit-hash>
npm run build
pm2 restart web
```

---

## Monitoring

### Key Metrics to Watch

**Worker Logs:**
```bash
# Look for these patterns:
# Good: Job claiming is fast
grep "claimed slice job" worker.log | wc -l

# Bad: Jobs stuck in pending
psql $DATABASE_URL -c "SELECT COUNT(*) FROM export_jobs WHERE job_type='slice' AND status='pending' AND created_at < NOW() - INTERVAL '2 minutes';"

# Bad: Failed slices
psql $DATABASE_URL -c "SELECT error_message FROM export_jobs WHERE job_type='slice' AND status='failed' ORDER BY created_at DESC LIMIT 5;"
```

**Database Queries:**
```sql
-- Active slice jobs
SELECT id, order_id, status, created_at, started_at, completed_at
FROM export_jobs
WHERE job_type = 'slice'
ORDER BY created_at DESC
LIMIT 10;

-- Job throughput (last hour)
SELECT
  job_type,
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_duration_sec
FROM export_jobs
WHERE created_at > NOW() - INTERVAL '1 hour'
  AND completed_at IS NOT NULL
GROUP BY job_type, status;
```

---

## Known Issues & Future Enhancements

### Current Limitations
- No heartbeat tracking yet (jobs stuck >2min won't auto-recover)
- No automatic quote invalidation when size changes
- Worker doesn't automatically slice sized STLs

### Planned Improvements (Post-MVP)
1. **Heartbeat tracking:** Worker pings `updated_at` every 10s
2. **Stale job redriver:** Cron marks jobs stuck >2min as `failed`
3. **Auto-slice on size:** Trigger slice job when `repaired_sized_stl` created
4. **Quote invalidation:** Clear `orders.quote_json` when transform changes

---

## Support & Debugging

### Common Issues

**Issue:** "Print check running — please wait" never completes
**Debug:**
```sql
-- Check if job exists
SELECT * FROM export_jobs WHERE order_id = '<order-id>' AND job_type = 'slice' ORDER BY created_at DESC LIMIT 1;

-- Check worker activity
SELECT worker_id, status, started_at FROM export_jobs WHERE status = 'processing';
```

**Issue:** Worker logs "No orders to process" but slice job exists
**Debug:**
```sql
-- Verify job is pending
SELECT id, status FROM export_jobs WHERE status = 'pending' AND job_type = 'slice';
```
**Fix:** Restart worker

**Issue:** Buy button stays disabled after quote appears
**Debug:** Check browser console for `sliceMeta` state
**Fix:** Refresh page, verify `orders.status = 'ready_to_pay'`

---

## Changes Summary

| Component | Lines Changed | Risk Level |
|-----------|--------------|------------|
| Database Schema | +40 | Low (additive) |
| API Route | +30 | Low (backwards compat) |
| Worker | +150 | Medium (refactor) |
| Frontend | +60 | Low (graceful fallback) |
| **Total** | **~280 LOC** | **Low-Medium** |

**Deployment Time:** 15-20 minutes
**Rollback Time:** 5 minutes
**Risk Assessment:** Low (extends proven patterns, maintains backward compat)
