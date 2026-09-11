> **⚠️ ARCHIVED — OUTDATED SPEC. Do NOT use this file as a reference for UI screens, app code, Edge Functions or database work.**
>
> This is the original pre-design spec (archived 2026-09-11). Many decisions changed while the database
> was designed and verified — e.g. live chat is **never stored**, new LK Battle ending rules, 15-minute
> kick / 3-stream ban / 7-day platform ban, a 50-gift catalog + 10 coin packages, and co-hosting (not in
> these specs at all). The **source of truth** is now:
> `supabase/migrations/20260910_01…06_*.sql`, `APP_SCHEMA_OVERVIEW.md`, and the user's current
> instructions and screenshots. If this file disagrees with those, this file is wrong.
>
> *PURANI file — is se UI ya code na banayein. Kept only as history.*

---

# Feature 1: Core Live Streaming Infrastructure (Broadcaster & Viewer Engine)

Streaming SDK: **ZegoCloud** (RTC publish/playback + room signaling). Only chat/gifts/battles/
moderation are separate features (Feature 2–5 MD files) — they all attach to `live_streams` via
`live_stream_id`.

## Flow (behavior only, no UI)

1. **Preview screen**: user requests camera/mic permission, sets title + category, toggles camera
   flip / mic mute (local UI state, not persisted). Nothing written to DB yet.
2. **Start Streaming tap** → app creates/joins a ZegoCloud room → publishes local stream → **only
   after publish is confirmed**, create `live_streams` row (`status='live'`). Never mark live before
   SDK confirms publish.
3. **Broadcasting screen**: shows live viewer count + duration timer (both derived, not stored per
   tick — see Real-time section). Camera flip/mic mute during live stream = local SDK state only,
   not logged as events (confirm with client if history is ever needed).
4. **Viewer opens a stream**: player starts receiving → this is a "join" → insert
   `live_stream_viewer_sessions` row. Swipe-up to next stream = "leave" current session + "join"
   next one.
5. **Leave** (swipe away / exit / stream ends / kicked by moderation): close the open viewer session
   row (`left_at`, `duration_seconds`, `leave_reason`).
6. **Auto-reconnect** (either side): retry silently within a bounded window; no new rows on success.
7. **End Stream** (broadcaster confirms) → SDK stops publish/leaves room → update `live_streams`
   (`status='ended'`, `ended_at`, `duration_seconds`, cached metrics) → force-close any still-open
   viewer sessions on that stream (`leave_reason='stream_ended'`) → show summary (views, unique
   viewers, peak concurrent, duration — all derived, see 4.1).
8. **Force-end (system)**: if broadcaster disconnects and doesn't reconnect within N minutes
   (server/webhook-detected), end the stream server-side with `end_reason='disconnected'` so it
   doesn't stay "live" forever with a dead room.

## Entities

### `live_streams` — one row per broadcast, permanent record
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| broadcaster_user_id | uuid FK → profiles | |
| title | text | required |
| category_id | uuid FK → stream_categories | required |
| zego_room_id | text | = `id` reused as room ID (no separate mapping table needed) |
| status | enum: live, ended | drives discovery/feed queries |
| started_at | timestamptz | set on confirmed publish |
| ended_at | timestamptz null | |
| end_reason | enum: broadcaster_ended, disconnected, moderation_ban, null | |
| duration_seconds | int null | |
| total_views | int default 0 | cached at end, see 4.1 |
| unique_viewers | int default 0 | cached at end |
| peak_concurrent_viewers | int default 0 | updated live, see 4.1 |
| created_at | timestamptz | |

### `stream_categories` — small static reference table
| Field | Type |
|---|---|
| id | uuid PK |
| name | text |
| is_active | boolean |

### `live_stream_viewer_sessions` — one row per (viewer, single watch session)
Repeat joins on the same stream = new row each time (needed for total vs unique view counts).

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| live_stream_id | uuid FK → live_streams | |
| viewer_user_id | uuid FK → profiles, nullable | nullable only if guest viewing allowed (confirm w/ client) |
| joined_at | timestamptz | |
| left_at | timestamptz null | null while still watching |
| duration_seconds | int null | computed on leave |
| leave_reason | enum: swiped_away, manual_exit, stream_ended, kicked, null | `kicked` from Feature 5 |

## ZegoCloud ID mapping
- `live_streams.id` = `zego_room_id` (reuse our UUID as the room ID directly — no lookup table).
- Publish stream ID within the room: `{live_streams.id}_host` (each room has one broadcaster here;
  dual co-hosting/LK Battles room-merging is handled in the Feature 3 doc).

## Real-time vs historical (important for how this gets built)
1. **Real-time / do not write to DB on every tick**:
   - Live viewer count = count of open (`left_at IS NULL`) `live_stream_viewer_sessions` rows for a
     stream, but serve it via a realtime/presence channel, not a polled DB query per viewer.
   - Duration timer on screen = computed client-side from `started_at`.
   - Camera/mic toggle state, overlay visibility = pure client state, never persisted.
2. **Historical / durable rows**: `live_streams`, `live_stream_viewer_sessions`, and the cached
   metrics on `live_streams` (written at join/leave/end checkpoints, not recomputed from scratch on
   every read).

## Actions/events → writes
| Event | Trigger | Writes |
|---|---|---|
| Stream created | Publish confirmed | INSERT live_streams (status='live') |
| Viewer joined | Player receiving stream | INSERT viewer_sessions row; bump presence; maybe bump peak_concurrent_viewers |
| Viewer left | swipe/exit/end/kick | UPDATE that session row (left_at, duration, leave_reason) |
| Stream ended (user) | End Stream confirmed | UPDATE live_streams (ended, cached metrics); force-close open sessions |
| Stream force-ended (system) | broadcaster disconnect timeout | same, end_reason='disconnected' |

### 4.1 Derived metrics (no extra tables)
- `total_views` = COUNT(*) of viewer_sessions for the stream.
- `unique_viewers` = COUNT(DISTINCT viewer_user_id).
- `peak_concurrent_viewers` = tracked incrementally (increment on join, compare/store max, decrement
  on leave) — can't be derived after the fact from session rows alone.

## Relationships
- profiles 1→many live_streams (as broadcaster); 1→many viewer_sessions (as viewer).
- stream_categories 1→many live_streams.
- live_streams 1→many live_stream_viewer_sessions.
- `live_streams.id` is the anchor FK that Features 2–5 (chat, gifts/wallet, LK battles, moderation)
  will attach to.

## Open questions for client
1. Is guest/anonymous viewing allowed, or must every viewer be logged in?
2. Log camera-flip/mic-mute toggle events during a live stream, or client-state only (assumed: no)?
3. Disconnect timeout before a stream is force-ended?
4. Any minimum stream duration / cooldown between consecutive streams per user?
