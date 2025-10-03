-- Track first user-visible activity per order and expose an efficient filter for sidebar listing

do $$ begin
  begin
    alter table if exists public.orders
      add column if not exists first_activity_at timestamptz null;
  exception when undefined_table then null; end;

  -- Index to quickly fetch recent active orders
  begin
    create index if not exists orders_first_activity_idx on public.orders(first_activity_at desc, created_at desc);
  exception when undefined_table then null; end;

  -- Helper function to set first_activity_at once
  create or replace function public.mark_order_first_activity(p_order_id uuid)
  returns void language plpgsql as $$
  begin
    update public.orders set first_activity_at = now()
    where id = p_order_id and first_activity_at is null;
  end $$;

  -- chat_messages: first user message counts as activity
  begin
    create or replace function public.chat_messages_after_ins_first_activity()
    returns trigger language plpgsql as $$
    begin
      if (new.role = 'user') then
        perform public.mark_order_first_activity(new.order_id);
      end if;
      return null;
    end $$;
    drop trigger if exists chat_messages_after_ins_first_activity on public.chat_messages;
    create trigger chat_messages_after_ins_first_activity
      after insert on public.chat_messages
      for each row execute function public.chat_messages_after_ins_first_activity();
  exception when undefined_table then null; end;

  -- assets: any asset creation counts as activity
  begin
    create or replace function public.assets_after_ins_first_activity()
    returns trigger language plpgsql as $$
    begin
      perform public.mark_order_first_activity(new.order_id);
      return null;
    end $$;
    drop trigger if exists assets_after_ins_first_activity on public.assets;
    create trigger assets_after_ins_first_activity
      after insert on public.assets
      for each row execute function public.assets_after_ins_first_activity();
  exception when undefined_table then null; end;

  -- images: candidate/chosen images creation counts as activity
  begin
    create or replace function public.images_after_ins_first_activity()
    returns trigger language plpgsql as $$
    begin
      perform public.mark_order_first_activity(new.order_id);
      return null;
    end $$;
    drop trigger if exists images_after_ins_first_activity on public.images;
    create trigger images_after_ins_first_activity
      after insert on public.images
      for each row execute function public.images_after_ins_first_activity();
  exception when undefined_table then null; end;

  -- orders: status transitions away from 'new' count as activity
  begin
    create or replace function public.orders_before_upd_first_activity()
    returns trigger language plpgsql as $$
    begin
      if (new.first_activity_at is null) then
        if (coalesce(new.status, 'new') <> 'new' and coalesce(old.status, 'new') = 'new') then
          new.first_activity_at := now();
        end if;
      end if;
      return new;
    end $$;
    drop trigger if exists orders_before_upd_first_activity on public.orders;
    create trigger orders_before_upd_first_activity
      before update of status on public.orders
      for each row execute function public.orders_before_upd_first_activity();
  exception when undefined_table then null; end;

end $$;

