begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type public.order_status as enum (
      'new',
      'visualizing',
      'await_image_pick',
      'materializing',
      'generating',
      'repairing',
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
    );
  end if;
end $$;

do $$
declare
  invalid_values text[];
begin
  select array_agg(distinct status order by status)
    into invalid_values
  from public.orders
  where status is not null
    and status not in (
      'new',
      'visualizing',
      'await_image_pick',
      'materializing',
      'generating',
      'repairing',
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
    );

  if invalid_values is not null then
    raise exception 'orders.status contains values outside canonical order_status: %', invalid_values;
  end if;
end $$;

alter table public.orders
  alter column status drop default;

alter table public.orders
  alter column status type public.order_status
  using status::public.order_status;

alter table public.orders
  alter column status set default 'new'::public.order_status;

alter table public.orders
  drop constraint if exists orders_status_canonical_check;

alter table public.orders
  add constraint orders_status_canonical_check
  check (status::text in (
    'new',
    'visualizing',
    'await_image_pick',
    'materializing',
    'generating',
    'repairing',
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
  ));

create table if not exists public.order_transitions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  authority text not null check (authority in ('chat','visualize','materialize','worker','stripe','operator','user','catalog')),
  idempotency_key text not null,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (order_id, idempotency_key)
);

create index if not exists order_transitions_order_created_idx
  on public.order_transitions(order_id, created_at desc);

alter table public.order_transitions enable row level security;

drop policy if exists order_transitions_select_org on public.order_transitions;
create policy order_transitions_select_org on public.order_transitions for select using (
  exists (
    select 1 from public.orders o
    where o.id = public.order_transitions.order_id and o.org_id = public.current_org_id()
  )
);

alter table public.generation_tasks
  add column if not exists idempotency_key text;

create unique index if not exists generation_tasks_order_kind_idempotency_idx
  on public.generation_tasks(order_id, kind, idempotency_key)
  where idempotency_key is not null;

alter table public.export_jobs
  add column if not exists idempotency_key text;

create unique index if not exists export_jobs_order_type_idempotency_idx
  on public.export_jobs(order_id, job_type, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists payments_provider_ref_unique
  on public.payments(provider_ref)
  where provider_ref is not null;

create or replace function public.claim_next_order(p_worker_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.orders;
begin
  -- Compatibility shim only. MVP-critical claims must use job-specific RPCs
  -- that call transition_order and create order_transitions audit records.
  claimed := null;
  return claimed;
end;
$$;

create or replace function public.transition_order(
  p_order_id uuid,
  p_to_status public.order_status,
  p_authority text,
  p_expected_from public.order_status[] default null,
  p_idempotency_key text default null,
  p_meta_json jsonb default '{}'::jsonb
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  current_order public.orders;
  transition_key text;
  already public.order_transitions;
  allowed boolean := false;
begin
  if p_authority not in ('chat','visualize','materialize','worker','stripe','operator','user','catalog') then
    raise exception 'invalid transition authority: %', p_authority;
  end if;

  transition_key := coalesce(nullif(p_idempotency_key, ''), p_authority || ':' || p_order_id::text || ':' || p_to_status::text);

  select *
    into current_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found: %', p_order_id;
  end if;

  select *
    into already
  from public.order_transitions
  where order_id = p_order_id and idempotency_key = transition_key;

  if found then
    return current_order;
  end if;

  if p_expected_from is not null and not (current_order.status = any(p_expected_from)) then
    raise exception 'invalid current status %, expected %', current_order.status, p_expected_from;
  end if;

  if current_order.status = p_to_status then
    allowed := true;
  elsif current_order.status in ('done'::public.order_status, 'cancelled'::public.order_status) then
    allowed := false;
  elsif p_to_status = 'cancelled'::public.order_status and p_authority in ('user','operator') then
    allowed := current_order.status not in ('paid'::public.order_status, 'dispatching'::public.order_status, 'printing'::public.order_status, 'done'::public.order_status);
  elsif current_order.status in ('new'::public.order_status, 'await_image_pick'::public.order_status, 'generate_failed'::public.order_status, 'repair_failed'::public.order_status, 'slice_failed'::public.order_status, 'needs_review'::public.order_status) and p_to_status = 'visualizing'::public.order_status and p_authority in ('chat','visualize') then
    allowed := true;
  elsif current_order.status = 'visualizing'::public.order_status and p_to_status = 'await_image_pick'::public.order_status and p_authority in ('chat','visualize') then
    allowed := true;
  elsif current_order.status = 'await_image_pick'::public.order_status and p_to_status = 'materializing'::public.order_status and p_authority in ('chat','materialize') then
    allowed := true;
  elsif current_order.status = 'materializing'::public.order_status and p_to_status = 'generating'::public.order_status and p_authority = 'worker' then
    allowed := true;
  elsif current_order.status = 'generating'::public.order_status and p_to_status in ('repairing'::public.order_status, 'generate_failed'::public.order_status, 'needs_review'::public.order_status) and p_authority = 'worker' then
    allowed := true;
  elsif current_order.status = 'repairing'::public.order_status and p_to_status in ('slicing'::public.order_status, 'repair_failed'::public.order_status, 'needs_review'::public.order_status) and p_authority = 'worker' then
    allowed := true;
  elsif current_order.status = 'slice_failed'::public.order_status and p_to_status = 'slicing'::public.order_status and p_authority = 'worker' then
    allowed := true;
  elsif current_order.status = 'slicing'::public.order_status and p_to_status in ('ready_to_pay'::public.order_status, 'slice_failed'::public.order_status) and p_authority = 'worker' then
    allowed := true;
  elsif current_order.status = 'ready_to_pay'::public.order_status and p_to_status = 'paid'::public.order_status and p_authority = 'stripe' then
    allowed := true;
  elsif current_order.status = 'paid'::public.order_status and p_to_status = 'dispatching'::public.order_status and p_authority in ('operator','worker') then
    allowed := true;
  elsif current_order.status = 'dispatching'::public.order_status and p_to_status = 'printing'::public.order_status and p_authority in ('operator','worker') then
    allowed := true;
  elsif current_order.status = 'printing'::public.order_status and p_to_status = 'done'::public.order_status and p_authority in ('operator','worker') then
    allowed := true;
  end if;

  if not allowed then
    raise exception 'illegal order transition: % -> % by %', current_order.status, p_to_status, p_authority;
  end if;

  insert into public.order_transitions(order_id, from_status, to_status, authority, idempotency_key, meta_json)
  values (p_order_id, current_order.status, p_to_status, p_authority, transition_key, coalesce(p_meta_json, '{}'::jsonb));

  update public.orders
  set status = p_to_status,
      worker_id = case when p_authority = 'worker' then worker_id else worker_id end,
      status_updated_at = now()
  where id = p_order_id
  returning * into current_order;

  return current_order;
end;
$$;

create or replace function public.claim_i23d_task(p_worker_id uuid)
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

  select *
    into updated_order
  from public.transition_order(
    selected_task.order_id,
    'generating'::public.order_status,
    'worker',
    array['materializing'::public.order_status],
    'worker:claim_i23d:' || selected_task.id::text,
    jsonb_build_object('task_id', selected_task.id, 'worker_id', p_worker_id)
  );

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

commit;
