-- Migration: Add atomic claim RPC functions for worker job claiming
-- Fixes backoff issues and provides SKIP LOCKED semantics

begin;

-- Atomic claim for i23d generation tasks
-- This eliminates the 70+ backoff failures seen in worker logs
CREATE OR REPLACE FUNCTION public.claim_i23d_task(p_worker_id uuid)
RETURNS TABLE(order_data jsonb)
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.generation_tasks
    SET
      status = 'running',
      worker_id = p_worker_id,
      claimed_at = now()
    WHERE id = (
      SELECT id
      FROM public.generation_tasks
      WHERE status = 'queued' AND kind = 'i23d'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING order_id
  )
  SELECT row_to_json(o.*)::jsonb
  FROM claimed c
  JOIN public.orders o ON o.id = c.order_id;
END;
$$;

COMMENT ON FUNCTION public.claim_i23d_task IS
  'Atomically claim next queued i23d generation task and return order data';

commit;
