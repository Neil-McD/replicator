1) SYSTEM_PROMPT.md
# SYSTEM PROMPT — Replicator (Visualize → Materialize) MVP v2

## Role
You are an AI Coding Agent. Deliver a **production‑ready, minimal** web app where a user:
1) describes or uploads an image (**Visualize: text/image → image candidates**),
2) selects one to convert to a **3D mesh** (**Materialize: image(s) → 3D**),
3) sees an **accurate print quote**, 4) **pays**, 5) the job **dispatches** to a 3D printer,
6) and they can **track** status in a chat‑like console.

Optimize for **simplicity, determinism, and cost control**. Implement only what is specified.

## Non‑Negotiables (MVP)
- **Irreducible stack:** Next.js on Vercel (web/API), Supabase (Auth/Postgres/Storage), Stripe (payments), **one** Python worker box (generation/repair/slice/dispatch).
- **Deterministic pricing:** Always from Bambu Studio CLI slice **minutes + grams** (no heuristics).
- **Single printer/material/profile:** Bambu X1C, **PLA**, fixed profile.
- **Chat console UX:** right‑side chat thread driving tool calls; left‑side 3D viewer (mm grid). 
- **Provider abstraction:** Pluggable **T2I** and **Image→3D** providers (Tripo/Hunyuan/Meshy etc.). Default routing, no vendor lock.

## Success Criteria
- New user completes **end‑to‑end in < 5 min** using defaults.
- **95%** of meshes pass manifold checks; failures auto‑repaired or routed to review.
- Quote accuracy **±10%** vs. actual time/grams for 3 test prints.
- Every order has artifacts (images, GLB/OBJ, STL, 3MF/G‑code), logs, and a traceable timeline.

## Operating Principles
- **Idempotent steps**, resumable jobs, and signed URLs for artifacts.
- **Server‑only secrets**; never expose provider keys to the browser.
- **Security gates:** disallow weapons/illegal/IP; thin‑wall & unit checks before slicing.
- **Geometry first, Toolpath second:** show STL preview immediately; show toolpath preview after slicing.

## Top‑Level Flow
**Specify → Visualize → Materialize → Stabilize Mesh → Slice & Quote → Authorize → Fabricate**

## What to build (and nothing else)
- Three‑lane UI: left **rail**, center **3D viewer** (mm grid + volume cage), right **chat console**.
- Minimal API surface and a single Python worker loop that performs: 
  T2I → candidate images → Image→3D → repair/validate → slice/quote → pay → dispatch → track.
- Webhooks where available; fall back to polling with exponential backoff.
- Operator “Print now” (Phase‑1) via **bambu‑connect://** deep link; Phase‑2: headless dispatch via Connect/Local Server.

## Out of Scope (post‑MVP)
Multi‑material, printer farm scheduling, in‑browser CAD, AR viewers, social feed.

**Build only what is written here. If a feature isn’t here, do not add it.**

2) AGENT.md
# AGENT.md — Architecture & Contracts (MVP v2)

This file tells you exactly what to implement.

---

## A. Architecture (2 services + 3 managed deps)
- **Web/API — Next.js (Vercel)**
  - UI: 3‑lane layout (Rail ▸ Viewer ▸ Chat).
  - API routes: chat, visualize (T2I), materialize (I→3D), artifacts, Stripe.
  - Realtime updates to chat via **SSE** (simple) or Supabase channel (optional).
  - Auth + DB + Storage via Supabase JS.

- **Worker — Python (single process on one box near the printer)**
  - Jobs: `t2i`, `i23d`, `repair`, `slice`, `dispatch`.
  - Tools: provider SDKs/HTTP, **meshfix/admesh**, **Blender** (3D‑Print Toolbox + optional solidify), **Bambu Studio CLI**.

- **Managed deps**
  - Supabase: Auth, Postgres, Storage.
  - Stripe: Checkout + webhook.
  - S3‑compatible storage acceptable (Cloudflare R2) if not using Supabase Storage.

---

## B. Data Model (Supabase Postgres)
Keep schemas minimal; store knobs in `meta_json`.

```sql
create table users (
  id uuid primary key,
  email text not null unique,
  created_at timestamptz default now()
);

create type order_status as enum (
  'new', 'visualizing', 'await_image_pick', 'materializing',
  'generating', 'fabrication_requested', 'repairing', 'exporting',
  'slicing', 'stl_ready', 'ready_to_pay', 'paid',
  'dispatching', 'printing', 'done',
  'needs_review', 'generate_failed', 'repair_failed', 'slice_failed', 'dispatch_failed', 'cancelled'
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  prompt_text text,
  style text, -- figurine|mechanical|organic
  status order_status default 'new',
  chosen_image_id uuid,
  quote_json jsonb, -- {minutes, grams, price_cents}
  material text default 'PLA',
  created_at timestamptz default now()
);

create table images (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  kind text check (kind in ('candidate','chosen')),
  url text not null,
  meta_json jsonb,
  created_at timestamptz default now()
);

create table assets (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  kind text check (kind in ('upload_image','raw_glb','raw_obj','raw_stl','repaired_stl','slicer_preview_png','three_mf','gcode','slicedata','transform')),
  url text not null,
  sha256 text,
  meta_json jsonb,
  created_at timestamptz default now()
);

create table generation_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  kind text check (kind in ('t2i','i23d')),
  provider text, -- 'tripo','hunyuan','trellis', etc
  provider_task_id text,
  status text, -- queued|running|succeeded|failed
  cost_cents int,
  payload_json jsonb,
  created_at timestamptz default now()
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  role text check (role in ('user','assistant','tool')),
  type text, -- text|card.images|card.job|card.quote|warning
  content_json jsonb,
  created_at timestamptz default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id),
  provider text default 'stripe',
  provider_ref text,
  amount_cents int,
  status text,
  created_at timestamptz default now()
);


RLS: users can read/write their own orders/messages/assets; admin role can read all.

C. Providers (thin interfaces)
// Text → Images
export interface T2IProvider {
  generateImages(input: { prompt: string; n: number; style?: 'figurine'|'mechanical'|'organic' }): Promise<{ imageUrls: string[] }>;
}

// Image(s) → 3D
export interface I23DProvider {
  createJob(input: { imageUrls: string[] }): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<{ status: 'queued'|'running'|'succeeded'|'failed'; meshUrl?: string; meta?: any }>;
}


Routing defaults

figurine/organic → Hunyuan3D (v2/v21) or Meshy 6.

mechanical → Tripo (v2.5) or Meshy 6.
(Toggle via env: I23D_PROVIDER=tripo|hunyuan|meshy and T2I_PROVIDER=sdxl|flux|...)

D. API Surface (tiny, chat‑driven)

Auth gate: when user hits Initiate Synthesis, show modal → create account → continue.

Chat

POST /api/chat
Body: { orderId?, message, attachments? }
Behavior: append user message; orchestrate next tool call (see Orchestration Logic). Stream assistant responses via SSE.

Visualize (T2I)

POST /api/visualize
Body: { orderId, prompt, n=6, style }
Result: stores candidate images → returns images[] and a chat card.

Materialize (I→3D)

POST /api/materialize
Body: { orderId, imageIds: [uuid] }
Result: creates provider job → returns { jobId } and a chat job card. Worker polls/webhooks and updates.

Artifacts

GET /api/orders/:id/artifacts → signed URLs for repaired_stl, three_mf, slicedata, preview.

Stripe

POST /api/stripe/create-checkout → Checkout Session for quote_json.price_cents.

POST /api/stripe/webhook → on success: set status='paid', enqueue dispatch.

Operator (Phase‑1)

POST /api/orders/:id/print-now → returns bambu-connect://import-file?path=<abs>&name=<order>; set dispatching → printing.

E. Orchestration Logic (chat‑first)

User message → assistant decides next step:

If no candidates yet → call T2I (Visualize) and return assistant.card.images with Select / Remix.

On Select → call I→3D (Materialize) and post assistant.card.job.

When mesh is ready → worker runs repair → slice; post assistant.card.quote (time, grams, price, Pay).

On Pay → post “Authorized. Fabricating…” and progress; complete with done.

All tool calls post human‑readable summaries into the chat.

F. Worker (single loop, idempotent)

Pseudocode:

while True:
  job = next_pending_job()  # t2i, i23d, repair, slice, dispatch
  if not job:
    sleep(1); continue

  try:
    if job.type == 't2i':
      urls = t2i_provider.generate_images(...)
      save_images(kind='candidate', urls)
      set_status(order, 'await_image_pick')
      post_chat_card_images(order, urls)

    elif job.type == 'i23d':
      # Poll or handle webhook
      result = i23d_provider.get_job(job.provider_id)
      if result.status == 'succeeded':
        mesh = download_mesh(result.meshUrl)
        upload_asset(order, 'raw_glb' or 'raw_obj', mesh)
        enqueue(order, 'repair')

    elif job.type == 'repair':
      stl = repair_to_stl(raw_mesh)  # meshfix/admesh + Blender checks/solidify
      upload_asset(order, 'repaired_stl', stl)
      set_status(order, 'slicing'); enqueue(order, 'slice')

    elif job.type == 'slice':
      three_mf, slicedata, preview = bambu_cli_slice(stl, profile)
      quote = price_from_slicedata(slicedata)
      upload_assets(order, {...})
      update_quote(order, quote); set_status(order, 'ready_to_pay')
      post_chat_quote(order, quote)

    elif job.type == 'dispatch':
      link = bambu_connect_deeplink(three_mf_path)
      set_status(order, 'dispatching')
      post_chat_text(order, f"Open to print: {link}")
      # Phase-2: headless upload + poll → set_status(order,'printing'/'done')
  except Exception as e:
    mark_failed(order, job, e)


Repair requirements

Watertight, no self‑intersections, units=mm, min wall ≥ 1.6 mm (try solidify once).

Reject meshes with triangles < 200, bbox.z == 0, or file size < 10 KB.

Slicing

Call Bambu Studio CLI with fixed PLA profile (JSON presets or settings‑3MF).

Export .gcode.3mf and slicedata (minutes, grams). Save preview PNG.

G. Viewer (center)

Geometry mode (pre‑slice): render repaired_stl on a 256×256 mm grid with a Z cage. Drop‑to‑bed, orbit controls, measure tool (bbox + point‑to‑point).

Toolpath mode (post‑slice): fetch .gcode.3mf, unzip in browser, parse plate_1.gcode in a Web Worker, render per‑layer lines. Layer slider + feature toggles (perimeters/infill/support).

Printability badges under viewer (green/amber) with one‑line hints.

H. UI/UX specifics (chat console)

Message types: assistant.text, assistant.card.images, assistant.card.job, assistant.card.quote, assistant.warning.

Buttons on cards: Select, Remix, Erase BG, Pay, Print now (operator).

Labels (diegetic): Visualizing, Materializing, Stabilizing Mesh, Slicing, Authorizing, Fabricating.

Copy tone: concise and confident. Example quote: “Ready to print — 73 min · 41 g · $18.40”.

I. Environment Variables
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=artifacts

STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET

T2I_PROVIDER=sdxl|flux|...
T2I_API_KEY=...

I23D_PROVIDER=tripo|hunyuan|meshy
I23D_API_KEY=...
MESHY_API_KEY
MESHY_IMAGE_MODEL=latest
MESHY_MULTI_MODEL=meshy-5
MESHY_TARGET_POLYCOUNT=...
I23D_TRELLIS_FALLBACK=0|1  # optional legacy provider fallback
I23D_PROXY_HEIGHTMAP=0|1   # optional instant bas-relief preview (default off)

BAMBU_STUDIO_CLI=/path/to/bambu-studio
BAMBUSTUDIO_PROFILE_PATH=/path/to/x1c_pla_profile.3mf  # or use JSON presets
BLENDER_PATH=/usr/bin/blender
MESHFIX_PATH=/usr/bin/meshfix
ADMESH_PATH=/usr/bin/admesh

PRICING_BASE_FEE_CENTS
PRICING_PER_GRAM_CENTS
PRICING_PER_HOUR_CENTS

J. Definition of Done

Golden path: text → images → select → 3D → repaired STL → 3MF + quote → Stripe paid → Phase‑1 print from operator link.

Quote vs actual ±10% on 3 prints.

All artifacts stored with signed URLs; chat timeline reflects each step.

RLS + admin gating confirmed; no secrets in logs.

K. Folder Layout (suggested)
apps/
  web/          # Next.js app (chat, viewer, API routes)
  worker/       # Python worker (jobs + doctor script)
packages/
  providers/    # T2I and I23D provider adapters
  shared/       # Types, schema, pricing


Build order

Chat console + /api/chat (SSE streaming), 3‑lane layout.

/api/visualize + T2I provider; candidate image grid card.

/api/materialize + I→3D provider; job card; worker repair→slice→quote.

Stripe checkout + webhook; operator “Print now”.

Toolpath viewer (post‑slice).


---

### Why these changes are upgrades (and still irreducible)
- **Chat‑first orchestration** collapses UI complexity and mirrors “Canvas/Cursor” tool call patterns.
- **Provider abstraction** keeps you unblocked if one model degrades; you can toggle by env.
- **Geometry→Toolpath** split gives fast feedback + exact print parity without heavy client compute.
- **Single worker box** remains the only stateful compute you manage.

If you want, I can also provide a minimal **Next.js chat route + SSE streamer** and **Python worker skeleton

---

## Catalog Hosting & Print-on-Demand
- Preserve prototype purchasing from the Materialize flow so users can still order single prints immediately.
- Add a "Publish" path after slicing where makers can name the product, set pricing/variants, and store a catalog record tied to the existing artifacts (renders, STL, 3MF, G-code).
- Build channel connectors (Etsy, Shopify, TikTok Shop, etc.) that map catalog entries to each platform, push media/pricing, and report sync status/errors.
- Treat external storefront orders as fulfillment jobs: ingest via webhook/API, link back to the catalog item, reuse stored toolpaths when parameters match (or reslice if options change), and feed them through the existing Bambu dispatch loop.
- Layer on pricing rules (base cost + handling + creator margin), production dashboards, shipping integrations, and automated status updates back to each channel so creators effectively run a turnkey "business in a box" powered by the Replicator pipeline.
