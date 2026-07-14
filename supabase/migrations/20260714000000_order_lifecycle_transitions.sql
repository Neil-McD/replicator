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

  if p_transition = 'quote_ready' then
    v_quote := v_patch->'quote_json';
    if jsonb_typeof(v_quote) <> 'object'
       or not (v_quote ? 'minutes')
       or not (v_quote ? 'grams')
       or not ((v_quote ? 'price_cents') or (v_quote ? 'total_cents')) then
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
      payment_status = case when p_transition = 'payment_completed' then 'paid'
                            when v_patch ? 'payment_status' then v_patch->>'payment_status'
                            else payment_status end,
      quote_json = case when v_patch ? 'quote_json' then v_patch->'quote_json' else quote_json end,
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

-- generation_tasks owns provider work; the worker performs the lifecycle transition
-- after this atomic task claim instead of this queue RPC owning order status.
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
