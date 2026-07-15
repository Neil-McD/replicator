-- Authoritative order lifecycle command for the first Replicator reboot slice.
-- orders.status remains the compatibility projection consumed by the existing UI.

comment on column public.orders.status
is 'UI-facing projection of the Replicator lifecycle; mutate through transition_order_lifecycle.';

create or replace function public.transition_order_lifecycle(
  p_order_id uuid,
  p_transition text,
  p_expected_from text[] default null,
  p_to_status text default null,
  p_actor text default 'system',
  p_idempotency_key text default null,
  p_event_phase text default null,
  p_event_message text default null,
  p_event_meta jsonb default '{}'::jsonb,
  p_patch jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_from text;
  v_allowed_from text[];
  v_reused_at text[] := array[]::text[];
  v_required_to text;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_quote jsonb;
  v_event_meta jsonb;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_from := v_order.status;

  case p_transition
    when 'visualize_started' then
      v_required_to := 'visualizing';
      v_allowed_from := array['new','await_image_pick','stl_ready','ready_to_pay','generate_failed','needs_review'];
    when 'visualize_candidates_ready' then
      v_required_to := 'await_image_pick';
      v_allowed_from := array['new','visualizing'];
    when 'materialize_requested' then
      v_required_to := 'materializing';
      v_allowed_from := array['await_image_pick','visualizing','generate_failed','needs_review'];
    when 'materialize_claimed' then
      v_required_to := 'generating';
      v_allowed_from := array['new','visualizing','await_image_pick','materializing','generating'];
      v_reused_at := array['generating'];
    when 'fabrication_requested' then
      v_required_to := 'fabrication_requested';
      v_allowed_from := array['materializing','generating','stl_ready','generate_failed','needs_review'];
      v_reused_at := array['fabrication_requested','repairing','slicing','stl_ready','ready_to_pay','paid','dispatching','printing','done'];
    when 'repair_started' then
      v_required_to := 'repairing';
      v_allowed_from := array['fabrication_requested','generating'];
      v_reused_at := array['repairing'];
    when 'stl_ready' then
      v_required_to := 'stl_ready';
      v_allowed_from := array['repairing','exporting'];
      v_reused_at := array['stl_ready'];
    when 'export_requested' then
      v_required_to := 'exporting';
      v_allowed_from := array['stl_ready','ready_to_pay','needs_review'];
      v_reused_at := array['exporting'];
    when 'slice_requested' then
      v_required_to := 'slicing';
      v_allowed_from := array['stl_ready','fabrication_requested','repairing','slice_failed'];
      v_reused_at := array['slicing'];
    when 'quote_ready' then
      v_required_to := 'ready_to_pay';
      v_allowed_from := array['slicing'];
      v_reused_at := array['ready_to_pay'];
    when 'payment_completed' then
      v_required_to := 'paid';
      v_allowed_from := array['ready_to_pay'];
      v_reused_at := array['paid','dispatching','printing','done'];
    when 'dispatch_requested' then
      v_required_to := 'dispatching';
      v_allowed_from := array['paid','dispatch_failed'];
      v_reused_at := array['dispatching','printing','done'];
    when 'printing_started' then
      v_required_to := 'printing';
      v_allowed_from := array['dispatching'];
      v_reused_at := array['printing','done'];
    when 'done' then
      v_required_to := 'done';
      v_allowed_from := array['printing'];
      v_reused_at := array['done'];
    when 'generate_failed' then
      v_required_to := 'generate_failed';
      v_allowed_from := array['materializing','generating'];
      v_reused_at := array['generate_failed'];
    when 'repair_failed' then
      v_required_to := 'repair_failed';
      v_allowed_from := array['fabrication_requested','generating','repairing'];
      v_reused_at := array['repair_failed'];
    when 'slice_failed' then
      v_required_to := 'slice_failed';
      v_allowed_from := array['fabrication_requested','repairing','slicing'];
      v_reused_at := array['slice_failed'];
    when 'dispatch_failed' then
      v_required_to := 'dispatch_failed';
      v_allowed_from := array['paid','dispatching'];
      v_reused_at := array['dispatch_failed'];
    when 'needs_review' then
      v_required_to := 'needs_review';
      v_allowed_from := array['materializing','generating','fabrication_requested','repairing','exporting','slicing','stl_ready','slice_failed'];
      v_reused_at := array['needs_review'];
    when 'cancelled' then
      v_required_to := 'cancelled';
      v_allowed_from := array['new','visualizing','await_image_pick','materializing','generating','fabrication_requested','repairing','exporting','slicing','stl_ready','ready_to_pay','paid','dispatching','printing','needs_review','generate_failed','repair_failed','slice_failed','dispatch_failed'];
      v_reused_at := array['cancelled'];
    else
      return jsonb_build_object('ok', false, 'error', 'invalid_transition', 'previous_status', v_from);
  end case;

  if p_to_status is distinct from v_required_to then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition', 'previous_status', v_from);
  end if;

  if v_from = 'cancelled' and v_required_to <> 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'cancelled', 'previous_status', v_from);
  end if;

  if exists (
    select 1 from jsonb_object_keys(v_patch) as patch_key(key)
    where key not in ('worker_id','locked_at','payment_status','quote_json','meta_json')
  ) then
    return jsonb_build_object('ok', false, 'error', 'invalid_patch', 'previous_status', v_from);
  end if;

  if v_patch ? 'payment_status'
     and (p_transition <> 'payment_completed' or v_patch->>'payment_status' <> 'paid') then
    return jsonb_build_object('ok', false, 'error', 'invalid_patch', 'previous_status', v_from);
  end if;

  if v_patch ? 'quote_json' and p_transition <> 'quote_ready' then
    return jsonb_build_object('ok', false, 'error', 'invalid_patch', 'previous_status', v_from);
  end if;

  if p_transition = 'quote_ready' then
    v_quote := v_patch->'quote_json';
    if jsonb_typeof(v_quote) <> 'object'
       or not (v_quote ? 'minutes')
       or not (v_quote ? 'grams')
       or not ((v_quote ? 'price_cents') or (v_quote ? 'total_cents'))
       or jsonb_typeof(v_quote->'minutes') <> 'number'
       or jsonb_typeof(v_quote->'grams') <> 'number'
       or (v_quote ? 'price_cents' and jsonb_typeof(v_quote->'price_cents') <> 'number')
       or (v_quote ? 'total_cents' and jsonb_typeof(v_quote->'total_cents') <> 'number')
       or (v_quote->>'minutes')::numeric <= 0
       or (v_quote->>'grams')::numeric <= 0
       or coalesce((v_quote->>'price_cents')::numeric, (v_quote->>'total_cents')::numeric) < 0 then
      return jsonb_build_object('ok', false, 'error', 'invalid_quote', 'previous_status', v_from);
    end if;
  end if;

  if v_from = any(v_reused_at) then
    -- A repeated request may refresh intent metadata (notably cancel_requested=false),
    -- but must not clear a worker lock or rewrite payment/quote projections.
    if v_from = v_required_to and v_patch ? 'meta_json' then
      update public.orders
      set meta_json = coalesce(meta_json, '{}'::jsonb) || coalesce(v_patch->'meta_json', '{}'::jsonb)
      where id = p_order_id;
    end if;
    return jsonb_build_object(
      'ok', true,
      'previous_status', v_from,
      'new_status', v_from,
      'changed', false,
      'reused', true
    );
  end if;

  if not (v_from = any(v_allowed_from))
     or (p_expected_from is not null and not (v_from = any(p_expected_from))) then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_transition',
      'previous_status', v_from,
      'requested_status', v_required_to
    );
  end if;

  if p_transition = 'payment_completed' and not exists (
    select 1 from public.payments
    where order_id = p_order_id and status in ('succeeded','paid','complete','completed')
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_paid', 'previous_status', v_from);
  end if;

  if p_transition = 'dispatch_requested' then
    if v_from not in ('paid','dispatch_failed') then
      return jsonb_build_object('ok', false, 'error', 'not_paid', 'previous_status', v_from);
    end if;
    if not exists (
      select 1 from public.assets
      where order_id = p_order_id and kind = 'three_mf'
    ) then
      return jsonb_build_object('ok', false, 'error', 'missing_artifact', 'previous_status', v_from);
    end if;
  end if;

  update public.orders
  set status = v_required_to,
      worker_id = case when v_patch ? 'worker_id' then nullif(v_patch->>'worker_id', '')::uuid else worker_id end,
      locked_at = case when v_patch ? 'locked_at' then nullif(v_patch->>'locked_at', '')::timestamptz else locked_at end,
      payment_status = case when p_transition = 'payment_completed' then 'paid' else payment_status end,
      quote_json = case when p_transition = 'quote_ready' then v_patch->'quote_json' else quote_json end,
      meta_json = case when v_patch ? 'meta_json'
                       then coalesce(meta_json, '{}'::jsonb) || coalesce(v_patch->'meta_json', '{}'::jsonb)
                       else meta_json end
  where id = p_order_id;

  v_event_meta := coalesce(p_event_meta, '{}'::jsonb)
    || jsonb_build_object('transition', p_transition, 'actor', coalesce(p_actor, 'system'));
  if p_idempotency_key is not null then
    v_event_meta := v_event_meta || jsonb_build_object('idempotency_key', p_idempotency_key);
  end if;

  insert into public.order_events(order_id, phase, message, meta_json)
  values (
    p_order_id,
    coalesce(nullif(p_event_phase, ''), p_transition),
    p_event_message,
    v_event_meta
  );

  return jsonb_build_object(
    'ok', true,
    'previous_status', v_from,
    'new_status', v_required_to,
    'changed', true,
    'reused', false
  );
end;
$$;

comment on function public.transition_order_lifecycle(uuid,text,text[],text,text,text,text,text,jsonb,jsonb)
is 'Server-only authoritative command for Replicator orders.status lifecycle transitions.';

revoke all on function public.transition_order_lifecycle(uuid,text,text[],text,text,text,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.transition_order_lifecycle(uuid,text,text[],text,text,text,text,text,jsonb,jsonb) to service_role;

-- Collapse any legacy duplicate active work before enforcing one runnable work
-- unit per order and job type. Prefer an already-processing unit, otherwise the
-- oldest pending unit, so rollout does not interrupt work already under way.
with ranked_active_jobs as (
  select id,
         row_number() over (
           partition by order_id, job_type
           order by case when status = 'processing' then 0 else 1 end, created_at asc, id asc
         ) as active_rank
  from public.export_jobs
  where status in ('pending', 'processing')
)
update public.export_jobs as jobs
set status = 'cancelled',
    completed_at = coalesce(jobs.completed_at, now()),
    error_message = coalesce(jobs.error_message, 'superseded_by_active_job_constraint')
from ranked_active_jobs as ranked
where jobs.id = ranked.id
  and ranked.active_rank > 1;

create unique index if not exists export_jobs_one_active_job_idx
on public.export_jobs(order_id, job_type)
where status in ('pending', 'processing');

-- Atomically validates the lifecycle request and creates or reuses its queue
-- work. The order row lock serializes concurrent callers; the partial unique
-- index is the final invariant if another writer bypasses this command.
create or replace function public.request_order_job(
  p_order_id uuid,
  p_job_type text,
  p_actor text default 'system',
  p_requested_by uuid default null,
  p_target_max_dim_mm numeric default null,
  p_target_tolerance_mm numeric default 0.1,
  p_transform_asset_id uuid default null,
  p_source text default 'api',
  p_event_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_transition jsonb;
  v_ready_transition jsonb;
  v_active public.export_jobs;
  v_completed public.export_jobs;
  v_job public.export_jobs;
  v_transform_asset_id uuid := p_transform_asset_id;
  v_target numeric := case when p_target_max_dim_mm is null then null else greatest(p_target_max_dim_mm, 0) end;
  v_tolerance numeric := greatest(coalesce(p_target_tolerance_mm, 0.1), 0.1);
  v_is_same_target boolean;
begin
  if p_job_type not in ('export', 'slice') then
    return jsonb_build_object('ok', false, 'error', 'invalid_job_type');
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if not exists (
    select 1 from public.assets
    where order_id = p_order_id and kind = 'repaired_stl'
  ) then
    return jsonb_build_object('ok', false, 'error', 'missing_artifact', 'previous_status', v_order.status);
  end if;

  v_transition := public.transition_order_lifecycle(
    p_order_id,
    case when p_job_type = 'slice' then 'slice_requested' else 'export_requested' end,
    null,
    case when p_job_type = 'slice' then 'slicing' else 'exporting' end,
    p_actor,
    'order-job:' || p_job_type || ':' || p_order_id::text,
    case when p_job_type = 'slice' then 'slicing' else 'export_requested' end,
    p_event_message,
    jsonb_build_object('job_type', p_job_type, 'source', coalesce(p_source, 'api')),
    jsonb_build_object('meta_json', jsonb_build_object('cancel_requested', false))
  );

  if not coalesce((v_transition->>'ok')::boolean, false) then
    return v_transition;
  end if;

  if p_job_type = 'export' then
    select * into v_completed
    from public.export_jobs
    where order_id = p_order_id
      and job_type = 'export'
      and status = 'succeeded'
      and asset_id is not null
      and (
        (target_max_dim_mm is null and v_target is null)
        or (target_max_dim_mm is not null and v_target is not null and abs(target_max_dim_mm - v_target) <= v_tolerance)
      )
    order by completed_at desc nulls last, created_at desc
    limit 1;

    if found then
      update public.export_jobs
      set status = 'cancelled', completed_at = now(), error_message = 'superseded_by_completed_export'
      where order_id = p_order_id
        and job_type = 'export'
        and status in ('pending', 'processing');

      v_ready_transition := public.transition_order_lifecycle(
        p_order_id,
        'stl_ready',
        null,
        'stl_ready',
        p_actor,
        'order-job:export-ready:' || v_completed.id::text,
        'stl_ready',
        'Reusing completed print-ready STL export',
        jsonb_build_object('job_id', v_completed.id, 'asset_id', v_completed.asset_id),
        '{}'::jsonb
      );
      if not coalesce((v_ready_transition->>'ok')::boolean, false) then
        return v_ready_transition;
      end if;
      return jsonb_build_object(
        'ok', true,
        'job_id', v_completed.id,
        'job_status', v_completed.status,
        'asset_id', v_completed.asset_id,
        'reused', true,
        'completed', true,
        'lifecycle', v_ready_transition
      );
    end if;
  end if;

  select * into v_active
  from public.export_jobs
  where order_id = p_order_id
    and job_type = p_job_type
    and status in ('pending', 'processing')
  order by case when status = 'processing' then 0 else 1 end, created_at asc
  limit 1
  for update;

  if found then
    v_is_same_target := p_job_type = 'slice'
      or ((v_active.target_max_dim_mm is null and v_target is null)
          or (v_active.target_max_dim_mm is not null and v_target is not null
              and abs(v_active.target_max_dim_mm - v_target) <= v_tolerance));
    if v_is_same_target then
      return jsonb_build_object(
        'ok', true,
        'job_id', v_active.id,
        'job_status', v_active.status,
        'reused', true,
        'completed', false,
        'lifecycle', v_transition
      );
    end if;

    update public.export_jobs
    set status = 'cancelled', completed_at = now(), error_message = 'superseded_by_new_request'
    where id = v_active.id;
  end if;

  if p_job_type = 'export' and v_target is not null and v_transform_asset_id is null then
    insert into public.assets(order_id, kind, url, meta_json)
    values (p_order_id, 'transform', '', jsonb_build_object('target_max_dim_mm', v_target))
    returning id into v_transform_asset_id;
  end if;

  insert into public.export_jobs(
    order_id,
    status,
    job_type,
    target_max_dim_mm,
    target_tolerance_mm,
    transform_asset_id,
    requested_by,
    meta_json
  ) values (
    p_order_id,
    'pending',
    p_job_type,
    v_target,
    v_tolerance,
    v_transform_asset_id,
    p_requested_by,
    jsonb_build_object('source', coalesce(p_source, 'api'), 'requested_at', now())
  )
  returning * into v_job;

  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'job_status', v_job.status,
    'reused', false,
    'completed', false,
    'lifecycle', v_transition
  );
end;
$$;

comment on function public.request_order_job(uuid,text,text,uuid,numeric,numeric,uuid,text,text)
is 'Server-only atomic lifecycle and export_jobs request command.';

revoke all on function public.request_order_job(uuid,text,text,uuid,numeric,numeric,uuid,text,text) from public, anon, authenticated;
grant execute on function public.request_order_job(uuid,text,text,uuid,numeric,numeric,uuid,text,text) to service_role;

-- generation_tasks owns provider work; the worker performs the lifecycle transition
-- after this atomic task claim instead of this queue RPC owning order status.
-- The 20251002 version has the same argument signature but returns jsonb. PostgreSQL
-- cannot change a function return type with CREATE OR REPLACE, so remove that exact
-- legacy signature before installing the richer worker response.
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
  select * into selected_task
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
  set worker_id = p_worker_id, locked_at = now()
  where id = selected_task.order_id
  returning * into updated_order;

  order_data := updated_order;
  task_data := updated_task;
  return next;
end;
$$;

comment on function public.claim_i23d_task(uuid)
is 'Server-only atomic claim for the next queued i23d generation task.';

revoke all on function public.claim_i23d_task(uuid) from public, anon, authenticated;
grant execute on function public.claim_i23d_task(uuid) to service_role;

-- Dispatch is lifecycle work, but claiming it must not project a different
-- lifecycle status. Lease one dispatching order atomically so only the worker
-- that owns the lease can perform dispatching -> printing.
create function public.claim_dispatching_order(p_worker_id uuid)
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
    select id
    from public.orders
    where status = 'dispatching'
      and (
        worker_id is null
        or locked_at is null
        or locked_at < now() - interval '5 minutes'
      )
    order by created_at asc
    for update skip locked
    limit 1
  )
    and o.status = 'dispatching'
  returning * into claimed;

  return claimed;
end;
$$;

comment on function public.claim_dispatching_order(uuid)
is 'Server-only atomic lease for dispatching orders; preserves lifecycle status.';

revoke all on function public.claim_dispatching_order(uuid) from public, anon, authenticated;
grant execute on function public.claim_dispatching_order(uuid) to service_role;
