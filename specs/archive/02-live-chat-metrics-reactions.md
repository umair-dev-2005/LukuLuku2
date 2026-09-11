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

# Feature 2: Live Chat, Viewer Metrics & Reactions

Depends on Feature 1 (`live_streams`, `live_stream_viewer_sessions`). Realtime transport: ZegoCloud
in-room signaling and/or Supabase Realtime channel scoped per `live_stream_id` (either works — pick
one consistently; don't mix). This doc covers: chat messages, pinning, join notices, tap-to-like
reactions, and the metrics already promised in Feature 1 (viewer counter, views, timer) — this file
only adds what Feature 1 didn't: chat + reactions.

## Flow (behavior only)

1. **Sending a message**: viewer types in chat box while watching a live stream → message broadcast
   to the room in real time → also persisted (see `live_chat_messages`) so late-joining viewers can
   load recent scrollback and moderation can audit later.
2. **Broadcaster highlight**: any message sent by the stream's own broadcaster (`sender_user_id ==
   live_streams.broadcaster_user_id`) is visually highlighted client-side — this is a client-side
   comparison, not a stored flag, since it's fully derivable.
3. **Pinning**: broadcaster (or a moderator, Feature 5) can pin one message at a time to the top of
   the chat box — pinning message B unpins A. Only the currently-pinned message needs tracking.
4. **Join notifications**: "User XYZ joined" banners are derived from Feature 1's viewer-join event
   (`live_stream_viewer_sessions` insert) — broadcast over the realtime channel as a transient event
   when it happens. **Not stored as chat rows** by default (would flood scrollback on popular
   streams). If the client wants joins visible in chat history too, they can be inserted as
   `live_chat_messages` with `type='system_join'` — flag as open question below.
5. **Viewer counter / total views / duration timer**: already defined in Feature 1 — this feature
   just displays them; no new fields.
6. **Tap-to-like reactions**: viewer taps screen → local flying-heart animation plays immediately
   (client-side, no round trip needed for the animation itself) → a lightweight "reaction tapped"
   event is sent over the realtime channel so other viewers' visual counters update too. Individual
   taps are **not** written to the DB one row at a time (way too high-volume) — see Reactions
   section below for how the running total is kept.

## Entities

### `live_chat_messages` — persisted chat history per stream
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| live_stream_id | uuid FK → live_streams | |
| sender_user_id | uuid FK → profiles, nullable | null only for `type='system_*'` rows |
| type | enum: message, system_join, system | default `message` |
| body | text | required for `type='message'` |
| is_pinned | boolean default false | see pin logic below |
| created_at | timestamptz | used for scrollback ordering |
| moderation_status | enum: visible, hidden, deleted, default visible | set by Feature 5 (mute/filter/delete); this feature just reads/writes `visible` |

Pin logic: at most one row per `live_stream_id` should have `is_pinned = true` at a time — enforce
in application logic (on pin, unset the previous pinned row for that stream first) rather than a DB
constraint, since it's a simple two-step operation.

### `live_stream_reaction_counts` — one row per stream, running total only
Individual taps are ephemeral events on the realtime channel, not individual rows. This table only
stores the aggregate, updated via periodic batched increments (e.g. client buffers taps for ~1–2s
and sends a batch increment) rather than one write per tap.

| Field | Type | Notes |
|---|---|---|
| live_stream_id | uuid PK, FK → live_streams | |
| total_reactions | bigint default 0 | incremented in batches, never per-tap |
| updated_at | timestamptz | |

This total is useful for the end-of-stream summary screen (Feature 1, section on summary) — add it
there as a display field once this table exists.

## Real-time vs historical
1. **Real-time only (no DB write per event)**:
   - Tap-to-like animation trigger + live visual reaction counter shown during the stream — driven
     by the realtime channel, not `live_stream_reaction_counts` (that table lags behind by design,
     via batching).
   - Join notification banner (derived from Feature 1's join event).
   - Live viewer counter, duration timer — as defined in Feature 1.
2. **Historical / durable**:
   - `live_chat_messages` — every real chat message, permanently (needed for moderation audit trail
     and scrollback on rejoin).
   - `live_stream_reaction_counts` — batched, eventually-consistent running total.

## Actions/events → writes
| Event | Trigger | Writes |
|---|---|---|
| Chat message sent | viewer/broadcaster sends text | INSERT live_chat_messages; broadcast on realtime channel |
| Message pinned | broadcaster/mod pins a message | UPDATE: unset prior pinned row for stream, set `is_pinned=true` on target |
| Viewer joins | Feature 1 join event | broadcast transient "joined" event only (no chat row by default) |
| Reaction tap | viewer taps screen | broadcast transient event immediately; client buffers taps and periodically sends a batch increment |
| Reaction batch flush | buffer interval elapses (client or edge function) | UPDATE live_stream_reaction_counts (`total_reactions += batch_size`) |

## Relationships
- `live_streams` 1→many `live_chat_messages`.
- `live_streams` 1→1 `live_stream_reaction_counts`.
- `profiles` 1→many `live_chat_messages` (as sender).
- `live_chat_messages.moderation_status` is written by Feature 5 (moderation), read here.

## Open questions for client
1. Should viewer joins also appear in persisted chat scrollback (`type='system_join'` rows), or stay
   purely transient (assumed: transient only)?
2. Can a viewer pin their own message, or is pinning broadcaster/moderator-only (assumed: broadcaster
   + moderators only, per client's spec wording "Broadcaster can pin any his or any viewer message")?
3. Any chat rate limit (max messages per viewer per X seconds) before Feature 5's anti-spam kicks in,
   or is that fully owned by Feature 5?
4. Retention: keep `live_chat_messages` forever, or purge after N days for ended streams?
