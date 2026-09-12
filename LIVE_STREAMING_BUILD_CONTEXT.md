# Live Streaming — Build Context (UI phase)

Handover note for a fresh Claude Code session. Everything below was built in the sessions of
**2026-09-11 → 2026-09-12**. Read this together with `CLAUDE.md` and `APP_SCHEMA_OVERVIEW.md`.

> **Phase:** UI only. **ZegoCloud SDK is NOT integrated yet** and **no `live_*` / `lk_battle_*` /
> `gift_*` / `stream_mod_*` RPC is called by any RN code.** Plain Supabase *table reads* (and one
> table write, tapins) are used where real data exists; everything else is local mock state.

---

## 1. What exists now (screens & flow)

```
Home (header LIVE button)  ──►  Live Hub (viewer feed)  ──►  Live Viewer Screen
Home (+ tab) ──► Create ──► Go Live ──► Live Preview ──► Live Broadcast (host's own screen)
```

| Screen | File | Purpose |
|---|---|---|
| Go Live entry | `screens/CreateScreen.tsx` | "Go Live" row added to the create menu (`radio` icon, `colors.tapIn`) |
| Live trigger | `screens/HomeScreen.tsx` | Play-icon pill + "LIVE" badge in the header → opens Live Hub |
| Preview | `screens/LivePreviewScreen.tsx` | Camera preview, flip, mic meter, title (60 chars), category chips, Start Streaming |
| Broadcaster | `screens/LiveBroadcastScreen.tsx` | Host's own live screen: header stats, 3-dot menu, chat, counters, input |
| Viewer feed | `screens/LiveHubScreen.tsx` | Back/title/search bar, category filter, vertical card feed |
| Viewer stream | `screens/LiveViewerScreen.tsx` | The watch screen: Aero header, chat, counters, gift button, end overlay |

**Routes in `App.tsx`:** `livePreview`, `liveBroadcast`, `liveHub`, `liveViewer` (all `lazy()` + `Suspense`,
same pattern as the rest of the app).

---

## 2. Shared building blocks (reuse these — do NOT rebuild for co-hosting/battles)

| File | What it gives you |
|---|---|
| `hooks/useLiveChat.ts` | Whole chat engine: messages, roles (host/mod/viewer), pin/unpin, mute/kick/ban/promote local effects, profanity block, slow mode, join toasts, like/chat/share counters. Options: `{ hostUserId?, currentUserName?, currentUserAvatarUrl? }` |
| `hooks/useMicLevel.ts` | Mic level meter + mute toggle + permission handling (`initialMuted` arg) |
| `hooks/useStreamCategories.ts` | `stream_categories` (real, i18n label per `slug`) |
| `hooks/useLiveHostHeader.ts` | The **current signed-in user's own** name/avatar/tapins (used on both host and viewer screens) |
| `hooks/useLiveFeed.ts` | Live feed items: solo / cohost / battle, with pairing + dedupe |
| `hooks/useLiveViewerStream.ts` | One stream's data for a viewer (host info, viewers, started_at, moderator check, tapIn) |
| `lib/liveChatModeration.ts` | Placeholder profanity list + `CHAT_RATE_LIMIT` constants |
| `lib/utils.ts` → `formatLiveDuration()` | `mm:ss`, `h:mm:ss` past an hour |
| `components/live/EdgeGradient.tsx` | Top/bottom dark vignette (react-native-svg) |
| `components/live/LiveChatList.tsx` | Bubbles (avatar inside the bubble), host=gold/mod=blue + badges, pinned banner w/ shimmer, top fade, sticky-bottom autoscroll |
| `components/live/LiveCounters.tsx` | Heart/chat/share stack. `variant="host" \| "viewer"` |
| `components/live/LiveModerationMenu.tsx` | Action sheet. `viewerRole="host" \| "moderator" \| "viewer"` |
| `components/live/LiveJoinToast.tsx` | "X joined" floating toasts (queue, max 3) |
| `components/live/LiveFeedCard.tsx` | Feed card: solo / co-host / battle variants |
| `components/live/viewer/*` | `AeroHeader`, `HeartBurst`, `GiftCelebration`, `LiveEndedOverlay` |

---

## 3. Real vs mocked (important — don't "fix" the zeros)

**Real (already reading/writing Supabase):**
- Categories (`stream_categories`), host/channel name + avatar (`channels` → `profiles` fallback)
- **Total Tapins** = `channels.tapiners` (trigger-maintained column; counting `tapins` returns 0 under RLS)
- **Live viewers** = `live_stream_runtime.current_concurrent_viewers`
- **Stream status / started_at** = `live_streams` (polled every 20s on the viewer screen)
- **Moderator check** = `stream_moderators` (stream / channel / global scope via one `.or()`)
- **"+ Tappin" button** = real insert into `tapins` + optimistic `tapiners` bump (same as `ChannelScreen.tsx`)
- Live feed = `live_streams` (`status='live'`) + `live_cohost_sessions` + `lk_battles` + `lk_battle_scores`

**Mocked / placeholder (by design, this phase):**
- **Video** — no ZegoCloud. Host screens show the phone's own `CameraView`; viewer/feed show the
  **host's profile picture** as the stand-in (there is **no thumbnail/cover column on `live_streams`**).
- **Chat messages** — local only, and they stay local forever: schema migration 02 decided chat is
  **never stored in the DB**. Only the *transport* changes later (local mock → ZegoCloud ZIM).
- **Earned coins / diamonds** — always `0`; the only viewer-safe source is the RPC `gift_live_stream_points()`.
- **Host mic on/off shown to a viewer** — no DB source; it's ZegoCloud room extra-info.
- **Likes/chats/shares counters** — local counts (real sources: `live_stream_reaction_counts`,
  `live_stream_chat_counts`, `live_shares`). `0` at stream start is the *correct* real value.
- **Moderation actions** (mute/kick/ban/promote/report) — local UI effect only.
- **Demo data** that self-removes: `useLiveFeed` shows 3 demo cards **only when nobody is live**;
  `useLiveChat` seeds 4 messages + a pinned welcome + a pre-set moderator ("James") and generates a
  mock message/join every 6–10s; `GiftCelebration` fires its own occasional demo event.
- **Dev-only:** long-press the ✕ on `LiveViewerScreen` to preview the end-of-stream screen.

---

## 4. Decisions already made (don't re-litigate)

1. **One feed, dual cards.** Co-hosting/battle are *links between two ordinary `live_streams` rows*,
   so the Live Hub is a single feed; a linked pair collapses into ONE 50/50 split card (a paired
   stream never also appears as its own solo card).
2. **Tapping a dual card passes the tapped `sideIndex`** — later only THAT side's room gets joined,
   so one tap never double-counts viewers on both sides.
3. **Moderation durations follow the deployed schema, not intuition:** mute = configurable (15 min
   chosen in UI), **kick = fixed 15 min** in `stream_mod_kick()`, **ban has no duration** — it blocks
   the broadcaster's *next* stream(s). UI copy matches this.
4. **Role-based menus:** viewer → Report only; moderator → +mute/kick/ban/pin; host → + Make/Remove
   Moderator. Self-moderation never offered (schema blocks it too).
5. **Feed cards have no heart/favourite icon** — removed on request; there is no "favourite stream" table.
6. **Blur is used sparingly** (Aero header + viewer input bar). Small repeated elements use plain
   `rgba` — `BlurView` over live video is expensive on Android.
7. **Counters column is vertically centered** on the viewer/host screens (TikTok/Bigo-style).

---

## 5. Platform gotchas learned the hard way (re-reading this saves hours)

- **Keyboard:** do NOT use `KeyboardAvoidingView` on these screens. Its padding/height math
  double-counts against this app's Android `adjustResize`. Both live screens track
  `Keyboard.addListener('keyboardDidShow'/'keyboardDidHide')` manually and shift only the input bar.
- **Camera hand-off:** `LivePreviewScreen` unmounts its `CameraView` the moment "Start Streaming" is
  pressed and waits ~350 ms before navigating — two `CameraView`s mounting back-to-back on Android
  race for the camera and the new one comes up **black**.
- **react-native-svg stacking (Android):** an `<Svg>` composites through its own native surface and
  can paint **above** later siblings regardless of JSX order — `zIndex`/`elevation` did not fix it.
  The liked-heart gradient was replaced with a plain solid background for this reason. Don't overlay
  an icon on top of an SVG in the same parent.
- **`TextInput.focus()` from another button's `onPress`** needs a ~50 ms `setTimeout` on Android or
  the keyboard doesn't open.
- **Native rebuild:** `expo-camera` + `expo-audio` were added to `package.json`, and
  `CAMERA` / `MODIFY_AUDIO_SETTINGS` to `android/app/src/main/AndroidManifest.xml`. The `android/`
  and `ios/` folders are committed and hand-maintained (prebuild is NOT re-run), so native
  permission changes must be edited there directly.
- **Polling rule from the schema:** viewer counts re-sync every ~20 s — *never* per second.

---

## 6. What's next (in order)

1. **Gift-sending bottom sheet** (catalog, coin balance, send) — the viewer screen's gift button is
   a placeholder today; `GiftCelebration` is the display layer already waiting for real events.
2. **Co-hosting UI** and **LK Battle UI** — reuse everything in §2; what's genuinely new is the
   split-screen dual video layout, the invite/accept flow, and the battle score/timer/winner UI.
3. **ZegoCloud integration** (one plan for the whole feature, per `CLAUDE.md`): replace camera/mic
   stand-ins with Zego preview + publish/play, wire `live_stream_init` / `heartbeat` (30 s) /
   `join` / `leave` / `end`, chat through ZIM + `stream_mod_chat_gate()`, reactions via
   `live_reactions_increment()`, shares via `live_share_record()`, gifts via `gift_send()`.

**Open questions for the integration phase:**
- Where do real video **thumbnails** for the feed come from? (`live_streams` has no cover column →
  either a new column, permission required, or a Zego/server snapshot service.)
- A battle/co-host viewer must see **two streams from two different Zego rooms** → Zego
  **multi-room mode** has to be decided *at engine creation time*, not later.
- Edge Functions listed as PENDING in `APP_SCHEMA_OVERVIEW.md` (chat relay, token endpoint) must be
  written and deployed by the user before the parts that depend on them.

---

## 7. Checks

- `npx tsc --noEmit` — the live-streaming files are clean. Pre-existing unrelated errors live in
  `convex/`, `screens/HomeScreen.tsx`, `ProfileScreen.tsx`, `ShortsScreen.tsx`, `VideoPlayerScreen.tsx`,
  `components/VideoCard.tsx`, `VideoInteractionLayers.tsx`, `PreRollAd.tsx`, `supabase/functions/`.
- No lint/test setup exists in this repo (see `CLAUDE.md`).
