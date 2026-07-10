-- Replicator authoritative lifecycle foundation.
-- orders.status is the only customer-visible lifecycle state.

create table if not exists public.order_commands (
  key text primary key,
  command text not null,
  order_id uuid references public.orders(id) on delete cascade,
  status text not null default 'started' check (status in ('started','succeeded','failed')),
  actor text,
  metadata_json jsonb not null default '{}'::jsonb,
  result_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_commands_order_id_idx on public.order_commands(order_id);
create index if not exists order_commands_command_idx on public.order_commands(command);

update public.orders
set status = case status
  when 'generating' then 'materializing'
  when 'fabrication_requested' then 'stabilizing'
  when 'repairing' then 'stabilizing'
  when 'exporting' then 'stabilizing'
  when 'stl_ready' then
    case
      when quote_json is not null then 'ready_to_pay'
      else 'stabilizing'
    end
  else status
end
where status in ('generating','fabrication_requested','repairing','exporting','stl_ready');

alter table public.orders
  drop constraint if exists orders_status_authoritative_check;

alter table public.orders
  add constraint orders_status_authoritative_check
  check (status in (
    'new',
    'visualizing',
    'await_image_pick',
    'materializing',
    'stabilizing',
    'slicing',
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
  )) not valid;

update public.export_jobs
set job_type = case job_type
  when 'export' then 'export_stl'
  when 'slice' then 'slice_quote'
  else job_type
end
where job_type in ('export','slice');

alter table public.export_jobs
  drop constraint if exists export_jobs_job_type_check;

alter table public.export_jobs
  add constraint export_jobs_job_type_check
  check (job_type in ('repair','export_stl','slice_quote','dispatch')) not valid;

alter table public.export_jobs
  add column if not exists produced_asset_ids uuid[] not null default '{}'::uuid[];

alter table public.product_versions
  add column if not exists source_order_id uuid references public.orders(id),
  add column if not exists source_quote_json jsonb,
  add column if not exists source_profile_hash text,
  add column if not exists source_artifact_set_hash text;

create index if not exists product_versions_source_order_id_idx on public.product_versions(source_order_id);
create index if not exists product_versions_source_artifact_set_hash_idx on public.product_versions(source_artifact_set_hash);

alter table public.product_assets
  add column if not exists source_asset_id uuid references public.assets(id);

create index if not exists product_assets_source_asset_id_idx on public.product_assets(source_asset_id);
