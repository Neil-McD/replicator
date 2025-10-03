-- Ensure the order_status enum exists before trying to extend it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM (
      'new',
      'visualizing',
      'await_image_pick',
      'materializing',
      'generating',
      'fabrication_requested',
      'repairing',
      'exporting',
      'slicing',
      'stl_ready',
      'ready_to_pay',
      'paid',
      'dispatching',
      'printing',
      'done',
      'needs_review',
      'generate_failed',
      'repair_failed',
      'slice_failed',
      'dispatch_failed',
      'cancelled'
    );
  END IF;
END $$;

-- Adds missing order_status enum values used by the application code.
DO $$
BEGIN
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'generating';
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'fabrication_requested';
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'exporting';
  ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'stl_ready';
END $$;
