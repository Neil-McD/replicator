begin;

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'export_job_status'
  ) then
    create type public.export_job_status as enum ('pending','processing','succeeded','failed','cancelled');
  end if;
end $$;

create table if not exists public.export_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  status public.export_job_status not null default 'pending',
  target_max_dim_mm numeric(10,2),
  target_tolerance_mm numeric(10,2),
  asset_id uuid references public.assets(id) on delete set null,
  transform_asset_id uuid references public.assets(id) on delete set null,
  error_message text,
  worker_id uuid,
  requested_by uuid references auth.users(id) on delete set null,
  retries integer not null default 0,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists export_jobs_order_idx on public.export_jobs(order_id, created_at);
create index if not exists export_jobs_status_idx on public.export_jobs(status, created_at);

alter table public.export_jobs enable row level security;

drop policy if exists export_jobs_select_org on public.export_jobs;
create policy export_jobs_select_org on public.export_jobs for select using (
  exists (
    select 1
    from public.orders o
    where o.id = export_jobs.order_id
      and o.org_id = public.current_org_id()
  )
);

drop policy if exists export_jobs_write_org on public.export_jobs;
create policy export_jobs_write_org on public.export_jobs for all using (
  exists (
    select 1
    from public.orders o
    where o.id = export_jobs.order_id
      and o.org_id = public.current_org_id()
  )
);

drop trigger if exists trg_export_jobs_touch on public.export_jobs;
create trigger trg_export_jobs_touch
before update on public.export_jobs
for each row execute procedure public.touch_updated_at();

commit;
