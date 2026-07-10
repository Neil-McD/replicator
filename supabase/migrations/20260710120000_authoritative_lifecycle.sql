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

-- Legacy order claiming may lock rows for compatibility, but it must not move
-- customer-visible lifecycle state. New worker production queues use
-- generation_tasks/export_jobs instead.
create or replace function public.claim_next_order(p_worker_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.orders;
begin
  update public.orders o
  set worker_id = p_worker_id,
      locked_at = now()
  where o.id = (
    select id from public.orders
    where status = 'new'
    order by created_at asc
    for update skip locked
    limit 1
  )
  returning * into claimed;
  return claimed;
end;
$$;

-- Replace older schema/RPC definitions that made provider queue claiming a
-- customer-visible lifecycle transition. Claiming a generation task is provider
-- queue state only; materializing is recorded by the lifecycle command layer.
drop function if exists public.claim_i23d_task(uuid);

create function public.claim_i23d_task(p_worker_id uuid)
returns table(order_data public.orders, task_data public.generation_tasks)
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_task public.generation_tasks;
  updated_task public.generation_tasks;
  updated_order public.orders;
begin
  select *
    into selected_task
  from public.generation_tasks
  where kind = 'i23d' and status = 'queued'
  order by created_at asc
  limit 1
  for update skip locked;

  if not found then
    return;
  end if;

  update public.generation_tasks
  set status = 'running', worker_id = p_worker_id, claimed_at = now()
  where id = selected_task.id
  returning * into updated_task;

  update public.orders
  set worker_id = p_worker_id,
      locked_at = now()
  where id = selected_task.order_id
  returning * into updated_order;

  order_data := updated_order;
  task_data := updated_task;
  return next;
end;
$$;

create or replace function public.prevent_asset_identity_update()
returns trigger
language plpgsql
as $$
begin
  if old.order_id is distinct from new.order_id
    or old.kind is distinct from new.kind
    or old.url is distinct from new.url
    or old.sha256 is distinct from new.sha256 then
    raise exception 'asset_identity_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists assets_prevent_identity_update on public.assets;
create trigger assets_prevent_identity_update
before update on public.assets
for each row
execute function public.prevent_asset_identity_update();
