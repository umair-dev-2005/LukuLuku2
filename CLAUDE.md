# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## Project Overview

LukuLuku — an Expo/React Native (TypeScript) video/social app (short-form video "Momenti", long-form
video, "Bangi" community posts, mini-games, wallets/monetization). Ships to iOS and Android via EAS
Build. This repo is a **private full backup repo** — signing keys/certs/env files (
`android-credentials/`, `*.jks`, `*.p12`, `*.pem`, `.env*`) are committed on purpose (see
`.gitignore` header comment). Don't treat their presence as a leak to fix; don't add them to
`.gitignore`.

## Current Task Scope
Database design ONLY for Live Streaming feature, right now. The current task is strictly limited to designing and producing the
database schema/migrations for the Live Streaming feature (per specs/*.md and
APP_SCHEMA_OVERVIEW.md). Do NOT write, edit, or scaffold any UI screens, components, hooks, or
ZegoCloud low level SDK integration code, and do NOT touch any other unrelated part of the app, until
explicitly asked to move on to implementation. If a task seems to need application code to proceed,
stop and ask first instead of writing it.

## Absolute Architectural Guardrails

- **Live Streaming Core Engine:** MUST use **ZegoCloud Low-Level SDK only**. Strictly DO NOT install
  or use Agora SDKs or ZegoCloud Pre-built UI Kits.
- **Single Source of Truth for DB Schema:** `APP_SCHEMA_OVERVIEW.md` is the official reference for
  Mobile App & Shared (App + Web) database state. Ignore vestigial SQL/Convex files for current DB
  context.
- **Single Source of Truth for Streaming Specs:** The 5 `.md` files in the `specs/` folder govern
  the live-streaming requirements and features.

- **Raw Full DB Dump (`supabase/lukuluku_public_schema_dump.sql`):** This is the complete,
  unfiltered database SQL dump — it contains the App-only schema, Site (web)-only schema, and the
  Shared (App + Web) schema all mixed together. It has already been filtered/parsed, and the
  relevant App + Shared portions have been extracted into `APP_SCHEMA_OVERVIEW.md` to avoid
  confusion. Do NOT use this raw dump file directly as a schema reference — always use
  `APP_SCHEMA_OVERVIEW.md` instead. Only consult the raw dump if `APP_SCHEMA_OVERVIEW.md` is
  missing something and cross-verification against the true production schema is genuinely needed.

## Directory map (non-obvious parts only)

- `screens/` — one file per app screen, wired together only from `App.tsx`.
- `components/` — shared UI; `components/games/` is the orphaned native-game code noted above.
- `lib/` — all cross-cutting logic (Supabase client + queries, auth, i18n, theme, tracking/ATT, VAST
  ad parsing, community safety).
- `hooks/` — small data hooks (`useActiveAds`, `useRankBadges`), Supabase-backed.
- `supabase/functions/` — the one deployed Edge Function (`delete-account`).
- `supabase_complete_migration.sql` / `supabase_migrations.sql` — reference schema/migrations for
  the live Supabase project (not applied automatically by any script here).
- `convex/` — vestigial, see Architecture above.

## Commands

There is no lint or test setup in this project (no eslint config, no test runner/scripts in
`package.json`). Don't invent `npm run lint`/`npm test` commands.

```
npm start            # expo start — Metro dev server
npm run android      # expo run:android — native Android build
npm run ios          # expo run:ios — native iOS build
npm run web          # expo start --web
```

TypeScript is `strict: true` (extends `expo/tsconfig.base`). There's no standalone typecheck script;
run `npx tsc --noEmit` directly if you need to verify types.

EAS builds are configured in `eas.json` (`development`, `preview`, `production` profiles) — these
require the `eas` CLI and an Expo account; don't run builds/submits without being asked.

## Architecture

**Backend is Supabase, not Convex — despite the `convex/` directory.** All real data access (auth,
videos, channels, posts, wallets, notifications, moderation) goes through `lib/supabase.ts` using
`@supabase/supabase-js` directly from React Native screens/components. The `convex/` directory (
schema + functions for wallets, games, moderation, ads, reports) and `lib/convexStub.ts` are
leftovers from an earlier export and are **not wired into the app** — `convexStub.ts` isn't even
imported anywhere. Don't try to "reconnect" Convex or treat `convex/schema.ts` as the source of
truth for data shapes; `lib/supabase.ts`'s exported interfaces (`Profile`, `Channel`, `Video`,
`Short`, `CommunityPost`, etc.) are the real types, and RLS/actual columns live in Supabase (see
`supabase_complete_migration.sql`, `supabase_migrations.sql`, `supabase/functions/`).

**Navigation is a hand-rolled screen stack, not React Navigation.** `App.tsx` holds a `Screen`
discriminated union (`{ type: 'tabs' } | { type: 'video'; ... } | ...`) plus a manual `screenStack`
array; `navigateTo`/`goBack`/`goHome` push/pop it, and the Android hardware back button is wired to
the same `goBack`. All non-tab screens are `lazy()`-loaded and rendered behind `<Suspense>`. The 4
bottom tabs (Home/Momenti/Search/Profile) are kept mounted simultaneously and toggled with
`display: none` (not conditionally rendered) so tab state/scroll position survives switching. Deep
links (`lukuluku.online/watch|momenti|post/...`) are parsed in `App.tsx`'s `useEffect` via
`Linking`, fetch the row from Supabase, then navigate.

**Client-side data aggregation works around Supabase RLS.** Several read paths (`fetchLeaderboard`,
ad-window checks in `hooks/useActiveAds.ts`) intentionally recompute aggregates in JS from raw
tables rather than using DB views/RPCs, because RLS makes some tables/columns return `0`/empty to a
normal authenticated user, or because a table isn't reliably populated. When touching these paths,
read the inline comments in `lib/supabase.ts` before "simplifying" a query back to a server-side
aggregate — that was tried and reverted for a reason. Momenti (short videos) are stored in **both**
the `videos` table (`is_short = true`) and a separate `shorts` table; dedupe logic uses a composite
key of `user_id|channel_id|video_url|title|thumbnail_url` — mirror this key if you add another
momenti aggregate.

**Auth identity is deterministic on the Supabase session UID** (`lib/auth.ts`,
`resolveExistingUserId`) — no fuzzy matching against existing profiles by name/handle (that was
removed after it caused account mixups). `ensureSupabaseProfile`/`ensureChannelExists` auto-create a
`profiles` row and a `channels` row on first sign-in. `FOUNDER_ENTITLED_USER_IDS` is a hardcoded
allowlist of user IDs that get founder monetization entitlements patched onto their profile on every
login (and revoked if removed from the list) — a real product mechanism, not test/debug code.

**Mini-games are third-party, not native.** `screens/GamesScreen.tsx` fetches a game catalog from
the GamePix feed (`feeds.gamepix.com`) and `GamePlayScreen` just opens the chosen game's URL in
`WebViewScreen` (a WebView). `components/games/*.tsx` (MemoryGame, TapSpeedGame, ColorMatchGame,
QuizGame) are unused native implementations from an earlier approach — not referenced by any screen.
Apple review context for this is in `scripts/APPLE_4.7.4_REVIEW_NOTES.md`.

**i18n** (`lib/i18n.ts`) is a flat `translations` object keyed by dotted string keys with
`{ nl, en, srn }` (Dutch / English / Sranantongo) values, exposed via `t()` and a `useLanguage()`
hook (`useSyncExternalStore`-based) plus `loadSavedLanguage()`/AsyncStorage persistence. Add new UI
strings to this object rather than introducing a separate i18n library.

**Theming** (`lib/theme.ts`) is plain exported JS objects (`colors`, `spacing`, `fontSize`,
`borderRadius`) — no theme provider/context, no dark mode.

## Critical Schema Design Authority & Permission Override

- **Database Optimization Mandate:** You have full authority to override, alter, or redesign the
  database structures suggested in the `specs/*.md` files if you identify performance bottlenecks,
  schema duplication, broken application flows, or poor foreign key relationships when
  cross-referencing with `APP_SCHEMA_OVERVIEW.md` and the whole app codebase.
- **Permission Boundary:** Before applying any schema design changes that differ from `specs/*.md`,
  you MUST present the architectural reasoning, performance benefits, and proposed SQL changes to
  the user and obtain explicit permission.

## 🔒 Strict Schema Protection & Non-Breaking Mandate

- **Pure Extension First (Default Rule):** All new features (including Live Streaming) MUST be built
  as pure extensions. Create new tables, enums, or RPCs that connect to existing tables (`profiles`,
  `channels`, `wallets`, etc.) via Foreign Keys without altering existing structures.
- **Shared App & Web Protection:** `APP_SCHEMA_OVERVIEW.md` contains some shared database structures
  used by both the Mobile App and Website. Nothing should be deleted, dropped, or broken that
  corrupts existing app or site functionality.
- **Strict Need Exception & Permission Flow:** NEVER modify, rename, or update any existing
  table/column directly. IF there is a strict, unavoidable technical need to change an existing
  structure:
    1. STOP and explain the issue to the user in **very simple, easy words**.
    2. Explain WHY the change is strictly required and what safety measures will be taken.
    3. Obtain explicit permission from the user BEFORE outputting or applying any modifying
       migration SQL.

## Sub-Agent & Migration Workflow Rules

1. **Analysis & Scope:** Launch targeted sub-agents per feature/spec file to deeply analyze app
   codebase flows, `APP_SCHEMA_OVERVIEW.md`, and `specs/*.md`.
2. **Migration Output:** Sub-agents must generate modular, standalone PostgreSQL migration `.sql`
   files with proper foreign keys, indexes, and RLS policies targeting Supabase.
3. **Execution & Feedback Loop:** Output the migration SQL for the user to execute manually in the
   Supabase SQL Editor. Wait for the user to provide execution logs or success confirmation.
4. **Auto-Update Source of Truth (`APP_SCHEMA_OVERVIEW.md`):** Once a migration is confirmed
   successful, ask for permission and immediately update `APP_SCHEMA_OVERVIEW.md` with the new DDL,
   Enums, functions, and RLS policies to maintain 100% sync with the production DB.
## Communication Style

- **Language:** Communicate in Roman Urdu (Urdu written in English/Latin alphabet, mixed naturally
  with common English technical terms) by default — not plain English — unless explicitly asked
  otherwise.
- **Explaining technical/complex things:** When explaining database design decisions, SQL,
  architecture choices, trade-offs, or errors, break it down in simple, easy words, as if explaining
  to someone who is not a professional developer. If a technical term must be used, briefly explain
  what it means in plain language right after using it.
- **Code stays as-is:** Code blocks, SQL, file names, and commands must remain in their normal
  English/code syntax, unchanged — only the surrounding explanation, questions, and conversation
  should be in Roman Urdu.
- This applies across all sessions in this repo, not just the current one.