# Replicator MVP (Web + Worker)

Minimal, production‑oriented pipeline to: Visualize (T2I), Materialize (Image→3D), Repair, Slice + Quote, Pay, and Dispatch to a Bambu X1C. See AGENTS.md for the full architecture and contracts.

## Quick Start

Prereqs: Node 18+, Python 3.10+, Supabase project, Stripe secret, Bambu Studio CLI box for the worker.

- Web (Next.js)
  - `cd web && npm install`
  - Create `web/.env.local` (see AGENT.md variables)
  - `npm run dev` → http://localhost:3000

- Worker (Python)
  - `cd worker && python3 -m venv .venv && source .venv/bin/activate`
  - `pip install -r requirements.txt`
  - Create `worker/.env` (copy from `worker/.env.example` and fill paths/keys)
  - `python main.py`

Key environment variables are listed in AGENT.md (Section I). Do not commit secrets.

## Project layout

- `app` — Root API/app entrypoints.
- `web` — Next.js app, UI components, libraries, and browser workers.
- `worker` — Python worker, support scripts, and worker tests.
- `scripts` — Helper shell scripts for local development and operations.
- `supabase` — Database schema and migrations.

## Deploy/Operate

- Supabase schema/migrations are under `supabase/`. Apply via Supabase CLI or SQL.
- See `DEPLOYMENT.md` for queue/slicing rollout details and operational checks.

## Push to GitHub

From this folder (first time):

```
git init
git add -A
git commit -m "chore: initial commit"
git branch -M main
```

Create an empty GitHub repo (UI or GitHub CLI) and add the remote:

SSH

```
git remote add origin git@github.com:<you>/replicator.git
git push -u origin main
```

HTTPS

```
git remote add origin https://github.com/<you>/replicator.git
git push -u origin main
```

## Work on Another Device (Mac)

```
git clone git@github.com:<you>/replicator.git
cd replicator
# Web
cd web && npm install && npm run dev
# Worker
cd ../worker && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python main.py
```

Create `web/.env.local` and `worker/.env` on the Mac (never commit them). Refer to AGENT.md for required keys and paths.
