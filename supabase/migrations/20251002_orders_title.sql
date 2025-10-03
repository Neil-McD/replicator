-- Add a dedicated display title for orders and ensure updated_at touches on changes.
begin;

alter table public.orders
  add column if not exists title text;

-- Backfill title from prompt_text for existing rows where missing
update public.orders
  set title = coalesce(title, prompt_text)
where title is null;

commit;

