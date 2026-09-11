-- ============================================================================
-- Migration 03 of 05 — LK (Luku Knockout) Battles + CO-HOSTING
-- Feature: dual-streamer scored match system (specs/archive/03-lk-battles.md — archived, outdated) and co-hosting —
--          two live streams linked 50/50 with no timer / score / winner / penalty
--          (no spec file; flow approved by the user 2026-09-11).
--
-- CREATES
--   enums     : public.lk_battle_status, public.lk_penalty_status,
--               public.lk_battle_end_method, public.lk_battle_end_request_status,
--               public.live_cohost_status, public.live_cohost_end_method
--   tables    : public.lk_battles, public.lk_battle_scores,
--               public.lk_battle_end_requests,
--               public.live_cohost_sessions
--   columns   : public.lk_battles.cohost_session_id  (OUR table, added idempotently)
--   functions : public.lk_battles_assert_single_active()   (trigger guard, shared by
--                                                          lk_battles AND live_cohost_sessions)
--               public.lk_pairing_invite_guard_internal(text, uuid, uuid, uuid, uuid)
--                                                         -> timestamptz [private, no grants]
--               public.lk_battle_invite(uuid, uuid, int) -> uuid
--               public.lk_battle_accept(uuid)             -> uuid
--               public.lk_battle_decline(uuid)            -> uuid
--               public.lk_battle_cancel(uuid)             -> uuid   (invites only)
--               public.lk_battle_finish_internal(uuid, lk_battle_end_method, text)
--                                                         -> uuid   [private, no grants]
--               public.lk_battle_settle_internal(uuid)    -> uuid   [private, no grants]
--               public.lk_battle_settle(uuid)             -> uuid
--               public.lk_battle_end_early(uuid)          -> uuid   (host)
--               public.lk_battle_surrender(uuid)          -> uuid   (co-host)
--               public.lk_battle_request_end(uuid)        -> uuid   (co-host)
--               public.lk_battle_respond_end_request(uuid, boolean) -> uuid (host)
--               public.lk_battle_set_penalty(uuid, text, public.lk_penalty_status) -> uuid
--               public.lk_battle_add_points(uuid, bigint) -> uuid   <-- CONTRACT for file 04
--               public.lk_battles_expire_stale()          -> integer (cron sweep)
--               public.lk_battles_settle_due()            -> integer (cron sweep)
--               public.lk_battle_on_stream_ended(uuid)    -> integer [private, no grants]
--                                                         (called by file 01's
--                                                          live_stream_end_internal)
--               public.live_cohost_invite(uuid, uuid)     -> uuid   (host = inviter)
--               public.live_cohost_accept(uuid)           -> uuid   (co-host = invitee)
--               public.live_cohost_decline(uuid)          -> uuid   (co-host)
--               public.live_cohost_cancel(uuid)           -> uuid   (host, invites only)
--               public.live_cohost_end(uuid)              -> uuid   (either participant)
--               public.live_cohost_on_stream_ended(uuid)  -> integer [private, no grants]
--                                                         (called by file 01 AFTER the
--                                                          battle hook)
--               public.live_cohost_active_session(uuid)   -> uuid   [private, no grants]
--                                                         <-- used by file 04 (gift_send)
--                                                             and file 06
--   schedules : pg_cron jobs 'lk_battles_expire_stale' and 'lk_battles_settle_due'
--               (every minute) — only if pg_cron is installed, see section 9.
--               *** USER APPROVED 2026-09-10 *** (the expire job also lapses co-host
--               invites since 2026-09-11)
--
-- ROLES IN A BATTLE
--   host    = broadcaster of initiator_stream_id (sent the invite)
--   co-host = broadcaster of opponent_stream_id  (accepted the invite)
--
-- HOW A BATTLE CAN END (user approved 2026-09-10) — recorded in lk_battles.end_method
--   timer                : ends_at reached; decided by score (equal = draw).
--   host_ended           : host ended it early (lk_battle_end_early); decided by the
--                          CURRENT score (equal = draw).
--   end_request_accepted : co-host asked (lk_battle_request_end), host accepted;
--                          decided by the CURRENT score (equal = draw).
--   cohost_surrendered   : co-host gave up (lk_battle_surrender); HOST WINS regardless
--                          of score.
--   cohost_left          : co-host's stream ended mid-battle; HOST WINS.
--   host_left            : host's stream ended mid-battle; decided by the CURRENT score.
--   Nobody can "cancel" a live battle any more; lk_battle_cancel() only withdraws an
--   invite that has not been accepted yet. Every path goes through ONE function,
--   lk_battle_finish_internal(), so the outcome rule lives in exactly one place.
--
-- INVITE ANTI-SPAM (lk_battle_invite AND live_cohost_invite — one shared helper,
-- lk_pairing_invite_guard_internal, so the two invite kinds cannot be alternated to spam)
--   * the same inviter may not re-invite the same person within 2 minutes of a
--     declined / expired / cancelled invite from that inviter to that person —
--     battle and co-host invites BOTH count;
--   * at most 20 invites per inviter per rolling hour — battle and co-host invites
--     COMBINED.
--   Keyed on PEOPLE (initiator_host_user_id / opponent_host_user_id, and
--   host_user_id / cohost_user_id on co-host sessions), not streams, because a
--   broadcaster gets a new live_streams id every time they go live.
--
-- CO-HOSTING (user approved 2026-09-11) — public.live_cohost_sessions
--   Two DIFFERENT broadcasters, BOTH already live, link their existing streams 50/50
--   (the client mixes the two existing zego rooms, exactly like a battle; no new room).
--   No timer, no score, no winner, no penalty.
--     host    = broadcaster of host_stream_id   (sent the co-host invite)
--     co-host = broadcaster of cohost_stream_id (accepted it)
--   Invite / 60-second TTL / accept / decline / withdraw / anti-spam work exactly like
--   battle invites. Either participant can end the co-hosting (live_cohost_end) — their
--   streams keep running solo. A stream ending in any way (host end, 2-minute disconnect
--   sweep, moderation ban) ends the session through file 01's hook, AFTER the battle hook,
--   so battle rules apply first.
--   BATTLES INSIDE CO-HOSTING: while the session is live, host and co-host may battle each
--   other (either may invite; the battle inviter is the battle host, all battle rules
--   unchanged). Such a battle carries lk_battles.cohost_session_id. When it ends (any way)
--   the session is untouched and stays live, so the app returns to plain co-hosting.
--   live_cohost_end refuses while that battle is live (a pending battle invite is withdrawn).
--
-- ONE ACTIVE PAIRING PER STREAM (both tables, one trigger function):
--   * an active co-host session (invited/live) never coexists with another active
--     session or with any active battle on either of its streams;
--   * an active battle never coexists with another active battle on either stream, and
--     coexists with a co-host session ONLY when that session is LIVE, is between the SAME
--     two streams and lk_battles.cohost_session_id points at it;
--   * so a stream with a pending co-host invite is busy for battles, and vice versa.
--   Enforced by lk_battles_assert_single_active() on BOTH tables (sorted advisory locks on
--   the stream ids), on top of the per-column partial unique indexes.
--
-- LOCK ORDER (deadlock avoidance) — every function in this file takes locks in this order:
--   1. the LIVE co-host session row  (FOR SHARE by battle invite/accept; FOR NO KEY UPDATE
--      by live_cohost_end and the stream-ended hook);
--   2. the inviter advisory lock ('lk_battle_invite_host:<uid>');
--   3. lk_battles rows;
--   4. invited (not yet live) live_cohost_sessions rows;
--   5. the stream-id advisory locks taken by the trigger.
--   Session rows are locked FOR NO KEY UPDATE (never FOR UPDATE) so that the FOR KEY SHARE
--   lock taken by every gift_transactions / lk_battles foreign-key check never waits on a
--   session state change — a gift can never deadlock against "end co-hosting".
--
-- MUST RUN AFTER : 20260910_01_live_streaming_core.sql by convention (it only needs
--                  the PRE-EXISTING public.live_streams, public.user_roles /
--                  public.has_role() and public.update_updated_at_column()).
--                  File 01 calls lk_battle_on_stream_ended() and then
--                  live_cohost_on_stream_ended() DYNAMICALLY, only if they exist, so
--                  neither file hard-depends on the other.
-- MUST RUN BEFORE: 20260910_04_economy* — its atomic gift RPC calls
--                  public.lk_battle_add_points(p_live_stream_id, p_points) and
--                  public.live_cohost_active_session(p_live_stream_id).
--
-- PURE EXTENSION: no ALTER / DROP / RENAME against any pre-existing table, and
-- no policy on any pre-existing table is created, changed or removed.
--
-- SAFE TO RE-RUN: fully idempotent (guarded enums, create ... if not exists,
-- create or replace function, drop policy/trigger if exists before create,
-- unschedule-then-schedule cron jobs).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. ENUMs
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.lk_battle_status as enum (
    'invited',    -- invite sent, waiting on the opponent (lapses at invite_expires_at)
    'live',       -- accepted, rooms mixed, timer running
    'ended',      -- finished and the result has been settled (see end_method for HOW)
    'declined',   -- opponent explicitly refused
    'expired',    -- opponent never answered before invite_expires_at, or the
                  -- opponent's stream ended while the invite was open
    'cancelled'   -- the host withdrew the invite (or the host's stream ended)
                  -- BEFORE it was accepted. A live battle can never be cancelled.
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.lk_penalty_status as enum ('assigned', 'skipped');
exception when duplicate_object then null;
end $$;

-- HOW an ended battle ended. Set exactly when lk_battles.status = 'ended'.
do $$
begin
  create type public.lk_battle_end_method as enum (
    'timer',                 -- ends_at reached; decided by score
    'host_ended',            -- host ended it early; decided by current score
    'end_request_accepted',  -- co-host asked, host accepted; decided by current score
    'cohost_surrendered',    -- co-host surrendered; host wins regardless of score
    'cohost_left',           -- co-host's stream ended mid-battle; host wins
    'host_left'              -- host's stream ended mid-battle; decided by current score
  );
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.lk_battle_end_request_status as enum (
    'pending',   -- waiting for the host's answer (lapses at expires_at)
    'accepted',  -- host accepted; the battle was ended by current score
    'declined',  -- host said no; the battle continues
    'expired'    -- nobody answered in time, or the battle ended some other way first
  );
exception when duplicate_object then null;
end $$;

comment on type public.lk_battle_status is
  'Lifecycle of an LK Battle. invited/live are the only "active" states and are the ones '
  'covered by the one-active-battle-per-stream partial unique indexes.';
comment on type public.lk_penalty_status is
  'Whether the winning host assigned a fun penalty task to the loser, or skipped it.';
comment on type public.lk_battle_end_method is
  'How an ended LK battle ended. Written only by lk_battle_finish_internal(). The co-host '
  'exits (cohost_surrendered, cohost_left) always make the host (initiator) the winner.';
comment on type public.lk_battle_end_request_status is
  'State of a co-host''s "please end the battle" request (lk_battle_end_requests).';

-- CO-HOSTING lifecycle. Same shape as lk_battle_status on purpose (same invite flow).
do $$
begin
  create type public.live_cohost_status as enum (
    'invited',    -- co-host invite sent, waiting on the invitee (lapses at invite_expires_at)
    'live',       -- accepted: the two streams are linked 50/50
    'ended',      -- the link was broken (see end_method for HOW)
    'declined',   -- the invitee refused
    'expired',    -- the invitee never answered in time, or the invitee's stream ended
                  -- while the invite was open
    'cancelled'   -- the host withdrew the invite, or the host's stream ended, BEFORE it
                  -- was accepted
  );
exception when duplicate_object then null;
end $$;

-- HOW a live co-host session ended. Set exactly when live_cohost_sessions.status = 'ended'.
do $$
begin
  create type public.live_cohost_end_method as enum (
    'host_ended',    -- the host pressed "end co-hosting" (both streams keep running solo)
    'cohost_ended',  -- the co-host pressed "end co-hosting"
    'host_left',     -- the host's whole stream ended (end, disconnect sweep, ban)
    'cohost_left'    -- the co-host's whole stream ended
  );
exception when duplicate_object then null;
end $$;

comment on type public.live_cohost_status is
  'Lifecycle of a co-host session (live_cohost_sessions). invited/live are the only "active" '
  'states and are the ones covered by the one-active-pairing-per-stream guard.';
comment on type public.live_cohost_end_method is
  'How a live co-host session ended. There is no winner in co-hosting; this only records who '
  'broke the link and whether it was a button press (*_ended) or a stream ending (*_left).';

-- ---------------------------------------------------------------------------
-- 2. TABLE public.lk_battles
-- ---------------------------------------------------------------------------
-- One row per battle ATTEMPT (from invite onward). Declined / expired / cancelled
-- invites are kept on purpose: they are the raw material for the invite
-- anti-spam rules in lk_battle_invite() and for Feature 5 abuse signals.

create table if not exists public.lk_battles (
  id                   uuid primary key default gen_random_uuid(),

  initiator_stream_id  uuid not null
                         references public.live_streams(id) on delete cascade,
  opponent_stream_id   uuid
                         references public.live_streams(id) on delete cascade,
  winner_stream_id     uuid
                         references public.live_streams(id) on delete cascade,

  -- The two PEOPLE, copied from live_streams.host_user_id at invite time.
  -- See the column comments for why these are denormalised.
  initiator_host_user_id uuid
                         references auth.users(id) on delete set null,
  opponent_host_user_id  uuid
                         references auth.users(id) on delete set null,

  status               public.lk_battle_status not null default 'invited',

  -- Settled outcome. Kept as constrained text (not an enum) because the
  -- ownership map for this migration set allocates only two enums to file 03.
  result               text
                         check (result in ('initiator_win','opponent_win','draw')),

  -- HOW the battle ended. NULL until status = 'ended'.
  end_method           public.lk_battle_end_method,

  duration_seconds     integer not null
                         check (duration_seconds > 0 and duration_seconds <= 3600),

  invited_at           timestamptz not null default now(),
  invite_expires_at    timestamptz not null default (now() + interval '60 seconds'),
  started_at           timestamptz,
  ends_at              timestamptz,
  ended_at             timestamptz,

  penalty_text         text
                         check (penalty_text is null
                                or length(btrim(penalty_text)) between 1 and 280),
  penalty_status       public.lk_penalty_status,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- A stream can never fight itself.
  constraint lk_battles_distinct_sides_chk
    check (opponent_stream_id is null or opponent_stream_id <> initiator_stream_id),

  -- Once accepted there must be a real opponent and a real timer window.
  constraint lk_battles_live_shape_chk
    check (
      status <> 'live'
      or (opponent_stream_id is not null and started_at is not null and ends_at is not null)
    ),

  -- ends_at is a stored copy of started_at + duration_seconds (see column comment).
  constraint lk_battles_ends_at_shape_chk
    check ((started_at is null) = (ends_at is null)),

  -- "not settled yet" (result IS NULL) must be distinguishable from
  -- "settled, and it was a draw" (result = 'draw'). Only an ended battle has a
  -- result; there is no "void" outcome any more (a live battle cannot be cancelled).
  constraint lk_battles_result_status_chk
    check (
      case status
        when 'ended' then result in ('initiator_win','opponent_win','draw')
        else              result is null
      end
    ),

  -- end_method is set exactly when the battle has ended.
  constraint lk_battles_end_method_status_chk
    check ((status = 'ended') = (end_method is not null)),

  -- A co-host exit (surrender / leaving) always hands the win to the host.
  constraint lk_battles_end_method_result_chk
    check (
      end_method is null
      or end_method not in ('cohost_surrendered', 'cohost_left')
      or result = 'initiator_win'
    ),

  -- winner_stream_id must agree with result.
  constraint lk_battles_winner_matches_result_chk
    check (
      case
        when result = 'initiator_win' then winner_stream_id is not null
                                       and winner_stream_id = initiator_stream_id
        when result = 'opponent_win'  then winner_stream_id is not null
                                       and winner_stream_id = opponent_stream_id
        else                               winner_stream_id is null
      end
    ),

  -- ended_at = "the moment this row left the active states", so it is set for
  -- EVERY terminal status (ended, declined, expired, cancelled) and for none of
  -- the active ones. The invite pair-cooldown reads it (see lk_battle_invite).
  constraint lk_battles_ended_at_shape_chk
    check ((status in ('invited','live')) = (ended_at is null)),

  -- A penalty only exists after a decided battle, and 'assigned' needs text.
  constraint lk_battles_penalty_shape_chk
    check (
      penalty_status is null
      or (status = 'ended'
          and winner_stream_id is not null
          and (penalty_status <> 'assigned' or penalty_text is not null))
    ),
  constraint lk_battles_penalty_text_requires_status_chk
    check (penalty_text is null or penalty_status is not null)
);

comment on table public.lk_battles is
  'LK (Luku Knockout) Battles: one row per battle attempt between two already-live '
  'streams. No new ZegoCloud room is created — the client mixes the two existing '
  'live_streams.zego_room_id values. All writes go through the lk_battle_* SECURITY '
  'DEFINER RPCs; there are deliberately no client INSERT/UPDATE/DELETE policies.';

comment on column public.lk_battles.initiator_stream_id is
  'live_streams.id of the HOST (the broadcaster who sent the invite).';
comment on column public.lk_battles.opponent_stream_id is
  'live_streams.id of the CO-HOST (the invited broadcaster). Always set from invite time in '
  'the current flow; kept nullable per spec so a future "open challenge" flow can reuse the row.';
comment on column public.lk_battles.initiator_host_user_id is
  'Host (inviter) person, copied from live_streams.host_user_id by lk_battle_invite() and never '
  'changed afterwards. Denormalised on purpose: a broadcaster gets a NEW live_streams id every '
  'time they go live, so the invite anti-spam rules (pair cooldown, hourly cap) and a person''s '
  'battle history must key on the person, not the stream. Also used by the host/co-host checks '
  'of the end-of-battle RPCs. ON DELETE SET NULL keeps the battle row when an account is deleted.';
comment on column public.lk_battles.opponent_host_user_id is
  'Co-host (invited) person, copied from live_streams.host_user_id by lk_battle_invite(). Same '
  'reasoning as initiator_host_user_id.';
comment on column public.lk_battles.winner_stream_id is
  'NULL until settled AND on a draw. Use the result column to tell those two apart.';
comment on column public.lk_battles.result is
  'NULL = not settled (or the invite never became a battle). initiator_win / opponent_win / '
  'draw = settled outcome of an ended battle.';
comment on column public.lk_battles.end_method is
  'HOW the battle ended (timer, host_ended, end_request_accepted, cohost_surrendered, '
  'cohost_left, host_left). Set exactly when status = ''ended''; NULL otherwise.';
comment on column public.lk_battles.ended_at is
  'When this row left the active states: the settlement instant for an ended battle (ends_at '
  'itself for a timer end), or when the invite was declined / expired / cancelled. NULL while '
  'invited or live.';
comment on column public.lk_battles.invite_expires_at is
  'Invites lapse if not accepted by this instant. Enforced inside lk_battle_accept() and '
  'swept to status = ''expired'' by lk_battles_expire_stale().';
comment on column public.lk_battles.ends_at is
  'Stored started_at + duration_seconds, written once by lk_battle_accept(). It is NOT a '
  'generated column because timestamptz + interval is only STABLE, not IMMUTABLE. Storing '
  'it makes the per-gift lk_battle_add_points() check a single indexed timestamp compare '
  'instead of an interval computation per candidate row.';
comment on column public.lk_battles.duration_seconds is
  'Preset chosen by the initiator (product presets are 180 / 300). The client renders the '
  'synchronized countdown from started_at + duration_seconds; no server tick is needed.';

-- ---------------------------------------------------------------------------
-- 3. TABLE public.lk_battle_scores
-- ---------------------------------------------------------------------------
-- Exactly two rows per battle, created atomically by lk_battle_accept().
-- This is a running TOTAL, not a ledger — the per-gift ledger is Feature 4's
-- gift_transactions. These numbers mirror real money and must never be
-- client-writable.

create table if not exists public.lk_battle_scores (
  id          uuid primary key default gen_random_uuid(),
  battle_id   uuid not null references public.lk_battles(id)   on delete cascade,
  stream_id   uuid not null references public.live_streams(id) on delete cascade,
  points      bigint not null default 0 check (points >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint lk_battle_scores_battle_stream_uniq unique (battle_id, stream_id)
);

comment on table public.lk_battle_scores is
  'Running point total per side for one battle. Exactly two rows per live battle. Written '
  'ONLY by public.lk_battle_add_points(), which Feature 4''s atomic gift RPC calls inside '
  'the same transaction as the gift ledger insert. No client write policy and no client '
  'write grant exists on this table, by design.';
comment on column public.lk_battle_scores.points is
  'Sum of gift_catalog.point_value for gifts received on this side inside the battle '
  'window. Mirrors Feature 4''s ledger; monotonically increasing.';

-- ---------------------------------------------------------------------------
-- 3b. TABLE public.lk_battle_end_requests
-- ---------------------------------------------------------------------------
-- The co-host cannot end a battle. One of their two options is to ASK the host
-- (lk_battle_request_end); the host's app gets an Accept / Decline popup through
-- realtime and answers with lk_battle_respond_end_request. A request lapses after
-- 30 seconds. At most ONE pending request per battle (partial unique index below),
-- and after a declined / expired request the co-host waits 60 seconds before
-- asking again, so the popup cannot be used to spam the host.
-- RPC-only: no client INSERT/UPDATE/DELETE policy or grant.

create table if not exists public.lk_battle_end_requests (
  id                    uuid primary key default gen_random_uuid(),
  battle_id             uuid not null
                          references public.lk_battles(id) on delete cascade,
  requested_by_user_id  uuid
                          references auth.users(id) on delete set null,
  status                public.lk_battle_end_request_status not null default 'pending',
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null default (now() + interval '30 seconds'),
  responded_at          timestamptz,

  constraint lk_battle_end_requests_expiry_chk
    check (expires_at > created_at),

  -- responded_at = the host's answer time, so it exists exactly for accepted/declined.
  -- An expired request was never answered; its close time is expires_at (or the
  -- battle's ended_at, when the battle ended some other way first).
  constraint lk_battle_end_requests_responded_chk
    check ((status in ('accepted','declined')) = (responded_at is not null))
);

comment on table public.lk_battle_end_requests is
  'A co-host''s "please end the battle" request to the host. Written ONLY by '
  'lk_battle_request_end() / lk_battle_respond_end_request() / lk_battle_finish_internal() / '
  'lk_battles_expire_stale(). Readable by the two participating broadcasters and admins. '
  'A row that is still ''pending'' after expires_at is treated as expired everywhere, and is '
  'flipped to ''expired'' by the next request on that battle or by the cron sweep.';
comment on column public.lk_battle_end_requests.requested_by_user_id is
  'The co-host who asked (always lk_battles.opponent_host_user_id at request time). Used for '
  'the 60-second re-ask cooldown. ON DELETE SET NULL keeps the row if the account is deleted.';
comment on column public.lk_battle_end_requests.expires_at is
  'created_at + 30 seconds. After this the host can no longer accept it.';
comment on column public.lk_battle_end_requests.responded_at is
  'When the host accepted or declined. NULL while pending and for expired requests.';

-- ---------------------------------------------------------------------------
-- 3c. TABLE public.live_cohost_sessions — CO-HOSTING (user approved 2026-09-11)
-- ---------------------------------------------------------------------------
-- One row per co-host ATTEMPT (from invite onward), exactly like lk_battles: declined /
-- expired / cancelled invites are kept because the shared invite anti-spam reads them.
-- No score table, no timer, no result: co-hosting is just "these two live streams are
-- linked 50/50". The ZegoCloud mixing uses the two existing live_streams.zego_room_id
-- values. Chat, hearts, shares, viewers and moderation stay per stream (files 01/02/05/06);
-- gifts carry gift_transactions.cohost_session_id (file 04).
-- RPC-only: no client INSERT/UPDATE/DELETE policy or grant.

create table if not exists public.live_cohost_sessions (
  id                 uuid primary key default gen_random_uuid(),

  host_stream_id     uuid not null
                       references public.live_streams(id) on delete cascade,
  cohost_stream_id   uuid not null
                       references public.live_streams(id) on delete cascade,

  -- The two PEOPLE, copied from live_streams.host_user_id at invite time (same reasoning
  -- as lk_battles.initiator_host_user_id: anti-spam and history key on people).
  host_user_id       uuid
                       references auth.users(id) on delete set null,
  cohost_user_id     uuid
                       references auth.users(id) on delete set null,

  status             public.live_cohost_status not null default 'invited',

  invited_at         timestamptz not null default now(),
  invite_expires_at  timestamptz not null default (now() + interval '60 seconds'),
  started_at         timestamptz,
  ended_at           timestamptz,
  ended_by_user_id   uuid
                       references auth.users(id) on delete set null,
  end_method         public.live_cohost_end_method,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Two different streams ...
  constraint live_cohost_sessions_distinct_streams_chk
    check (host_stream_id <> cohost_stream_id),

  -- ... owned by two different people. (NULL-tolerant only because of ON DELETE SET NULL;
  -- live_cohost_invite always writes both.)
  constraint live_cohost_sessions_distinct_users_chk
    check (host_user_id is null or cohost_user_id is null or host_user_id <> cohost_user_id),

  constraint live_cohost_sessions_invite_window_chk
    check (invite_expires_at > invited_at),

  -- started_at exists exactly for sessions that were accepted (live, and later ended).
  constraint live_cohost_sessions_started_shape_chk
    check ((status in ('live', 'ended')) = (started_at is not null)),

  -- ended_at = "the moment this row left the active states": set for EVERY terminal
  -- status (ended, declined, expired, cancelled), for none of the active ones — the same
  -- rule as lk_battles, and the pair cooldown reads it.
  constraint live_cohost_sessions_ended_at_shape_chk
    check ((status in ('invited', 'live')) = (ended_at is null)),

  constraint live_cohost_sessions_ended_after_start_chk
    check (ended_at is null or started_at is null or ended_at >= started_at),

  -- end_method is set exactly when the session has ended.
  constraint live_cohost_sessions_end_method_status_chk
    check ((status = 'ended') = (end_method is not null)),

  -- ended_by_user_id = the person who pressed a button: the invitee (declined), the host
  -- (cancelled via live_cohost_cancel) or the participant who pressed "end co-hosting".
  -- NULL for expiries and for stream-ended closes (*_left, cancelled/expired by the hook).
  constraint live_cohost_sessions_ended_by_shape_chk
    check (
      ended_by_user_id is null
      or status in ('declined', 'cancelled')
      or (status = 'ended' and end_method in ('host_ended', 'cohost_ended'))
    )
);

comment on table public.live_cohost_sessions is
  'CO-HOSTING: one row per co-host attempt between two already-live streams owned by two '
  'different broadcasters, linked 50/50 with no timer / score / winner / penalty. No new '
  'ZegoCloud room — the client mixes the two existing live_streams.zego_room_id values, like an '
  'LK battle. All writes go through the live_cohost_* SECURITY DEFINER RPCs (and file 01''s '
  'stream-ended hook); there are deliberately no client INSERT/UPDATE/DELETE policies.';
comment on column public.live_cohost_sessions.host_stream_id is
  'live_streams.id of the HOST (the broadcaster who sent the co-host invite).';
comment on column public.live_cohost_sessions.cohost_stream_id is
  'live_streams.id of the CO-HOST (the invited broadcaster who accepted).';
comment on column public.live_cohost_sessions.host_user_id is
  'Host (inviter) person, copied from live_streams.host_user_id by live_cohost_invite() and never '
  'changed. Keys the shared invite anti-spam (pair cooldown, hourly cap), the participant checks '
  'and participant read access. ON DELETE SET NULL keeps the row when an account is deleted.';
comment on column public.live_cohost_sessions.cohost_user_id is
  'Co-host (invitee) person, copied from live_streams.host_user_id by live_cohost_invite(). Same '
  'reasoning as host_user_id.';
comment on column public.live_cohost_sessions.invite_expires_at is
  'Invites lapse if not accepted by this instant (60 seconds, the same TTL as battle invites). '
  'Enforced inside live_cohost_accept() and swept to status = ''expired'' by '
  'lk_battles_expire_stale().';
comment on column public.live_cohost_sessions.started_at is
  'When the invite was accepted and the two streams were linked. NULL for sessions that never started.';
comment on column public.live_cohost_sessions.ended_at is
  'When this row left the active states: the end of a live session, or when the invite was '
  'declined / expired / cancelled. NULL while invited or live.';
comment on column public.live_cohost_sessions.ended_by_user_id is
  'Who pressed the button that closed this row (decline, withdraw, end co-hosting). NULL when it '
  'closed by itself (expiry) or because a stream ended.';
comment on column public.live_cohost_sessions.end_method is
  'HOW a live session ended (host_ended, cohost_ended, host_left, cohost_left). Set exactly when '
  'status = ''ended''; NULL otherwise.';

-- ---------------------------------------------------------------------------
-- 3d. lk_battles.cohost_session_id — a battle fought INSIDE a co-host session
-- ---------------------------------------------------------------------------
-- lk_battles is OUR table (created above), so adding a column is allowed. Added with
-- ADD COLUMN IF NOT EXISTS (plain) + a guarded, named FK so a re-run is a no-op.
-- Set by lk_battle_invite() when the initiator's stream is in a LIVE co-host session;
-- never changed afterwards (except ON DELETE SET NULL). The battle itself behaves exactly
-- like any other battle; the link only tells the app "when this battle ends, go back to
-- co-hosting" and lets the one-active-pairing guard allow the overlap.
alter table public.lk_battles
  add column if not exists cohost_session_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.lk_battles'::regclass
                    and conname  = 'lk_battles_cohost_session_id_fkey') then
    alter table public.lk_battles
      add constraint lk_battles_cohost_session_id_fkey
      foreign key (cohost_session_id) references public.live_cohost_sessions(id)
      on delete set null;
  end if;
end $$;

comment on column public.lk_battles.cohost_session_id is
  'Non-NULL when this battle was started INSIDE a live co-host session (live_cohost_sessions.id) '
  'between the same two streams. Written once by lk_battle_invite(). The battle''s rules are '
  'unchanged; when it ends (any way) the session stays live and the app returns to co-hosting. '
  'The one-active-pairing guard only allows a battle and a co-host session on the same streams '
  'when this column points at that live session.';

-- ---------------------------------------------------------------------------
-- 4. INDEXES
-- ---------------------------------------------------------------------------

-- 4a. THE INVARIANT AND THE HOT PATH, in one structure.
--
-- The spec says "application logic should prevent a stream being in two live
-- battles at once". We enforce it in the DATABASE instead, because:
--   * three different writers touch these rows (initiator app, opponent app,
--     scheduled sweep) and a client-side SELECT-then-INSERT is a textbook
--     TOCTOU race — two invites arriving in the same millisecond both pass the
--     check and both insert;
--   * PostgREST exposes this schema directly, so any bug or hand-rolled call
--     can bypass app logic, while a unique index is enforced by the storage
--     engine itself and cannot be bypassed at all;
--   * lk_battle_add_points() must resolve "the one active battle for this
--     stream" on EVERY gift. If two active battles could exist, that lookup is
--     ambiguous and real-money points would be scored into the wrong match.
--
-- These two partial unique indexes double as the read index for that hot lookup
-- (status = 'live' AND initiator/opponent = $1) — one structure, both jobs.
create unique index if not exists lk_battles_active_initiator_uniq
  on public.lk_battles (initiator_stream_id)
  where status in ('invited', 'live');

create unique index if not exists lk_battles_active_opponent_uniq
  on public.lk_battles (opponent_stream_id)
  where status in ('invited', 'live');

-- 4b. Battle history for one stream. Two indexes because a stream can sit on
--     either side. (Per-PERSON history uses the host-id indexes in 4f.)
create index if not exists lk_battles_initiator_history_idx
  on public.lk_battles (initiator_stream_id, invited_at desc);

create index if not exists lk_battles_opponent_history_idx
  on public.lk_battles (opponent_stream_id, invited_at desc)
  where opponent_stream_id is not null;

-- 4c. Expiry sweep: tiny partial index, so lk_battles_expire_stale() costs
--     roughly the number of actually-due rows, not a full scan.
create index if not exists lk_battles_expiry_sweep_idx
  on public.lk_battles (invite_expires_at)
  where status = 'invited';

-- 4d. Settlement sweep: same idea for battles whose timer has run out.
create index if not exists lk_battles_settle_sweep_idx
  on public.lk_battles (ends_at)
  where status = 'live';

-- 4e. Score lookup for the per-gift update target. Lookup by battle_id alone
--     (the progress bar reading both sides) is already served by the leading
--     column of lk_battle_scores_battle_stream_uniq, so no extra index for it.
create index if not exists lk_battle_scores_stream_idx
  on public.lk_battle_scores (stream_id);

-- 4f. PEOPLE-keyed history + invite anti-spam. These also serve the ON DELETE
--     SET NULL of the two auth.users FKs (leading column).
--     * initiator side: "invites this host sent in the last hour" (hourly cap)
--       and "battles this person started" (history);
create index if not exists lk_battles_initiator_host_history_idx
  on public.lk_battles (initiator_host_user_id, invited_at desc)
  where initiator_host_user_id is not null;

--     * opponent side: "battles this person was invited to" (history).
create index if not exists lk_battles_opponent_host_history_idx
  on public.lk_battles (opponent_host_user_id, invited_at desc)
  where opponent_host_user_id is not null;

-- 4g. Pair cooldown: "did THIS host have an invite to THAT opponent closed in the
--     last 2 minutes?" — an exact pair lookup on a small partial index, newest
--     close first. ended_at is not bounded by invited_at (a decline can arrive
--     late, a sweep can lag), so the history index above cannot answer this alone.
create index if not exists lk_battles_pair_cooldown_idx
  on public.lk_battles (initiator_host_user_id, opponent_host_user_id, ended_at desc)
  where status in ('declined', 'expired', 'cancelled');

-- 4h. End requests.
--     * "at most ONE pending request per battle" — enforced by the storage engine,
--       and also the lookup used by lk_battle_finish_internal() to expire it;
create unique index if not exists lk_battle_end_requests_one_pending_uidx
  on public.lk_battle_end_requests (battle_id)
  where status = 'pending';

--     * a battle's request history (RLS reads, the 60-second re-ask cooldown —
--       a battle has only a handful of requests, filtered in memory) and the FK
--       cascade from lk_battles;
create index if not exists lk_battle_end_requests_battle_created_idx
  on public.lk_battle_end_requests (battle_id, created_at desc);

--     * expiry sweep in lk_battles_expire_stale();
create index if not exists lk_battle_end_requests_expiry_sweep_idx
  on public.lk_battle_end_requests (expires_at)
  where status = 'pending';

--     * ON DELETE SET NULL of requested_by_user_id when an account is deleted.
create index if not exists lk_battle_end_requests_requested_by_idx
  on public.lk_battle_end_requests (requested_by_user_id)
  where requested_by_user_id is not null;

-- 4i. CO-HOSTING
--     * same-role half of "one active pairing per stream", enforced by the storage engine
--       (the cross-role half and the battle<->session overlap rule live in the shared
--       trigger, section 5b). Also the hot lookup of live_cohost_active_session(), which
--       gift_send() calls on every gift (status = 'live' implies the index predicate).
create unique index if not exists live_cohost_sessions_active_host_uniq
  on public.live_cohost_sessions (host_stream_id)
  where status in ('invited', 'live');

create unique index if not exists live_cohost_sessions_active_cohost_uniq
  on public.live_cohost_sessions (cohost_stream_id)
  where status in ('invited', 'live');

--     * a stream's session history + the ON DELETE CASCADE from live_streams (the partial
--       indexes above only cover active rows, so they cannot serve the cascade).
create index if not exists live_cohost_sessions_host_stream_history_idx
  on public.live_cohost_sessions (host_stream_id, invited_at desc);

create index if not exists live_cohost_sessions_cohost_stream_history_idx
  on public.live_cohost_sessions (cohost_stream_id, invited_at desc);

--     * people: "invites this host sent in the last hour" (combined hourly cap) + history +
--       ON DELETE SET NULL of the two auth.users FKs.
create index if not exists live_cohost_sessions_host_user_history_idx
  on public.live_cohost_sessions (host_user_id, invited_at desc)
  where host_user_id is not null;

create index if not exists live_cohost_sessions_cohost_user_history_idx
  on public.live_cohost_sessions (cohost_user_id, invited_at desc)
  where cohost_user_id is not null;

--     * pair cooldown (exact pair, newest close first) — mirror of lk_battles_pair_cooldown_idx.
create index if not exists live_cohost_sessions_pair_cooldown_idx
  on public.live_cohost_sessions (host_user_id, cohost_user_id, ended_at desc)
  where status in ('declined', 'expired', 'cancelled');

--     * invite expiry sweep (lk_battles_expire_stale) — cost = number of due rows.
create index if not exists live_cohost_sessions_expiry_sweep_idx
  on public.live_cohost_sessions (invite_expires_at)
  where status = 'invited';

--     * ON DELETE SET NULL of ended_by_user_id.
create index if not exists live_cohost_sessions_ended_by_idx
  on public.live_cohost_sessions (ended_by_user_id)
  where ended_by_user_id is not null;

--     * battles of one co-host session: live_cohost_end() looks for a running / pending
--       battle, and the ON DELETE SET NULL from live_cohost_sessions.
create index if not exists lk_battles_cohost_session_idx
  on public.lk_battles (cohost_session_id)
  where cohost_session_id is not null;

-- ---------------------------------------------------------------------------
-- 5. TRIGGERS
-- ---------------------------------------------------------------------------

-- 5a. updated_at maintenance — reuses the PRE-EXISTING shared function.
drop trigger if exists update_lk_battles_updated_at on public.lk_battles;
create trigger update_lk_battles_updated_at
  before update on public.lk_battles
  for each row execute function public.update_updated_at_column();

drop trigger if exists update_lk_battle_scores_updated_at on public.lk_battle_scores;
create trigger update_lk_battle_scores_updated_at
  before update on public.lk_battle_scores
  for each row execute function public.update_updated_at_column();

drop trigger if exists update_live_cohost_sessions_updated_at on public.live_cohost_sessions;
create trigger update_live_cohost_sessions_updated_at
  before update on public.live_cohost_sessions
  for each row execute function public.update_updated_at_column();

-- 5b. ONE ACTIVE PAIRING PER STREAM — shared by lk_battles AND live_cohost_sessions.
--
-- The partial unique indexes above catch same-role collisions inside ONE table
-- (initiator-vs-initiator, host-vs-host, ...), but NOT the cross cases: stream A as
-- initiator in battle 1 and as opponent in battle 2, a stream in a co-host session AND a
-- battle, and so on. Postgres cannot express "unique across the union of columns of two
-- tables" declaratively, so the cross cases are closed here, in ONE function attached to
-- BOTH tables (it branches on TG_TABLE_NAME), so the rule holds for every write path.
--
-- Rules (NEW row in an active state = invited / live):
--   * lk_battles row           : no other active battle on either stream; no active co-host
--                                session on either stream, EXCEPT the LIVE session between
--                                the SAME two streams that NEW.cohost_session_id points at.
--                                A non-NULL cohost_session_id must point at exactly such a
--                                session (checked under FOR SHARE, see LOCK ORDER).
--   * live_cohost_sessions row : no other active session on either stream; no active battle
--                                on either stream, EXCEPT (when NEW is live) a battle between
--                                the same two streams whose cohost_session_id = NEW.id.
--   So a pending co-host invite makes both streams busy for battles, and vice versa.
--
-- It takes transaction-scoped advisory locks on the participating stream ids in
-- deterministic (sorted) order, which serialises two concurrent mirrored writes (battle or
-- co-host, the key is the raw stream id for both) and makes deadlock among them impossible.
-- The function keeps its original name so the existing lk_battles trigger keeps working.
create or replace function public.lk_battles_assert_single_active()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind     text;
  v_a        uuid;      -- the row's two streams
  v_b        uuid;
  v_link     uuid;      -- lk_battles.cohost_session_id (battle rows only)
  v_ids      uuid[];
  v_sorted   uuid[];
  v_id       uuid;
  v_conflict uuid;
  v_s_status public.live_cohost_status;
  v_s_host   uuid;
  v_s_cohost uuid;
begin
  if tg_table_name = 'lk_battles' then
    if new.status::text not in ('invited', 'live') then
      return new;
    end if;
    v_kind := 'battle';
    v_a    := new.initiator_stream_id;
    v_b    := new.opponent_stream_id;
    v_link := new.cohost_session_id;
  elsif tg_table_name = 'live_cohost_sessions' then
    if new.status::text not in ('invited', 'live') then
      return new;
    end if;
    v_kind := 'cohost';
    v_a    := new.host_stream_id;
    v_b    := new.cohost_stream_id;
  else
    raise exception 'lk_battles_assert_single_active: unexpected table %', tg_table_name;
  end if;

  -- A battle linked to a co-host session: lock that session FIRST (LOCK ORDER step 1,
  -- before the stream advisory locks) and check it really is the live session between
  -- these same two streams. FOR SHARE conflicts with the FOR NO KEY UPDATE taken by
  -- live_cohost_end(), so a session cannot end half-way through linking a battle to it.
  if v_link is not null then
    select s.status, s.host_stream_id, s.cohost_stream_id
      into v_s_status, v_s_host, v_s_cohost
      from public.live_cohost_sessions s
     where s.id = v_link
       for share;

    if not found
       or v_s_status <> 'live'
       or v_b is null
       or not ((v_s_host = v_a and v_s_cohost = v_b)
               or (v_s_host = v_b and v_s_cohost = v_a)) then
      raise exception
        'This battle is linked to co-host session %, which is not a live co-hosting between these two streams.',
        v_link
        using errcode = '23514';
    end if;
  end if;

  v_ids := array_remove(array[v_a, v_b], null);

  select array_agg(x order by x) into v_sorted from unnest(v_ids) as x;

  foreach v_id in array coalesce(v_sorted, array[]::uuid[]) loop
    perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  end loop;

  if v_kind = 'battle' then
    -- battle vs battle (the original rule)
    select b.id
      into v_conflict
      from public.lk_battles b
     where b.id <> new.id
       and b.status in ('invited', 'live')
       and (b.initiator_stream_id = any (v_ids)
            or b.opponent_stream_id = any (v_ids))
     limit 1;

    if v_conflict is not null then
      raise exception
        'One of these streams is already in an active LK battle (battle %).', v_conflict
        using errcode = '23505';
    end if;

    -- battle vs co-host session: only its own live session is allowed.
    select s.id
      into v_conflict
      from public.live_cohost_sessions s
     where s.status in ('invited', 'live')
       and (s.host_stream_id = any (v_ids)
            or s.cohost_stream_id = any (v_ids))
       and not coalesce(v_link is not null and s.id = v_link and s.status = 'live', false)
     limit 1;

    if v_conflict is not null then
      raise exception
        'One of these streams is busy in a co-host session (session %).', v_conflict
        using errcode = '23505';
    end if;

  else
    -- co-host session vs co-host session
    select s.id
      into v_conflict
      from public.live_cohost_sessions s
     where s.id <> new.id
       and s.status in ('invited', 'live')
       and (s.host_stream_id = any (v_ids)
            or s.cohost_stream_id = any (v_ids))
     limit 1;

    if v_conflict is not null then
      raise exception
        'One of these streams is already in an active co-host session (session %).', v_conflict
        using errcode = '23505';
    end if;

    -- co-host session vs battle: only a battle of THIS live session, on the same streams.
    select b.id
      into v_conflict
      from public.lk_battles b
     where b.status in ('invited', 'live')
       and (b.initiator_stream_id = any (v_ids)
            or b.opponent_stream_id = any (v_ids))
       and not coalesce(
             new.status::text = 'live'
             and b.cohost_session_id = new.id
             and ((b.initiator_stream_id = v_a and b.opponent_stream_id = v_b)
                  or (b.initiator_stream_id = v_b and b.opponent_stream_id = v_a)),
             false)
     limit 1;

    if v_conflict is not null then
      raise exception
        'One of these streams is already in an active LK battle (battle %).', v_conflict
        using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.lk_battles_assert_single_active() is
  'Trigger guard shared by lk_battles AND live_cohost_sessions: at most ONE active pairing '
  '(invited/live battle or co-host session) per live stream, across both sides and both tables. '
  'The only allowed overlap is a battle whose cohost_session_id points at the LIVE co-host '
  'session between the same two streams. Serialised with sorted advisory locks on the stream ids. '
  'Complements the per-column partial unique indexes, which only cover same-role collisions.';

drop trigger if exists lk_battles_single_active_trg on public.lk_battles;
create trigger lk_battles_single_active_trg
  before insert or update of status, initiator_stream_id, opponent_stream_id, cohost_session_id
  on public.lk_battles
  for each row execute function public.lk_battles_assert_single_active();

drop trigger if exists live_cohost_sessions_single_active_trg on public.live_cohost_sessions;
create trigger live_cohost_sessions_single_active_trg
  before insert or update of status, host_stream_id, cohost_stream_id
  on public.live_cohost_sessions
  for each row execute function public.lk_battles_assert_single_active();

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
-- READ MODEL: a battle (and its scores) is visible to whoever can already see
-- either of its two parent streams. That mirrors the PRE-EXISTING
-- public.live_streams policy ("status = 'live' OR host_user_id = auth.uid()")
-- exactly, so battles never leak more than the streams they belong to. Viewers
-- of either side therefore get the live progress bar for free.
--
-- WRITE MODEL: NONE. There is no INSERT/UPDATE/DELETE policy and no write GRANT
-- on either table. lk_battle_scores mirrors Feature 4's real-money gift ledger,
-- so a client-writable score row would be equivalent to a client-writable
-- wallet. Every mutation goes through the SECURITY DEFINER RPCs in section 7.

alter table public.lk_battles       enable row level security;
alter table public.lk_battle_scores enable row level security;

drop policy if exists "Viewers can read battles of visible streams" on public.lk_battles;
create policy "Viewers can read battles of visible streams"
  on public.lk_battles
  as permissive for select
  to anon, authenticated
  using (
    -- PRIVACY (user decision 2026-09-11): viewers only ever see battles that actually
    -- STARTED. An invite that was declined / expired / withdrawn is a private matter between
    -- the two broadcasters (started_at is set only on accept), so it is readable only by
    -- them (next policy) and by admins — the same rule live_deeplink_resolve() already uses.
    lk_battles.started_at is not null
    and exists (
      select 1
        from public.live_streams ls
       where ls.id in (lk_battles.initiator_stream_id, lk_battles.opponent_stream_id)
         and (ls.status = 'live' or ls.host_user_id = auth.uid())
    )
  );

-- The two broadcasters always see their own battles — including pending invites, which the
-- invite popup and the "waiting for response" state need.
drop policy if exists "Participants can read their battles" on public.lk_battles;
create policy "Participants can read their battles"
  on public.lk_battles
  as permissive for select
  to authenticated
  using ((select auth.uid()) in (lk_battles.initiator_host_user_id, lk_battles.opponent_host_user_id));

drop policy if exists "Admins can read all battles" on public.lk_battles;
create policy "Admins can read all battles"
  on public.lk_battles
  as permissive for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Viewers can read scores of visible battles" on public.lk_battle_scores;
create policy "Viewers can read scores of visible battles"
  on public.lk_battle_scores
  as permissive for select
  to anon, authenticated
  using (
    exists (
      select 1
        from public.lk_battles b
        join public.live_streams ls
          on ls.id in (b.initiator_stream_id, b.opponent_stream_id)
       where b.id = lk_battle_scores.battle_id
         and (ls.status = 'live' or ls.host_user_id = auth.uid())
    )
  );

drop policy if exists "Admins can read all battle scores" on public.lk_battle_scores;
create policy "Admins can read all battle scores"
  on public.lk_battle_scores
  as permissive for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

-- Explicit grants (Supabase default privileges are not relied upon in this project).
-- Read-only to clients on purpose. No insert/update/delete grant is issued.
grant select on public.lk_battles       to anon, authenticated;
grant select on public.lk_battle_scores to anon, authenticated;

-- --- lk_battle_end_requests: the two participating broadcasters + admins ----------
-- A request is a private conversation between the two hosts, so viewers do not see
-- it (unlike the battle and its scores). The host's app can receive new rows through
-- Supabase Realtime postgres_changes, which applies this same policy per subscriber.
-- The policy's lk_battles subquery is itself filtered by lk_battles' RLS; a
-- participating broadcaster can always see their own battle (host_user_id = auth.uid()
-- on their own stream), so the check still passes after either stream ends.
alter table public.lk_battle_end_requests enable row level security;

-- Start from nothing (Supabase default privileges may have granted everything), then
-- grant SELECT only. Writes are RPC-only.
revoke all on table public.lk_battle_end_requests from public, anon, authenticated;

drop policy if exists "Battle hosts can read their end requests" on public.lk_battle_end_requests;
create policy "Battle hosts can read their end requests"
  on public.lk_battle_end_requests
  as permissive for select
  to authenticated
  using (
    exists (
      select 1
        from public.lk_battles b
       where b.id = lk_battle_end_requests.battle_id
         and (select auth.uid()) in (b.initiator_host_user_id, b.opponent_host_user_id)
    )
  );

drop policy if exists "Admins can read all battle end requests" on public.lk_battle_end_requests;
create policy "Admins can read all battle end requests"
  on public.lk_battle_end_requests
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));

grant select on public.lk_battle_end_requests to authenticated;   -- RLS narrows it
-- anon gets no access at all.

-- OPTIONAL — run ONLY if the app delivers the host's Accept/Decline popup through
-- Supabase Realtime postgres_changes (instead of a broadcast message sent by the
-- co-host's app after lk_battle_request_end() returns):
-- alter publication supabase_realtime add table public.lk_battle_end_requests;

-- --- live_cohost_sessions: same read model as lk_battles, plus the participants ---------
-- * viewers: readable whenever either of its two streams is visible under the PRE-EXISTING
--   live_streams rule (status = 'live' OR own stream) — the battle pattern, so the viewers
--   of both rooms see the 50/50 link;
-- * participants: ALWAYS, through the denormalised host_user_id / cohost_user_id, so an
--   ended session never vanishes for the two broadcasters (even after both streams end);
-- * admins: everything.
-- WRITE MODEL: NONE (no INSERT/UPDATE/DELETE policy, no write grant) — RPC-only.
alter table public.live_cohost_sessions enable row level security;

revoke all on table public.live_cohost_sessions from public, anon, authenticated;

drop policy if exists "Viewers can read co-host sessions of visible streams" on public.live_cohost_sessions;
create policy "Viewers can read co-host sessions of visible streams"
  on public.live_cohost_sessions
  as permissive for select
  to anon, authenticated
  using (
    -- PRIVACY (user decision 2026-09-11): viewers only see co-hosting that actually STARTED.
    -- Declined / expired / withdrawn invites stay between the two broadcasters (policy
    -- below) and admins. started_at is set only when the invite is accepted.
    live_cohost_sessions.started_at is not null
    and exists (
      select 1
        from public.live_streams ls
       where ls.id in (live_cohost_sessions.host_stream_id, live_cohost_sessions.cohost_stream_id)
         and (ls.status = 'live' or ls.host_user_id = (select auth.uid()))
    )
  );

drop policy if exists "Participants can read their co-host sessions" on public.live_cohost_sessions;
create policy "Participants can read their co-host sessions"
  on public.live_cohost_sessions
  as permissive for select
  to authenticated
  using ((select auth.uid()) in (live_cohost_sessions.host_user_id, live_cohost_sessions.cohost_user_id));

drop policy if exists "Admins can read all co-host sessions" on public.live_cohost_sessions;
create policy "Admins can read all co-host sessions"
  on public.live_cohost_sessions
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));

grant select on public.live_cohost_sessions to anon, authenticated;   -- RLS narrows it

-- OPTIONAL — run ONLY if the app delivers the invitee's co-host Accept/Decline popup (and
-- the 50/50 link / unlink to viewers) through Supabase Realtime postgres_changes instead of
-- a broadcast message sent after the live_cohost_* RPC returns:
-- alter publication supabase_realtime add table public.live_cohost_sessions;

-- ---------------------------------------------------------------------------
-- 7. RPCs
-- ---------------------------------------------------------------------------
-- All are SECURITY DEFINER with a pinned search_path. Every CLIENT-facing one
-- re-derives the caller from auth.uid() instead of trusting a parameter; the
-- private ones (*_internal, the stream-ended hook, the sweeps) have no auth check
-- and are therefore granted to no client role (section 8).

-- 7a-0. SHARED INVITE GUARD — battle AND co-host invites -----------------------
-- The ONE place the invite rules live, called by lk_battle_invite() and
-- live_cohost_invite(), so the two invite kinds share one budget and cannot be
-- alternated to spam someone:
--   * serialises all invites sent by the inviter (advisory lock);
--   * lazily lapses stale battle AND co-host invites on the two streams;
--   * 2-minute pair cooldown (battle + co-host closed invites both count);
--   * 20 invites per inviter per rolling hour (battle + co-host combined).
-- Returns the invite_expires_at to stamp on the new row (now() + the 60-second invite
-- TTL, which therefore also lives only here).
-- PRIVATE: no auth check (the callers validate auth.uid() and pass the people they
-- resolved from live_streams), NO grant to any client role.
create or replace function public.lk_pairing_invite_guard_internal(
  p_kind            text,   -- 'battle' | 'cohost' — only labels the hourly-cap message
  p_inviter_user_id uuid,
  p_invitee_user_id uuid,
  p_stream_a        uuid,
  p_stream_b        uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_invite_ttl             constant interval := interval '60 seconds';
  -- Anti-spam (user approved 2026-09-10; shared with co-host invites 2026-09-11).
  -- Keyed on people, not streams.
  c_pair_cooldown          constant interval := interval '2 minutes';  -- same inviter -> same person
  c_invite_window          constant interval := interval '1 hour';     -- rolling window ...
  c_max_invites_per_window constant integer  := 20;                    -- ... and its cap per inviter
  v_last_close    timestamptz;
  v_last_close_co timestamptz;
  v_recent        integer;
  v_recent_co     integer;
  v_oldest        timestamptz;
  v_oldest_co     timestamptz;
begin
  if p_kind is null or p_kind not in ('battle', 'cohost') then
    raise exception 'lk_pairing_invite_guard_internal: p_kind must be battle or cohost (got %).',
      coalesce(p_kind, 'NULL') using errcode = '22023';
  end if;

  if p_inviter_user_id is null or p_invitee_user_id is null
     or p_stream_a is null or p_stream_b is null then
    raise exception 'lk_pairing_invite_guard_internal: inviter, invitee and both streams are required.'
      using errcode = '22004';
  end if;

  -- Serialise all invites (battle AND co-host) sent by THIS inviter, so two invites fired
  -- at the same instant cannot both pass the hourly-cap / pair-cooldown checks below.
  -- Namespaced key: it can never collide with the raw stream-id locks taken by the
  -- one-active-pairing trigger. Always taken BEFORE the trigger's stream locks (LOCK ORDER
  -- step 2), so the lock order is fixed. (Key text kept from the battle-only version.)
  perform pg_advisory_xact_lock(hashtextextended('lk_battle_invite_host:' || p_inviter_user_id::text, 0));

  -- Lazily lapse invites on these two streams whose 60 seconds are already up but which
  -- the cron sweep has not reached yet. Without this, "invite timed out on screen ->
  -- invite someone else" would fail with "busy" for up to a minute. Rows are locked in id
  -- order so two invites cannot deadlock here. Battles first, then co-host invites
  -- (LOCK ORDER steps 3 and 4).
  update public.lk_battles b
     set status   = 'expired',
         ended_at = b.invite_expires_at
   where b.id in (
           select x.id
             from public.lk_battles x
            where x.status = 'invited'
              and x.invite_expires_at <= now()
              and (x.initiator_stream_id in (p_stream_a, p_stream_b)
                   or x.opponent_stream_id in (p_stream_a, p_stream_b))
            order by x.id
              for update
         )
     and b.status = 'invited';

  update public.live_cohost_sessions s
     set status   = 'expired',
         ended_at = s.invite_expires_at
   where s.id in (
           select x.id
             from public.live_cohost_sessions x
            where x.status = 'invited'
              and x.invite_expires_at <= now()
              and (x.host_stream_id in (p_stream_a, p_stream_b)
                   or x.cohost_stream_id in (p_stream_a, p_stream_b))
            order by x.id
              for no key update
         )
     and s.status = 'invited';

  -- ANTI-SPAM 1 — pair cooldown. Directional on purpose: it stops the INVITER repeating
  -- an invite the other person did not take. The invitee inviting back is unaffected.
  -- A closed battle invite and a closed co-host invite BOTH count.
  -- Reads lk_battles_pair_cooldown_idx / live_cohost_sessions_pair_cooldown_idx.
  select max(b.ended_at)
    into v_last_close
    from public.lk_battles b
   where b.initiator_host_user_id = p_inviter_user_id
     and b.opponent_host_user_id  = p_invitee_user_id
     and b.status in ('declined', 'expired', 'cancelled')
     and b.ended_at > now() - c_pair_cooldown;

  select max(s.ended_at)
    into v_last_close_co
    from public.live_cohost_sessions s
   where s.host_user_id   = p_inviter_user_id
     and s.cohost_user_id = p_invitee_user_id
     and s.status in ('declined', 'expired', 'cancelled')
     and s.ended_at > now() - c_pair_cooldown;

  v_last_close := greatest(v_last_close, v_last_close_co);   -- greatest() ignores NULLs

  if v_last_close is not null then
    -- PT429: PostgREST turns a PTxxx SQLSTATE into that HTTP status (429 Too Many Requests).
    raise exception
      'You recently invited this broadcaster. You can invite them again in % seconds.',
      greatest(1, ceil(extract(epoch from (v_last_close + c_pair_cooldown - now())))::integer)
      using errcode = 'PT429';
  end if;

  -- ANTI-SPAM 2 — hourly cap per inviter: every battle invite AND every co-host invite
  -- counts, whatever happened to it. Reads lk_battles_initiator_host_history_idx /
  -- live_cohost_sessions_host_user_history_idx.
  select count(*), min(b.invited_at)
    into v_recent, v_oldest
    from public.lk_battles b
   where b.initiator_host_user_id = p_inviter_user_id
     and b.invited_at > now() - c_invite_window;

  select count(*), min(s.invited_at)
    into v_recent_co, v_oldest_co
    from public.live_cohost_sessions s
   where s.host_user_id = p_inviter_user_id
     and s.invited_at > now() - c_invite_window;

  v_recent := coalesce(v_recent, 0) + coalesce(v_recent_co, 0);
  v_oldest := least(v_oldest, v_oldest_co);                    -- least() ignores NULLs

  if v_recent >= c_max_invites_per_window then
    raise exception
      '% invite limit reached (% per hour). Try again in % minutes.',
      case p_kind when 'battle' then 'Battle' else 'Co-host' end,
      c_max_invites_per_window,
      greatest(1, ceil(extract(epoch from (v_oldest + c_invite_window - now())) / 60.0))::integer
      using errcode = 'PT429';
  end if;

  return now() + c_invite_ttl;
end;
$$;

comment on function public.lk_pairing_invite_guard_internal(text, uuid, uuid, uuid, uuid) is
  'PRIVATE (no grants). The shared invite rules for LK battle AND co-host invites: serialises the '
  'inviter''s invites (advisory lock), lazily lapses stale battle / co-host invites on the two '
  'streams, 2-minute directional pair cooldown and 20-invites-per-rolling-hour cap per inviter — '
  'battle and co-host invites counted TOGETHER (both raise SQLSTATE PT429 = HTTP 429 with a '
  '"try again in ..." message). Returns invite_expires_at = now() + 60 seconds.';

-- 7a. INVITE ---------------------------------------------------------------
create or replace function public.lk_battle_invite(
  p_initiator_stream_id uuid,
  p_opponent_stream_id  uuid,
  p_duration_seconds    integer
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_init_host  uuid;
  v_opp_host   uuid;
  v_init_stat  text;
  v_opp_stat   text;
  v_battle_id  uuid;
  v_expires    timestamptz;
  v_session    public.live_cohost_sessions%rowtype;
  v_session_id uuid;
  v_partner    uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  if p_initiator_stream_id is null or p_opponent_stream_id is null then
    raise exception 'Both stream ids are required.' using errcode = '22004';
  end if;

  if p_initiator_stream_id = p_opponent_stream_id then
    raise exception 'A stream cannot battle itself.' using errcode = '22023';
  end if;

  if p_duration_seconds is null
     or p_duration_seconds <= 0
     or p_duration_seconds > 3600 then
    raise exception 'Battle duration must be between 1 and 3600 seconds.'
      using errcode = '22023';
  end if;

  select ls.host_user_id, ls.status into v_init_host, v_init_stat
    from public.live_streams ls where ls.id = p_initiator_stream_id;
  if not found then
    raise exception 'Initiator stream not found.' using errcode = 'P0002';
  end if;

  select ls.host_user_id, ls.status into v_opp_host, v_opp_stat
    from public.live_streams ls where ls.id = p_opponent_stream_id;
  if not found then
    raise exception 'Opponent stream not found.' using errcode = 'P0002';
  end if;

  -- Only the initiating stream's own host may send the invite.
  if v_init_host is null or v_init_host <> v_uid then
    raise exception 'Only the host of the initiating stream can send a battle invite.'
      using errcode = '42501';
  end if;

  if coalesce(v_init_stat, '') <> 'live' or coalesce(v_opp_stat, '') <> 'live' then
    raise exception 'Both streams must be live to start an LK battle.'
      using errcode = '22023';
  end if;

  -- Two streams owned by the same person are not a battle.
  if v_opp_host is null or v_opp_host = v_init_host then
    raise exception 'The opponent must be a different broadcaster.' using errcode = '22023';
  end if;

  -- CO-HOSTING. Is the initiator's stream in a LIVE co-host session right now? If so the
  -- only stream it may battle is its co-hosting partner (host -> co-host or co-host ->
  -- host), and the battle is linked to the session. Locked FOR SHARE (LOCK ORDER step 1,
  -- before the inviter lock) so "end co-hosting" cannot slip in between this check and the
  -- insert; FOR SHARE re-checks status = 'live' after any wait. Served by the partial
  -- unique indexes live_cohost_sessions_active_*_uniq.
  select s.*
    into v_session
    from public.live_cohost_sessions s
   where s.status = 'live'
     and (s.host_stream_id = p_initiator_stream_id
          or s.cohost_stream_id = p_initiator_stream_id)
   limit 1
     for share;

  if found then
    v_session_id := v_session.id;
    v_partner    := case when v_session.host_stream_id = p_initiator_stream_id
                         then v_session.cohost_stream_id
                         else v_session.host_stream_id
                    end;
    if p_opponent_stream_id <> v_partner then
      raise exception 'You are co-hosting right now. During co-hosting you can only invite your co-hosting partner to an LK battle.'
        using errcode = '23505';
    end if;
  end if;

  -- Shared invite rules (inviter lock, lazy lapse of stale invites, pair cooldown, hourly
  -- cap — battle and co-host invites counted together). Returns the invite deadline.
  v_expires := public.lk_pairing_invite_guard_internal(
                 'battle', v_init_host, v_opp_host,
                 p_initiator_stream_id, p_opponent_stream_id);

  -- Friendly pre-checks. The AUTHORITATIVE guard is the partial unique indexes plus the
  -- shared one-active-pairing trigger (lk_battles_single_active_trg), which also takes the
  -- advisory locks.
  if exists (
    select 1 from public.lk_battles b
     where b.status in ('invited', 'live')
       and (b.initiator_stream_id in (p_initiator_stream_id, p_opponent_stream_id)
            or b.opponent_stream_id in (p_initiator_stream_id, p_opponent_stream_id))
  ) then
    raise exception 'One of these streams is already in an active LK battle.'
      using errcode = '23505';
  end if;

  -- Any other active co-host session on either stream (a pending co-host invite, or the
  -- opponent co-hosting with someone else) makes the pair busy. Only the initiator's own
  -- live session with this very opponent (found above) is allowed.
  if exists (
    select 1 from public.live_cohost_sessions s
     where s.status in ('invited', 'live')
       and (s.host_stream_id in (p_initiator_stream_id, p_opponent_stream_id)
            or s.cohost_stream_id in (p_initiator_stream_id, p_opponent_stream_id))
       and s.id is distinct from v_session_id
  ) then
    raise exception 'One of these streams is busy in a co-host session.'
      using errcode = '23505';
  end if;

  insert into public.lk_battles (
    initiator_stream_id, opponent_stream_id,
    initiator_host_user_id, opponent_host_user_id, status,
    duration_seconds, invited_at, invite_expires_at, cohost_session_id
  )
  values (
    p_initiator_stream_id, p_opponent_stream_id,
    v_init_host, v_opp_host, 'invited',
    p_duration_seconds, now(), v_expires, v_session_id
  )
  returning id into v_battle_id;

  return v_battle_id;
end;
$$;

comment on function public.lk_battle_invite(uuid, uuid, integer) is
  'Host-only. Creates an invited LK battle between two currently-live streams owned by two '
  'different broadcasters, and records both people (initiator_host_user_id / '
  'opponent_host_user_id). Invite TTL is 60s (spec allows 30-60s). Anti-spam (shared with co-host '
  'invites via lk_pairing_invite_guard_internal): the same inviter cannot re-invite the same '
  'person within 2 minutes of a declined / expired / cancelled battle OR co-host invite, and an '
  'inviter can send at most 20 battle + co-host invites per rolling hour (both raise SQLSTATE '
  'PT429 = HTTP 429 with a "try again in ..." message). CO-HOSTING: if the initiator''s stream is '
  'in a live co-host session, only the co-hosting partner can be invited and the battle gets '
  'cohost_session_id; a stream with any other active co-host session is refused as busy. '
  'Returns the battle id.';

-- 7b. ACCEPT ---------------------------------------------------------------
create or replace function public.lk_battle_accept(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_b          public.lk_battles%rowtype;
  v_opp_host   uuid;
  v_now        timestamptz := now();
  v_session_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  -- CO-HOSTING LOCK ORDER (header, step 1): a battle inside a co-host session locks that
  -- session row BEFORE the battle row, the same order live_cohost_end() uses, so accepting
  -- the battle and ending the co-hosting at the same instant serialise instead of
  -- deadlocking. The shared trigger then re-checks the session is still live. No rule of
  -- the battle itself changes. (cohost_session_id is written once at invite time.)
  select b.cohost_session_id into v_session_id
    from public.lk_battles b where b.id = p_battle_id;
  if v_session_id is not null then
    perform 1 from public.live_cohost_sessions s where s.id = v_session_id for share;
  end if;

  -- Row lock makes a double-accept (two taps, two devices) impossible.
  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.status = 'live' then
    return v_b.id;                       -- idempotent re-accept
  end if;

  if v_b.status <> 'invited' then
    raise exception 'This battle invite is no longer open (status = %).', v_b.status
      using errcode = '22023';
  end if;

  if v_b.opponent_stream_id is null then
    raise exception 'This invite has no opponent stream.' using errcode = '22023';
  end if;

  select ls.host_user_id into v_opp_host
    from public.live_streams ls where ls.id = v_b.opponent_stream_id;

  if v_opp_host is null or v_opp_host <> v_uid then
    raise exception 'Only the invited broadcaster can accept this battle.'
      using errcode = '42501';
  end if;

  if v_now >= v_b.invite_expires_at then
    -- No "mark it expired" UPDATE here: the RAISE below rolls back everything this
    -- call wrote, so such an UPDATE could never persist. The row is flipped to
    -- 'expired' (with ended_at = invite_expires_at) by lk_battles_expire_stale()
    -- within a minute, or immediately by the next lk_battle_invite() on either stream.
    raise exception 'This battle invite has expired.' using errcode = '22023';
  end if;

  update public.lk_battles
     set status     = 'live',
         started_at = v_now,
         ends_at    = v_now + make_interval(secs => v_b.duration_seconds)
   where id = v_b.id;

  -- Exactly two score rows, at 0, in the same transaction as the state flip.
  insert into public.lk_battle_scores (battle_id, stream_id, points)
  values (v_b.id, v_b.initiator_stream_id, 0),
         (v_b.id, v_b.opponent_stream_id,  0)
  on conflict on constraint lk_battle_scores_battle_stream_uniq do nothing;

  return v_b.id;
end;
$$;

comment on function public.lk_battle_accept(uuid) is
  'Opponent host only. Flips an unexpired invite to live, stamps started_at/ends_at and '
  'creates the two lk_battle_scores rows at 0. Idempotent if the battle is already live.';

-- 7c. DECLINE --------------------------------------------------------------
create or replace function public.lk_battle_decline(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_b        public.lk_battles%rowtype;
  v_opp_host uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.status = 'declined' then
    return v_b.id;                       -- idempotent
  end if;

  if v_b.status <> 'invited' then
    raise exception 'Only an open invite can be declined (status = %).', v_b.status
      using errcode = '22023';
  end if;

  select ls.host_user_id into v_opp_host
    from public.live_streams ls where ls.id = v_b.opponent_stream_id;

  if v_opp_host is null or v_opp_host <> v_uid then
    raise exception 'Only the invited broadcaster can decline this battle.'
      using errcode = '42501';
  end if;

  update public.lk_battles
     set status   = 'declined',
         ended_at = now()          -- close time, read by the invite pair-cooldown
   where id = v_b.id;
  return v_b.id;
end;
$$;

comment on function public.lk_battle_decline(uuid) is
  'Opponent host only. Marks an open invite declined. The row is kept for abuse / '
  'rate-limit history (Feature 5).';

-- 7d. CANCEL (withdraw an invite) -------------------------------------------
-- ONLY for an 'invited' battle, ONLY by the host. A LIVE battle can no longer be
-- cancelled by anyone: a "cancel = no winner" button would let a losing side
-- escape defeat. Live battles end through lk_battle_end_early (host),
-- lk_battle_surrender / lk_battle_request_end (co-host), the timer, or a stream
-- ending (lk_battle_on_stream_ended) — all of which produce a real result.
create or replace function public.lk_battle_cancel(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_b   public.lk_battles%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.initiator_host_user_id is null or v_b.initiator_host_user_id <> v_uid then
    raise exception 'Only the host who sent this invite can withdraw it.'
      using errcode = '42501';
  end if;

  if v_b.status = 'cancelled' then
    return v_b.id;                       -- idempotent
  end if;

  if v_b.status = 'live' then
    raise exception 'A live battle cannot be cancelled. The host can end it early; the co-host can surrender or ask the host to end it.'
      using errcode = '22023';
  end if;

  if v_b.status <> 'invited' then
    raise exception 'Only an open invite can be withdrawn (status = %).', v_b.status
      using errcode = '22023';
  end if;

  update public.lk_battles
     set status   = 'cancelled',
         ended_at = now()          -- close time, read by the invite pair-cooldown
   where id = v_b.id;

  return v_b.id;
end;
$$;

comment on function public.lk_battle_cancel(uuid) is
  'Host only (the broadcaster who sent the invite). Withdraws an invite that has not been '
  'accepted yet -> status cancelled. A live battle cannot be cancelled by anyone; use '
  'lk_battle_end_early (host) or lk_battle_surrender / lk_battle_request_end (co-host).';

-- 7e. FINISH — THE ONE OUTCOME RULE ------------------------------------------
--
-- Every way a live battle can end goes through lk_battle_finish_internal():
--   timer settle (lk_battle_settle / lk_battles_settle_due via
--   lk_battle_settle_internal), lk_battle_end_early, lk_battle_surrender,
--   lk_battle_respond_end_request (accept) and lk_battle_on_stream_ended.
-- So "who won" is decided in exactly one place:
--   * p_forced_winner = 'initiator' -> the host wins regardless of score
--     (ONLY allowed for the co-host exits: cohost_surrendered, cohost_left);
--   * otherwise                     -> decided by the score AT THIS MOMENT,
--     equal points = draw (spec open question 1, default draw rule).
--
-- PRIVATE: no auth check and NO grant to any client role. Reachable only from the
-- SECURITY DEFINER wrappers in this file, which run as the function owner. That is
-- also what lets the pg_cron sweep (no JWT, auth.uid() IS NULL) reuse it.
--
-- GUARANTEES
--   * locks the battle row (FOR UPDATE), so two end paths racing each other (e.g.
--     host taps "End" while the timer sweep fires) serialise; the second one sees
--     status = 'ended' and returns without re-deciding;
--   * IDEMPOTENT: an already-ended battle is returned as-is, never re-decided;
--   * returns NULL (no error) when the battle is not live (invite states) or when
--     p_end_method = 'timer' but ends_at has not been reached yet;
--   * locks both score rows before reading them, so a gift whose lk_battle_add_points()
--     UPDATE is already in flight is waited for and counted. (A gift whose statement
--     started before this commit but reaches the score row after it can still add
--     points to the ended row — the same sub-millisecond edge the timer path always
--     had. lk_battles.result is the authoritative outcome.)
--   * stamps ended_at (= ends_at for a timer end, i.e. when gifting actually stopped;
--     now() for every early end) and end_method;
--   * marks any pending end request for this battle 'expired' (it is moot now).
create or replace function public.lk_battle_finish_internal(
  p_battle_id     uuid,
  p_end_method    public.lk_battle_end_method,
  p_forced_winner text default null   -- 'initiator' or NULL (= decide by score)
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_b           public.lk_battles%rowtype;
  v_init_points bigint;
  v_opp_points  bigint;
  v_result      text;
  v_winner      uuid;
begin
  if p_end_method is null then
    raise exception 'lk_battle_finish_internal: an end method is required.'
      using errcode = '22004';
  end if;

  if p_forced_winner is not null and p_forced_winner <> 'initiator' then
    raise exception 'lk_battle_finish_internal: p_forced_winner must be ''initiator'' or NULL (got %).',
      p_forced_winner using errcode = '22023';
  end if;

  -- The forced host win belongs to the co-host exits and to nothing else.
  if (p_end_method in ('cohost_surrendered', 'cohost_left'))
     <> (p_forced_winner is not null) then
    raise exception 'lk_battle_finish_internal: end method % does not match forced winner %.',
      p_end_method, coalesce(p_forced_winner, 'NULL') using errcode = '22023';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.status = 'ended' then
    return v_b.id;                       -- already settled: never re-decide
  end if;

  if v_b.status <> 'live' then
    return null;                         -- invited/declined/expired/cancelled: nothing to finish
  end if;

  if p_end_method = 'timer' and now() < v_b.ends_at then
    return null;                         -- timer still running: not an error
  end if;

  -- Lock both score rows (fixed order) before reading them — see GUARANTEES above.
  perform 1
     from public.lk_battle_scores s
    where s.battle_id = v_b.id
    order by s.stream_id
      for update;

  select coalesce(max(s.points) filter (where s.stream_id = v_b.initiator_stream_id), 0),
         coalesce(max(s.points) filter (where s.stream_id = v_b.opponent_stream_id),  0)
    into v_init_points, v_opp_points
    from public.lk_battle_scores s
   where s.battle_id = v_b.id;

  if p_forced_winner = 'initiator' then
    v_result := 'initiator_win';
    v_winner := v_b.initiator_stream_id;
  elsif v_init_points > v_opp_points then
    v_result := 'initiator_win';
    v_winner := v_b.initiator_stream_id;
  elsif v_opp_points > v_init_points then
    v_result := 'opponent_win';
    v_winner := v_b.opponent_stream_id;
  else
    -- DEFAULT DRAW RULE (spec open question 1): equal points => no winner.
    -- winner_stream_id stays NULL and result = 'draw' is what distinguishes a
    -- settled draw from a battle that has not been settled yet (result IS NULL).
    v_result := 'draw';
    v_winner := null;
  end if;

  update public.lk_battles
     set status           = 'ended',
         ended_at         = case when p_end_method = 'timer' then v_b.ends_at else now() end,
         result           = v_result,
         winner_stream_id = v_winner,
         end_method       = p_end_method
   where id = v_b.id;

  -- A pending "please end" request is moot once the battle is over, however it ended.
  -- (Served by lk_battle_end_requests_one_pending_uidx.)
  update public.lk_battle_end_requests r
     set status = 'expired'
   where r.battle_id = v_b.id
     and r.status    = 'pending';

  return v_b.id;
end;
$$;

comment on function public.lk_battle_finish_internal(uuid, public.lk_battle_end_method, text) is
  'PRIVATE (no grants). The single end-of-battle outcome rule used by every end path. Locks '
  'the battle row; idempotent (an ended battle is returned unchanged, never re-decided); '
  'returns NULL when the battle is not live, or for p_end_method = timer before ends_at. '
  'p_forced_winner = ''initiator'' (only with cohost_surrendered / cohost_left) makes the host '
  'win regardless of score; otherwise the current score decides and equal points = draw. '
  'Writes status/ended_at/result/winner_stream_id/end_method and expires any pending end request.';

-- 7e-2. TIMER SETTLE --------------------------------------------------------
-- Kept as a thin wrapper so every existing caller (lk_battle_settle, the
-- lk_battles_settle_due sweep) keeps working, but the rule itself now lives in
-- lk_battle_finish_internal(). No grant to any client role.
create or replace function public.lk_battle_settle_internal(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.lk_battle_finish_internal(p_battle_id, 'timer'::public.lk_battle_end_method);
end;
$$;

comment on function public.lk_battle_settle_internal(uuid) is
  'PRIVATE (no grants). Timer settlement = lk_battle_finish_internal(p_battle_id, ''timer''). '
  'Only the lk_battle_settle() wrapper and the lk_battles_settle_due() sweep call it.';

create or replace function public.lk_battle_settle(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Deliberately NOT restricted to the two hosts. Timer settlement is fully
  -- deterministic (compare two stored numbers) and time-gated (it only fires
  -- once ends_at has passed), so there is nothing a caller can influence.
  -- Letting any authenticated viewer in the room trigger it means the battle
  -- still settles the moment the countdown hits zero, even when both broadcaster
  -- apps crash; the every-minute cron sweep (7j / section 9) is the backstop.
  if auth.uid() is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  return public.lk_battle_settle_internal(p_battle_id);
end;
$$;

comment on function public.lk_battle_settle(uuid) is
  'Idempotent TIMER settlement. Acts only on a live battle whose ends_at has passed; the '
  'current score decides (equal = draw) and end_method = timer. Returns the battle id when '
  'settled (or already ended), NULL when there was nothing to do. Safe to call from any '
  'authenticated client; the cron sweep uses the same rule via lk_battle_settle_internal().';

-- 7f. END EARLY — HOST ONLY --------------------------------------------------
-- Only the HOST may stop a live battle before the timer runs out, and the result is
-- then decided by the CURRENT score (equal = draw). There is deliberately no
-- "end with no winner" option: that would let a host who is losing simply end the
-- battle to escape defeat. If the timer has already run out, this is just a normal
-- timer settlement (end_method = timer).
create or replace function public.lk_battle_end_early(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_b   public.lk_battles%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.initiator_host_user_id is null or v_b.initiator_host_user_id <> v_uid then
    raise exception 'Only the host can end this battle early.' using errcode = '42501';
  end if;

  if v_b.status = 'ended' then
    return v_b.id;                       -- double tap / already over: idempotent
  end if;

  if v_b.status <> 'live' then
    raise exception 'Only a live battle can be ended (status = %). To withdraw an invite use lk_battle_cancel.',
      v_b.status using errcode = '22023';
  end if;

  if now() >= v_b.ends_at then
    return public.lk_battle_finish_internal(v_b.id, 'timer'::public.lk_battle_end_method);
  end if;

  return public.lk_battle_finish_internal(v_b.id, 'host_ended'::public.lk_battle_end_method);
end;
$$;

comment on function public.lk_battle_end_early(uuid) is
  'Host only (broadcaster of initiator_stream_id), live battles only. Ends the battle NOW and '
  'decides it by the CURRENT score (equal = draw), end_method = host_ended. If ends_at has '
  'already passed it is settled as a normal timer end. Idempotent on an ended battle. There is '
  'no "no winner" early end, so a losing host cannot escape defeat.';

-- 7g. CO-HOST EXITS ---------------------------------------------------------
-- The co-host can NOT end a battle. They have two options:
--   (a) lk_battle_surrender        -> battle ends immediately, HOST WINS regardless
--                                      of score (end_method = cohost_surrendered);
--   (b) lk_battle_request_end      -> asks the host; the host answers with
--       lk_battle_respond_end_request (accept = end by current score, draw if equal,
--       end_method = end_request_accepted; decline = the battle continues).
-- In every one of these, if the timer has already run out the battle is simply
-- settled as a timer end instead — the fight is already over at that point.

-- 7g-1. SURRENDER -----------------------------------------------------------
create or replace function public.lk_battle_surrender(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_b   public.lk_battles%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.opponent_host_user_id is null or v_b.opponent_host_user_id <> v_uid then
    raise exception 'Only the co-host can surrender this battle.' using errcode = '42501';
  end if;

  if v_b.status = 'ended' then
    return v_b.id;                       -- double tap / already over: idempotent
  end if;

  if v_b.status <> 'live' then
    raise exception 'Only a live battle can be surrendered (status = %).', v_b.status
      using errcode = '22023';
  end if;

  if now() >= v_b.ends_at then
    return public.lk_battle_finish_internal(v_b.id, 'timer'::public.lk_battle_end_method);
  end if;

  return public.lk_battle_finish_internal(
    v_b.id, 'cohost_surrendered'::public.lk_battle_end_method, 'initiator');
end;
$$;

comment on function public.lk_battle_surrender(uuid) is
  'Co-host only (broadcaster of opponent_stream_id), live battles only. Ends the battle '
  'immediately and the HOST WINS regardless of score (end_method = cohost_surrendered), so the '
  'host may then set the penalty. If ends_at has already passed it is settled as a normal '
  'timer end instead. Idempotent on an ended battle.';

-- 7g-2. REQUEST END ---------------------------------------------------------
create or replace function public.lk_battle_request_end(p_battle_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_request_ttl     constant interval := interval '30 seconds';  -- host must answer within
  c_retry_cooldown  constant interval := interval '60 seconds';  -- after declined / expired
  v_uid         uuid := auth.uid();
  v_b           public.lk_battles%rowtype;
  v_pending_id  uuid;
  v_last_close  timestamptz;
  v_request_id  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  -- Locking the BATTLE row serialises every request / response / finish on this
  -- battle (lock order everywhere is: battle row, then request rows).
  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.opponent_host_user_id is null or v_b.opponent_host_user_id <> v_uid then
    raise exception 'Only the co-host can ask to end this battle.' using errcode = '42501';
  end if;

  if v_b.status <> 'live' then
    raise exception 'Only a live battle can be asked to end (status = %).', v_b.status
      using errcode = '22023';
  end if;

  -- Timer already over: settle it as a normal timer end; no request is needed.
  -- Returns NULL so the app knows no popup should be shown.
  if now() >= v_b.ends_at then
    perform public.lk_battle_finish_internal(v_b.id, 'timer'::public.lk_battle_end_method);
    return null;
  end if;

  -- Close a pending request whose 30 seconds are up but which the sweep has not
  -- reached yet, so it neither blocks the one-pending index nor counts as open.
  update public.lk_battle_end_requests r
     set status = 'expired'
   where r.battle_id  = v_b.id
     and r.status     = 'pending'
     and r.expires_at <= now();

  -- Still-open request (double tap): return it instead of failing.
  select r.id into v_pending_id
    from public.lk_battle_end_requests r
   where r.battle_id = v_b.id
     and r.status    = 'pending';
  if v_pending_id is not null then
    return v_pending_id;
  end if;

  -- 60-second cooldown after THIS co-host's last declined / expired request on THIS
  -- battle. Close time = the host's answer (declined) or the deadline (expired).
  select max(coalesce(r.responded_at, r.expires_at))
    into v_last_close
    from public.lk_battle_end_requests r
   where r.battle_id            = v_b.id
     and r.requested_by_user_id = v_uid
     and r.status in ('declined', 'expired');

  if v_last_close is not null and v_last_close > now() - c_retry_cooldown then
    -- PT429: PostgREST turns a PTxxx SQLSTATE into that HTTP status (429 Too Many Requests).
    raise exception 'Please wait % seconds before asking the host to end the battle again.',
      greatest(1, ceil(extract(epoch from (v_last_close + c_retry_cooldown - now())))::integer)
      using errcode = 'PT429';
  end if;

  insert into public.lk_battle_end_requests
         (battle_id, requested_by_user_id, status, created_at, expires_at)
  values (v_b.id, v_uid, 'pending', now(), now() + c_request_ttl)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.lk_battle_request_end(uuid) is
  'Co-host only, live battles only. Creates a "please end the battle" request for the host '
  'that lapses after 30 seconds, and returns its id (the host''s app shows Accept / Decline via '
  'realtime). At most one pending request per battle — a repeat call while one is open returns '
  'that same id. After a declined or expired request the co-host must wait 60 seconds before '
  'asking again (raises SQLSTATE PT429 = HTTP 429). Returns NULL if the timer had already run '
  'out, in which case the battle is settled as a normal timer end instead.';

-- 7g-3. RESPOND TO AN END REQUEST — HOST ONLY --------------------------------
create or replace function public.lk_battle_respond_end_request(
  p_request_id uuid,
  p_accept     boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_battle_id uuid;
  v_b         public.lk_battles%rowtype;
  v_r         public.lk_battle_end_requests%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  if p_accept is null then
    raise exception 'p_accept (true = accept, false = decline) is required.'
      using errcode = '22004';
  end if;

  -- Find the battle first, then lock in the fixed order: battle row, then request row.
  select r.battle_id into v_battle_id
    from public.lk_battle_end_requests r
   where r.id = p_request_id;
  if not found then
    raise exception 'End request not found.' using errcode = 'P0002';
  end if;

  select * into v_b from public.lk_battles where id = v_battle_id for update;
  select * into v_r from public.lk_battle_end_requests where id = p_request_id for update;

  if v_b.initiator_host_user_id is null or v_b.initiator_host_user_id <> v_uid then
    raise exception 'Only the host can answer this end request.' using errcode = '42501';
  end if;

  -- Already answered with the same answer (double tap): idempotent.
  if (v_r.status = 'accepted' and p_accept) or (v_r.status = 'declined' and not p_accept) then
    return v_b.id;
  end if;

  if v_r.status <> 'pending' then
    raise exception 'This end request is no longer open (status = %).', v_r.status
      using errcode = '22023';
  end if;

  if now() >= v_r.expires_at then
    -- The request is NOT flipped to 'expired' here on purpose: the RAISE below rolls
    -- back everything this call wrote, so such an UPDATE could never persist. A
    -- pending row past expires_at is treated as expired everywhere, and is flipped
    -- by the next lk_battle_request_end() on this battle or by the cron sweep.
    raise exception 'This end request has expired (the co-host''s 30 seconds are up).'
      using errcode = '22023';
  end if;

  if v_b.status <> 'live' then
    -- Defensive: finishing a battle always expires its pending request, so this
    -- should be unreachable.
    raise exception 'This battle is no longer live (status = %).', v_b.status
      using errcode = '22023';
  end if;

  if not p_accept then
    update public.lk_battle_end_requests
       set status       = 'declined',
           responded_at = now()
     where id = v_r.id;
    return v_b.id;                       -- battle continues
  end if;

  -- ACCEPT. If the timer has already run out, it is a normal timer end (the request
  -- is then marked expired by the finish, as the battle ended on its own).
  if now() >= v_b.ends_at then
    return public.lk_battle_finish_internal(v_b.id, 'timer'::public.lk_battle_end_method);
  end if;

  -- Mark it accepted FIRST, so the finish's "expire any pending request" skips it.
  update public.lk_battle_end_requests
     set status       = 'accepted',
         responded_at = now()
   where id = v_r.id;

  return public.lk_battle_finish_internal(
    v_b.id, 'end_request_accepted'::public.lk_battle_end_method);
end;
$$;

comment on function public.lk_battle_respond_end_request(uuid, boolean) is
  'Host only. Answers a pending, unexpired co-host end request. Accept -> the battle ends now, '
  'decided by the CURRENT score (equal = draw), end_method = end_request_accepted. Decline -> '
  'request declined, the battle continues (the co-host must wait 60s to ask again). Raises a '
  'clear error if the request has expired. Idempotent for a repeated identical answer. Returns '
  'the battle id.';

-- 7h. PENALTY --------------------------------------------------------------
-- Only the WINNER's host, never on a draw. After cohost_surrendered / cohost_left
-- the host (initiator) is the winner, so the host may set it.
create or replace function public.lk_battle_set_penalty(
  p_battle_id    uuid,
  p_penalty_text text,
  p_status       public.lk_penalty_status
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_b           public.lk_battles%rowtype;
  v_winner_host uuid;
  v_text        text;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  if p_status is null then
    raise exception 'A penalty status (assigned or skipped) is required.'
      using errcode = '22004';
  end if;

  select * into v_b from public.lk_battles where id = p_battle_id for update;
  if not found then
    raise exception 'Battle not found.' using errcode = 'P0002';
  end if;

  if v_b.status <> 'ended' then
    raise exception 'A penalty can only be set on a finished battle (status = %).', v_b.status
      using errcode = '22023';
  end if;

  if v_b.winner_stream_id is null then
    raise exception 'This battle was a draw — there is no winner to assign a penalty.'
      using errcode = '22023';
  end if;

  select ls.host_user_id into v_winner_host
    from public.live_streams ls where ls.id = v_b.winner_stream_id;

  if v_winner_host is null or v_winner_host <> v_uid then
    raise exception 'Only the winning broadcaster can set the penalty.'
      using errcode = '42501';
  end if;

  if p_status = 'skipped' then
    v_text := null;
  else
    v_text := nullif(btrim(p_penalty_text), '');
    if v_text is null then
      raise exception 'Penalty text is required when assigning a penalty.'
        using errcode = '22004';
    end if;
    if length(v_text) > 280 then
      raise exception 'Penalty text must be 280 characters or fewer.' using errcode = '22001';
    end if;
  end if;

  update public.lk_battles
     set penalty_text   = v_text,
         penalty_status = p_status
   where id = v_b.id;

  return v_b.id;
end;
$$;

comment on function public.lk_battle_set_penalty(uuid, text, public.lk_penalty_status) is
  'Winner''s host only, on an ended battle with a decided winner. Free text + status only — '
  'this is a cosmetic on-screen banner, not a structured task system.';

-- 7i. ADD POINTS — CROSS-FEATURE CONTRACT REQUIRED BY MIGRATION 04 ---------
-- UNCHANGED signature and behaviour (only live battles, only inside the window).
--
-- Called UNCONDITIONALLY by Feature 4's atomic gift RPC on every gift send,
-- inside that same transaction. It MUST NOT raise when there is no battle.
--
-- CONCURRENCY: the whole thing is a SINGLE UPDATE statement. Postgres takes a
-- row-level exclusive lock on the matched lk_battle_scores row and re-evaluates
-- that row under the lock, so two gifts landing on the same side at the same
-- instant serialise and neither increment is lost (a read-modify-write in
-- plpgsql would have lost one). Joining lk_battles inside the same statement
-- also means the status / time-window test and the increment cannot drift apart.
create or replace function public.lk_battle_add_points(
  p_live_stream_id uuid,
  p_points         bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_battle_id uuid;
begin
  if p_live_stream_id is null or p_points is null or p_points <= 0 then
    return null;
  end if;

  -- STEP 1 — take a SHARE lock on the active battle row.
  -- Why this is not a single UPDATE ... FROM lk_battles any more: in an UPDATE ... FROM,
  -- Postgres locks only the target row (the score row). If lk_battle_finish_internal()
  -- decided the result while this gift was waiting on the score-row lock, the re-check
  -- after the wait would still see the OLD battle row (status = 'live') and add the
  -- points AFTER the winner was decided — the result screen could then show a final
  -- score that contradicts the declared winner.
  -- FOR SHARE conflicts with the FOR UPDATE that lk_battle_finish_internal() takes on this
  -- row, so a gift and a battle-end serialise: if the end commits first, the re-check
  -- sees status <> 'live', no row comes back, and the gift simply doesn't count toward
  -- the battle (the Feature 4 ledger still credits the broadcaster normally).
  -- Concurrent gifts do NOT block each other: SHARE locks are compatible with each other.
  select b.id
    into v_battle_id
    from public.lk_battles b
   where b.status = 'live'
     and now() < b.ends_at
     and (b.initiator_stream_id = p_live_stream_id
          or b.opponent_stream_id = p_live_stream_id)
   limit 1
     for share;

  if v_battle_id is null then
    return null;        -- this stream is not inside an active battle
  end if;

  -- STEP 2 — single-statement increment; the score-row lock serialises simultaneous
  -- gifts to the same side, so no increment is ever lost.
  update public.lk_battle_scores s
     set points     = s.points + p_points,
         updated_at = now()
   where s.battle_id = v_battle_id
     and s.stream_id = p_live_stream_id;

  return v_battle_id;
end;
$$;

comment on function public.lk_battle_add_points(uuid, bigint) is
  'CONTRACT for migration 04. Adds p_points to the battle-score row of p_live_stream_id if '
  'that stream is inside an active battle window, and returns the battle id; otherwise does '
  'nothing and returns NULL. Never raises on "no battle" — safe to call on every gift send.';

-- 7j. SWEEPS (pg_cron every minute, see section 9) --------------------------
-- Run by pg_cron as the scheduling role, so auth.uid() is NULL inside them; they
-- have no auth check and are granted to service_role only.
create or replace function public.lk_battles_expire_stale()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_battles  integer;
  v_requests integer;
  v_sessions integer;
begin
  -- Lapsed invites. ended_at = the instant the invite actually lapsed (not the
  -- sweep time), so the invite pair-cooldown does not depend on cron lag.
  with expired as (
    update public.lk_battles
       set status   = 'expired',
           ended_at = invite_expires_at
     where status = 'invited'
       and invite_expires_at <= now()
    returning 1
  )
  select count(*)::integer into v_battles from expired;

  -- Lapsed co-host end requests (30 seconds without an answer).
  with expired as (
    update public.lk_battle_end_requests
       set status = 'expired'
     where status = 'pending'
       and expires_at <= now()
    returning 1
  )
  select count(*)::integer into v_requests from expired;

  -- Lapsed CO-HOST invites (60 seconds without an answer) — same rule as battle invites.
  with expired as (
    update public.live_cohost_sessions
       set status   = 'expired',
           ended_at = invite_expires_at
     where status = 'invited'
       and invite_expires_at <= now()
    returning 1
  )
  select count(*)::integer into v_sessions from expired;

  return coalesce(v_battles, 0) + coalesce(v_requests, 0) + coalesce(v_sessions, 0);
end;
$$;

comment on function public.lk_battles_expire_stale() is
  'Idempotent sweep (pg_cron, every minute): lapses invited battles AND invited co-host sessions '
  'past invite_expires_at (status expired, ended_at = invite_expires_at) and pending battle end '
  'requests past expires_at. Uses the partial indexes lk_battles_expiry_sweep_idx / '
  'live_cohost_sessions_expiry_sweep_idx / lk_battle_end_requests_expiry_sweep_idx, so cost is '
  'proportional to the number of due rows. Returns the total rows lapsed.';

create or replace function public.lk_battles_settle_due()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id    uuid;
  v_count integer := 0;
begin
  for v_id in
    select id from public.lk_battles
     where status = 'live' and ends_at is not null and ends_at <= now()
     order by ends_at
     limit 500
  loop
    -- Re-uses the same settlement rule so client and cron can never disagree
    -- (lk_battle_settle_internal = lk_battle_finish_internal(id, 'timer')).
    -- The _internal variant is used because pg_cron has no JWT (auth.uid() is NULL).
    if public.lk_battle_settle_internal(v_id) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.lk_battles_settle_due() is
  'Backstop sweep (pg_cron, every minute) for battles whose timer expired while nobody called '
  'lk_battle_settle(). Delegates to lk_battle_settle_internal() -> lk_battle_finish_internal('
  'id, ''timer''), so the outcome rule lives in exactly one place. Returns how many it settled.';

-- 7k. STREAM ENDED HOOK — someone left mid-battle ------------------------------
-- Called by file 01's live_stream_end_internal() for EVERY way a stream ends (host
-- ends it, admin/moderator ends it, moderation ban, abandoned-stream sweeper), right
-- after the stream row is marked ended. File 01 calls it DYNAMICALLY (only if it
-- exists), so there is no hard dependency between the two files.
--
-- PRIVATE: SECURITY DEFINER, no auth check, revoked from every client role. It runs
-- as the function owner inside the caller's transaction.
--
-- What happens to an ACTIVE battle that this stream is a side of:
--   live, co-host's stream ended -> ends now, HOST WINS           (cohost_left)
--   live, host's stream ended    -> ends now, by CURRENT score    (host_left)
--       (either way, if ends_at had already passed it is a normal timer end)
--   invited, host's stream ended -> 'cancelled'  — the inviter is gone, which is the
--       same thing as the host withdrawing the invite;
--   invited, opponent's stream ended -> 'expired' — the invitee can no longer answer;
--       they did not refuse ('declined') and the host did not withdraw ('cancelled').
-- A stream that is in no active battle, or a stream that was already ended earlier,
-- simply finds no active battle rows: a no-op returning 0.
create or replace function public.lk_battle_on_stream_ended(p_live_stream_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_b     public.lk_battles%rowtype;
  v_count integer := 0;
begin
  if p_live_stream_id is null then
    return 0;
  end if;

  -- CO-HOSTING LOCK ORDER (header, step 1): lock this stream's LIVE co-host session (if
  -- any) BEFORE the battle rows, the same order live_cohost_end() uses, so a stream ending
  -- and "end co-hosting" racing each other cannot deadlock. The session itself is closed
  -- afterwards by live_cohost_on_stream_ended(), which file 01 calls right after this hook.
  perform 1
     from public.live_cohost_sessions s
    where s.status = 'live'
      and (s.host_stream_id = p_live_stream_id
           or s.cohost_stream_id = p_live_stream_id)
    order by s.id
      for no key update;

  -- The one-active-battle-per-stream invariant means this finds at most one row;
  -- a loop is used anyway so the hook stays correct even if that ever changed.
  -- Served by the two partial unique indexes (lk_battles_active_*_uniq).
  for v_b in
    select *
      from public.lk_battles b
     where b.status in ('invited', 'live')
       and (b.initiator_stream_id = p_live_stream_id
            or b.opponent_stream_id = p_live_stream_id)
     order by b.id
       for update
  loop
    if v_b.status = 'live' then
      if now() >= v_b.ends_at then
        perform public.lk_battle_finish_internal(v_b.id, 'timer'::public.lk_battle_end_method);
      elsif v_b.opponent_stream_id = p_live_stream_id then
        perform public.lk_battle_finish_internal(
          v_b.id, 'cohost_left'::public.lk_battle_end_method, 'initiator');
      else
        perform public.lk_battle_finish_internal(v_b.id, 'host_left'::public.lk_battle_end_method);
      end if;

    else  -- 'invited'
      update public.lk_battles
         set status   = case when v_b.initiator_stream_id = p_live_stream_id
                             then 'cancelled'::public.lk_battle_status
                             else 'expired'::public.lk_battle_status
                        end,
             ended_at = now()
       where id = v_b.id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.lk_battle_on_stream_ended(uuid) is
  'PRIVATE (no grants). Called by live_stream_end_internal() (file 01) after a stream is marked '
  'ended. Live battle: co-host side gone -> host wins (cohost_left); host side gone -> decided '
  'by current score (host_left); timer already over -> timer end. Open invite: host side gone -> '
  'cancelled; opponent side gone -> expired. No-op (returns 0) for a stream in no active battle '
  'or one already ended. Returns the number of battles closed.';

-- 7l. CO-HOSTING RPCs (user approved 2026-09-11) ------------------------------
-- Same conventions as the battle RPCs: SECURITY DEFINER, pinned search_path, every
-- client-facing one re-derives the caller from auth.uid(). Session rows are locked
-- FOR NO KEY UPDATE (see LOCK ORDER in the header).

-- 7l-1. INVITE — the inviter becomes the HOST ---------------------------------
create or replace function public.live_cohost_invite(
  p_host_stream_id   uuid,
  p_cohost_stream_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_host        uuid;
  v_cohost      uuid;
  v_host_stat   text;
  v_cohost_stat text;
  v_expires     timestamptz;
  v_session_id  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  if p_host_stream_id is null or p_cohost_stream_id is null then
    raise exception 'Both stream ids are required.' using errcode = '22004';
  end if;

  if p_host_stream_id = p_cohost_stream_id then
    raise exception 'A stream cannot co-host with itself.' using errcode = '22023';
  end if;

  select ls.host_user_id, ls.status into v_host, v_host_stat
    from public.live_streams ls where ls.id = p_host_stream_id;
  if not found then
    raise exception 'Host stream not found.' using errcode = 'P0002';
  end if;

  select ls.host_user_id, ls.status into v_cohost, v_cohost_stat
    from public.live_streams ls where ls.id = p_cohost_stream_id;
  if not found then
    raise exception 'Co-host stream not found.' using errcode = 'P0002';
  end if;

  -- Only the inviting stream's own host may send the invite.
  if v_host is null or v_host <> v_uid then
    raise exception 'Only the host of the inviting stream can send a co-host invite.'
      using errcode = '42501';
  end if;

  if coalesce(v_host_stat, '') <> 'live' or coalesce(v_cohost_stat, '') <> 'live' then
    raise exception 'Both streams must be live to start co-hosting.' using errcode = '22023';
  end if;

  -- Two streams owned by the same person are not co-hosting.
  if v_cohost is null or v_cohost = v_host then
    raise exception 'The co-host must be a different broadcaster.' using errcode = '22023';
  end if;

  -- Shared invite rules with battles (inviter lock, lazy lapse of stale invites, 2-minute
  -- pair cooldown, 20 invites per hour — battle + co-host counted together).
  v_expires := public.lk_pairing_invite_guard_internal(
                 'cohost', v_host, v_cohost, p_host_stream_id, p_cohost_stream_id);

  -- Friendly pre-check: neither stream may be in ANY active pairing (a co-host session or
  -- an LK battle, invited or live). The AUTHORITATIVE guard is the partial unique indexes
  -- plus live_cohost_sessions_single_active_trg (shared with battles).
  if exists (
    select 1 from public.live_cohost_sessions s
     where s.status in ('invited', 'live')
       and (s.host_stream_id in (p_host_stream_id, p_cohost_stream_id)
            or s.cohost_stream_id in (p_host_stream_id, p_cohost_stream_id))
  ) or exists (
    select 1 from public.lk_battles b
     where b.status in ('invited', 'live')
       and (b.initiator_stream_id in (p_host_stream_id, p_cohost_stream_id)
            or b.opponent_stream_id in (p_host_stream_id, p_cohost_stream_id))
  ) then
    raise exception 'One of these streams is already busy in a co-host session or an LK battle.'
      using errcode = '23505';
  end if;

  insert into public.live_cohost_sessions (
    host_stream_id, cohost_stream_id, host_user_id, cohost_user_id,
    status, invited_at, invite_expires_at
  )
  values (
    p_host_stream_id, p_cohost_stream_id, v_host, v_cohost,
    'invited', now(), v_expires
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

comment on function public.live_cohost_invite(uuid, uuid) is
  'Host-only (the caller must host p_host_stream_id and becomes the co-hosting HOST). Creates an '
  'invited co-host session between two currently-live streams owned by two different broadcasters. '
  'Refused (23505) when either stream is already in any active co-host session or LK battle, '
  'invited or live. Invite TTL 60s. Anti-spam shared with battle invites '
  '(lk_pairing_invite_guard_internal): 2-minute pair cooldown after a declined / expired / '
  'cancelled battle or co-host invite to the same person, 20 battle + co-host invites per rolling '
  'hour (SQLSTATE PT429 = HTTP 429). Returns the session id.';

-- 7l-2. ACCEPT — the invitee becomes the CO-HOST -------------------------------
create or replace function public.live_cohost_accept(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_s           public.live_cohost_sessions%rowtype;
  v_cohost_host uuid;
  v_cohost_stat text;
  v_host_stat   text;
  v_now         timestamptz := now();
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  -- Row lock makes a double-accept (two taps, two devices) impossible.
  select * into v_s from public.live_cohost_sessions where id = p_session_id for no key update;
  if not found then
    raise exception 'Co-host session not found.' using errcode = 'P0002';
  end if;

  select ls.host_user_id, ls.status into v_cohost_host, v_cohost_stat
    from public.live_streams ls where ls.id = v_s.cohost_stream_id;

  if v_cohost_host is null or v_cohost_host <> v_uid then
    raise exception 'Only the invited broadcaster can accept this co-host invite.'
      using errcode = '42501';
  end if;

  if v_s.status = 'live' then
    return v_s.id;                       -- idempotent re-accept
  end if;

  if v_s.status <> 'invited' then
    raise exception 'This co-host invite is no longer open (status = %).', v_s.status
      using errcode = '22023';
  end if;

  if v_now >= v_s.invite_expires_at then
    -- No "mark it expired" UPDATE here: the RAISE rolls it back. The sweep or the next
    -- invite on either stream flips it (same as lk_battle_accept).
    raise exception 'This co-host invite has expired.' using errcode = '22023';
  end if;

  select ls.status into v_host_stat
    from public.live_streams ls where ls.id = v_s.host_stream_id;

  if coalesce(v_host_stat, '') <> 'live' or coalesce(v_cohost_stat, '') <> 'live' then
    raise exception 'Both streams must still be live to start co-hosting.' using errcode = '22023';
  end if;

  -- The shared one-active-pairing trigger re-checks both streams under the advisory locks.
  update public.live_cohost_sessions
     set status     = 'live',
         started_at = v_now
   where id = v_s.id;

  return v_s.id;
end;
$$;

comment on function public.live_cohost_accept(uuid) is
  'Invitee only (the broadcaster of cohost_stream_id). Flips an unexpired co-host invite to live '
  '(started_at = now) while both streams are still live. Idempotent if the session is already live.';

-- 7l-3. DECLINE — invitee only ------------------------------------------------
create or replace function public.live_cohost_decline(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid         uuid := auth.uid();
  v_s           public.live_cohost_sessions%rowtype;
  v_cohost_host uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_s from public.live_cohost_sessions where id = p_session_id for no key update;
  if not found then
    raise exception 'Co-host session not found.' using errcode = 'P0002';
  end if;

  select ls.host_user_id into v_cohost_host
    from public.live_streams ls where ls.id = v_s.cohost_stream_id;

  if v_cohost_host is null or v_cohost_host <> v_uid then
    raise exception 'Only the invited broadcaster can decline this co-host invite.'
      using errcode = '42501';
  end if;

  if v_s.status = 'declined' then
    return v_s.id;                       -- idempotent
  end if;

  if v_s.status <> 'invited' then
    raise exception 'Only an open co-host invite can be declined (status = %).', v_s.status
      using errcode = '22023';
  end if;

  update public.live_cohost_sessions
     set status           = 'declined',
         ended_at         = now(),     -- close time, read by the shared pair cooldown
         ended_by_user_id = v_uid
   where id = v_s.id;

  return v_s.id;
end;
$$;

comment on function public.live_cohost_decline(uuid) is
  'Invitee only. Marks an open co-host invite declined. The row is kept for the shared invite '
  'anti-spam (the host then waits 2 minutes before inviting this person again, battle or co-host).';

-- 7l-4. CANCEL — the host withdraws an invite -----------------------------------
create or replace function public.live_cohost_cancel(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_s   public.live_cohost_sessions%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  select * into v_s from public.live_cohost_sessions where id = p_session_id for no key update;
  if not found then
    raise exception 'Co-host session not found.' using errcode = 'P0002';
  end if;

  if v_s.host_user_id is null or v_s.host_user_id <> v_uid then
    raise exception 'Only the host who sent this co-host invite can withdraw it.'
      using errcode = '42501';
  end if;

  if v_s.status = 'cancelled' then
    return v_s.id;                       -- idempotent
  end if;

  if v_s.status = 'live' then
    raise exception 'This co-hosting is already live. Use live_cohost_end to end it.'
      using errcode = '22023';
  end if;

  if v_s.status <> 'invited' then
    raise exception 'Only an open co-host invite can be withdrawn (status = %).', v_s.status
      using errcode = '22023';
  end if;

  update public.live_cohost_sessions
     set status           = 'cancelled',
         ended_at         = now(),     -- close time, read by the shared pair cooldown
         ended_by_user_id = v_uid
   where id = v_s.id;

  return v_s.id;
end;
$$;

comment on function public.live_cohost_cancel(uuid) is
  'Host only (the broadcaster who sent the invite). Withdraws a co-host invite that has not been '
  'accepted yet -> status cancelled. A live session is ended with live_cohost_end instead.';

-- 7l-5. END CO-HOSTING — either participant -------------------------------------
-- Breaks the 50/50 link; BOTH streams keep running solo (nothing on live_streams is
-- touched). Refused while a battle inside this co-hosting is live — that battle must end
-- first by its own rules. If its timer has already run out it is simply settled here as a
-- normal timer end (exactly what lk_battle_settle would do), so the button never stays
-- blocked waiting for the cron sweep. A battle invite inside this co-hosting that is still
-- pending is withdrawn ('cancelled'), because the battle could no longer start.
create or replace function public.live_cohost_end(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_s         public.live_cohost_sessions%rowtype;
  v_battle_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.' using errcode = '28000';
  end if;

  -- LOCK ORDER step 1. FOR NO KEY UPDATE conflicts with the FOR SHARE taken by
  -- lk_battle_invite / lk_battle_accept on this session, so no battle can be linked to or
  -- started inside this session while we decide; it does NOT block gifts (their foreign-key
  -- check only takes FOR KEY SHARE).
  select * into v_s from public.live_cohost_sessions where id = p_session_id for no key update;
  if not found then
    raise exception 'Co-host session not found.' using errcode = 'P0002';
  end if;

  if not coalesce(v_uid = v_s.host_user_id, false)
     and not coalesce(v_uid = v_s.cohost_user_id, false) then
    raise exception 'Only the host or the co-host can end this co-hosting.' using errcode = '42501';
  end if;

  if v_s.status = 'ended' then
    return v_s.id;                       -- double tap / already over: idempotent
  end if;

  if v_s.status <> 'live' then
    raise exception 'Only a live co-hosting can be ended (status = %). To withdraw an invite use live_cohost_cancel; to refuse one use live_cohost_decline.',
      v_s.status using errcode = '22023';
  end if;

  -- A battle inside this co-hosting whose timer already ran out is over: settle it now as a
  -- normal timer end (same rule, same function as every other end path).
  for v_battle_id in
    select b.id
      from public.lk_battles b
     where b.cohost_session_id = v_s.id
       and b.status  = 'live'
       and b.ends_at <= now()
     order by b.id
  loop
    perform public.lk_battle_finish_internal(v_battle_id, 'timer'::public.lk_battle_end_method);
  end loop;

  if exists (
    select 1 from public.lk_battles b
     where b.cohost_session_id = v_s.id
       and b.status = 'live'
  ) then
    raise exception 'An LK battle is running inside this co-hosting. It has to end first (by its own rules); then the co-hosting can be ended.'
      using errcode = '22023';
  end if;

  -- A pending battle invite inside this co-hosting can no longer become a battle.
  update public.lk_battles b
     set status   = 'cancelled',
         ended_at = now()
   where b.cohost_session_id = v_s.id
     and b.status = 'invited';

  update public.live_cohost_sessions
     set status           = 'ended',
         -- greatest(): never before started_at, even if this transaction began a moment
         -- before the accept committed (live_cohost_sessions_ended_after_start_chk).
         ended_at         = greatest(now(), v_s.started_at),
         ended_by_user_id = v_uid,
         end_method       = case when v_uid = v_s.host_user_id
                                 then 'host_ended'::public.live_cohost_end_method
                                 else 'cohost_ended'::public.live_cohost_end_method
                            end
   where id = v_s.id;

  return v_s.id;
end;
$$;

comment on function public.live_cohost_end(uuid) is
  'Host or co-host. Ends a LIVE co-host session (end_method host_ended / cohost_ended); both '
  'streams keep running solo. Refused (22023) while an LK battle inside this co-hosting is live — '
  'it must end first by its own rules (a battle whose timer already ran out is settled here as a '
  'timer end). A pending battle invite inside the session is cancelled. Idempotent on an ended '
  'session.';

-- 7l-6. STREAM ENDED HOOK — someone's whole stream ended --------------------------
-- Called by file 01's live_stream_end_internal() for EVERY way a stream ends, right AFTER
-- lk_battle_on_stream_ended() — so a battle inside the co-hosting is first closed by the
-- battle rules (e.g. co-host left -> host wins), and only then the session ends. Called
-- DYNAMICALLY by file 01 (only if it exists).
-- PRIVATE: SECURITY DEFINER, no auth check, revoked from every client role.
--   live,    host's stream ended    -> ended, end_method = host_left
--   live,    co-host's stream ended -> ended, end_method = cohost_left
--   invited, host's stream ended    -> 'cancelled' (the inviter is gone = withdrawn)
--   invited, co-host's stream ended -> 'expired'   (the invitee can no longer answer)
-- The other broadcaster simply continues solo. No-op (returns 0) for a stream in no active
-- session or one already handled — safe to call repeatedly.
create or replace function public.live_cohost_on_stream_ended(p_live_stream_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_s     public.live_cohost_sessions%rowtype;
  v_count integer := 0;
begin
  if p_live_stream_id is null then
    return 0;
  end if;

  -- At most one row (one active pairing per stream); a loop keeps it correct regardless.
  -- Served by the partial unique indexes live_cohost_sessions_active_*_uniq.
  for v_s in
    select *
      from public.live_cohost_sessions s
     where s.status in ('invited', 'live')
       and (s.host_stream_id = p_live_stream_id
            or s.cohost_stream_id = p_live_stream_id)
     order by s.id
       for no key update
  loop
    if v_s.status = 'live' then
      update public.live_cohost_sessions
         set status     = 'ended',
             ended_at   = greatest(now(), v_s.started_at),
             end_method = case when v_s.host_stream_id = p_live_stream_id
                               then 'host_left'::public.live_cohost_end_method
                               else 'cohost_left'::public.live_cohost_end_method
                          end
       where id = v_s.id;
    else  -- 'invited'
      update public.live_cohost_sessions
         set status   = case when v_s.host_stream_id = p_live_stream_id
                             then 'cancelled'::public.live_cohost_status
                             else 'expired'::public.live_cohost_status
                        end,
             ended_at = now()
       where id = v_s.id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.live_cohost_on_stream_ended(uuid) is
  'PRIVATE (no grants). Called by live_stream_end_internal() (file 01) after the battle hook, once a '
  'stream is marked ended. Live session: host side gone -> ended/host_left; co-host side gone -> '
  'ended/cohost_left. Open invite: host side gone -> cancelled; invitee side gone -> expired. '
  'No-op (returns 0) otherwise. Returns the number of sessions closed.';

-- 7l-7. ACTIVE SESSION LOOKUP — CONTRACT for files 04 and 06 ----------------------
-- "Which LIVE co-host session is this stream in right now?" (NULL if none). file 04's
-- gift_send() calls it on every gift to stamp gift_transactions.cohost_session_id, and file
-- 06 uses it for the co-host counts / deep links. Two partial-unique-index probes.
-- PRIVATE: no client grant; the SECURITY DEFINER callers (same owner) execute it as owner.
create or replace function public.live_cohost_active_session(p_live_stream_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
    from public.live_cohost_sessions s
   where s.status = 'live'
     and (s.host_stream_id   = p_live_stream_id
          or s.cohost_stream_id = p_live_stream_id)
   limit 1;
$$;

comment on function public.live_cohost_active_session(uuid) is
  'PRIVATE (no client grants). Returns the id of the LIVE co-host session p_live_stream_id is part '
  'of (either side), else NULL. Never raises. Called by gift_send() (file 04) and file 06.';

-- ---------------------------------------------------------------------------
-- 8. FUNCTION GRANTS
-- ---------------------------------------------------------------------------

-- SECURITY: Supabase grants EXECUTE on every new public function to anon, authenticated and
-- service_role through ALTER DEFAULT PRIVILEGES. "revoke ... from public" alone does NOT remove
-- those explicit role grants, so every revoke below names anon and authenticated too; the grants
-- that follow re-open only what clients are meant to call. Do not shorten these back to "from public".
revoke all on function public.lk_battle_invite(uuid, uuid, integer)                       from public, anon, authenticated;
revoke all on function public.lk_battle_accept(uuid)                                      from public, anon, authenticated;
revoke all on function public.lk_battle_decline(uuid)                                     from public, anon, authenticated;
revoke all on function public.lk_battle_cancel(uuid)                                      from public, anon, authenticated;
revoke all on function public.lk_battle_settle(uuid)                                      from public, anon, authenticated;
revoke all on function public.lk_battle_settle_internal(uuid)                             from public, anon, authenticated;
revoke all on function public.lk_battle_finish_internal(uuid, public.lk_battle_end_method, text) from public, anon, authenticated;
revoke all on function public.lk_battle_end_early(uuid)                                   from public, anon, authenticated;
revoke all on function public.lk_battle_surrender(uuid)                                   from public, anon, authenticated;
revoke all on function public.lk_battle_request_end(uuid)                                 from public, anon, authenticated;
revoke all on function public.lk_battle_respond_end_request(uuid, boolean)                from public, anon, authenticated;
revoke all on function public.lk_battle_set_penalty(uuid, text, public.lk_penalty_status) from public, anon, authenticated;
revoke all on function public.lk_battle_add_points(uuid, bigint)                          from public, anon, authenticated;
revoke all on function public.lk_battles_expire_stale()                                   from public, anon, authenticated;
revoke all on function public.lk_battles_settle_due()                                     from public, anon, authenticated;
revoke all on function public.lk_battle_on_stream_ended(uuid)                             from public, anon, authenticated;
revoke all on function public.lk_battles_assert_single_active()                            from public, anon, authenticated;
revoke all on function public.lk_pairing_invite_guard_internal(text, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.live_cohost_invite(uuid, uuid)                              from public, anon, authenticated;
revoke all on function public.live_cohost_accept(uuid)                                    from public, anon, authenticated;
revoke all on function public.live_cohost_decline(uuid)                                   from public, anon, authenticated;
revoke all on function public.live_cohost_cancel(uuid)                                    from public, anon, authenticated;
revoke all on function public.live_cohost_end(uuid)                                       from public, anon, authenticated;
revoke all on function public.live_cohost_on_stream_ended(uuid)                           from public, anon, authenticated;
revoke all on function public.live_cohost_active_session(uuid)                            from public, anon, authenticated;

grant execute on function public.lk_battle_invite(uuid, uuid, integer)                       to authenticated;
grant execute on function public.lk_battle_accept(uuid)                                      to authenticated;
grant execute on function public.lk_battle_decline(uuid)                                     to authenticated;
grant execute on function public.lk_battle_cancel(uuid)                                      to authenticated;
grant execute on function public.lk_battle_settle(uuid)                                      to authenticated;
grant execute on function public.lk_battle_end_early(uuid)                                   to authenticated;
grant execute on function public.lk_battle_surrender(uuid)                                   to authenticated;
grant execute on function public.lk_battle_request_end(uuid)                                 to authenticated;
grant execute on function public.lk_battle_respond_end_request(uuid, boolean)                to authenticated;
grant execute on function public.lk_battle_set_penalty(uuid, text, public.lk_penalty_status) to authenticated;

-- Co-hosting client surface (each validates auth.uid() and the caller's role itself).
grant execute on function public.live_cohost_invite(uuid, uuid)                              to authenticated;
grant execute on function public.live_cohost_accept(uuid)                                    to authenticated;
grant execute on function public.live_cohost_decline(uuid)                                   to authenticated;
grant execute on function public.live_cohost_cancel(uuid)                                    to authenticated;
grant execute on function public.live_cohost_end(uuid)                                       to authenticated;

-- add_points is deliberately NOT granted to clients: it is an internal building
-- block that migration 04's gift RPC (also SECURITY DEFINER, so it runs as the
-- function owner) calls server-side. Granting it to authenticated would let a
-- client inflate a battle score with no real gift behind it.
grant execute on function public.lk_battle_add_points(uuid, bigint) to service_role;

-- lk_battle_finish_internal(), lk_battle_settle_internal(), lk_battle_on_stream_ended(),
-- lk_pairing_invite_guard_internal(), live_cohost_on_stream_ended() and
-- live_cohost_active_session() get NO grant at all: they are reachable only through
-- SECURITY DEFINER callers owned by the same role (the wrappers in this file, file 01's
-- live_stream_end_internal for the two hooks, file 04's gift_send and file 06's resolvers
-- for live_cohost_active_session), which execute as the owner.

-- Sweeps are for the scheduler / backend only.
grant execute on function public.lk_battles_expire_stale() to service_role;
grant execute on function public.lk_battles_settle_due()   to service_role;

-- ---------------------------------------------------------------------------
-- 9. SCHEDULING — invite / end-request expiry and timer settlement
-- ---------------------------------------------------------------------------
-- *** USER APPROVED 2026-09-10 *** : both sweeps ON, every minute.
--
--   lk_battles_expire_stale -> lapses battle invites AND co-host session invites past
--                              invite_expires_at, and co-host "end the battle" requests
--                              past expires_at.
--   lk_battles_settle_due   -> settles live battles whose ends_at has passed and that
--                              no client settled (both apps crashed / went offline).
--
-- Security: pg_cron runs each job as the role that scheduled it (the SQL Editor's
-- `postgres` role, which also owns these functions — so the REVOKEs in section 8 do
-- not block it). The job carries no JWT, so auth.uid() is NULL inside the functions;
-- neither sweep has an auth check, by design.
--
-- Idempotent: any existing job with the same name is unscheduled first, then created
-- again, so re-running this file never produces duplicate jobs. The earlier draft of
-- this file suggested scheduling the same sweeps by hand as 'lk-battles-expire-stale'
-- / 'lk-battles-settle-due'; those are removed too so nothing runs twice a minute.
-- If pg_cron is not installed the block does nothing except raise a NOTICE.
--
-- Check they are scheduled :  select * from cron.job where jobname like 'lk_battles_%';
-- See recent runs          :  select * from cron.job_run_details order by start_time desc limit 20;
-- Turn them off            :  select cron.unschedule('lk_battles_expire_stale');
--                             select cron.unschedule('lk_battles_settle_due');
do $lk_battle_cron$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(j.jobid)
           from cron.job j
          where j.jobname in ('lk_battles_expire_stale',
                              'lk_battles_settle_due',
                              'lk-battles-expire-stale',    -- old hand-run draft names
                              'lk-battles-settle-due');

        perform cron.schedule(
            'lk_battles_expire_stale',
            '* * * * *',                                     -- every minute
            $cmd_expire$select public.lk_battles_expire_stale();$cmd_expire$
        );

        perform cron.schedule(
            'lk_battles_settle_due',
            '* * * * *',                                     -- every minute
            $cmd_settle$select public.lk_battles_settle_due();$cmd_settle$
        );
    else
        raise notice 'pg_cron is not installed: jobs lk_battles_expire_stale / lk_battles_settle_due were NOT scheduled. Invites and end requests will only lapse lazily, and battles will only settle when a client calls lk_battle_settle(), until pg_cron is enabled and this file is re-run.';
    end if;
end $lk_battle_cron$;

commit;

-- ============================================================================
-- ROLLBACK (manual) — run in this order, uncommented, if this migration must go.
-- ============================================================================
-- begin;
-- select cron.unschedule('lk_battles_expire_stale');   -- stop the sweeps first (section 9)
-- select cron.unschedule('lk_battles_settle_due');
-- -- ---- co-hosting (roll back file 04's gift_transactions.cohost_session_id / gift_send
-- -- ----  and file 06's live_engagement_counts_cohost / live_deeplink_resolve FIRST: they
-- -- ----  call live_cohost_active_session() and read live_cohost_sessions statically) ----
-- --   To remove ONLY co-hosting and keep battles: run just the co-hosting lines below,
-- --   then straight away re-run a version of this file WITHOUT co-hosting (it is
-- --   idempotent) so lk_battle_invite, lk_battle_accept, lk_battle_on_stream_ended,
-- --   lk_battles_expire_stale, lk_battles_assert_single_active and the
-- --   lk_battles_single_active_trg trigger come back without their co-hosting parts.
-- drop trigger  if exists live_cohost_sessions_single_active_trg  on public.live_cohost_sessions;
-- drop trigger  if exists update_live_cohost_sessions_updated_at  on public.live_cohost_sessions;
-- drop function if exists public.live_cohost_active_session(uuid);
-- drop function if exists public.live_cohost_on_stream_ended(uuid);  -- file 01's hook then no-ops (it checks to_regprocedure)
-- drop function if exists public.live_cohost_end(uuid);
-- drop function if exists public.live_cohost_cancel(uuid);
-- drop function if exists public.live_cohost_decline(uuid);
-- drop function if exists public.live_cohost_accept(uuid);
-- drop function if exists public.live_cohost_invite(uuid, uuid);
-- drop index    if exists public.lk_battles_cohost_session_idx;
-- drop trigger  if exists lk_battles_single_active_trg on public.lk_battles;  -- its UPDATE OF list
-- --                                  names cohost_session_id (the co-hosting-free file re-creates it)
-- alter table public.lk_battles drop constraint if exists lk_battles_cohost_session_id_fkey;
-- alter table public.lk_battles drop column     if exists cohost_session_id;
-- drop table    if exists public.live_cohost_sessions;
-- drop type     if exists public.live_cohost_end_method;
-- drop type     if exists public.live_cohost_status;
-- -- ---- battles ----------------------------------------------------------------------
-- drop trigger  if exists lk_battles_single_active_trg        on public.lk_battles;
-- drop trigger  if exists update_lk_battles_updated_at        on public.lk_battles;
-- drop trigger  if exists update_lk_battle_scores_updated_at  on public.lk_battle_scores;
-- drop function if exists public.lk_battle_on_stream_ended(uuid);  -- file 01's hook then no-ops (it checks to_regprocedure)
-- drop function if exists public.lk_battles_settle_due();
-- drop function if exists public.lk_battles_expire_stale();
-- drop function if exists public.lk_battle_add_points(uuid, bigint);
-- drop function if exists public.lk_battle_set_penalty(uuid, text, public.lk_penalty_status);
-- drop function if exists public.lk_battle_respond_end_request(uuid, boolean);
-- drop function if exists public.lk_battle_request_end(uuid);
-- drop function if exists public.lk_battle_surrender(uuid);
-- drop function if exists public.lk_battle_end_early(uuid);
-- drop function if exists public.lk_battle_settle(uuid);
-- drop function if exists public.lk_battle_settle_internal(uuid);
-- drop function if exists public.lk_battle_finish_internal(uuid, public.lk_battle_end_method, text);
-- drop function if exists public.lk_battle_cancel(uuid);
-- drop function if exists public.lk_battle_decline(uuid);
-- drop function if exists public.lk_battle_accept(uuid);
-- drop function if exists public.lk_battle_invite(uuid, uuid, integer);
-- drop function if exists public.lk_pairing_invite_guard_internal(text, uuid, uuid, uuid, uuid);
-- drop function if exists public.lk_battles_assert_single_active();
-- drop table    if exists public.lk_battle_end_requests;
-- drop table    if exists public.lk_battle_scores;
-- drop table    if exists public.lk_battles;
-- drop type     if exists public.lk_battle_end_request_status;
-- drop type     if exists public.lk_battle_end_method;
-- drop type     if exists public.lk_penalty_status;
-- drop type     if exists public.lk_battle_status;
-- commit;
--
-- NOTE: nothing above touches public.live_streams, public.profiles, public.user_roles,
-- public.has_role() or public.update_updated_at_column() — all pre-existing and untouched.
-- Files 04 (gift_transactions.battle_id / cohost_session_id, gift_send) and 06 (live_shares /
-- live_engagement_counters, live_engagement_counts_cohost, live_deeplink_resolve) reference
-- public.lk_battles / public.live_cohost_sessions; roll those back first, or drop the tables
-- with CASCADE (gift_send would then fail until it is re-created without the co-host call).
