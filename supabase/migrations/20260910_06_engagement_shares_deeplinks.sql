-- =====================================================================================
-- LukuLuku Live Streaming — Migration 06
-- Feature: The five live numbers (live viewers / total views / hearts / chats / shares),
--          share tracking, deep links for live streams and LK battles.
-- Approved by the user 2026-09-10 ("whatever is industry standard and best for performance").
-- Target:  Supabase / PostgreSQL 17
--
-- Scope:   mobile app only (the website does not run live streaming).
--
-- CREATES
--   tables    : public.live_engagement_counters     (lazy SHARE snapshot cache, 1 row per target)
--               public.live_shares                  (one row per COUNTED share)
--   functions : public.live_engagement_snapshot_internal(text, uuid)  [private, no grants]
--               public.live_engagement_viewers_internal(uuid)         [private, no grants]
--               public.live_engagement_counts_stream(uuid)            -> jsonb
--               public.live_engagement_counts_battle(uuid)            -> jsonb
--               public.live_engagement_counts_cohost(uuid)            -> jsonb  (co-hosting)
--               public.live_share_record(uuid, uuid, text, text)      -> jsonb
--               public.live_deeplink_stream_card_internal(uuid)       [private, no grants]
--               public.live_deeplink_resolve(text, uuid)              -> jsonb
--   enums     : none, by design (share_channel is checked text so new share targets never
--               need a migration).
--
-- MUST RUN AFTER (hard dependencies, checked by the preflight block below):
--   20260910_01_live_streaming_core.sql   (live_stream_runtime incl. total_views_live,
--                                          stream_categories, live_streams.category_id /
--                                          total_views)
--   20260910_02_live_chat_reactions.sql   (live_stream_chat_counts, live_stream_reaction_counts)
--   20260910_03_lk_battles.sql            (lk_battles, live_cohost_sessions,
--                                          live_cohost_active_session)
--   20260910_04_economy_gifting.sql       (gift_transactions.cohost_session_id — the co-host
--                                          points-in-session sum)
--   20260910_05                           run-order only, no hard dependency (file 05's chat
--                                          gate is what increments live_stream_chat_counts).
--   This file runs LAST.
--
-- PURE EXTENSION: no ALTER / DROP / RENAME on any pre-existing table, and no policy on a
-- pre-existing table (live_streams, profiles, channels, ...) is created, changed or dropped.
-- Nothing is added to any table created by files 01-05.
--
-- SAFE TO RE-RUN: fully idempotent (if-not-exists tables/indexes, drop-policy-before-create,
-- drop-trigger-before-create, create-or-replace functions), one transaction.
--
-- -------------------------------------------------------------------------------------
-- HOW THE FIVE LIVE NUMBERS WORK — READ THIS BEFORE CHANGING ANYTHING
-- -------------------------------------------------------------------------------------
-- During a live stream, an LK battle and co-hosting, EVERYONE in the room —
-- broadcaster, host, co-host, viewers — sees five numbers update live:
--     live viewers | total views | total hearts | total chats | total shares
--
-- The numbers on screen move INSTANTLY because of REALTIME ROOM EVENTS, not the database:
--   * live viewers / total views : join / leave presence on the room's realtime channel,
--     or the video service's (ZegoCloud) room user-count callback. A join = viewers +1 and
--     views +1; a leave = viewers -1.
--   * hearts : the heart/reaction events already sent on the room's realtime channel.
--   * chats  : every viewer already receives every chat message over that channel; +1 each.
--   * shares : a counted share is broadcast on the same channel (send it only when
--     live_share_record() returns counted = true); +1 each.
--
-- The phone RE-SYNCS all five from live_engagement_counts_stream() /
-- live_engagement_counts_battle() / live_engagement_counts_cohost():
--   * once when a viewer opens the stream (also the battle screen, the co-hosting screen,
--     the end-of-stream summary and the ended-stream deep-link page), and
--   * then periodically, every few minutes (e.g. every 3-5 minutes), to correct any drift
--     from missed events, reconnects or presence gaps.
--   NEVER poll these RPCs per second: on a busy stream that is thousands of database
--   calls a second for numbers the realtime events already deliver.
-- Co-hosting: each participant's side gets the same five numbers of its own stream, plus
-- the points it earned in the session — see "CO-HOSTING" below.
--
-- LIVE VIEWERS / TOTAL VIEWS — primary-key reads (file 01's tables), no snapshot, no delta:
--   * live_viewers = live_stream_runtime.current_concurrent_viewers; 0 once the stream is
--     no longer live.
--   * total_views while live = live_stream_runtime.total_views_live: +1 per watch session
--     opened (repeat joins count), the same definition as the final number, bumped by
--     live_stream_join() inside the runtime write it already does.
--     Once ended = live_streams.total_views, the exact final count written by
--     live_stream_end_internal() (which also reconciles total_views_live to it).
--   * Served by live_engagement_viewers_internal() (section 5), used for streams and for
--     each side of a battle, so the rule lives in one place.
--
-- CHAT COUNT — an exact counter, read directly (no snapshot, no delta):
--   * Chat messages are NEVER stored (user decision 2026-09-10, see file 02's header). The
--     file-05 message gate (stream_mod_chat_gate) increments
--     live_stream_chat_counts.total_chat_messages by 1 for every message it allows — the
--     relay already makes exactly one gate call per message, so this adds no extra round
--     trip, and that counter row is separate from the reaction counter so the two never
--     wait on each other's lock.
--   * chat_count therefore = messages that passed the gate. A moderator "remove message"
--     is a realtime-only signal and does not lower it.
--
-- SHARE COUNT — SNAPSHOT + DELTA, refreshed lazily:
--   * live_engagement_counters keeps a share snapshot (count as of snapshot_at).
--   * Every counts call returns snapshot + (share rows created after snapshot_at). The
--     delta is a short index range scan (at most ~5 minutes of rows).
--   * If the snapshot is missing or older than 5 minutes, ONE caller (whoever wins
--     pg_try_advisory_xact_lock) recomputes it in full; everyone else just uses
--     snapshot + delta. No cron job is needed, counts are exact at the moment of the
--     call, and the full recompute self-heals any drift.
--
-- HEARTS (reaction_count) — read directly from live_stream_reaction_counts (file 02).
--
--   Client pattern (all five numbers): call live_engagement_counts_* when the stream is
--   opened, then move the numbers from realtime events, and re-sync every few minutes.
--   Do NOT poll these RPCs per second.
--
-- -------------------------------------------------------------------------------------
-- DEEP LINK URL SHAPES (app routing + the website fallback page are implementation-phase
-- work, NOT part of this SQL)
-- -------------------------------------------------------------------------------------
--   https://lukuluku.online/live/<live_stream_id>     -> live_deeplink_resolve('live',   id)
--   https://lukuluku.online/battle/<battle_id>        -> live_deeplink_resolve('battle', id)
--   (co-hosting has NO link of its own: the stream link is shared, and the resolver adds the
--    live co-host partner to the 'live' answer — see "CO-HOSTING" below.)
-- Matches how App.tsx already handles /watch, /momenti, /post: parse the id from the URL,
-- fetch, navigate. The resolver exists because live_streams' own SELECT policy hides ENDED
-- streams from everyone except the host, so without it a link to an ended stream would look
-- exactly like a broken link. The resolver returns only public-safe fields and does not touch
-- that table's policies. Stream/battle ids are random UUIDs, so this is link-based access
-- only — nobody can list or guess ended streams through it.
--
-- -------------------------------------------------------------------------------------
-- CO-HOSTING (built 2026-09-11; the session table lives in file 03, live_cohost_sessions)
-- -------------------------------------------------------------------------------------
--   * NO separate share target and NO separate link kind: co-hosting is two ordinary live
--     streams linked 50/50, so people share (and count shares on) the STREAM link, and
--     live_shares / live_engagement_counters / live_share_record are unchanged.
--   * live_engagement_counts_cohost(session_id) (5.3b): for each side (host, co-host) the
--     five live numbers of that side's own stream, exactly as live_engagement_counts_stream()
--     returns them (it is reused as-is), plus points_in_session = the points that side
--     received from gifts stamped with this session (gift_transactions.cohost_session_id,
--     file 04).
--   * live_deeplink_resolve('live', id): while the stream is live in a LIVE co-host session
--     the answer carries cohost = {session_id, role ('host'|'cohost'), partner: <stream
--     card>} (null otherwise), so an opened link lands on the 50/50 screen with the
--     partner's card. 'battle' answers carry cohost_session_id (a battle fought inside a
--     co-hosting returns to that co-hosting when it ends).
-- =====================================================================================

begin;

-- -------------------------------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly if an earlier file has not been run.
-- -------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.live_streams') is null then
    raise exception 'public.live_streams is missing. It is a PRE-EXISTING table — check the database.';
  end if;
  if to_regclass('public.live_stream_runtime') is null
     or to_regclass('public.stream_categories') is null
     or not exists (select 1 from pg_attribute
                     where attrelid = 'public.live_streams'::regclass
                       and attname  = 'category_id'
                       and not attisdropped) then
    raise exception 'Run 20260910_01_live_streaming_core.sql first (live_stream_runtime / stream_categories / live_streams.category_id missing).';
  end if;
  -- The viewers/views helper (section 5) reads these two columns. plpgsql only resolves
  -- column names when a function first runs, so check them here instead of failing later.
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.live_stream_runtime'::regclass
                    and attname  = 'total_views_live'
                    and not attisdropped)
     or not exists (select 1 from pg_attribute
                     where attrelid = 'public.live_streams'::regclass
                       and attname  = 'total_views'
                       and not attisdropped) then
    raise exception 'Re-run the CURRENT 20260910_01_live_streaming_core.sql first (live_stream_runtime.total_views_live / live_streams.total_views missing).';
  end if;
  if to_regclass('public.live_stream_chat_counts') is null then
    raise exception 'Run 20260910_02_live_chat_reactions.sql first (live_stream_chat_counts missing).';
  end if;
  if to_regclass('public.live_stream_reaction_counts') is null then
    raise exception 'Run 20260910_02_live_chat_reactions.sql first (live_stream_reaction_counts missing).';
  end if;
  if to_regclass('public.lk_battles') is null then
    raise exception 'Run 20260910_03_lk_battles.sql first (lk_battles missing).';
  end if;
  -- Co-hosting (file 03 + file 04). plpgsql resolves these only at first call, so check here.
  if to_regclass('public.live_cohost_sessions') is null
     or to_regprocedure('public.live_cohost_active_session(uuid)') is null
     or not exists (select 1 from pg_attribute
                     where attrelid = 'public.lk_battles'::regclass
                       and attname  = 'cohost_session_id'
                       and not attisdropped) then
    raise exception 'Re-run the CURRENT 20260910_03_lk_battles.sql first (co-hosting: live_cohost_sessions / live_cohost_active_session / lk_battles.cohost_session_id missing).';
  end if;
  -- Two separate IFs on purpose: a '...'::regclass literal is resolved when the condition is
  -- parsed, so putting it in the same condition as the to_regclass() null-test would raise
  -- 42P01 instead of this clear message when file 04 has not been run yet.
  if to_regclass('public.gift_transactions') is null then
    raise exception 'Run 20260910_04_economy_gifting.sql first (gift_transactions missing).';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.gift_transactions'::regclass
                    and attname  = 'cohost_session_id'
                    and not attisdropped) then
    raise exception 'Re-run the CURRENT 20260910_04_economy_gifting.sql first (gift_transactions.cohost_session_id missing).';
  end if;
end $$;


-- -------------------------------------------------------------------------------------
-- 1. (no longer used) — the chat count needs no index of its own: it is read straight
--    from live_stream_chat_counts (file 02) by primary key. Section numbers below are
--    kept unchanged.
-- -------------------------------------------------------------------------------------


-- -------------------------------------------------------------------------------------
-- 2. TABLE public.live_engagement_counters — lazy SHARE snapshot cache
-- -------------------------------------------------------------------------------------
create table if not exists public.live_engagement_counters (
  id                    uuid        primary key default gen_random_uuid(),
  live_stream_id        uuid        null references public.live_streams(id) on delete cascade,
  lk_battle_id          uuid        null references public.lk_battles(id)   on delete cascade,
  share_count_snapshot  bigint      not null default 0,
  snapshot_at           timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint live_engagement_counters_exactly_one_target_check
    check (num_nonnulls(live_stream_id, lk_battle_id) = 1),
  constraint live_engagement_counters_share_check check (share_count_snapshot >= 0)
);

comment on table public.live_engagement_counters is
  'Cache of SHARE totals per target (a live stream OR an LK battle). Holds the count as of snapshot_at; readers add share rows created after snapshot_at. Refreshed lazily (older than 5 minutes) by live_engagement_snapshot_internal() under a try-advisory-lock — no cron, no per-share counter writes. Derived data only: dropping every row is safe, they are rebuilt on the next read. Chat totals are NOT here (exact counter in live_stream_chat_counts), nor reactions (live_stream_reaction_counts). Clients read it only through live_engagement_counts_stream() / live_engagement_counts_battle().';
comment on column public.live_engagement_counters.share_count_snapshot is
  'live_shares rows for this target with created_at <= snapshot_at.';
comment on column public.live_engagement_counters.snapshot_at is
  'Cut-off instant of the snapshot. Set a few seconds in the past at refresh time so a share insert whose transaction was still committing is counted by the delta instead of being missed.';

-- One row per target. These partial unique indexes are also the lookup path and the FK
-- cascade index.
create unique index if not exists live_engagement_counters_stream_uidx
  on public.live_engagement_counters (live_stream_id)
  where live_stream_id is not null;

create unique index if not exists live_engagement_counters_battle_uidx
  on public.live_engagement_counters (lk_battle_id)
  where lk_battle_id is not null;

drop trigger if exists update_live_engagement_counters_updated_at on public.live_engagement_counters;
create trigger update_live_engagement_counters_updated_at
  before update on public.live_engagement_counters
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 3. TABLE public.live_shares — one row per COUNTED share
-- -------------------------------------------------------------------------------------
create table if not exists public.live_shares (
  id              uuid        primary key default gen_random_uuid(),
  live_stream_id  uuid        null references public.live_streams(id) on delete cascade,
  lk_battle_id    uuid        null references public.lk_battles(id)   on delete cascade,
  sharer_user_id  uuid        null references auth.users(id)          on delete set null,
  guest_key       text        null,
  share_channel   text        null,
  created_at      timestamptz not null default now(),

  constraint live_shares_exactly_one_target_check
    check (num_nonnulls(live_stream_id, lk_battle_id) = 1),

  -- A row carries AT MOST one identity. "At least one identity" is enforced inside
  -- live_share_record() (the only insert path) and deliberately NOT as a table CHECK:
  -- sharer_user_id is ON DELETE SET NULL, and a CHECK requiring an identity would make
  -- that SET NULL fail — i.e. deleting a user account (delete-account Edge Function)
  -- would error for anyone who ever shared a stream.
  constraint live_shares_identity_exclusive_check
    check (sharer_user_id is null or guest_key is null),

  constraint live_shares_guest_key_check
    check (guest_key is null or length(guest_key) between 8 and 64),

  -- Checked text, not an enum: a new share target (e.g. 'tiktok') never needs a migration.
  constraint live_shares_share_channel_check
    check (share_channel is null or share_channel ~ '^[a-z0-9_]{1,32}$')
);

comment on table public.live_shares is
  'One row per COUNTED share of a live stream or an LK battle. Written only by live_share_record(), which applies a 10-minute per-identity-per-target cooldown, so repeat taps do not create rows. Share rows reveal who shared what, so they are readable only by the sharer and admins; the public total comes from live_engagement_counts_*().';
comment on column public.live_shares.sharer_user_id is
  'Signed-in sharer. ON DELETE SET NULL so a deleted account''s shares still count toward the stream''s total. A row with both sharer_user_id and guest_key NULL means "shared by an account that has since been deleted".';
comment on column public.live_shares.guest_key is
  'Signed-out sharer: the same opaque device-scoped key the app sends to live_stream_join() (file 01). Used only for the cooldown. NULL whenever sharer_user_id is set.';
comment on column public.live_shares.share_channel is
  'Optional client hint of where it was shared (''whatsapp'', ''copy_link'', ''facebook'', ''other'', ...). Lower-cased by live_share_record(); anything that does not match ^[a-z0-9_]{1,32}$ is stored as ''other''.';

-- Count paths (full recompute + delta) and the FK cascade index. Index-only for count(*).
create index if not exists live_shares_stream_created_idx
  on public.live_shares (live_stream_id, created_at)
  where live_stream_id is not null;

create index if not exists live_shares_battle_created_idx
  on public.live_shares (lk_battle_id, created_at)
  where lk_battle_id is not null;

-- Cooldown lookup (identity first: one person's shares in the last 10 minutes are a
-- handful of rows, the target is filtered in memory), "my shares" under RLS, and the index
-- the ON DELETE SET NULL needs when an account is deleted.
create index if not exists live_shares_user_created_idx
  on public.live_shares (sharer_user_id, created_at desc)
  where sharer_user_id is not null;

create index if not exists live_shares_guest_created_idx
  on public.live_shares (guest_key, created_at desc)
  where guest_key is not null;


-- -------------------------------------------------------------------------------------
-- 4. RLS + TABLE GRANTS
-- -------------------------------------------------------------------------------------
alter table public.live_engagement_counters enable row level security;
alter table public.live_shares              enable row level security;

-- Start from nothing (Supabase default privileges may have granted everything), then grant
-- only what the policies below allow. No client INSERT/UPDATE/DELETE on either table:
-- both are written exclusively by the SECURITY DEFINER functions in section 5.
revoke all on table public.live_engagement_counters from public, anon, authenticated;
revoke all on table public.live_shares              from public, anon, authenticated;

-- --- live_engagement_counters: admins only (everyone else reads via the counts RPCs) ----
drop policy if exists "Admins can read engagement counters" on public.live_engagement_counters;
create policy "Admins can read engagement counters"
  on public.live_engagement_counters
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));

-- --- live_shares: the sharer sees their own rows, admins see all, nobody else -----------
drop policy if exists "Users can read their own live shares" on public.live_shares;
create policy "Users can read their own live shares"
  on public.live_shares
  as permissive for select
  to authenticated
  using (sharer_user_id = (select auth.uid()));

drop policy if exists "Admins can read all live shares" on public.live_shares;
create policy "Admins can read all live shares"
  on public.live_shares
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));

grant select on public.live_engagement_counters to authenticated;  -- RLS narrows to admins
grant select on public.live_shares              to authenticated;  -- RLS: own rows + admins
-- anon gets no table access at all.


-- -------------------------------------------------------------------------------------
-- 5. FUNCTIONS
-- -------------------------------------------------------------------------------------

-- 5.1 live_engagement_snapshot_internal — PRIVATE. The single implementation of the
--     engagement totals for one target. Target kinds: 'stream' | 'battle'
--     (co-hosting needs no kind of its own: each side is an ordinary 'stream').
--       * chat  : read directly from live_stream_chat_counts (exact counter, file 02,
--                 incremented by file 05's gate). 0 for battles — battle chat lives on each
--                 side's own stream.
--       * shares: "snapshot + delta, refresh lazily".
--     Granted to nobody; reachable only from the SECURITY DEFINER wrappers below.
create or replace function public.live_engagement_snapshot_internal(
  p_kind            text,
  p_id              uuid,
  out o_chat_count  bigint,
  out o_share_count bigint,
  out o_as_of       timestamptz
)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  c_max_age     constant interval := interval '5 minutes';  -- snapshot freshness window
  c_settle      constant interval := interval '5 seconds';  -- in-flight commit margin
  v_share_snap  bigint;
  v_snap_at     timestamptz;
  v_cut         timestamptz;
  v_chat        bigint;
  v_share       bigint;
begin
  if p_id is null or p_kind is null or p_kind not in ('stream', 'battle') then
    raise exception 'live_engagement_snapshot_internal: invalid target (%, %)', p_kind, p_id
      using errcode = '22023';
  end if;

  -- ---- 1. read the current share snapshot (PK-like partial-unique lookup) ----------
  if p_kind = 'stream' then
    select c.share_count_snapshot, c.snapshot_at
      into v_share_snap, v_snap_at
      from public.live_engagement_counters c
     where c.live_stream_id = p_id;
  else
    select c.share_count_snapshot, c.snapshot_at
      into v_share_snap, v_snap_at
      from public.live_engagement_counters c
     where c.lk_battle_id = p_id;
  end if;

  -- ---- 2. lazy refresh when missing or stale ---------------------------------------
  -- Nested IFs on purpose: SQL does not guarantee AND short-circuiting, and the lock must
  -- only be attempted when a refresh is actually due.
  if v_snap_at is null or v_snap_at < now() - c_max_age then
    -- Never try to write inside a read-only transaction (e.g. an rpc(..., { get: true })
    -- call); just fall through to snapshot + delta.
    if coalesce(current_setting('transaction_read_only', true), 'off') <> 'on' then
      -- Non-blocking: if someone else is refreshing this target right now we do not wait,
      -- we just answer with the old snapshot + a longer (still exact) delta.
      -- Key is namespaced ('live_engagement:...') so it can never collide with the raw
      -- stream-id advisory locks used by file 03 (battle invites).
      if pg_try_advisory_xact_lock(
           hashtextextended('live_engagement:' || p_kind || ':' || p_id::text, 0)) then

        -- Double-check under the lock: another transaction may have committed a fresh
        -- snapshot between our read and our lock. (Each statement in a VOLATILE plpgsql
        -- function sees a new READ COMMITTED snapshot, so this re-read sees it.)
        if p_kind = 'stream' then
          select c.share_count_snapshot, c.snapshot_at
            into v_share_snap, v_snap_at
            from public.live_engagement_counters c
           where c.live_stream_id = p_id;
        else
          select c.share_count_snapshot, c.snapshot_at
            into v_share_snap, v_snap_at
            from public.live_engagement_counters c
           where c.lk_battle_id = p_id;
        end if;

        if v_snap_at is null or v_snap_at < now() - c_max_age then
          -- created_at defaults to its transaction's start time, so a share row can appear
          -- slightly "in the past" when it commits. Cutting the snapshot a few seconds back
          -- leaves such rows to the delta instead of losing them.
          v_cut := now() - c_settle;

          if p_kind = 'stream' then
            select count(*) into v_share
              from public.live_shares s
             where s.live_stream_id = p_id
               and s.created_at    <= v_cut;

            insert into public.live_engagement_counters as c
                   (live_stream_id, share_count_snapshot, snapshot_at)
            values (p_id, v_share, v_cut)
            on conflict (live_stream_id) where live_stream_id is not null
            do update set share_count_snapshot = excluded.share_count_snapshot,
                          snapshot_at          = excluded.snapshot_at
             where c.snapshot_at < excluded.snapshot_at;   -- never move a snapshot backwards
          else
            select count(*) into v_share
              from public.live_shares s
             where s.lk_battle_id = p_id
               and s.created_at  <= v_cut;

            insert into public.live_engagement_counters as c
                   (lk_battle_id, share_count_snapshot, snapshot_at)
            values (p_id, v_share, v_cut)
            on conflict (lk_battle_id) where lk_battle_id is not null
            do update set share_count_snapshot = excluded.share_count_snapshot,
                          snapshot_at          = excluded.snapshot_at
             where c.snapshot_at < excluded.snapshot_at;
          end if;

          v_share_snap := v_share;
          v_snap_at    := v_cut;
        end if;
      end if;
    end if;
  end if;

  -- No snapshot and we could not refresh (a concurrent first caller holds the lock):
  -- a "zero at -infinity" snapshot makes the delta below a full, exact count.
  v_share_snap := coalesce(v_share_snap, 0);
  v_snap_at    := coalesce(v_snap_at, '-infinity'::timestamptz);

  -- ---- 3. shares: snapshot + delta (short index range scan) -------------------------
  --      chat : exact counter row (primary-key lookup), no delta needed.
  if p_kind = 'stream' then
    select count(*) into v_share
      from public.live_shares s
     where s.live_stream_id = p_id
       and s.created_at     > v_snap_at;

    select coalesce(max(cc.total_chat_messages), 0) into v_chat
      from public.live_stream_chat_counts cc
     where cc.live_stream_id = p_id;
  else
    v_chat := 0;   -- battles have no chat of their own (each side's stream does)
    select count(*) into v_share
      from public.live_shares s
     where s.lk_battle_id = p_id
       and s.created_at   > v_snap_at;
  end if;

  o_chat_count  := v_chat;
  o_share_count := v_share_snap + v_share;
  o_as_of       := now();
end;
$fn$;

comment on function public.live_engagement_snapshot_internal(text, uuid) is
  'PRIVATE (no grants). Returns exact chat/share totals for a target (''stream'' | ''battle''). Chat = live_stream_chat_counts.total_chat_messages (exact counter; 0 for battles). Shares = snapshot + delta: if the snapshot is missing or older than 5 minutes and pg_try_advisory_xact_lock succeeds, recomputes it in full and upserts live_engagement_counters. Never blocks, never writes in a read-only transaction. The caller must have verified that the target exists.';


-- 5.1b live_engagement_viewers_internal — PRIVATE. Live viewers + total views for ONE
--      stream. Two primary-key lookups (live_streams, live_stream_runtime); no snapshot
--      logic needed. The single place this rule lives — used by the stream counts (and so
--      by each side of a co-hosting) and by each side of a battle.
--        * live_viewers : runtime current_concurrent_viewers while live, else 0.
--        * total_views  : while live  -> runtime total_views_live (running count);
--                         once ended  -> live_streams.total_views (exact final count).
--      Fallbacks:
--        * live, no runtime row yet (nobody has joined) -> live_streams.total_views (0).
--        * ended WITHOUT going through live_stream_end_internal() (end_reason NULL, e.g.
--          the website set status = 'ended' itself, so total_views was never computed)
--          -> the larger of live_streams.total_views and the runtime running count, so
--          a stream mobile viewers watched never shows 0 views.
--      Granted to nobody; reachable only from the SECURITY DEFINER wrappers below.
create or replace function public.live_engagement_viewers_internal(
  p_live_stream_id  uuid,
  out o_live_viewers bigint,
  out o_total_views  bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status      text;
  v_end_reason  text;
  v_final       bigint;
  v_concurrent  bigint;
  v_running     bigint;
begin
  o_live_viewers := 0;
  o_total_views  := 0;

  if p_live_stream_id is null then
    return;
  end if;

  select ls.status, ls.end_reason::text, ls.total_views
    into v_status, v_end_reason, v_final
    from public.live_streams ls
   where ls.id = p_live_stream_id;
  if not found then
    return;
  end if;

  select rt.current_concurrent_viewers, rt.total_views_live
    into v_concurrent, v_running
    from public.live_stream_runtime rt
   where rt.live_stream_id = p_live_stream_id;

  -- live_streams.status is free text (website-written, no CHECK): anything that is not
  -- 'live' is treated as ended, same as live_deeplink_stream_card_internal().
  if v_status = 'live' then
    o_live_viewers := coalesce(v_concurrent, 0);
    o_total_views  := greatest(coalesce(v_running, 0), coalesce(v_final, 0));
  elsif v_end_reason is not null then
    o_total_views  := coalesce(v_final, 0);        -- exact final number
  else
    o_total_views  := greatest(coalesce(v_final, 0), coalesce(v_running, 0));
  end if;
end;
$fn$;

comment on function public.live_engagement_viewers_internal(uuid) is
  'PRIVATE (no grants). Returns (o_live_viewers, o_total_views) for one stream. live_viewers = live_stream_runtime.current_concurrent_viewers while live, else 0. total_views = live_stream_runtime.total_views_live while live; once ended = live_streams.total_views (exact final count written by live_stream_end_internal); a stream ended outside that path (end_reason NULL) falls back to the larger of the two. (0, 0) for an unknown id. Two primary-key reads, STABLE.';


-- 5.2 live_engagement_counts_stream — public counts for ANY existing stream id -----------
create or replace function public.live_engagement_counts_stream(p_live_stream_id uuid)
returns jsonb
language plpgsql
volatile            -- may refresh the snapshot, so it cannot be STABLE
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_snap      record;
  v_views     record;
  v_reactions bigint;
begin
  -- No auth.uid() requirement, on purpose: totals are not sensitive, and the end-of-stream
  -- summary and the ended-stream deep-link page (often opened signed-out) need them. The
  -- only write this can cause is the derived cache refresh, at most once per 5 minutes per
  -- stream, so calling it repeatedly cannot inflate or corrupt anything.
  if p_live_stream_id is null then
    raise exception 'live_engagement_counts_stream: p_live_stream_id is required'
      using errcode = '22023';
  end if;

  -- Existence check reads live_streams as the function owner, so ENDED streams resolve
  -- too (their normal SELECT policy hides them from non-hosts).
  perform 1 from public.live_streams ls where ls.id = p_live_stream_id;
  if not found then
    raise exception 'live_engagement_counts_stream: stream % not found', p_live_stream_id
      using errcode = 'P0002';
  end if;

  select * into v_snap
    from public.live_engagement_snapshot_internal('stream', p_live_stream_id);

  -- Reaction total is already a single counter row (file 02); just read it.
  select coalesce(max(r.total_reactions), 0) into v_reactions
    from public.live_stream_reaction_counts r
   where r.live_stream_id = p_live_stream_id;

  -- Live viewers + total views (two primary-key reads, see 5.1b).
  select * into v_views
    from public.live_engagement_viewers_internal(p_live_stream_id);

  return jsonb_build_object(
    'chat_count',     v_snap.o_chat_count,
    'share_count',    v_snap.o_share_count,
    'reaction_count', v_reactions,
    'live_viewers',   v_views.o_live_viewers,
    'total_views',    v_views.o_total_views,
    'as_of',          v_snap.o_as_of
  );
end;
$fn$;

comment on function public.live_engagement_counts_stream(uuid) is
  'Exact totals for one live stream (live or ended) — the five live numbers: {chat_count, share_count, reaction_count (hearts), live_viewers, total_views, as_of}. chat_count = live_stream_chat_counts.total_chat_messages (messages that passed the chat gate; chat text itself is never stored). live_viewers = live_stream_runtime.current_concurrent_viewers (0 when not live). total_views = live_stream_runtime.total_views_live while live, live_streams.total_views (exact final) once ended. Callable by anon + authenticated. Call when the stream is opened (and on the summary screen), move the numbers from realtime events, and re-sync every few minutes — never poll per second. VOLATILE (uses POST via supabase-js rpc()).';


-- 5.3 live_engagement_counts_battle — battle shares + each side's stream totals ---------
create or replace function public.live_engagement_counts_battle(p_battle_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_init_id   uuid;
  v_opp_id    uuid;
  v_status    text;
  v_battle    record;
  v_side      record;
  v_views     record;
  v_initiator jsonb;
  v_opponent  jsonb := null;
begin
  -- Public on purpose, same reasoning as live_engagement_counts_stream().
  if p_battle_id is null then
    raise exception 'live_engagement_counts_battle: p_battle_id is required'
      using errcode = '22023';
  end if;

  select b.initiator_stream_id, b.opponent_stream_id, b.status::text
    into v_init_id, v_opp_id, v_status
    from public.lk_battles b
   where b.id = p_battle_id;
  if not found then
    raise exception 'live_engagement_counts_battle: battle % not found', p_battle_id
      using errcode = 'P0002';
  end if;

  -- The battle's OWN share count (shares of the /battle/<id> link).
  select * into v_battle
    from public.live_engagement_snapshot_internal('battle', p_battle_id);

  -- Each side's stream totals, via the exact same helpers (no duplicated counting SQL).
  select * into v_side
    from public.live_engagement_snapshot_internal('stream', v_init_id);
  select * into v_views
    from public.live_engagement_viewers_internal(v_init_id);
  v_initiator := jsonb_build_object(
    'live_stream_id', v_init_id,
    'reaction_count', coalesce((select rc.total_reactions from public.live_stream_reaction_counts rc
                                 where rc.live_stream_id = v_init_id), 0),
    'chat_count',     v_side.o_chat_count,
    'share_count',    v_side.o_share_count,
    'live_viewers',   v_views.o_live_viewers,
    'total_views',    v_views.o_total_views
  );

  if v_opp_id is not null then
    select * into v_side
      from public.live_engagement_snapshot_internal('stream', v_opp_id);
    select * into v_views
      from public.live_engagement_viewers_internal(v_opp_id);
    v_opponent := jsonb_build_object(
      'live_stream_id', v_opp_id,
      'reaction_count', coalesce((select rc.total_reactions from public.live_stream_reaction_counts rc
                                   where rc.live_stream_id = v_opp_id), 0),
      'chat_count',     v_side.o_chat_count,
      'share_count',    v_side.o_share_count,
      'live_viewers',   v_views.o_live_viewers,
      'total_views',    v_views.o_total_views
    );
  end if;

  return jsonb_build_object(
    'battle_id',   p_battle_id,
    'status',      v_status,
    'share_count', v_battle.o_share_count,
    'as_of',       v_battle.o_as_of,
    'initiator',   v_initiator,
    'opponent',    v_opponent
  );
end;
$fn$;

comment on function public.live_engagement_counts_battle(uuid) is
  'Totals for one LK battle: {battle_id, status, share_count (shares of the battle link itself), as_of, initiator:{live_stream_id, chat_count, share_count, live_viewers, total_views}, opponent:{...}|null}. Side totals are each side''s whole-stream totals; live_viewers / total_views follow the same rule as live_engagement_counts_stream(). Callable by anon + authenticated. Same client pattern: call on open, realtime events in between, re-sync every few minutes — never poll per second.';


-- 5.3b live_engagement_counts_cohost — both sides of a co-hosting ------------------------
-- Co-hosting has no totals of its own (no score, no separate share link): each side shows
-- the five live numbers of ITS OWN stream — produced by live_engagement_counts_stream()
-- itself, reused as-is, so no counting rule exists twice — plus the points that side
-- earned in this session.
--   points_in_session = sum(total_point_value) of gift_transactions stamped with this
--   session (file 04) and sent to that side's stream. gift_send() always makes the
--   receiver = that stream's host, so this is exactly "points received by that side's
--   user"; keying on the stream keeps the number correct even after an account deletion
--   sets receiver_user_id NULL. Served by gift_transactions_cohost_session_idx.
create or replace function public.live_engagement_counts_cohost(p_session_id uuid)
returns jsonb
language plpgsql
volatile            -- reuses live_engagement_counts_stream(), which may refresh a snapshot
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_s      record;
  v_points bigint;
  v_host   jsonb;
  v_cohost jsonb;
begin
  -- Public on purpose, same reasoning as live_engagement_counts_stream().
  if p_session_id is null then
    raise exception 'live_engagement_counts_cohost: p_session_id is required'
      using errcode = '22023';
  end if;

  -- Read as the owner: a finished session must still answer (summary / after-the-fact).
  select s.status::text      as status,
         s.started_at        as started_at,
         s.ended_at          as ended_at,
         s.host_stream_id    as host_stream_id,
         s.cohost_stream_id  as cohost_stream_id,
         s.host_user_id      as host_user_id,
         s.cohost_user_id    as cohost_user_id
    into v_s
    from public.live_cohost_sessions s
   where s.id = p_session_id;
  if not found then
    raise exception 'live_engagement_counts_cohost: co-host session % not found', p_session_id
      using errcode = 'P0002';
  end if;

  -- HOST side.
  select coalesce(sum(gt.total_point_value), 0)::bigint into v_points
    from public.gift_transactions gt
   where gt.cohost_session_id = p_session_id
     and gt.live_stream_id    = v_s.host_stream_id;
  v_host := jsonb_build_object('live_stream_id', v_s.host_stream_id,
                               'user_id',        v_s.host_user_id)
            || (public.live_engagement_counts_stream(v_s.host_stream_id) - 'as_of')
            || jsonb_build_object('points_in_session', v_points);

  -- CO-HOST side.
  select coalesce(sum(gt.total_point_value), 0)::bigint into v_points
    from public.gift_transactions gt
   where gt.cohost_session_id = p_session_id
     and gt.live_stream_id    = v_s.cohost_stream_id;
  v_cohost := jsonb_build_object('live_stream_id', v_s.cohost_stream_id,
                                 'user_id',        v_s.cohost_user_id)
              || (public.live_engagement_counts_stream(v_s.cohost_stream_id) - 'as_of')
              || jsonb_build_object('points_in_session', v_points);

  return jsonb_build_object(
    'session_id', p_session_id,
    'status',     v_s.status,       -- invited | live | ended | declined | expired | cancelled
    'started_at', v_s.started_at,
    'ended_at',   v_s.ended_at,
    'as_of',      now(),
    'host',       v_host,
    'cohost',     v_cohost
  );
end;
$fn$;

comment on function public.live_engagement_counts_cohost(uuid) is
  'Totals for one co-host session: {session_id, status, started_at, ended_at, as_of, host:{live_stream_id, user_id, chat_count, share_count, reaction_count, live_viewers, total_views, points_in_session}, cohost:{...same}}. Each side''s five numbers are its own stream''s, exactly as live_engagement_counts_stream() returns them (that function is reused). points_in_session = points received by that side from gifts stamped with this session (gift_transactions.cohost_session_id). No timer / score / winner: co-hosting has none. Callable by anon + authenticated. Same client pattern: call on open, realtime events in between, re-sync every few minutes — never poll per second.';


-- 5.4 live_share_record — count a share (cooldown-protected) ---------------------------
create or replace function public.live_share_record(
  p_live_stream_id uuid default null,
  p_lk_battle_id   uuid default null,
  p_guest_key      text default null,
  p_share_channel  text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  c_cooldown       constant interval := interval '10 minutes';
  v_uid            uuid := auth.uid();
  v_kind           text;
  v_target         uuid;
  v_battle_started timestamptz;
  v_guest          text;
  v_identity       text;
  v_channel        text;
  v_counted        boolean := false;
  v_reason         text;
  v_in_cooldown    boolean;
  v_snap           record;
begin
  -- ---- target: exactly one, and it must exist ---------------------------------------
  if num_nonnulls(p_live_stream_id, p_lk_battle_id) <> 1 then
    raise exception 'live_share_record: pass exactly one of p_live_stream_id / p_lk_battle_id'
      using errcode = '22023';
  end if;

  if p_live_stream_id is not null then
    v_kind   := 'stream';
    v_target := p_live_stream_id;
    perform 1 from public.live_streams ls where ls.id = v_target;
    if not found then
      raise exception 'live_share_record: stream % not found', v_target using errcode = 'P0002';
    end if;
  else
    v_kind   := 'battle';
    v_target := p_lk_battle_id;
    select b.started_at into v_battle_started
      from public.lk_battles b where b.id = v_target;
    if not found then
      raise exception 'live_share_record: battle % not found', v_target using errcode = 'P0002';
    end if;
  end if;

  -- ENDED streams and battles can be shared, on purpose: people share the replay / the
  -- deep link after the fact (the resolver serves ended targets), and a share is a share —
  -- the same way a post's share count keeps growing after it is published.

  -- ---- identity: signed-in user, else the guest's device key -------------------------
  if v_uid is not null then
    v_identity := 'u:' || v_uid::text;          -- any guest key is ignored once signed in
  else
    v_guest := nullif(btrim(coalesce(p_guest_key, '')), '');
    if v_guest is not null and length(v_guest) between 8 and 64 then
      v_identity := 'g:' || v_guest;
    else
      v_guest := null;
    end if;
  end if;

  -- ---- share_channel: normalise, never reject (it is only an analytics hint) ---------
  v_channel := nullif(lower(btrim(coalesce(p_share_channel, ''))), '');
  if v_channel is not null and v_channel !~ '^[a-z0-9_]{1,32}$' then
    v_channel := 'other';
  end if;

  -- None of the "not counted" outcomes raise: the user already shared from their phone,
  -- so the app must never show an error for it. We just do not add a row.
  if v_kind = 'battle' and v_battle_started is null then
    -- Invite that was never accepted (invited / declined / expired / cancelled early):
    -- there was never a battle to watch, and the resolver reports it as not found.
    v_reason := 'not_shareable';

  elsif v_identity is null then
    -- Signed-out caller with no device key. Nothing is generated server-side: a fresh
    -- random key per call would make every call "new", so the cooldown could never apply
    -- and a simple loop could inflate the count without limit. Without an identity the
    -- share is not recorded; the current total is still returned.
    v_reason := 'no_identity';

  else
    -- Serialise the same identity on the same target, so a double-tap (two requests in
    -- the same millisecond) cannot both pass the cooldown check and insert twice.
    -- Namespaced key: never collides with other advisory locks in files 01-05.
    perform pg_advisory_xact_lock(
      hashtextextended('live_share:' || v_kind || ':' || v_target::text || ':' || v_identity, 0));

    -- Sliding window: at most one counted share per identity per target per 10 minutes.
    -- (New statement after the lock => sees a row the other request just committed.)
    if v_uid is not null then
      select exists (
        select 1 from public.live_shares s
         where s.sharer_user_id = v_uid
           and s.created_at     > now() - c_cooldown
           and s.live_stream_id is not distinct from p_live_stream_id
           and s.lk_battle_id   is not distinct from p_lk_battle_id
      ) into v_in_cooldown;
    else
      select exists (
        select 1 from public.live_shares s
         where s.guest_key      = v_guest
           and s.sharer_user_id is null
           and s.created_at     > now() - c_cooldown
           and s.live_stream_id is not distinct from p_live_stream_id
           and s.lk_battle_id   is not distinct from p_lk_battle_id
      ) into v_in_cooldown;
    end if;

    if v_in_cooldown then
      v_reason := 'cooldown';
    else
      insert into public.live_shares
             (live_stream_id, lk_battle_id, sharer_user_id, guest_key, share_channel)
      values (p_live_stream_id, p_lk_battle_id, v_uid, v_guest, v_channel);
      v_counted := true;
      v_reason  := 'counted';
    end if;
  end if;

  -- Fresh total (includes the row just inserted — it is in the delta).
  select * into v_snap
    from public.live_engagement_snapshot_internal(v_kind, v_target);

  return jsonb_build_object(
    'counted',     v_counted,
    'share_count', v_snap.o_share_count,
    'reason',      v_reason,      -- counted | cooldown | no_identity | not_shareable
    'as_of',       v_snap.o_as_of
  );
end;
$fn$;

comment on function public.live_share_record(uuid, uuid, text, text) is
  'Records a share of a live stream OR an LK battle (exactly one). Identity = auth.uid(), else p_guest_key (8-64 chars; no key => not recorded). The same identity counts at most once per target per 10 minutes (sliding window, enforced under an advisory lock so double-taps cannot both insert). Never errors for "not counted" cases. Returns {counted, share_count, reason, as_of}. Broadcast a share event on the realtime channel only when counted = true. Callable by anon + authenticated.';


-- 5.5 live_deeplink_stream_card_internal — PRIVATE. Public-safe card for one stream ------
create or replace function public.live_deeplink_stream_card_internal(p_live_stream_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_id            uuid;
  v_host          uuid;
  v_channel_id    uuid;
  v_title         text;
  v_category_txt  text;
  v_category_id   uuid;
  v_status        text;
  v_started_at    timestamptz;
  v_ended_at      timestamptz;
  v_category      jsonb;
  v_display_name  text;
  v_avatar_url    text;
  v_ch_id         uuid;
  v_ch_name       text;
  v_ch_handle     text;
  v_ch_avatar     text;
  v_ch_tapiners   integer;
  v_current_live  uuid;
begin
  if p_live_stream_id is null then
    return null;
  end if;

  -- Deliberately NOT selected: zego_room_id (the room credential side of the stream). A
  -- LIVE stream's full row is already readable through live_streams' normal policy, so the
  -- player screen loads it there; an ENDED stream's room id is nobody's business.
  select ls.id, ls.host_user_id, ls.channel_id, ls.title, ls.category, ls.category_id,
         ls.status, ls.started_at, ls.ended_at
    into v_id, v_host, v_channel_id, v_title, v_category_txt, v_category_id,
         v_status, v_started_at, v_ended_at
    from public.live_streams ls
   where ls.id = p_live_stream_id;
  if not found then
    return null;
  end if;

  -- Category: normalised stream_categories row (mobile), else the website's free text.
  -- slug is included because it is the i18n key (see stream_categories.slug comment).
  if v_category_id is not null then
    select jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name)
      into v_category
      from public.stream_categories c
     where c.id = v_category_id;
  end if;
  if v_category is null and nullif(btrim(coalesce(v_category_txt, '')), '') is not null then
    v_category := jsonb_build_object('id', null, 'slug', null, 'name', v_category_txt);
  end if;

  if v_host is not null then
    -- profiles_user_id_key
    select p.display_name, p.avatar_url
      into v_display_name, v_avatar_url
      from public.profiles p
     where p.user_id = v_host;
  end if;

  -- Channel: live_streams.channel_id may be NULL on web-created rows, so fall back to the
  -- host's one channel (channels.user_id is UNIQUE). Both are unique-index lookups.
  if v_channel_id is not null then
    select c.id, c.name, c.handle, c.avatar_url, c.tapiners
      into v_ch_id, v_ch_name, v_ch_handle, v_ch_avatar, v_ch_tapiners
      from public.channels c
     where c.id = v_channel_id;
  end if;
  if v_ch_id is null and v_host is not null then
    select c.id, c.name, c.handle, c.avatar_url, c.tapiners
      into v_ch_id, v_ch_name, v_ch_handle, v_ch_avatar, v_ch_tapiners
      from public.channels c
     where c.user_id = v_host;
  end if;

  -- Is the host live RIGHT NOW in a different stream? (lets the app redirect an old link)
  -- Served by file 01's idx_live_streams_host_started (host_user_id, started_at desc): the
  -- host's current live stream is their newest one, so this normally stops at the first
  -- index entry. ORDER BY matches the index order exactly (DESC, NULLS FIRST) — do not add
  -- NULLS LAST, it would force a sort over the host's whole history.
  if v_host is not null then
    select ls2.id
      into v_current_live
      from public.live_streams ls2
     where ls2.host_user_id = v_host
       and ls2.status       = 'live'
       and ls2.id          <> v_id
     order by ls2.started_at desc
     limit 1;
  end if;

  return jsonb_build_object(
    'live_stream_id', v_id,
    -- live_streams.status is free text (website-written, no CHECK); anything that is not
    -- 'live' is presented as 'ended'.
    'status',         case when v_status = 'live' then 'live' else 'ended' end,
    'title',          v_title,
    'started_at',     v_started_at,
    'ended_at',       v_ended_at,
    'category',       v_category,
    'host',           jsonb_build_object(
                        'user_id',            v_host,
                        'display_name',       v_display_name,
                        'avatar_url',         v_avatar_url,
                        'channel_id',         v_ch_id,
                        'channel_name',       v_ch_name,
                        'channel_handle',     v_ch_handle,
                        'channel_avatar_url', v_ch_avatar,
                        'tapiners',           v_ch_tapiners
                      ),
    'host_current_live_stream_id', v_current_live
  );
end;
$fn$;

comment on function public.live_deeplink_stream_card_internal(uuid) is
  'PRIVATE (no grants). Public-safe description of one stream for deep links: status (live|ended), title, times, category, host profile + channel, and the host''s other currently-live stream id. NULL if the stream does not exist. Never returns zego_room_id.';


-- 5.6 live_deeplink_resolve — what does this link point to? -----------------------------
create or replace function public.live_deeplink_resolve(p_kind text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_kind        text := lower(btrim(coalesce(p_kind, '')));
  v_card        jsonb;
  v_status      text;
  v_result      text;
  v_end_method  text;
  v_winner      uuid;
  v_started_at  timestamptz;
  v_ends_at     timestamptz;
  v_ended_at    timestamptz;
  v_init_id     uuid;
  v_opp_id      uuid;
  v_cohost_sess uuid;
  v_sess_host   uuid;
  v_sess_cohost uuid;
  v_cohost      jsonb := null;
begin
  -- Read-only and public on purpose (anon + authenticated): the whole point is resolving
  -- a link someone received, often before they sign in. Access requires the exact UUID.
  if v_kind not in ('live', 'battle') then
    -- A bad kind is an app bug, not a user situation, so it raises.
    raise exception 'live_deeplink_resolve: unknown link kind "%" (expected live | battle)', p_kind
      using errcode = '22023';
  end if;

  if p_id is null then
    return jsonb_build_object('found', false, 'kind', v_kind);
  end if;

  -- ---- /live/<id> -------------------------------------------------------------------
  if v_kind = 'live' then
    v_card := public.live_deeplink_stream_card_internal(p_id);
    if v_card is null then
      return jsonb_build_object('found', false, 'kind', 'live');   -- app shows "not found"
    end if;

    -- CO-HOSTING: a live stream that is linked 50/50 right now opens WITH its partner.
    -- Only while this stream is live (a stream the website ended itself, bypassing the
    -- stream-ended hook, must not show a stale partner). file 03's lookup, partial-index probes.
    if v_card->>'status' = 'live' then
      v_cohost_sess := public.live_cohost_active_session(p_id);
      if v_cohost_sess is not null then
        select s.host_stream_id, s.cohost_stream_id
          into v_sess_host, v_sess_cohost
          from public.live_cohost_sessions s
         where s.id = v_cohost_sess;
        v_cohost := jsonb_build_object(
          'session_id', v_cohost_sess,
          'role',       case when v_sess_host = p_id then 'host' else 'cohost' end,
          'partner',    public.live_deeplink_stream_card_internal(
                          case when v_sess_host = p_id then v_sess_cohost else v_sess_host end)
        );
      end if;
    end if;

    return jsonb_build_object('found', true, 'kind', 'live') || v_card
           || jsonb_build_object('cohost', v_cohost);           -- null when not co-hosting
  end if;

  -- ---- /battle/<id> -----------------------------------------------------------------
  -- Reads lk_battles as the owner: that table's policy only shows battles whose streams
  -- are still live, which would make every finished battle look like a broken link.
  select b.status::text, b.result, b.end_method::text, b.winner_stream_id,
         b.started_at, b.ends_at, b.ended_at,
         b.initiator_stream_id, b.opponent_stream_id, b.cohost_session_id
    into v_status, v_result, v_end_method, v_winner,
         v_started_at, v_ends_at, v_ended_at,
         v_init_id, v_opp_id, v_cohost_sess
    from public.lk_battles b
   where b.id = p_id;

  -- A battle that never started (invited / declined / expired / cancelled before accept)
  -- was never watchable, and exposing it would reveal a private invite/decline between two
  -- hosts. Treated exactly like an unknown id.
  if not found or v_started_at is null then
    return jsonb_build_object('found', false, 'kind', 'battle');
  end if;

  -- penalty_text / penalty_status / invite timings are intentionally NOT returned.
  return jsonb_build_object(
    'found',            true,
    'kind',             'battle',
    'battle_id',        p_id,
    -- A started battle can only be live or ended (file 03: a live battle can never be
    -- cancelled, and there is no 'void' result any more).
    'status',           v_status,       -- live | ended
    'result',           v_result,       -- initiator_win | opponent_win | draw | null (while live)
    'end_method',       v_end_method,   -- timer | host_ended | end_request_accepted |
                                        -- cohost_surrendered | cohost_left | host_left | null (while live)
    'winner_stream_id', v_winner,
    'started_at',       v_started_at,
    'ends_at',          v_ends_at,
    'ended_at',         v_ended_at,
    -- Non-null when this battle was fought INSIDE a co-hosting (it returns to that
    -- co-hosting when it ends). Just the id; the session itself is not described here.
    'cohost_session_id', v_cohost_sess,
    'initiator',        public.live_deeplink_stream_card_internal(v_init_id),
    'opponent',         public.live_deeplink_stream_card_internal(v_opp_id)
  );
end;
$fn$;

comment on function public.live_deeplink_resolve(text, uuid) is
  'Deep-link resolver. p_kind = ''live'' | ''battle'' (unknown kind raises; co-hosting has no kind of its own — the stream link is used). Unknown id => {found:false, kind}. live => {found, kind, live_stream_id, status (live|ended), title, started_at, ended_at, category{id,slug,name}, host{user_id, display_name, avatar_url, channel_id, channel_name, channel_handle, channel_avatar_url, tapiners}, host_current_live_stream_id, cohost: {session_id, role (host|cohost), partner{stream card}} | null (non-null only while the stream is live in a LIVE co-host session)}. battle => {found, kind, battle_id, status (live|ended), result, end_method (null while live), winner_stream_id, started_at, ends_at, ended_at, cohost_session_id (null unless fought inside a co-hosting), initiator{stream card}, opponent{stream card}}. Public-safe fields only; does not change any live_streams / lk_battles / live_cohost_sessions policy. STABLE, callable by anon + authenticated.';


-- -------------------------------------------------------------------------------------
-- 6. FUNCTION GRANTS
-- -------------------------------------------------------------------------------------
-- Revoke from PUBLIC *and* from anon/authenticated explicitly: on Supabase, default
-- privileges can grant EXECUTE on new functions directly to anon/authenticated, which a
-- revoke from PUBLIC alone does not remove.
revoke all on function public.live_engagement_snapshot_internal(text, uuid)  from public, anon, authenticated;
revoke all on function public.live_engagement_viewers_internal(uuid)         from public, anon, authenticated;
revoke all on function public.live_deeplink_stream_card_internal(uuid)       from public, anon, authenticated;
revoke all on function public.live_engagement_counts_stream(uuid)            from public, anon, authenticated;
revoke all on function public.live_engagement_counts_battle(uuid)            from public, anon, authenticated;
revoke all on function public.live_engagement_counts_cohost(uuid)            from public, anon, authenticated;
revoke all on function public.live_share_record(uuid, uuid, text, text)      from public, anon, authenticated;
revoke all on function public.live_deeplink_resolve(text, uuid)              from public, anon, authenticated;

grant execute on function public.live_engagement_counts_stream(uuid)         to anon, authenticated;
grant execute on function public.live_engagement_counts_battle(uuid)         to anon, authenticated;
grant execute on function public.live_engagement_counts_cohost(uuid)         to anon, authenticated;
grant execute on function public.live_share_record(uuid, uuid, text, text)   to anon, authenticated;
grant execute on function public.live_deeplink_resolve(text, uuid)           to anon, authenticated;
-- The three *_internal helpers are granted to NOBODY. They are reached only from the
-- SECURITY DEFINER wrappers above, which run as the function owner.

commit;


-- =====================================================================================
-- ROLLBACK (manual) — uncomment and run top to bottom only if this migration must go.
-- Nothing here touches a pre-existing table or any object from files 01-05
-- (live_stream_chat_counts / live_stream_reaction_counts belong to file 02 and stay).
-- =====================================================================================
-- begin;
-- drop function if exists public.live_deeplink_resolve(text, uuid);
-- drop function if exists public.live_deeplink_stream_card_internal(uuid);
-- drop function if exists public.live_share_record(uuid, uuid, text, text);
-- drop function if exists public.live_engagement_counts_cohost(uuid);
-- drop function if exists public.live_engagement_counts_battle(uuid);
-- drop function if exists public.live_engagement_counts_stream(uuid);
-- drop function if exists public.live_engagement_viewers_internal(uuid);
-- drop function if exists public.live_engagement_snapshot_internal(text, uuid);
-- (live_stream_runtime.total_views_live belongs to file 01 and stays.)
-- drop table    if exists public.live_shares;                -- drops its indexes + policies
-- drop table    if exists public.live_engagement_counters;   -- derived cache, safe to drop
-- commit;
