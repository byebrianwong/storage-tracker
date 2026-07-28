# Where is it

Home storage inventory for a two adult household. Answers one question fast:
*where is the thing.*

Floor plan → tap a storage area → see it straight on → tap a container → see what
is inside. Search from anywhere with Cmd/Ctrl K. Two way sync with Notion.

Built from `storage-app-handoff.md`. Every decision the handoff left open, plus
two places its SQL had to be corrected, is recorded in [DECISIONS.md](DECISIONS.md).

---

## Quick start

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase; Notion is optional
pnpm dev
```

The app runs without Notion configured. Sync stays dormant until `NOTION_TOKEN`
is set, and the settings page explains what is missing rather than erroring.

## Tests

```bash
pnpm test
```

No Docker and no external services required. The database tests run against
**PGlite**, Postgres 18 compiled to WASM, applying the real migrations from
`supabase/migrations/`. That means RLS policies, triggers and constraints are
exercised for real rather than mocked. See DECISIONS.md.

The sync conformance suite (`test/sync.conformance.test.ts`) covers all ten cases
from handoff section 11 — echo suppression by both hash and timestamp, conflict
resolution, 429 backoff, archive semantics, and schema drift — running the
production workers against real Postgres with only the Notion network faked.

```bash
pnpm test test/sync.conformance.test.ts   # the ten that matter
```

---

## Setting up Supabase

1. Create a project, then run the migrations in `supabase/migrations/` in
   filename order (`supabase db push`, or paste them into the SQL editor).
2. Create a **private** Storage bucket named `floorplans`. Do not make it public;
   the app serves signed URLs with a one hour expiry.
3. Enable Realtime on the `items` and `containers` tables, so a Notion sync write
   appears without the user refreshing.
4. Copy the project URL, anon key and service role key into `.env.local`.

Auth is magic link. The first sign in bootstraps a household, home and floor
automatically. To add the second person, invite them by email in the Supabase
dashboard and add a `household_members` row for them.

## Setting up Notion

Optional. Skip it and everything except sync works.

1. Create an internal integration at
   <https://www.notion.so/profile/integrations> and copy the token into
   `NOTION_TOKEN`.
2. Grant the integration access to the parent page the databases will live under.
3. In the app, go to **Settings → Sync** and use **Create databases in Notion**.
   That creates *Storage items* and *Storage locations* with the exact property
   names the mappers expect. Creating them by hand is possible but the names must
   match `lib/notion/mappers.ts` precisely.
4. Create a webhook subscription in the Notion integration settings pointing at
   `{APP_URL}/api/notion/webhook`.
5. Notion posts a one time `verification_token` to that endpoint. It is logged at
   warn level — find it in your Vercel logs (or your dev console), paste it back
   into the Notion UI, and confirm the subscription shows active.
6. Subscribe to page created, page properties updated, page deleted/moved, and
   the data source schema updated event.

**Notion cannot reach localhost.** Use a tunnel (`ngrok`, `cloudflared`) for local
webhook testing, and expect to delete and recreate the subscription if the tunnel
URL changes — the URL is locked once verified.

### Notion API version

Pinned to `2025-09-03` in `lib/notion/client.ts`. A newer version, `2026-03-11`,
exists; we are deliberately not on it because it renames `archived` to `in_trash`
and the current SDK still types the old name. The reasoning and the three line
upgrade path are in DECISIONS.md.

---

## Architecture

```
app/
  (app)/plan                  floor plan, the home screen
  (app)/zone/[zoneId]         elevation view, container panel
  (app)/search                full search results
  (app)/setup/plan            upload plan, draw zones
  (app)/setup/zone/[zoneId]   shelf and container editor
  (app)/settings/sync         Notion connection, sync log, conflicts
  actions/                    Server Actions, zod validated
  api/notion/webhook          HMAC verified, enqueues and returns
  api/sync/drain              outbound worker, cron every minute
  api/sync/reconcile          incremental every 15m, full nightly
lib/
  db/         supabase clients: browser, server, service role
  notion/     client (pinned version), mappers, limiter, api surface
  sync/       queue, drain, pull, reconcile, hashing, webhook verification
  geometry/   normalized coordinate math, polygon hit testing
  elevation/  deterministic elevation layout
components/
  plan/       PlanCanvas, PlanEditor
  elevation/  ElevationCanvas
  items/      ContainerPanel, AddItemForm
supabase/migrations/
```

### Two ideas worth knowing

**Coordinates are normalized.** Every polygon point is stored as x and y in 0..1
relative to the plan image, and the plan SVG uses `viewBox="0 0 1 1"` with
`preserveAspectRatio="none"`. Polygons are therefore drawn in raw stored units
with no pixel conversion anywhere, which removes an entire class of coordinate
bug. The plan can be re-exported at any resolution without invalidating a single
zone. Labels are HTML rather than SVG text so the non-uniform viewBox cannot
squash them.

**The elevation is pure output of the data.** No stored coordinates, no manual
layout. `lib/elevation/layout.ts` turns shelves and containers into geometry, and
`ElevationCanvas` maps that to SVG without doing arithmetic. Same data in, same
drawing out — which is what makes it unit testable without a DOM.

### Sync in one paragraph

Supabase is canonical; Notion is a mirror plus an input surface. A Postgres
trigger enqueues a `sync_jobs` row on every item and container change. The drain
claims jobs with `for update skip locked`, pushes through a 2.5 req/s token
bucket, and short circuits on a payload hash so a repeat run is a no-op. Inbound,
the webhook verifies an HMAC and only enqueues; the pull worker fetches current
page state and drops echoes by **both** timestamp and hash, because each catches
what the other misses. Reconciliation, not webhooks, is the correctness
mechanism: incremental every 15 minutes with a 5 minute overlap, full nightly.
Echo suppression uses a transaction scoped `set local app.sync_context = 'notion'`
rather than a column — see DECISIONS.md for why the column approach is
self-defeating.

---

## Deploying

Vercel. Set every variable from `.env.example` in the project settings, including
`CRON_SECRET`, which the sync endpoints require as a bearer token. The webhook
does not use it — it authenticates with Notion's HMAC instead.

`vercel.json` declares two **daily** crons: the full reconcile at 04:00 and a
drain at 05:00. That is deliberate, not a compromise on correctness. Vercel's
Hobby plan rejects any cron that runs more than once a day at deploy time, so
sync latency is driven by events instead — a mutation dispatches a drain, and so
does the webhook. The crons are purely the safety net. See DECISIONS.md.

On Pro you can tighten the drain to `* * * * *` and add a 15 minute incremental
reconcile; nothing else has to change.
