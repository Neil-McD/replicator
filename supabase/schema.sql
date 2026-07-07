-- Supabase schema for Replicator MVP
-- Requires pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

-- Helper function to read org_id from JWT once
create or replace function public.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt()->>'org_id', '')::uuid;
$$;

----------------------------------------------------------------------------------------------------
-- Organizations & Memberships --------------------------------------------------------------------
----------------------------------------------------------------------------------------------------

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','admin','editor','viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);

create unique index if not exists org_members_unique on public.org_members(org_id, user_id) where removed_at is null;

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;

drop policy if exists orgs_owner_read on public.orgs;
create policy orgs_owner_read on public.orgs for select using (
  owner_user_id = auth.uid() or exists (
    select 1 from public.org_members m where m.org_id = orgs.id and m.user_id = auth.uid() and m.removed_at is null
  )
);

drop policy if exists orgs_owner_update on public.orgs;
create policy orgs_owner_update on public.orgs for update using (owner_user_id = auth.uid());

drop policy if exists org_members_read on public.org_members;
create policy org_members_read on public.org_members for select using (
  org_id = public.current_org_id() or user_id = auth.uid()
);

drop policy if exists org_members_write on public.org_members;
create policy org_members_write on public.org_members for all using (
  exists (
    select 1 from public.orgs o
    where o.id = org_members.org_id and (
      o.owner_user_id = auth.uid() or exists (
        select 1 from public.org_members m
        where m.org_id = org_members.org_id and m.user_id = auth.uid() and m.role in ('owner','admin') and m.removed_at is null
      )
    )
  )
) with check (
  org_id = public.current_org_id()
);

create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin','editor','viewer')),
  token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz
);

alter table public.org_invites enable row level security;

drop policy if exists org_invites_read on public.org_invites;
create policy org_invites_read on public.org_invites for select using (
  org_id = public.current_org_id()
);

drop policy if exists org_invites_write on public.org_invites;
create policy org_invites_write on public.org_invites for all using (
  exists (
    select 1 from public.orgs o
    where o.id = org_invites.org_id and (
      o.owner_user_id = auth.uid() or exists (
        select 1 from public.org_members m
        where m.org_id = org_invites.org_id and m.user_id = auth.uid() and m.role in ('owner','admin') and m.removed_at is null
      )
    )
  )
) with check (org_id = public.current_org_id());

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_orgs_touch on public.orgs;
create trigger trg_orgs_touch
before update on public.orgs
for each row execute procedure public.touch_updated_at();


----------------------------------------------------------------------------------------------------
-- Products & Catalog -----------------------------------------------------------------------------
----------------------------------------------------------------------------------------------------

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text not null default 'draft', -- draft|ready|needs_fix|archived
  visibility text not null default 'hidden', -- visible|hidden|archived
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  version integer not null,
  name text not null,
  description text,
  cost_cents integer,
  price_cents integer,
  margin_cents integer,
  asset_version integer not null default 1,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  print_time_seconds integer,
  material_grams numeric(10,2),
  machine_hour_rate_cents integer,
  material_cost_cents integer,
  platform_fee_bps integer,
  shipping_cents integer,
  landed_cost_cents integer,
  info_json jsonb not null default '{}'::jsonb,
  unique (product_id, version)
);

alter table public.products
  add constraint products_current_version_fk
  foreign key (current_version_id) references public.product_versions(id) on delete set null;

create table if not exists public.product_assets (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  version integer not null,
  kind text not null check (kind in ('upload_image','raw_glb','raw_obj','raw_stl','repaired_stl','slicer_preview_png','three_mf','gcode','slicedata','concept_image','thumbnail','toolpath_preview')),
  storage_path text not null,
  sha256 text,
  size_bytes bigint,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (product_id, version, kind, sha256)
);

create table if not exists public.product_tags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists product_tags_unique on public.product_tags(org_id, lower(name)) where deleted_at is null;

create table if not exists public.product_tag_links (
  product_id uuid not null references public.products(id) on delete cascade,
  tag_id uuid not null references public.product_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (product_id, tag_id)
);

create table if not exists public.product_metrics (
  product_id uuid primary key references public.products(id) on delete cascade,
  print_success_rate numeric(5,2),
  avg_print_time_seconds integer,
  avg_material_grams numeric(10,2),
  updated_at timestamptz not null default now()
);

alter table public.products enable row level security;
alter table public.product_versions enable row level security;
alter table public.product_assets enable row level security;
alter table public.product_tags enable row level security;
alter table public.product_tag_links enable row level security;
alter table public.product_metrics enable row level security;

drop policy if exists products_select_org on public.products;
create policy products_select_org on public.products for select using (org_id = public.current_org_id());

drop policy if exists products_insert_org on public.products;
create policy products_insert_org on public.products for insert with check (org_id = public.current_org_id());

drop policy if exists products_update_org on public.products;
create policy products_update_org on public.products for update using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());

drop policy if exists product_versions_select_org on public.product_versions;
create policy product_versions_select_org on public.product_versions for select using (
  exists (
    select 1 from public.products p
    where p.id = product_versions.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_versions_write_org on public.product_versions;
create policy product_versions_write_org on public.product_versions for all using (
  exists (
    select 1 from public.products p
    where p.id = product_versions.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_assets_select_org on public.product_assets;
create policy product_assets_select_org on public.product_assets for select using (
  exists (
    select 1 from public.products p
    where p.id = product_assets.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_assets_write_org on public.product_assets;
create policy product_assets_write_org on public.product_assets for all using (
  exists (
    select 1 from public.products p
    where p.id = product_assets.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_tags_select_org on public.product_tags;
create policy product_tags_select_org on public.product_tags for select using (org_id = public.current_org_id());

drop policy if exists product_tags_write_org on public.product_tags;
create policy product_tags_write_org on public.product_tags for all using (org_id = public.current_org_id());

drop policy if exists product_tag_links_select_org on public.product_tag_links;
create policy product_tag_links_select_org on public.product_tag_links for select using (
  exists (
    select 1 from public.products p where p.id = product_tag_links.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_tag_links_write_org on public.product_tag_links;
create policy product_tag_links_write_org on public.product_tag_links for all using (
  exists (
    select 1 from public.products p where p.id = product_tag_links.product_id and p.org_id = public.current_org_id()
  )
);

drop policy if exists product_metrics_select_org on public.product_metrics;
create policy product_metrics_select_org on public.product_metrics for select using (
  product_id in (
    select id from public.products where org_id = public.current_org_id()
  )
);

drop policy if exists product_metrics_write_org on public.product_metrics;
create policy product_metrics_write_org on public.product_metrics for all using (
  product_id in (
    select id from public.products where org_id = public.current_org_id()
  )
);

drop trigger if exists trg_products_touch on public.products;
create trigger trg_products_touch
before update on public.products
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_product_metrics_touch on public.product_metrics;
create trigger trg_product_metrics_touch
before update on public.product_metrics
for each row execute procedure public.touch_updated_at();

----------------------------------------------------------------------------------------------------
-- Channels ---------------------------------------------------------------------------------------
----------------------------------------------------------------------------------------------------

create table if not exists public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null,
  status text not null default 'disconnected',
  display_name text,
  auth_encrypted bytea,
  settings_json jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.product_channel_state (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  product_version_id uuid references public.product_versions(id) on delete set null,
  channel_account_id uuid not null references public.channel_accounts(id) on delete cascade,
  listing_id text,
  status text not null default 'not_synced', -- not_synced|syncing|published|error
  last_synced_at timestamptz,
  sync_error text,
  sync_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, channel_account_id)
);

alter table public.channel_accounts enable row level security;
alter table public.product_channel_state enable row level security;

drop policy if exists channel_accounts_select_org on public.channel_accounts;
create policy channel_accounts_select_org on public.channel_accounts for select using (org_id = public.current_org_id());

drop policy if exists channel_accounts_write_org on public.channel_accounts;
create policy channel_accounts_write_org on public.channel_accounts for all using (org_id = public.current_org_id());

drop policy if exists product_channel_state_select_org on public.product_channel_state;
create policy product_channel_state_select_org on public.product_channel_state for select using (
  org_id = public.current_org_id()
);

drop policy if exists product_channel_state_write_org on public.product_channel_state;
create policy product_channel_state_write_org on public.product_channel_state for all using (
  org_id = public.current_org_id()
);

drop trigger if exists trg_channel_accounts_touch on public.channel_accounts;
create trigger trg_channel_accounts_touch
before update on public.channel_accounts
for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_product_channel_state_touch on public.product_channel_state;
create trigger trg_product_channel_state_touch
before update on public.product_channel_state
for each row execute procedure public.touch_updated_at();

----------------------------------------------------------------------------------------------------
-- Jobs & Events ----------------------------------------------------------------------------------
----------------------------------------------------------------------------------------------------

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  job_key text unique,
  step text not null,
  status text not null default 'queued', -- queued|running|succeeded|failed|cancelled
  attempts integer not null default 0,
  last_error text,
  last_error_at timestamptz,
  payload_json jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_status_idx on public.jobs(status, scheduled_at);
create index if not exists jobs_product_idx on public.jobs(product_id, step);

alter table public.jobs enable row level security;

drop policy if exists jobs_select_org on public.jobs;
create policy jobs_select_org on public.jobs for select using (org_id = public.current_org_id());

drop policy if exists jobs_write_org on public.jobs;
create policy jobs_write_org on public.jobs for all using (org_id = public.current_org_id());

drop trigger if exists trg_jobs_touch on public.jobs;
create trigger trg_jobs_touch
before update on public.jobs
for each row execute procedure public.touch_updated_at();

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  before jsonb,
  after jsonb,
  ip inet,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_org_idx on public.audit_log(org_id, created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists audit_log_select_org on public.audit_log;
create policy audit_log_select_org on public.audit_log for select using (org_id = public.current_org_id());


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

-- Orders: fabrication runs and purchases
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  customer_user_id uuid references auth.users(id) on delete set null,
  prompt_text text,
  status public.order_status not null default 'new',
  fulfillment_status text not null default 'pending',
  payment_status text not null default 'unpaid',
  style text,
  seed integer,
  chosen_image_id uuid,
  worker_id uuid,
  locked_at timestamptz,
  status_updated_at timestamptz not null default now(),
  material text not null default 'PLA',
  subtotal_cents integer not null default 0,
  tax_cents integer not null default 0,
  shipping_cents integer not null default 0,
  total_cents integer not null default 0,
  quote_json jsonb not null default '{}'::jsonb,
  meta_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists orders_org_status_idx on public.orders(org_id, status, created_at desc);

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

create index if not exists order_transitions_order_created_idx on public.order_transitions(order_id, created_at desc);

-- Order items capture immutable snapshots of product versions
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_version_id uuid references public.product_versions(id) on delete set null,
  name text not null,
  sku text,
  quantity integer not null default 1,
  unit_price_cents integer not null default 0,
  subtotal_cents integer not null default 0,
  asset_sha256 text,
  asset_kind text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items(order_id);

-- Assets: artifacts tied to an order
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null,
  url text not null,
  sha256 text,
  meta_json jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Payments: Stripe or other providers
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  provider_ref text,
  amount_cents integer not null,
  status text not null,
  created_at timestamptz not null default now()
);

-- Optional: profile flag for legacy admin usage
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;
alter table public.order_transitions enable row level security;
alter table public.order_items enable row level security;
alter table public.assets enable row level security;
alter table public.payments enable row level security;
alter table public.profiles enable row level security;

drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select using (user_id = auth.uid());

drop policy if exists profiles_upsert_self on public.profiles;
create policy profiles_upsert_self on public.profiles for insert with check (user_id = auth.uid());

drop policy if exists orders_select_org on public.orders;
create policy orders_select_org on public.orders for select using (org_id = public.current_org_id());

drop policy if exists orders_insert_org on public.orders;
create policy orders_insert_org on public.orders for insert with check (org_id = public.current_org_id());

drop policy if exists orders_update_org on public.orders;
create policy orders_update_org on public.orders for update using (org_id = public.current_org_id()) with check (org_id = public.current_org_id());

drop policy if exists order_transitions_select_org on public.order_transitions;
create policy order_transitions_select_org on public.order_transitions for select using (
  exists (
    select 1 from public.orders o
    where o.id = public.order_transitions.order_id and o.org_id = public.current_org_id()
  )
);

drop policy if exists order_items_select_org on public.order_items;
create policy order_items_select_org on public.order_items for select using (
  exists (select 1 from public.orders o where o.id = order_items.order_id and o.org_id = public.current_org_id())
);

drop policy if exists order_items_write_org on public.order_items;
create policy order_items_write_org on public.order_items for all using (
  exists (select 1 from public.orders o where o.id = order_items.order_id and o.org_id = public.current_org_id())
);

drop policy if exists assets_select_org on public.assets;
create policy assets_select_org on public.assets for select using (
  exists (select 1 from public.orders o where o.id = assets.order_id and o.org_id = public.current_org_id())
);

drop policy if exists assets_write_org on public.assets;
create policy assets_write_org on public.assets for all using (
  exists (select 1 from public.orders o where o.id = assets.order_id and o.org_id = public.current_org_id())
);

drop policy if exists payments_select_org on public.payments;
create policy payments_select_org on public.payments for select using (
  exists (select 1 from public.orders o where o.id = payments.order_id and o.org_id = public.current_org_id())
);

drop policy if exists payments_write_org on public.payments;
create policy payments_write_org on public.payments for all using (
  exists (select 1 from public.orders o where o.id = payments.order_id and o.org_id = public.current_org_id())
);

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  phase text not null,
  message text,
  meta_json jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.order_events enable row level security;

create policy order_events_select_org on public.order_events for select using (
  exists (select 1 from public.orders o where o.id = order_events.order_id and o.org_id = public.current_org_id())
);

create policy order_events_write_org on public.order_events for all using (
  exists (select 1 from public.orders o where o.id = order_events.order_id and o.org_id = public.current_org_id())
);

create table if not exists public.domain_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists domain_events_org_idx on public.domain_events(org_id, occurred_at desc);
create index if not exists domain_events_type_idx on public.domain_events(event_type, occurred_at desc);

alter table public.domain_events enable row level security;

drop policy if exists domain_events_select_org on public.domain_events;
create policy domain_events_select_org on public.domain_events for select using (org_id = public.current_org_id());

-- Maintain status_updated_at automatically
create or replace function public.touch_status_timestamp() returns trigger as $$
begin
  if TG_OP = 'UPDATE' and (new.status is distinct from old.status) then
    new.status_updated_at := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_touch_status on public.orders;
create trigger trg_orders_touch_status
before update on public.orders
for each row execute procedure public.touch_status_timestamp();

drop trigger if exists trg_orders_touch_updated on public.orders;
create trigger trg_orders_touch_updated
before update on public.orders
for each row execute procedure public.touch_updated_at();

-- Claim-next-order function (security definer) to atomically lock one job
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
  set status = 'generating', worker_id = p_worker_id, locked_at = now(), status_updated_at = now()
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

-- Merge helper to update nested order meta facts without clobbering existing keys
create or replace function public.merge_order_facts(p_order_id uuid, p_facts jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update public.orders
  set meta_json = coalesce(meta_json, '{}'::jsonb)
    || jsonb_build_object(
         'facts',
         coalesce(meta_json->'facts', '{}'::jsonb) || coalesce(p_facts, '{}'::jsonb)
       )
  where id = p_order_id;
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

  select * into current_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'order not found: %', p_order_id;
  end if;

  select * into already
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
      status_updated_at = now()
  where id = p_order_id
  returning * into current_order;

  return current_order;
end;
$$;

-- Atomically claim the next queued i23d generation task for a worker
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

-- Unique index to avoid duplicate assets (when checksum known)
create unique index if not exists assets_unique_order_kind_sha on public.assets(order_id, kind, sha256) where sha256 is not null;

-- Images: candidate and chosen images for Visualize step
create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('candidate','chosen')),
  url text not null,
  meta_json jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.images enable row level security;

drop policy if exists images_select_org on public.images;
create policy images_select_org on public.images for select using (
  exists (
    select 1 from public.orders o
    where o.id = public.images.order_id and o.org_id = public.current_org_id()
  )
);
drop policy if exists images_write_org on public.images;
create policy images_write_org on public.images for all using (
  exists (
    select 1 from public.orders o
    where o.id = public.images.order_id and o.org_id = public.current_org_id()
  )
);

-- Generation tasks: provider-backed jobs (t2i, i23d)
create table if not exists public.generation_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('t2i','i23d')),
  provider text,
  provider_task_id text,
  status text, -- queued|running|succeeded|failed
  worker_id uuid,
  claimed_at timestamptz,
  idempotency_key text,
  cost_cents integer,
  payload_json jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.generation_tasks enable row level security;

create index if not exists generation_tasks_provider_idx on public.generation_tasks(provider, provider_task_id);
create index if not exists generation_tasks_status_idx on public.generation_tasks(status, created_at);
create unique index if not exists generation_tasks_order_kind_idempotency_idx
  on public.generation_tasks(order_id, kind, idempotency_key)
  where idempotency_key is not null;

drop policy if exists generation_tasks_select_org on public.generation_tasks;
create policy generation_tasks_select_org on public.generation_tasks for select using (
  exists (
    select 1 from public.orders o
    where o.id = public.generation_tasks.order_id and o.org_id = public.current_org_id()
  )
);
drop policy if exists generation_tasks_write_org on public.generation_tasks;
create policy generation_tasks_write_org on public.generation_tasks for all using (
  exists (
    select 1 from public.orders o
    where o.id = public.generation_tasks.order_id and o.org_id = public.current_org_id()
  )
);

-- Chat messages: chat-first orchestration and UI
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  type text, -- text|card.images|card.job|card.quote|warning
  content_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.chat_messages enable row level security;

drop policy if exists chat_messages_select_org on public.chat_messages;
create policy chat_messages_select_org on public.chat_messages for select using (
  exists (
    select 1 from public.orders o
    where o.id = public.chat_messages.order_id and o.org_id = public.current_org_id()
  )
);
drop policy if exists chat_messages_write_org on public.chat_messages;
create policy chat_messages_write_org on public.chat_messages for all using (
  exists (
    select 1 from public.orders o
    where o.id = public.chat_messages.order_id and o.org_id = public.current_org_id()
  )
);
