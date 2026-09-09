# Feature 3: LK (Luku Knockout) Battles — Dual Streamer Co-Hosting & Match System

Depends on Feature 1 (`live_streams`) and Feature 4 (gift/coin transactions — battle score is driven
by gifts sent during the battle window). Rebranded PK Battles → **LK Battles** throughout, including
any user-facing strings/enums.

## Flow (behavior only)

1. **Invite**: a live broadcaster (initiator) invites another currently-live broadcaster (opponent)
   to a battle. Invite has a short expiry (e.g. 30–60s) — if not accepted in time it lapses.
2. **Accept/decline**: opponent accepts → battle starts; declines or expires → invite closes, no
   battle created (no need to persist declined/expired invites as their own rows — see 3.2).
3. **Battle starts**: both broadcasters' existing ZegoCloud rooms (already live independently per
   Feature 1) get cross-room mixed into a 50/50 split-screen for viewers of either stream — this
   uses ZegoCloud's room-mixing/co-host API against the two **existing** `live_streams.zego_room_id`
   values; no new/third room needs to be created or persisted.
4. **Match timer**: initiator picks a preset duration (e.g. 180s or 300s) when starting the battle.
   Both sides see a synchronized countdown, driven by `lk_battles.started_at + duration_seconds`
   (compute client-side from those two fields — don't need a server tick pushing time updates).
5. **Scoring**: any gift sent by a viewer to either broadcaster *while the battle is active* counts
   toward that broadcaster's battle score, in addition to normal gift/wallet crediting (Feature 4).
   Each such gift updates that side's running total (see `lk_battle_scores`) — this must be a real
   write per gift (not batched like reaction taps in Feature 2), since it's tied to the same
   real-money gift transaction Feature 4 already persists.
6. **Progress bar**: viewers see a live bar reflecting each side's current score vs the other —
   driven by realtime broadcast of score updates, with `lk_battle_scores` as the durable source those
   updates come from.
7. **Battle ends** (timer expiry): compare final scores → higher score wins → victory/defeat screen
   shown to both sides and viewers → `lk_battles` updated with `status='ended'`, `winner_stream_id`,
   `ended_at`.
8. **Penalty**: winner is prompted to either assign a fun penalty task to the loser or skip it. This
   is a lightweight, mostly cosmetic on-screen animation/banner — persisted only as free text +
   status so it's visible in battle history, not a structured task system.
9. **Return to normal**: rooms un-mix; both broadcasters go back to solo (or, if either had been
   dual-co-hosting outside of a scored battle — out of scope here, treat as future extension)
   streaming without dropping viewers.

## Entities

### `lk_battles` — one row per battle attempt (from invite onward)
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| initiator_stream_id | uuid FK → live_streams | who sent the invite |
| opponent_stream_id | uuid FK → live_streams, nullable | null until accepted |
| status | enum: invited, live, ended, declined, expired, cancelled | |
| duration_seconds | int | preset chosen at invite time, e.g. 180 or 300 |
| invited_at | timestamptz | |
| started_at | timestamptz null | set on accept |
| ended_at | timestamptz null | |
| winner_stream_id | uuid FK → live_streams, nullable | null until ended; null also on a tie (see open Qs) |
| penalty_text | text null | winner's chosen task, if assigned |
| penalty_status | enum: assigned, skipped, null | |

### `lk_battle_scores` — exactly 2 rows per battle once it goes live (one per stream)
| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| battle_id | uuid FK → lk_battles | |
| stream_id | uuid FK → live_streams | which side this row is for |
| points | bigint default 0 | sum of gift point-values received on this side during the battle window |
| updated_at | timestamptz | |

Points here should mirror whatever point/gem value Feature 4 assigns per gift — this table doesn't
redefine gift values, it just accumulates them for the battle window. A unique constraint on
`(battle_id, stream_id)` keeps it to one running-total row per side (avoid one row per gift here —
that ledger already lives in Feature 4's gift transaction table).

## ZegoCloud mapping
- No new room is created for a battle. `lk_battles` references the two existing
  `live_streams.zego_room_id`s (via `initiator_stream_id` / `opponent_stream_id`) and the client
  calls ZegoCloud's cross-room/co-host mixing API with those two room IDs directly.
- On battle end, un-mix using the same two room IDs; each stream's original room keeps running
  independently (their `live_streams` rows are untouched by this feature — battles don't end or
  restart the underlying stream).

## Real-time vs historical
1. **Real-time only**:
   - Countdown timer — computed client-side from `started_at + duration_seconds`.
   - Progress bar animation — driven by broadcast of score updates, not polling.
   - Video mixing/split-screen itself — pure ZegoCloud SDK/media layer, nothing to persist.
2. **Historical / durable**:
   - `lk_battles` — every battle attempt (including declined/expired, useful for abuse/rate-limit
     checks — e.g. spam-inviting).
   - `lk_battle_scores` — running totals, updated per qualifying gift (real write, not batched,
     since it must match Feature 4's ledger exactly).

## Actions/events → writes
| Event | Trigger | Writes |
|---|---|---|
| Invite sent | initiator picks opponent + duration | INSERT lk_battles (status='invited') |
| Invite accepted | opponent accepts | UPDATE status='live', started_at=now(), set opponent_stream_id if not already set; INSERT 2 lk_battle_scores rows (points=0) |
| Invite declined/expired | opponent declines / timeout | UPDATE status='declined' or 'expired' |
| Gift sent during battle | viewer gifts a battling broadcaster (Feature 4 flow) | Feature 4 writes its own gift/ledger row; this feature additionally does UPDATE lk_battle_scores (points += gift_points) for that side; broadcast new totals |
| Battle timer expires | duration elapsed | UPDATE lk_battles: status='ended', ended_at, winner_stream_id (higher points) |
| Penalty chosen | winner picks task or skips | UPDATE lk_battles: penalty_text, penalty_status |

## Relationships
- `live_streams` 1→many `lk_battles` (as initiator) and 1→many (as opponent) — a stream can battle
  multiple times sequentially, but application logic should prevent a stream being in two `status=
  'live'` battles at once.
- `lk_battles` 1→2 `lk_battle_scores`.
- Each qualifying `lk_battle_scores` update is driven by a gift transaction owned by Feature 4 — this
  feature does not duplicate the gift/coin ledger, only the battle-scoped point tally.

## Open questions for client
1. Tie handling: if both sides end with equal points, is `winner_stream_id` left null with a "draw"
   result, or is there a tiebreaker rule?
2. Can either broadcaster cancel a battle mid-way (before timer ends)? If so, what happens to score/
   winner (voided, or scored as-is at cancel time)?
3. Rate limiting: any cooldown between battles for the same broadcaster, or max invites per hour?
4. Does declining/ignoring invites repeatedly need to feed into Feature 5 (moderation/abuse) at some
   threshold?
