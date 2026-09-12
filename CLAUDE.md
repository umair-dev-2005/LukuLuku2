# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Project Overview

LukuLuku — an Expo/React Native (TypeScript) video/social app (short-form "Momenti", long-form
video, "Bangi" community posts, mini-games, wallets/monetization). Ships to iOS/Android via EAS
Build. This is a **private full backup repo** — signing keys/certs/env files
(`android-credentials/`, `*.jks`, `*.p12`, `*.pem`, `.env*`) are committed on purpose; don't treat
their presence as a leak or add them to `.gitignore`.

## Current Task Scope

Live Streaming database design is **complete** — all migrations ran successfully in Supabase SQL
Editor, `APP_SCHEMA_OVERVIEW.md` is up to date. Current task: **build the UI and integrate the real
ZegoCloud Low-Level SDK**, one feature at a time (workflow below). Do NOT propose/write further
schema changes now unless a genuine gap is found — then STOP and follow the "Strict Need Exception &
Permission Flow" before touching any SQL.

## UI, Integration & Testing Workflow (Live Streaming — Build Phase)

**Source of truth now:** whole app codebase, `APP_SCHEMA_OVERVIEW.md`, the 6 migration files, and
the
user's screenshot + text explanation per screen/flow. The 5 old spec files moved to `specs/archive/`
(outdated) — they were only for the DB design phase; do NOT use them for UI/integration. If they
conflict with what the user describes now, then explain , tell reason and take confirmation to take
action.

1. **Analyze first:** study codebase conventions (theme, style, reusable patterns) +
   `APP_SCHEMA_OVERVIEW.md` + all 6 migration files + the user's screenshot/text before writing
   anything.
2. **Functional-but-mocked, not static:** no hardcoded fake content with zero interaction. Every
   interactive element (chat input, mic/camera toggle, gift button) needs real React state + real
   validation/behavior (e.g. chat input accepts text, enforces the real char limit, shows sent
   message in the list) — even before real-time transmission is wired up.
3. **Minimal dummy data:** smallest placeholder data to demo the UI — no large fake datasets that
   later have to be found/removed, wasting time and tokens.
4. **Improvements — ask first:** if a genuinely worthwhile, in-scope improvement is spotted, explain
   it briefly in simple words and wait for confirmation before implementing. Never implement
   unrequested changes.
5. **One feature at a time, front-end then its own backend:** one feature = one session. Build that
   feature's UI first (multiple smaller plans OK, e.g. one per screen, each executed after
   confirmation), then that same feature's ZegoCloud integration as **one single plan** (shared
   room/connection state, don't split per screen). Only after both are done and tested, move to the
   next feature's UI. Never build all features' UI first and all backends after.
6. **No plan executes without the user's explicit confirmation — no exceptions.**
7. **Supabase Edge Functions — only when actually needed:** `APP_SCHEMA_OVERVIEW.md` references
   Edge Functions some features will eventually need. Do NOT write or scaffold any Edge Function
   code before the point in the current feature's integration where it's genuinely needed. When
   that point arrives, give the user the Edge Function code to deploy themselves — do not proceed
   with any work that depends on it until the user confirms it's deployed.
8. **Real device testing gate:** after a feature's UI , user tests on a real
   device via USB then start integration for the same feature. Don't start the next feature until
   the current one is confirmed fully working —
   fix and re-test first.
9. **Regression check:** before a new feature, sanity-check shared logic (ZegoCloud room/connection
   setup, shared components, navigation) used by completed features is still intact.
10. **Cross-platform mandatory:** every screen/integration point must work on **both Android and
    iOS** — never optimize for one only; flag platform-specific ZegoCloud differences when relevant.
11. **ZegoCloud credentials safety:** never hardcode App ID/App Sign or Server Secret in client-side
    RN code. Use a server-side token endpoint (e.g. Supabase Edge Function) for short-lived tokens —
    flag as required setup if missing, don't silently embed secrets.
12. **Real DB change needed during this phase:** if something genuinely can't proceed without a
    schema change, first explain the reason in simple words and get explicit permission (per Strict
    Need Exception & Permission Flow) before giving any SQL. Once approved and the migration is
    confirmed run in Supabase, you MUST update two places: (1) `APP_SCHEMA_OVERVIEW.md`, so the
    documented schema stays in sync with the real production structure and doesn't cause issues for
    future UI/ZegoCloud work, and (2) the correct one of the 6 migration files — tell the user
    exactly which file and what needs to change, then ask whether the user will make that edit
    themselves or wants you to edit that migration file directly.

## Absolute Architectural Guardrails

- **Live Streaming Core Engine:** MUST use **ZegoCloud Low-Level SDK only** — no Agora, no ZegoCloud
  Pre-built UI Kits.
- **DB Schema source of truth:** `APP_SCHEMA_OVERVIEW.md`. Ignore vestigial SQL/Convex files.
- **Retired: `specs/archive/`:** the 5 old streaming-spec files are outdated, DB-design-phase only —
  not for UI/ZegoCloud work (see workflow above).
- **Raw DB Dump (`supabase/lukuluku_public_schema_dump.sql`):** complete unfiltered dump (App+Site+
  Shared mixed) already filtered into `APP_SCHEMA_OVERVIEW.md` — don't reference it directly, only
  cross-verify against production if `APP_SCHEMA_OVERVIEW.md` is genuinely missing something.
- **External / Third-Party Platform Action Gate:** If any UI or integration step requires action
  on an external platform outside this project repository (e.g. Google Play Console IAP setup,
  Apple App Store Connect product IDs, ZegoCloud Admin Console key generation, Supabase Dashboard
  manual triggers), you MUST **STOP IMMEDIATELY**. Explain what needs to be done on that platform,
  provide clear step-by-step guidance if requested, and wait for the user to confirm completion
  before moving to the next code step.



## Directory map (non-obvious parts only)

- `screens/` — one file per screen, wired from `App.tsx`.
- `components/` — shared UI; `components/games/` is orphaned native-game code.
- `lib/` — Supabase client/queries, auth, i18n, theme, tracking/ATT, VAST ads, community safety.
- `hooks/` — small Supabase-backed data hooks (`useActiveAds`, `useRankBadges`).
- `supabase/functions/` — the one deployed Edge Function (`delete-account`).
- `supabase_complete_migration.sql` / `supabase_migrations.sql` — reference schema, not
  auto-applied.
- `convex/` — vestigial.

## Commands

No lint/test setup (no eslint config, no test scripts). Don't invent `npm run lint`/`npm test`.

```
npm start / npm run android / npm run ios / npm run web
```

TypeScript `strict: true` — no typecheck script, run `npx tsc --noEmit` directly. EAS profiles in
`eas.json` (development/preview/production) — don't build/submit without being asked.

## Architecture

**Backend is Supabase, not Convex.** All data access goes through `lib/supabase.ts` directly from
screens/components. `convex/` and `lib/convexStub.ts` are unwired leftovers — don't "reconnect"
them. `lib/supabase.ts`'s exported interfaces (`Profile`, `Channel`, `Video`, etc.) are the real
types.

**Navigation is hand-rolled**, not React Navigation — `App.tsx`'s `Screen` union + manual
`screenStack`, `navigateTo`/`goBack`/`goHome`. Non-tab screens `lazy()`-load behind `<Suspense>`.
The 4 bottom tabs stay mounted, toggled via `display: none` to preserve state/scroll. Deep links
parsed in `App.tsx`'s `useEffect`.

**Client-side aggregation works around RLS** in `fetchLeaderboard`, `hooks/useActiveAds.ts` — read
inline comments in `lib/supabase.ts` before "simplifying" back to a server-side aggregate (tried,
reverted). Momenti lives in **both** `videos` (`is_short=true`) and `shorts`; dedupe key:
`user_id|channel_id|video_url|title|thumbnail_url`.

**Auth is deterministic on the Supabase session UID** (`lib/auth.ts`) — no fuzzy name matching.
`ensureSupabaseProfile`/`ensureChannelExists` auto-create rows on first sign-in.
`FOUNDER_ENTITLED_USER_IDS` is a real hardcoded entitlement allowlist, not test code.

**Mini-games are third-party**, via GamePix feed in a WebView; `components/games/*.tsx` are unused
native leftovers.

**i18n** (`lib/i18n.ts`): flat `translations` object (`nl`/`en`/`srn`) via `t()`/`useLanguage()` —
add strings here, no new library. **Theming** (`lib/theme.ts`): plain JS objects, no provider, no
dark mode.

## 🔒 Strict Schema Protection & Non-Breaking Mandate

- **Pure Extension First:** new features = new tables/enums/RPCs via Foreign Keys, never altering
  existing structures.
- **Shared App & Web Protection:** nothing in `APP_SCHEMA_OVERVIEW.md`'s shared structures gets
  deleted/dropped/broken.
- **Strict Need Exception:** NEVER modify/rename an existing table/column directly. If unavoidable:
  (1) STOP, explain in very simple words, (2) explain WHY + safety measures, (3) get explicit
  permission before outputting/applying that SQL.

## Communication Style

- **Language:** Roman Urdu by default (Urdu in Latin script + common English technical terms) unless
  asked otherwise.
- **Explaining technical things:** simple words, as if to a non-professional; briefly explain any
  technical term used.
- **Code stays as-is:** code blocks, SQL, file names, commands stay in English/code syntax — only
  surrounding explanation is Roman Urdu.
- Applies across all sessions in this repo.