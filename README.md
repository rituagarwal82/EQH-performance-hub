# EQH Performance Hub

Build "EQH Performance Engine" — an internal operations dashboard for Energy Queens Hub, an Indian webinar-funnel coaching business. It reads Meta Ads data across all their ad accounts so the owner can see spend, leads and cost per lead per account, per campaign and per ad, by day. This is step one of a larger engine; keep the schema general enough to add registrations, webinar attendance and purchases later.

Enable Lovable Cloud.

DATABASE SCHEMA

ad_accounts
- account_id text primary key
- name text
- currency text default 'INR'
- status text
- is_active boolean default true — only these get synced
- agency_code text nullable — SD / RJ / PRM / SX / null

ad_entities
- entity_id text primary key
- level text check in ('campaign','adset','ad')
- account_id text references ad_accounts
- parent_id text nullable
- name text
- status text
- agency_code text nullable

daily_metrics
- id uuid pk
- date date not null
- account_id text not null references ad_accounts
- entity_id text nullable
- level text not null check in ('account','campaign','adset','ad')
- placement text nullable
- spend numeric(14,2) default 0
- impressions bigint default 0
- link_clicks integer default 0
- landing_page_views integer default 0
- leads integer default 0
- purchases integer default 0
- synced_at timestamptz default now()
- UNIQUE (date, account_id, entity_id, level, placement)

sync_runs
- id uuid pk, started_at, finished_at, source text, rows_written int, status text, error text

Index daily_metrics on (date), (account_id, date), (entity_id, date).

EDGE FUNCTION `sync-meta`
- Reads a secret named META_ACCESS_TOKEN. Never hardcode a token anywhere — the owner will add it in Cloud secrets himself. If the secret is missing, fail cleanly and write an explanatory row to sync_runs.
- For every ad_accounts row where is_active, call Meta Graph API v21.0 `/act_{account_id}/insights`
- fields: spend, impressions, inline_link_clicks, actions
- params: time_increment=1, level as requested, and a date range
- Parse `actions` for action_type `lead`, `landing_page_view` and `omni_purchase` into the matching columns
- Default behaviour on each run: re-pull a rolling 8-day window (today minus 8 days to today), because Meta revises attribution retroactively. Accept an optional `since`/`until` body parameter for backfills.
- Upsert into daily_metrics on the unique key — never insert duplicates
- Write one sync_runs row per invocation with rows_written and status
- Also refresh ad_entities (campaigns, ad sets, ads) for active accounts
- Schedule it to run daily via cron

FIRST SCREEN — Overview
- Month selector at top (default: current month)
- A KPI row: total spend, total leads, cost per lead, number of accounts with spend
- A bar chart of monthly total spend across 2026
- A table, one row per ad account for the selected month: account name, spend, leads, cost per lead, share of total spend. Sorted by spend descending. Accounts with zero spend collapse into a "dormant" group at the bottom rather than cluttering the table.
- A "Sync now" button that invokes sync-meta and shows the result
- A freshness indicator reading the latest sync_runs row — if the last successful sync is more than 36 hours old, show a clear warning
- Empty state: "No data yet — add META_ACCESS_TOKEN in Cloud secrets, then run the sync."

Format ALL currency in INR with Indian digit grouping (₹1,23,456 not ₹123,456). Use tabular numerals so columns align.

SEED ad_accounts with these real accounts (all currency INR):
1249430309131428 · Ritu Agarwal 2 · active · is_active true — this is the main workhorse account
1177480620566796 · Ritu Agarwal-SX-2 · active · is_active true · agency_code SX
1091860385814643 · Ritu Agarwal-SX · active · is_active true · agency_code SX
2929556933907035 · Ritu-SX3 · active · is_active true · agency_code SX
1488704194840585 · Ritu Ad manager · active · is_active true
699110549552181 · EQH_SD · active · is_active true · agency_code SD
587640350334915 · Ritu-Sabhi Digital-3 · active · is_active true · agency_code SD
514274773001361 · Ritu Sabhi Digital · active · is_active true · agency_code SD
1766718867459790 · Ritu Agarwal-Sabhi Digital2 · active · is_active true · agency_code SD
171158705384198 · Ritu Nikunj Ad Ac · active · is_active true
886948362374833 · Ritu New 4 · active · is_active true
742306694094489 · Ritu IDLS · active · is_active true
1292097099554679 · Ritu Agarwal (Read-Only) · active · is_active true
1475486154247855 · Ritu Agarwal (Read-Only) 2 · active · is_active true
517296235376502 · Ritu Agarwal (disabled by Meta) · disabled · is_active FALSE
326788779184576 · Ritu Agarwal · active · is_active FALSE — not enabled for API access

VALIDATION TARGET — after a full 2026 backfill, total Meta spend across all accounts per month should come out close to these figures. Put them in a comment in the sync function so anyone can check the pipeline is honest:
Jan ₹21,27,663 · Feb ₹24,17,683 · Mar ₹44,75,910 · Apr ₹33,91,244 · May ₹28,17,798 · Jun ₹23,38,455 · Jul ₹15,72,085 · Aug (to 26th) ₹8,06,404. 2026 total ≈ ₹1.99 crore.

DESIGN
This is an internal operations tool that gets opened every morning and read at a glance — not a marketing page. No hero section, no large decorative headers. Dense and tabular, high information density, generous use of the full width. Clear typographic hierarchy and real spacing discipline. Support both light and dark properly using CSS variables — the owner works late. Numbers are the interface: make them the most legible thing on the screen.

Do not invent or estimate any figure. Every number displayed must come from the database. If data is missing, show "no data" explicitly — never a zero, never a blank, and never a placeholder.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/99936e18-5a56-46c8-ac3a-3a284371d25c).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
