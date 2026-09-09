# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

LukuLuku — an Expo/React Native (TypeScript) video/social app (short-form video "Momenti", long-form
video, "Bangi" community posts, mini-games, wallets/monetization). Ships to iOS and Android via EAS
Build. This repo is a **private full backup repo** — signing keys/certs/env files (
`android-credentials/`, `*.jks`, `*.p12`, `*.pem`, `.env*`) are committed on purpose (see
`.gitignore` header comment). Don't treat their presence as a leak to fix; don't add them to
`.gitignore`.


## Project Status

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
