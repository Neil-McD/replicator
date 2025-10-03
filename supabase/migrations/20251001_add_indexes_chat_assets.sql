-- Speed up SSE/context polling over chat and assets
create index if not exists chat_messages_order_created_idx on chat_messages(order_id, created_at);
create index if not exists assets_order_created_idx on assets(order_id, created_at);

