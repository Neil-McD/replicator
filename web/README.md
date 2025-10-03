# Replicator Web (MVP)

Stack: Next.js 14 (App Router) + TailwindCSS

Scripts
- `npm install`
- `npm run dev` (http://localhost:3000)

Design tokens are in `tailwind.config.ts` and `app/globals.css`.

Structure
- `app/page.tsx`: Fabricator layout (Left Rail, Stage, Right Console)
- `components/`: UI building blocks (Progress, Quote, Style chips)

Uploading images in chat
- Click the paperclip next to the prompt to upload image(s).
- The server stores them in Supabase Storage as `upload_image` assets and uses the Edit provider to extract the object (2 variants max).
- A Candidates card with the extracted concepts appears; select one to materialize.

Next Steps
- Wire Supabase auth/storage and API routes.
- Replace Stage placeholder with `<model-viewer>` or three.js GLTF viewer.
- Implement order creation and live status updates.

Auth
- Sign in/out via Supabase (magic link or password) in the right sidebar.
- Orders page uses client-side RLS with your logged-in user.

Env (to be added)
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (API routes only)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `PRICING_BASE_FEE_CENTS`, `PRICING_PER_GRAM_CENTS`, `PRICING_PER_HOUR_CENTS`
