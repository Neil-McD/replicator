-- Migration: Add slice job support to export_jobs table
-- Allows slicing (price quote) jobs to use the same queue as export (sized STL) jobs

begin;

-- Add job_type field to distinguish export vs slice jobs
ALTER TABLE public.export_jobs
  ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'export';

-- Add quote storage for slice jobs
ALTER TABLE public.export_jobs
  ADD COLUMN IF NOT EXISTS quote_json JSONB;

-- Add index for efficient job claiming by type
CREATE INDEX IF NOT EXISTS export_jobs_type_status_idx
  ON public.export_jobs(job_type, status, created_at);

-- Add check constraint for job_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'export_jobs_job_type_check'
  ) THEN
    ALTER TABLE public.export_jobs
      ADD CONSTRAINT export_jobs_job_type_check
      CHECK (job_type IN ('export', 'slice'));
  END IF;
END $$;

COMMENT ON COLUMN public.export_jobs.job_type IS
  'Type of job: export (sized STL generation) or slice (price quote from Bambu CLI)';

COMMENT ON COLUMN public.export_jobs.quote_json IS
  'Quote result for slice jobs: {minutes, grams, price_cents, preview_url, three_mf_url}';

commit;
