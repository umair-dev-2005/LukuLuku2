-- =====================================================================================
-- LukuLuku Live Streaming — Migration 02
-- Feature: Live Reactions + the Live Chat COUNT (chat MESSAGES are never stored)
-- Spec:    specs/archive/02-live-chat-metrics-reactions.md (archived — outdated, history only)
-- Scope:   mobile app only (the website does not run live streaming).
--
-- -------------------------------------------------------------------------------------
-- PRODUCT DECISION (user-approved 2026-09-10): LIVE CHAT MESSAGES ARE NEVER STORED
-- -------------------------------------------------------------------------------------
-- Not for live streams, not for LK battles, not for (future) co-hosting. A chat message
-- exists only on screen during the live, delivered over the realtime channel; when the
-- stream ends it is gone. Accepted consequences:
--   1. Late joiners see only messages sent after they join.
--   2. Every message passes a lightweight server "message gate" before it is broadcast
--      (muted / banned? profanity? slow mode?). Mute/ban RECORDS stay in the database;
--      message text does not.
--   3. A moderator "remove message" is only a realtime signal telling phones to drop it.
--   4. Only a per-stream running COUNT of chat messages is stored (this file).
--   5. When a viewer reports a message, ONLY that one message's text is saved, inside the
--      report, for admin review (file 05, public.stream_reports.message_text).
--
-- WHERE EACH CHAT CONCERN LIVES NOW
--   message gate (mute/ban, profanity block,  -> file 05: public.stream_mod_chat_gate()
--   slow mode)
--   slow-mode state (no text)                 -> file 05: public.stream_chat_rate_state (UNLOGGED)
--   pinned message                            -> ZegoCloud room extra info, NOT the database
--   moderator "remove message"                -> realtime signal only, nothing stored
--   chat message count                        -> THIS FILE: public.live_stream_chat_counts
--                                                (incremented only by the file-05 gate)
--   reported message text                     -> file 05: public.stream_reports.message_text
--
-- HOW A MESSAGE IS BROADCAST (implementation phase — NOT part of this SQL)
--   The app's server-side relay (a Supabase Edge Function) calls
--   public.stream_mod_chat_gate() with the SENDER's JWT. Only if it returns allowed = true
--   does the relay broadcast {message_id, sent_at, sender_user_id, body, signature} to the
--   room. The relay MUST NOT broadcast with realtime.send() from inside Postgres (or from any
--   DB function/trigger): realtime.send() INSERTs every message into realtime.messages, which
--   would store chat in the database after all. Broadcast from the Edge Function itself
--   (Supabase Realtime Broadcast) or via ZegoCloud in-room signaling.
--
-- The filename still says "chat" on purpose: other files and the user reference it.
--
-- CREATES
--   tables    : public.live_stream_reaction_counts, public.live_stream_chat_counts
--   functions : public.live_chat_stream_status(uuid)         [helper, SECURITY DEFINER]
--               public.live_chat_stream_host_id(uuid)        [helper, SECURITY DEFINER]
--               public.live_reactions_increment(uuid, int)   [batched reaction counter]
--   triggers  : updated_at stamping on both tables (reuses public.update_updated_at_column())
--   RLS       : enabled + read policies on both tables
--
-- MUST RUN BEFORE THIS FILE
--   20260910_01_live_streaming_core.sql   (core live-streaming infrastructure)
--   NOTE: this file does not hard-reference any object created by file 01; it only anchors on the
--         PRE-EXISTING public.live_streams table. File 01 is listed for run-order consistency.
--
-- MUST RUN AFTER THIS FILE
--   20260910_05_moderation_safety.sql       (its chat gate increments live_stream_chat_counts and
--                                            calls live_chat_stream_status)
--   20260910_06_engagement_shares_deeplinks.sql (reads live_stream_chat_counts and
--                                            live_stream_reaction_counts)
--
-- SAFE TO RE-RUN: yes — every object is created with if-not-exists / or-replace / drop-then-create
-- semantics, and the whole file is one transaction.
--
-- NON-BREAKING: pure extension. No ALTER / DROP / RENAME against any pre-existing table, and no
-- policy on any pre-existing table is created, altered or dropped.
-- =====================================================================================

begin;

-- -------------------------------------------------------------------------------------
-- 1. HELPER FUNCTIONS — read public.live_streams without tripping over its own RLS
--
-- WHY THESE EXIST (important):
-- public.live_streams has RLS with SELECT = (status = 'live' OR host_user_id = auth.uid()).
-- RLS is NOT bypassed inside another table's policy subquery, so a naive
--     exists (select 1 from public.live_streams ls where ls.id = ...)
-- inside a counter-table policy would silently return FALSE for an ENDED stream to anyone who
-- is not the host — which would hide the end-of-stream totals from admins exactly when they
-- need them (after the stream is over). These two STABLE SECURITY DEFINER helpers read the
-- parent stream directly, mirroring how the existing public.has_role() helper is used in this
-- database. They expose only the status and the host id, neither of which is sensitive.
-- Both are primary-key lookups on live_streams, so they are cheap.
-- Used by: the read policies below, live_reactions_increment(), and file 05's chat gate.
-- -------------------------------------------------------------------------------------

create or replace function public.live_chat_stream_status(p_live_stream_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ls.status from public.live_streams ls where ls.id = p_live_stream_id;
$fn$;

create or replace function public.live_chat_stream_host_id(p_live_stream_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select ls.host_user_id from public.live_streams ls where ls.id = p_live_stream_id;
$fn$;

comment on function public.live_chat_stream_status(uuid) is
  'RLS-safe lookup of public.live_streams.status. SECURITY DEFINER so that policies and the chat '
  'gate can still evaluate the parent stream after it has ended (live_streams RLS hides ended '
  'streams from non-hosts).';

comment on function public.live_chat_stream_host_id(uuid) is
  'RLS-safe lookup of public.live_streams.host_user_id (the broadcaster). Used by the counter-table '
  'read policies to let the stream host see their own totals after the stream has ended.';


-- -------------------------------------------------------------------------------------
-- 2. TABLE: public.live_stream_reaction_counts
-- -------------------------------------------------------------------------------------

create table if not exists public.live_stream_reaction_counts (
  live_stream_id   uuid primary key
                     references public.live_streams(id) on delete cascade,
  total_reactions  bigint not null default 0 check (total_reactions >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.live_stream_reaction_counts is
  'One row per stream holding the running tap-to-like total. Individual taps are NEVER stored as '
  'rows — they are transient realtime events. The client buffers taps for ~1-2s and flushes a batch '
  'through public.live_reactions_increment(). This total is eventually consistent by design and is '
  'the value shown on the end-of-stream summary screen.';

comment on column public.live_stream_reaction_counts.total_reactions is
  'Monotonically increasing. Only writable through public.live_reactions_increment() — there is no '
  'client INSERT/UPDATE policy and no client write grant on this table.';

drop trigger if exists update_live_stream_reaction_counts_updated_at on public.live_stream_reaction_counts;
create trigger update_live_stream_reaction_counts_updated_at
  before update on public.live_stream_reaction_counts
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 3. TABLE: public.live_stream_chat_counts — the ONLY chat data stored per stream
-- -------------------------------------------------------------------------------------
-- A number, never text. Incremented by exactly 1 for every message that passes
-- public.stream_mod_chat_gate() (file 05). There is no other write path.
--
-- WHY A SEPARATE ROW FROM live_stream_reaction_counts (deliberate):
--   Reactions are batch-upserted by EVERY viewer every 1-2 seconds; chat increments happen once
--   per message. If both totals lived on the same row, every chat message would have to wait for
--   whichever viewer's reaction flush currently holds that row's lock (and vice versa), so a
--   burst of taps would slow the chat down exactly when the stream is busiest. On two different
--   rows (two different tables) the two write streams never wait on each other's row lock.
create table if not exists public.live_stream_chat_counts (
  live_stream_id       uuid primary key
                         references public.live_streams(id) on delete cascade,
  total_chat_messages  bigint not null default 0 check (total_chat_messages >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.live_stream_chat_counts is
  'One row per stream holding the running count of chat messages that passed the message gate. '
  'Chat message TEXT is never stored anywhere in this schema (user decision 2026-09-10) — this '
  'counter feeds the live chat counter and the end-of-stream summary. Written only by '
  'public.stream_mod_chat_gate() (file 05, SECURITY DEFINER). Kept on its own row, separate from '
  'live_stream_reaction_counts, so per-message chat increments and per-viewer reaction batches '
  'never wait on each other''s row lock.';

comment on column public.live_stream_chat_counts.total_chat_messages is
  'Exact, monotonically increasing count of messages allowed by the gate. A moderator "remove '
  'message" is a realtime-only signal and does NOT decrement it. No client write policy or grant.';

drop trigger if exists update_live_stream_chat_counts_updated_at on public.live_stream_chat_counts;
create trigger update_live_stream_chat_counts_updated_at
  before update on public.live_stream_chat_counts
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 4. WRITE-PATH RPC (SECURITY DEFINER, validates auth.uid() itself)
--    (The chat counter's only writer is file 05's gate, so it has no RPC here.)
-- -------------------------------------------------------------------------------------

-- 4a. Batched reaction increment.
--     Anti-abuse: a client cannot add an arbitrary number of reactions in one call, cannot react to
--     a stream that is not currently live, and cannot react anonymously.
create or replace function public.live_reactions_increment(
  p_live_stream_id uuid,
  p_delta          int
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_delta int;
  v_total bigint;
begin
  if v_uid is null then
    raise exception 'live_reactions_increment: authentication required'
      using errcode = '42501';
  end if;

  if p_live_stream_id is null then
    raise exception 'live_reactions_increment: p_live_stream_id is required'
      using errcode = '22023';
  end if;

  if p_delta is null or p_delta < 1 then
    raise exception 'live_reactions_increment: p_delta must be >= 1'
      using errcode = '22023';
  end if;

  -- Hard clamp per call. The client buffers ~1-2 seconds of taps; 100 is far above any human tap
  -- rate, so an honest client is never clamped while a malicious one cannot inflate the counter.
  v_delta := least(p_delta, 100);

  -- Only a currently-live stream accepts reactions. This also rejects unknown stream ids, because
  -- the helper returns NULL and the comparison then fails.
  if public.live_chat_stream_status(p_live_stream_id) is distinct from 'live' then
    raise exception 'live_reactions_increment: stream % is not live', p_live_stream_id
      using errcode = '22023';
  end if;

  insert into public.live_stream_reaction_counts as c (live_stream_id, total_reactions)
  values (p_live_stream_id, v_delta)
  on conflict (live_stream_id) do update
    set total_reactions = c.total_reactions + v_delta
  returning c.total_reactions into v_total;

  return v_total;
end;
$fn$;

comment on function public.live_reactions_increment(uuid, int) is
  'Batched tap-to-like increment. Upserts the stream''s counter row. Requires an authenticated '
  'caller, requires the parent stream to be status = ''live'', and clamps p_delta to 100 per call so '
  'a client cannot inflate the total. Returns the new total. NOTE: this clamps per CALL, not per '
  'second — a per-caller rate limit (calls per minute) still belongs at the edge, or can be added '
  'in migration 05 alongside the punishment tables.';


-- -------------------------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
-- -------------------------------------------------------------------------------------

alter table public.live_stream_reaction_counts enable row level security;
alter table public.live_stream_chat_counts     enable row level security;
-- NOTE: RLS is intentionally NOT FORCEd, so the SECURITY DEFINER RPCs (which run as the table
-- owner) can perform the privileged writes they exist for.

-- --- live_stream_reaction_counts -------------------------------------------------------

drop policy if exists "Anyone can read reaction counts of visible streams" on public.live_stream_reaction_counts;
create policy "Anyone can read reaction counts of visible streams"
  on public.live_stream_reaction_counts
  as permissive for select
  to anon, authenticated
  using (
    public.live_chat_stream_status(live_stream_id) = 'live'
    or public.live_chat_stream_host_id(live_stream_id) = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- No client INSERT/UPDATE/DELETE policy: the counter is a controlled aggregate and is only ever
-- moved by public.live_reactions_increment() (SECURITY DEFINER).
drop policy if exists "Admins can manage live stream reaction counts" on public.live_stream_reaction_counts;
create policy "Admins can manage live stream reaction counts"
  on public.live_stream_reaction_counts
  as permissive for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

-- --- live_stream_chat_counts -----------------------------------------------------------

-- Same visibility as the reaction total (mirrors live_streams' own rule: live, or you are the
-- host), plus admins — who can therefore also read the totals of ENDED streams.
drop policy if exists "Anyone can read chat counts of visible streams" on public.live_stream_chat_counts;
create policy "Anyone can read chat counts of visible streams"
  on public.live_stream_chat_counts
  as permissive for select
  to anon, authenticated
  using (
    public.live_chat_stream_status(live_stream_id) = 'live'
    or public.live_chat_stream_host_id(live_stream_id) = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- Deliberately NO client INSERT/UPDATE/DELETE policy — not even for admins. The only writer is
-- public.stream_mod_chat_gate() (file 05, SECURITY DEFINER, runs as the table owner).


-- -------------------------------------------------------------------------------------
-- 6. GRANTS (explicit — Supabase default privileges are not relied on here)
-- -------------------------------------------------------------------------------------

grant select                 on public.live_stream_reaction_counts to anon, authenticated;
-- intentionally NO insert/update/delete grant for anon/authenticated on the counter table.

-- Start from nothing (Supabase default privileges may have granted ALL on the new table to
-- anon/authenticated), then re-open read access only. RLS narrows it to visible streams.
revoke all   on table public.live_stream_chat_counts from public, anon, authenticated;
grant select on table public.live_stream_chat_counts to anon, authenticated;

-- SECURITY: Supabase grants EXECUTE on every new public function to anon, authenticated and
-- service_role through ALTER DEFAULT PRIVILEGES. "revoke ... from public" alone does NOT remove
-- those explicit role grants, so every revoke below names anon and authenticated too; the grants
-- that follow re-open only what clients are meant to call. Do not shorten these back to "from public".
revoke all on function public.live_chat_stream_status(uuid)       from public, anon, authenticated;
revoke all on function public.live_chat_stream_host_id(uuid)      from public, anon, authenticated;
revoke all on function public.live_reactions_increment(uuid, int) from public, anon, authenticated;

-- The two helpers must be executable by anon as well, because they are evaluated inside the
-- anon-facing SELECT policies.
grant execute on function public.live_chat_stream_status(uuid)       to anon, authenticated;
grant execute on function public.live_chat_stream_host_id(uuid)      to anon, authenticated;
grant execute on function public.live_reactions_increment(uuid, int) to authenticated;


-- -------------------------------------------------------------------------------------
-- 7. NOTES / OPTIONAL FOLLOW-UPS — deliberately NOT executed by this migration
-- -------------------------------------------------------------------------------------

-- 7a. There is no chat table, so there is nothing chat-related to add to the supabase_realtime
--     publication, and no chat retention / purge job is needed. Do NOT create one later, and do
--     not use realtime.send() for chat (see the header — it would store every message).

-- 7b. Supabase Realtime for the reaction total. Run this ONLY if the app decides to receive
--     reaction-total changes via Supabase Realtime postgres_changes (the spec says: pick ONE
--     transport, do not mix).
--
-- alter publication supabase_realtime add table public.live_stream_reaction_counts;

commit;


-- =====================================================================================
-- ROLLBACK (manual — run inside a transaction, in this order)
-- Roll back 20260910_06 and 20260910_05 FIRST: they read / write live_stream_chat_counts and
-- call public.live_chat_stream_status().
-- =====================================================================================
-- begin;
--   drop function if exists public.live_reactions_increment(uuid, int);
--
--   drop trigger if exists update_live_stream_chat_counts_updated_at     on public.live_stream_chat_counts;
--   drop trigger if exists update_live_stream_reaction_counts_updated_at on public.live_stream_reaction_counts;
--
--   drop table if exists public.live_stream_chat_counts;       -- drops its policies too
--   drop table if exists public.live_stream_reaction_counts;   -- drops its policies too
--
--   drop function if exists public.live_chat_stream_host_id(uuid);
--   drop function if exists public.live_chat_stream_status(uuid);
-- commit;
--
-- Do NOT drop public.update_updated_at_column() or public.has_role() — they are pre-existing shared
-- objects used by many other tables.
-- =====================================================================================
