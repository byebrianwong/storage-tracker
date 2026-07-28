# Decisions

Every call the handoff left open, plus the places the spec had to be corrected.
Section numbers refer to `storage-app-handoff.md`.

---

## Open questions from section 13

### 1. Containers sync to Notion as their own database (§13.1)

**Kept as specified: a relation to a Storage locations database.** Filtering items
by location inside Notion is the main reason to mirror at all, and a text field
loses that. The second sync surface is contained: locations are app-owned and
one-directional, so there is no inbound merge logic for them, only overwrite on
reconcile. If M5 had run long the fallback was a text property; it did not.

### 2. `last_write_source` column vs session variable (§13.2)

**Session variable, `set local app.sync_context = 'notion'`.**

The column approach in §7.5 step 6 is self-defeating. It requires a second
`UPDATE` to reset the flag to `'app'`, and that reset statement fires
`items_enqueue_push` with `last_write_source = 'app'` — enqueueing exactly the
spurious push the mechanism exists to suppress. You would then need to suppress
the reset, which is circular. `set local` is transaction scoped, needs no reset,
and cannot leak onto a pooled connection.

`items.last_write_source` is still written by the pull worker as a human readable
audit trail, but **the trigger does not read it**. There is one load-bearing
suppression path, per the spec's "do not do both."

### 3. One plan asset (§13.3)

**One floor for v1.** The schema already supports many (`floors.sort_order`,
`level`), and the plan view queries by floor, so adding the storage locker later
is a UI change with no migration. Not surfaced now.

### 4. Capacity hints (§13.4)

**Column added (`containers.capacity_hint`), not surfaced.** Cheap now,
expensive later. The elevation renderer shows the item count only, per §6.

---

## Notion API version (§7.2)

**Pinned to `2025-09-03` in `lib/notion/client.ts`.**

§7.2 says to check for something newer and use the latest stable. There is one:
**`2026-03-11`**. We are not on it, deliberately.

The 2026-03-11 changes are `after` → `position` on block insertion,
`transcription` → `meeting_notes` blocks, and **`archived` → `in_trash` across
pages, databases, blocks and data sources**. We touch none of the block APIs, but
`archived` is exactly the field the archive path in §7.4 step 5 and the
archived-in-Notion detection in §7.5 depend on.

`@notionhq/client@5.23.2` is the current latest and still defaults to and types
against `2025-09-03`. Pinning the header ahead of the SDK's types would leave the
archive path type-checking against a field the API no longer returns, and failing
silently — soft deletes would stop propagating with no error.

Upgrading later is a three line change, kept deliberately small:
flip `NOTION_VERSION` and `TRASH_FIELD` in `lib/notion/client.ts`. Every call site
goes through `trashPayload()` and `isPageTrashed()`, and `isPageTrashed` already
reads both field names.

---

## Corrections to the handoff

Two things in the spec do not run as written. Both are fixed in the migrations.

### The `search_tsv` generated column is invalid (§4.2)

```sql
coalesce(array_to_string(tags,' '),'')   -- inside a generated column
```

`array_to_string` is **STABLE, not IMMUTABLE** — in the general case it depends on
the element type's output function. Postgres rejects a generated column whose
expression is not immutable, with `generation expression is not immutable`. This
fails on any Postgres, not just our test harness (verified on 18.3).

Fixed with an `immutable_array_to_string(text[], text)` wrapper. Marking it
immutable is sound here because the element type is fixed as `text`, whose output
function genuinely is immutable.

### `enqueue_item_push` raises on DELETE (§4.4)

```sql
coalesce(new.household_id, old.household_id)
case when tg_op = 'DELETE' or new.deleted_at is not null then ...
```

`NEW` is unassigned in a DELETE trigger. Referencing `NEW.household_id` raises
`record "new" is not assigned yet`, so **any hard delete of an item errors out**.
Fixed by branching on `TG_OP` before touching either side.

Two related hardenings while in there:

- The trigger skips updates that changed nothing Notion mirrors (e.g. only
  `photo_path`), so editing a non-synced field does not churn the queue.
- `enqueue_container_push` resolves `household_id` by walking up from the shelf.
  During a cascading zone delete the parent may already be gone; in that case the
  job is skipped and the nightly full reconcile reports the orphaned Notion page,
  rather than the delete failing.

### Direction C's category colours never applied (design mock)

`storage-app-design-directions.html` sets the per-shape colour as an inline
custom property and then consumes it one level up:

```css
#app[data-skin="c"] { --box-fill: var(--tag-color, #4A4066); }
.box rect.body      { fill: var(--box-fill); }
```

That does not work. A custom property whose value contains `var()` is
substituted **when it is computed on the element that declares it**. `--box-fill`
is declared on the skin root, where `--tag-color` does not exist, so it resolves
to the fallback there and inherits down as a dead literal. Every bin renders the
same `#4A4066` purple, and the same applies to `--zone-fill` on the plan.

Since direction C's whole premise is that colour is the wayfinding
("camping green, second shelf"), that premise was silently not being delivered.

Fixed by consuming the property on the shape itself, where `--tag-color` is
genuinely inherited:

```css
[data-skin="c"] .zone polygon    { fill: var(--tag-color, #4A4066); }
[data-skin="c"] .box rect.body   { fill: var(--tag-color, #4A4066); }
```

Verified in the browser: seven containers now render five distinct category
colours. Directions A and B still go through `--box-fill`, which is correct for
them because their fills are not per-shape.

### Plan labels need their own ink

Zone labels sit on top of the uploaded plan image, not on the page. The plan is a
scan or export of a floor plan, so it is a light document in every skin. Drawing
labels in `var(--ink)` made them invisible in direction C, whose ink is near
white. They now use `--plan-label-ink` / `--plan-label-bg`, which stay
light-document-safe in all three directions. Labels that would overflow the right
edge flip to the left of their shape and keep their leader line.

---

## Build decisions

### Visual direction (§9.5): all three, defaulting to A

§9.5 says to pick one and drive everything through custom properties "so
switching later costs nothing." Rather than pick one and discard the work, all
three directions ship as token sets in `app/globals.css`, selected by one
`data-skin` attribute on `<html>` read from a cookie server side (no flash).
**Direction A, Plan and elevation, is the default.**

This makes the spec's own claim literally true instead of aspirational, and it
costs one attribute plus two extra token blocks. The renderers read only
`var(--*)`; no component contains a colour.

### Test database: PGlite, not Docker

There is no Docker or Postgres on this machine, so `supabase start` is not
available. Tests run against **PGlite** (Postgres 18.3 compiled to WASM,
in-process) with `pgcrypto`, `pg_trgm` and `btree_gist` loaded, applying the real
migrations from `supabase/migrations/`.

This is better than the alternative regardless: the sync conformance suite in §11
and the RLS checks in M1 run against real Postgres semantics — real policies, real
triggers, real constraints — instead of a mocked database. `test/pg.ts` stubs the
two pieces of Supabase's `auth` schema the migrations reference (`auth.users` and
`auth.uid()`).

### Container overlap is a database constraint (§6)

§6 says to use "a Postgres exclusion constraint if you can express it cleanly. If
not, validate in `lib/geometry/validateShelf.ts`." It expresses cleanly:

```sql
exclude using gist (shelf_id with =, int4range(col_start, col_start + col_span) with &&)
```

Requires `btree_gist` for the `=` on a uuid. `validateShelf.ts` exists too, but as
the editor's friendly message, not as the guarantee.

### A dedicated schema, because this Supabase project is shared

The project (`ssmiunjctsigikbwdfpc`) already hosts several other apps, so `public`
is occupied. Putting this app there would have been unsafe in a way that is easy
to miss:

- `items`, `containers`, `zones`, `homes`, `floors` are all plausible names for
  another app's tables. A clash on `create table` at least fails loudly.
- `create or replace function touch_updated_at() returns trigger` does **not**
  fail. On a matching signature it silently replaces the existing function body.
  `touch_updated_at` is close to the most common trigger function name there is,
  so this migration could have quietly broken another app's `updated_at`
  handling with no error anywhere.

So everything lives in `storage_tracker`, and the storage bucket is
`storage-tracker-floorplans` because bucket ids are global to the project. That
removes the need to inventory what is already in `public` at all: collisions
become impossible rather than merely unlikely.

**The migration ledger is shared too**, and that is the one thing a schema cannot
partition. `supabase_migrations.schema_migrations` is a single table in the
project database, so every repo pushing to this project writes to the same list.
`hearsay` was there first with versions `0001`–`0005`.

`db push` aborts whenever the remote holds versions the local directory lacks —
it assumes a stale checkout. `--include-all` does not bypass it, and both
remedies the CLI suggests are actively harmful here: `migration repair --status
reverted` marks hearsay's migrations un-applied so its repo may re-run them, and
`db pull` copies hearsay's entire schema into this repo, which is public.

The fix is to carry an **empty placeholder file per foreign version**, so the
local set is a superset of the remote one and the check passes. Push then applies
only this app's migrations — verified by dry run before anything was written.
The placeholders must stay empty, and `test/schema.test.ts` asserts it, because
filling one in would either publish another app's schema or re-run SQL the
project already applied. Both fail silently.

Consequences that are easy to trip over, all handled:

| Thing | Why it breaks | Where it is handled |
| --- | --- | --- |
| PostgREST 403s everything | Supabase's default grants only cover `public` | explicit grants + `alter default privileges` in the RLS migration |
| PostgREST still 403s | a custom schema is not exposed by default | **manual**: Dashboard → API → Exposed schemas |
| Every query 404s | clients default to the `public` schema | `db: { schema: DB_SCHEMA }` on all three clients |
| Realtime silently never fires | subscription named `schema: 'public'` | `DB_SCHEMA` in `ZoneView` |
| Realtime still silently never fires | tables must join the `supabase_realtime` publication | `20260727000700_realtime.sql` |

The last two are the dangerous ones — no error is raised in either case, the
subscription just sits there. Both are covered in code rather than left as
dashboard steps.

**Shared `auth.users`** is the one thing a schema cannot partition. Any user of
any app in this project can sign in here and `bootstrap_household` will give them
an empty household. RLS isolates households from each other correctly, so this is
not a data leak, but it is a shared front door. Gate `bootstrap_household` on an
allowlist if that matters.

### The webhook HMAC key lives in its own table

§7.5 says to persist the verification token to
`notion_config.webhook_verification_token`. That token is the HMAC key for every
subsequent Notion delivery, so anyone who can read it can forge webhook calls.

The obvious protection does not work:

```sql
revoke select (webhook_verification_token) on notion_config from authenticated;
```

Postgres column privileges are **additive to** table privileges, not subtractive
from them. Supabase grants table-wide `select` to `authenticated` by default, so
that revoke is silently a no-op and any signed in household member can read the
key. I wrote it that way first and only caught it because the test asserting the
column was unreadable failed.

The token now lives in a separate `notion_secrets` table with RLS enabled and
**no policy at all**. Non service-role clients get zero rows regardless of what
grants exist, which survives someone later re-running a blanket
`grant ... to authenticated`. The test grants `all on all tables` to
`authenticated` specifically to prove the isolation holds under that.

Do not add a policy to `notion_secrets`.

### RLS: security definer helpers, no denormalized `household_id` (§4.3)

§4.3 allows denormalizing `household_id` onto `zones` and `containers` if the join
is slow, but says to measure first. Not denormalized. The ownership walk lives in
`zone_is_visible()` / `container_is_visible()` style `security definer` functions
so policies stay one function call rather than an inline five table join.
Revisit with `EXPLAIN` against real data before adding the column.

### Sync latency does not depend on the cron schedule

§7.4 puts an every-minute cron on `/api/sync/drain` and §7.6 puts the
incremental reconcile on 15 minutes. **Vercel's Hobby plan caps cron jobs at once
per day, and a more frequent expression fails the deployment outright** rather
than degrading. This account is on Hobby.

Simply making the crons daily would have broken §1's "a row added in Notion
appears in the app within 2 minutes", because the webhook only *enqueues* a pull
job — the drain is what processes it, so a queued pull would have waited up to 24
hours.

So the webhook now dispatches the drain itself, fire and forget, exactly as a
Server Action mutation already did. Latency in both directions is now driven by
the events themselves, not by the schedule:

| Path | Trigger | Latency |
| --- | --- | --- |
| App → Notion | `dispatchDrain()` after the mutation | seconds |
| Notion → app | webhook verifies, enqueues, dispatches drain | seconds |
| Anything missed | daily full reconcile, then a drain | within a day |

`vercel.json` therefore declares two daily crons. This is arguably the better
architecture on any plan: §7.6 already says reconciliation is the correctness
mechanism and webhooks are the latency mechanism, and this makes the code match
that sentence instead of quietly relying on a minute-level cron for both.

On Pro, tightening the drain to `* * * * *` and adding the 15 minute incremental
reconcile back is a `vercel.json` edit and nothing else.

### Touch targets are CSS, not measurement (§5.2, §9.4)

`expandForTouch` takes pixel dimensions, and the plan's *intrinsic* size is what
the component has: a 2400px wide plan drawn at 360px on a phone turns a "44px"
expansion into about 7 real pixels, which is precisely the thin-shape problem
§5.2 exists to solve.

Measuring the rendered size needs a `ResizeObserver`. Instead the touch slop is a
transparent stroke on `.hitarea` with `vector-effect: non-scaling-stroke`, which
is specified in **screen** pixels however the plan is scaled, plus
`pointer-events: all` so an unpainted stroke is still hit-testable. Correct at
any viewport and any zoom, with no runtime dependency and nothing to measure.
`expandForTouch` is still applied against intrinsic dimensions as a second layer
for degenerate shapes.

**Not verified end to end.** The embedded browser used during the build has no
working `ResizeObserver` or `elementFromPoint`, so hit testing could not be
exercised. Worth one pass on a real phone.

### Search ranking (§8)

One `search_items(q, lim)` RPC. Score is additive: exact name 1.0, prefix 0.8,
substring 0.6, plus full text `ts_rank` when the tsquery matches, plus
`similarity() * 0.3` for typo tolerance, plus 0.25 when the zone, shelf or
container name matches — which is what makes "pantry" return the pantry's
contents. Trigram threshold is 0.25: loose enough for a transposition in a short
word, tight enough not to return the table.
