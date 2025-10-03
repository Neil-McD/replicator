-- Additional indexes to improve polling performance
create index if not exists generation_tasks_order_created_idx on generation_tasks(order_id, created_at);
create index if not exists assets_order_kind_idx on assets(order_id, kind, created_at);

