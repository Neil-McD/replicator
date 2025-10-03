-- Ensure child rows are removed when an order is deleted
-- Idempotent-ish: drop and recreate FKs with ON DELETE CASCADE where applicable

do $$ begin
  -- assets(order_id) → orders(id)
  begin
    alter table if exists public.assets
      drop constraint if exists assets_order_id_fkey;
  exception when undefined_table then null; end;
  begin
    alter table if exists public.assets
      add constraint assets_order_id_fkey
        foreign key (order_id) references public.orders(id) on delete cascade;
  exception when undefined_table then null; end;

  -- images(order_id) → orders(id)
  begin
    alter table if exists public.images
      drop constraint if exists images_order_id_fkey;
  exception when undefined_table then null; end;
  begin
    alter table if exists public.images
      add constraint images_order_id_fkey
        foreign key (order_id) references public.orders(id) on delete cascade;
  exception when undefined_table then null; end;

  -- chat_messages(order_id) → orders(id)
  begin
    alter table if exists public.chat_messages
      drop constraint if exists chat_messages_order_id_fkey;
  exception when undefined_table then null; end;
  begin
    alter table if exists public.chat_messages
      add constraint chat_messages_order_id_fkey
        foreign key (order_id) references public.orders(id) on delete cascade;
  exception when undefined_table then null; end;

  -- generation_tasks(order_id) → orders(id)
  begin
    alter table if exists public.generation_tasks
      drop constraint if exists generation_tasks_order_id_fkey;
  exception when undefined_table then null; end;
  begin
    alter table if exists public.generation_tasks
      add constraint generation_tasks_order_id_fkey
        foreign key (order_id) references public.orders(id) on delete cascade;
  exception when undefined_table then null; end;

  -- payments(order_id) → orders(id)
  begin
    alter table if exists public.payments
      drop constraint if exists payments_order_id_fkey;
  exception when undefined_table then null; end;
  begin
    alter table if exists public.payments
      add constraint payments_order_id_fkey
        foreign key (order_id) references public.orders(id) on delete cascade;
  exception when undefined_table then null; end;
end $$;

