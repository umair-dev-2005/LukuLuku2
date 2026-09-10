-- =====================================================================================
-- FILE 05 of 05 — Stream Moderation, Platform Safety & User Reporting
-- LukuLuku Live Streaming — Supabase / PostgreSQL migration
-- =====================================================================================
-- Scope: mobile app only (the website does not run live streaming).
--
-- LIVE CHAT IS NEVER STORED (user decision 2026-09-10 — full list of consequences in the
-- header of 20260910_02_live_chat_reactions.sql). What this file does for chat:
--   * THE MESSAGE GATE  stream_mod_chat_gate(): called once per message by the app's relay
--     (Edge Function) with the SENDER's JWT. Checks not-live / muted / banned / profanity
--     (block, never mask) / slow mode, increments live_stream_chat_counts on allow, and
--     returns a signed message envelope. The message text is NOT stored.
--   * SLOW-MODE STATE   stream_chat_rate_state: UNLOGGED, counters and timestamps only.
--   * SIGNED ENVELOPES  HMAC-SHA256 keyed by the Vault secret 'live_chat_signing_key', so a
--     reported message can later be proven to be exactly what the gate let through.
--   * REPORTS           stream_reports can carry ONE reported message's text — the only chat
--                       text stored anywhere in this schema.
--   Moderator "remove message" is a realtime-only signal (no RPC, nothing stored); the
--   pinned message lives in the ZegoCloud room extra info.
--
-- CREATES
--   enums   : stream_moderation_action_type, user_punishment_type, profanity_category,
--             stream_report_reason, stream_report_status
--   tables  : stream_moderators, stream_moderation_actions, user_punishments,
--             profanity_dictionaries, stream_reports,
--             stream_chat_rate_state (UNLOGGED)
--   vault   : secret 'live_chat_signing_key' (created once, only if absent)
--   funcs   : stream_mod_is_moderator, stream_mod_is_punished,
--             stream_mod_mute, stream_mod_unmute, stream_mod_kick,
--             stream_mod_ban, stream_mod_unban,
--             stream_mod_assign_moderator, stream_mod_revoke_moderator,
--             stream_mod_report_submit, stream_mod_report_set_status,
--             stream_mod_profanity_pattern, stream_mod_contains_profanity,
--             stream_mod_chat_signing_key (private), stream_mod_chat_signature (private),
--             stream_mod_chat_gate,
--             stream_mod_reject_audit_update (trigger fn),
--             stream_mod_block_banned_join (trigger fn),
--             stream_mod_block_banned_host (trigger fn)
--   hardens : public.live_stream_viewer_sessions (BEFORE INSERT trigger blocks banned and
--                                                 kicked-and-locked-out joins)
--             -- created by file 01 of THIS feature set.
--             public.live_streams  <-- PRE-EXISTING TABLE. BEFORE INSERT / UPDATE OF status
--                                      trigger stops a platform-banned user from going live.
--                                      *** USER PERMISSION GRANTED 2026-09-10 ***
--                                      The ONLY change in this file that touches a
--                                      pre-existing table; adds a trigger only, no column /
--                                      default / constraint / policy is changed. See 10.3.
--   also    : stream_mod_ban now ENDS the banned user's running broadcast(s)
--             (end_reason 'moderation_ban') via file 01's live_stream_end_internal.
--
-- PUNISHMENT RULES (user decisions 2026-09-10)
--   * KICK          = 15-minute lockout from THAT stream (user_punishments row of type
--                     'kick', expires_at = now() + 15 min; a re-kick restarts the 15 minutes).
--                     The join trigger refuses them with "You can rejoin in N minutes".
--   * STREAM BAN    = host/moderator ban. Scoped to the BROADCASTER, not to one stream id:
--                     it covers the stream it was issued on + that broadcaster's NEXT 2
--                     streams (3 in total), then stops applying by itself. No duration, no cron.
--   * PLATFORM BAN  = admin only, exactly 7 days (no permanent option any more).
--   * MUTE          = unchanged (per stream, optional duration).
--   * CHAT FILTER   = LDNOOBW word lists, English + Dutch only (section 8, CC BY 4.0).
--
-- MUST RUN AFTER
--   20260910_01_live_streaming_core.sql   (live_stream_viewer_sessions, live_viewer_leave_reason
--                                          enum incl. the 'kicked' value, live_stream_end_reason
--                                          incl. 'moderation_ban', live_stream_end_internal)
--   20260910_02_live_chat_reactions.sql   (live_stream_chat_counts, live_chat_stream_status)
--   20260910_03_lk_battles.sql            (no hard dependency, run-order only)
--   20260910_04_economy_gifting.sql         (no hard dependency, run-order only)
--
-- ALSO REQUIRES: Supabase Vault (extension supabase_vault, schema vault) and pgcrypto
--                (schema extensions). Both are installed on this project. If Vault is not
--                available the migration stops with a clear error (section 7A).
--
-- SAFE TO RE-RUN: yes — every object is created with if-not-exists / or-replace /
--                 drop-policy-if-exists / drop-function-if-exists (old stream_mod_ban
--                 signature), the dictionary seed is ON CONFLICT DO NOTHING, and the Vault
--                 secret is created only if it does not exist yet (never rotated).
-- =====================================================================================

begin;

-- -------------------------------------------------------------------------------------
-- 0. PREFLIGHT — fail loudly and early if files 01/02 have not been run yet.
-- -------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.live_streams') is null then
    raise exception 'public.live_streams is missing. This is a PRE-EXISTING table — check the database.';
  end if;
  if to_regclass('public.live_stream_viewer_sessions') is null then
    raise exception 'Run 20260910_01_live_streaming_core.sql BEFORE this file (live_stream_viewer_sessions missing).';
  end if;
  -- stream_mod_ban (5.4) calls this to end a banned broadcaster's stream.
  if to_regprocedure('public.live_stream_end_internal(uuid, public.live_stream_end_reason)') is null then
    raise exception 'Run 20260910_01_live_streaming_core.sql BEFORE this file (function live_stream_end_internal missing).';
  end if;
  -- stream_mod_chat_gate (7B) increments this counter and calls live_chat_stream_status.
  if to_regclass('public.live_stream_chat_counts') is null
     or to_regprocedure('public.live_chat_stream_status(uuid)') is null then
    raise exception 'Run 20260910_02_live_chat_reactions.sql BEFORE this file (live_stream_chat_counts / live_chat_stream_status missing).';
  end if;
  -- HMAC signing (7A) uses pgcrypto, which Supabase installs in the "extensions" schema.
  if to_regprocedure('extensions.hmac(text, text, text)') is null
     or to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'pgcrypto is missing from the "extensions" schema (needed for chat message signing). Enable it under Database > Extensions, then re-run.';
  end if;
end $$;


-- =====================================================================================
-- 1. ENUMS
-- =====================================================================================

-- mute/kick/ban are the enforcement actions; unmute/unban are the REVERSALS.
-- Reversals are included deliberately: stream_moderation_actions is an append-only legal
-- audit log, so "the mute was lifted" can never be recorded by deleting or editing the
-- original row. Without unmute/unban the log would show a punishment that silently
-- disappeared, which is exactly what an audit trail must not do.
do $$ begin
  create type public.stream_moderation_action_type as enum
    ('mute', 'kick', 'ban', 'unmute', 'unban');
exception when duplicate_object then null; end $$;

-- 'kick' = the 15-minute lockout a kick leaves behind (section 5.3).
do $$ begin
  create type public.user_punishment_type as enum
    ('mute', 'kick', 'stream_ban', 'platform_ban');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.profanity_category as enum
    ('profanity', 'hate_speech', 'spam_link', 'sexual_content');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.stream_report_reason as enum
    ('inappropriate_content', 'harassment', 'spam', 'violence', 'copyright', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.stream_report_status as enum
    ('pending', 'reviewed', 'resolved', 'dismissed');
exception when duplicate_object then null; end $$;


-- =====================================================================================
-- 2. TABLES
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 2.1 stream_moderators — who may moderate what.
--     THREE scopes, resolved by which of the two scope columns is set:
--       live_stream_id set, channel_id null  -> moderator of exactly that broadcast
--       channel_id set,     live_stream_id null -> moderator of EVERY stream of that channel
--       both null                            -> global platform moderator
--     (spec open question 2 answered: channel scope added, because a broadcaster's regular
--      mod team should not have to be re-assigned before every single stream.)
-- -------------------------------------------------------------------------------------
create table if not exists public.stream_moderators (
  id                  uuid primary key default gen_random_uuid(),
  live_stream_id      uuid references public.live_streams(id) on delete cascade,
  channel_id          uuid references public.channels(id) on delete cascade,
  user_id             uuid not null references auth.users(id) on delete cascade,
  assigned_by_user_id uuid references auth.users(id) on delete set null,
  revoked_at          timestamptz,
  revoked_by_user_id  uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  constraint stream_moderators_single_scope_chk
    check (live_stream_id is null or channel_id is null)
);

comment on table public.stream_moderators is
  'Moderator assignments. Scope = stream (live_stream_id), channel (channel_id) or global (both null). Soft-revoked via revoked_at so the assignment history survives.';
comment on column public.stream_moderators.channel_id is
  'Channel-wide moderator: valid for every live_streams row whose channel_id matches. Mutually exclusive with live_stream_id.';
comment on column public.stream_moderators.revoked_at is
  'NULL = assignment is active. Set = revoked; the row is kept for audit, and all UNIQUE indexes below are partial on revoked_at IS NULL so the same person can be re-assigned later.';

-- "the same moderator cannot be assigned twice" — one partial unique index per scope,
-- because a plain UNIQUE treats every NULL as distinct and would allow unlimited
-- duplicate global rows for the same user.
create unique index if not exists uq_stream_moderators_stream_active
  on public.stream_moderators (live_stream_id, user_id)
  where revoked_at is null and live_stream_id is not null;

create unique index if not exists uq_stream_moderators_channel_active
  on public.stream_moderators (channel_id, user_id)
  where revoked_at is null and channel_id is not null;

create unique index if not exists uq_stream_moderators_global_active
  on public.stream_moderators (user_id)
  where revoked_at is null and live_stream_id is null and channel_id is null;

-- Hot path: stream_mod_is_moderator() loads one user's (very small) active assignment set.
create index if not exists idx_stream_moderators_user_active
  on public.stream_moderators (user_id)
  include (live_stream_id, channel_id)
  where revoked_at is null;

-- UI path: render the mod list / mod badges for one stream.
create index if not exists idx_stream_moderators_stream_active
  on public.stream_moderators (live_stream_id)
  where revoked_at is null and live_stream_id is not null;

create index if not exists idx_stream_moderators_channel_active
  on public.stream_moderators (channel_id)
  where revoked_at is null and channel_id is not null;


-- -------------------------------------------------------------------------------------
-- 2.2 stream_moderation_actions — APPEND-ONLY audit log.
--     DELIBERATE DEVIATION from the shared "live_stream_id not null on delete cascade"
--     convention: live_streams has a host-owned DELETE policy, so a host could erase the
--     record of their own enforcement actions simply by deleting the stream row. The FKs
--     here are therefore ON DELETE SET NULL and the columns nullable — the accountability
--     record outlives the stream and outlives account deletion.
-- -------------------------------------------------------------------------------------
create table if not exists public.stream_moderation_actions (
  id                uuid primary key default gen_random_uuid(),
  live_stream_id    uuid references public.live_streams(id) on delete set null,
  moderator_user_id uuid references auth.users(id) on delete set null,
  target_user_id    uuid references auth.users(id) on delete set null,
  action_type       public.stream_moderation_action_type not null,
  duration_seconds  integer check (duration_seconds is null or duration_seconds > 0),
  reason            text,
  created_at        timestamptz not null default now()
);

comment on table public.stream_moderation_actions is
  'Immutable audit log of every manual moderation action. Never UPDATEd (trigger-blocked) and never DELETEd by clients (no RLS policy, DELETE grant revoked).';
comment on column public.stream_moderation_actions.live_stream_id is
  'ON DELETE SET NULL on purpose: deleting a stream must not erase its enforcement history.';
comment on column public.stream_moderation_actions.duration_seconds is
  'Length of a timed action: mute (as given), kick (900 = the 15-minute lockout), platform ban (604800 = 7 days). NULL for an untimed mute, a stream ban (its length is counted in STREAMS, see user_punishments.streams_covered) and all reversal actions.';

create index if not exists idx_stream_moderation_actions_stream_created
  on public.stream_moderation_actions (live_stream_id, created_at desc);

create index if not exists idx_stream_moderation_actions_target_created
  on public.stream_moderation_actions (target_user_id, created_at desc);

create index if not exists idx_stream_moderation_actions_moderator_created
  on public.stream_moderation_actions (moderator_user_id, created_at desc);


-- -------------------------------------------------------------------------------------
-- 2.3 user_punishments — CURRENT enforcement state (not history; history is 2.2).
--
--     "At most one ACTIVE punishment of a type per (user, scope)" cannot be expressed as a
--     partial unique index on `expires_at > now()` — now() is not IMMUTABLE, so Postgres
--     refuses it. Chosen alternative: a `revoked_at` column maintained by the RPCs, plus
--     partial unique indexes on `revoked_at is null`. Re-punishing an already-punished user
--     UPDATEs the single live row instead of inserting a second one (mute / platform ban:
--     extend expires_at; kick: restart the 15 minutes; stream ban: restart the 3-stream window).
--
--     TRADE-OFF (stated honestly): this table then holds one row per (user, scope, type)
--     forever rather than one row per punishment event, so you cannot count "how many times
--     was this user muted" from here. That count lives in stream_moderation_actions, which
--     is the correct place for it. The benefit is that the enforcement check — the single
--     hottest query in the whole feature, run on every chat message and every stream join —
--     stays a bounded index probe that can never degrade as punishment history grows.
--
--     THREE SCOPES (user decisions 2026-09-10):
--       platform_ban : whole platform, expires_at = issued + 7 days.
--       mute, kick   : ONE stream (live_stream_id). kick always has expires_at (15 minutes).
--       stream_ban   : ONE BROADCASTER (broadcaster_user_id), for a window of STREAMS, not
--                      time: the origin stream + the broadcaster's next (streams_covered - 1)
--                      streams, counted by live_streams.started_at. expires_at stays NULL.
--                      Before this change a stream ban was tied to a single stream id, so the
--                      banned user could simply walk into the same broadcaster's next stream.
--
--     WHY stream_ban ROWS HAVE live_stream_id NULL (and use origin_live_stream_id instead):
--     live_stream_id is ON DELETE CASCADE, and live_streams has a host-owned DELETE policy
--     (website). Keying the ban on it would let the ban vanish the moment the origin stream
--     row is deleted, although it must keep covering the NEXT streams.
--     WHY origin_started_at EXISTS (a deliberate addition to the user's column list):
--     origin_live_stream_id is ON DELETE SET NULL. If the CHECK below REQUIRED it, deleting
--     the origin stream (a normal website action) would fail with a check violation — the
--     same trap described under stream_reports' constraints. So the ban also stores a
--     SNAPSHOT of the origin's started_at, which is all the window count needs; the CHECK
--     requires that snapshot, and origin_live_stream_id is set by stream_mod_ban() (the only
--     write path) but may later become NULL through the FK. Bonus: the per-join check never
--     has to look the origin stream up, and a later edit of the origin's started_at cannot
--     move the window.
-- -------------------------------------------------------------------------------------
create table if not exists public.user_punishments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  live_stream_id        uuid references public.live_streams(id) on delete cascade,
  punishment_type       public.user_punishment_type not null,
  reason                text,
  issued_by_user_id     uuid references auth.users(id) on delete set null,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  revoked_by_user_id    uuid references auth.users(id) on delete set null,
  -- stream_ban only (NULL for every other type — see user_punishments_scope_chk):
  broadcaster_user_id   uuid references auth.users(id) on delete cascade,
  origin_live_stream_id uuid references public.live_streams(id) on delete set null,
  origin_started_at     timestamptz,
  streams_covered       smallint,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint user_punishments_scope_chk check (
    (punishment_type = 'platform_ban'
       and live_stream_id is null
       and broadcaster_user_id is null and origin_live_stream_id is null
       and origin_started_at is null and streams_covered is null)
    or
    (punishment_type in ('mute', 'kick')
       and live_stream_id is not null
       and broadcaster_user_id is null and origin_live_stream_id is null
       and origin_started_at is null and streams_covered is null)
    or
    -- origin_live_stream_id is deliberately NOT required here (ON DELETE SET NULL, see above).
    (punishment_type = 'stream_ban'
       and live_stream_id is null
       and broadcaster_user_id is not null
       and origin_started_at is not null
       and streams_covered is not null and streams_covered >= 1
       and expires_at is null)
  ),
  -- A kick is a lockout of a fixed length, never open-ended.
  constraint user_punishments_kick_expiry_chk check (
    punishment_type <> 'kick' or expires_at is not null
  )
);

comment on table public.user_punishments is
  'Live restriction state. One non-revoked row per (user, scope, type) — scope = stream for mute/kick, broadcaster for stream_ban, platform for platform_ban; re-issuing updates the existing row. Read by stream_mod_is_punished() on every chat message (via stream_mod_chat_gate) and every stream join.';
comment on column public.user_punishments.live_stream_id is
  'Set only for mute and kick (scoped to that broadcast). NULL for platform_ban and stream_ban. ON DELETE CASCADE: a stream-scoped mute/kick is meaningless once the stream row is gone.';
comment on column public.user_punishments.expires_at is
  'mute: NULL = until lifted, else the end time. kick: always set (issued + 15 min). platform_ban: issued + 7 days (NULL would mean permanent; no RPC issues that today). stream_ban: always NULL — it ends after streams_covered streams, not after a time. Evaluated at read time; there is no cron job, so nothing can silently fail to un-punish someone.';
comment on column public.user_punishments.revoked_at is
  'Set by stream_mod_unmute/stream_mod_unban. NULL = the row still counts. This is what makes the "one active punishment" UNIQUE indexes possible without now().';
comment on column public.user_punishments.broadcaster_user_id is
  'stream_ban only: the broadcaster (live_streams.host_user_id) whose streams the user is banned from. ON DELETE CASCADE: the ban is meaningless once the broadcaster account is gone.';
comment on column public.user_punishments.origin_live_stream_id is
  'stream_ban only: the stream the ban was issued on (always set by stream_mod_ban). ON DELETE SET NULL, so it can become NULL if that stream row is deleted; the ban then keeps covering the remaining streams via origin_started_at.';
comment on column public.user_punishments.origin_started_at is
  'stream_ban only: snapshot of the origin stream''s started_at (now() if it had none). Start of the ban window: the ban covers the origin stream plus the broadcaster''s first (streams_covered - 1) streams with started_at later than this.';
comment on column public.user_punishments.streams_covered is
  'stream_ban only: total streams the ban covers, INCLUDING the origin stream (3 = this stream + the next 2). Stored per row, so changing the rule later never silently lengthens or shortens bans already issued.';

-- mute / kick: at most one live row per (user, stream, type). stream_mod_mute and
-- stream_mod_kick upsert against this index.
create unique index if not exists uq_user_punishments_stream_scope_active
  on public.user_punishments (user_id, live_stream_id, punishment_type)
  where revoked_at is null and live_stream_id is not null;

-- platform_ban: at most one live row per user. Predicate names the TYPE (not
-- "live_stream_id is null") because stream_ban rows also have live_stream_id NULL.
create unique index if not exists uq_user_punishments_platform_scope_active
  on public.user_punishments (user_id, punishment_type)
  where revoked_at is null and punishment_type = 'platform_ban';

-- stream_ban: at most one live row per (user, broadcaster). A re-ban by the same
-- broadcaster upserts this row and restarts the 3-stream window. Also serves the
-- stream_mod_unban lookup.
create unique index if not exists uq_user_punishments_stream_ban_active
  on public.user_punishments (user_id, broadcaster_user_id)
  where punishment_type = 'stream_ban' and revoked_at is null;

-- THE HOT INDEX. stream_mod_is_punished() reads ONE user's unrevoked rows and needs only
-- the columns in INCLUDE, so it runs as an index-only scan (heap untouched while the
-- visibility map is current) with a single B-tree descent on user_id. All type / scope /
-- expiry filtering happens on the index tuples. For the overwhelmingly common case (the
-- user has no unrevoked punishment rows at all) it is ONE EMPTY INDEX PROBE; only rows
-- that actually exist for this user are ever examined. A user's row set is bounded: one
-- per (stream, mute|kick), one per broadcaster that banned them, one platform ban.
create index if not exists idx_user_punishments_active_lookup
  on public.user_punishments (user_id)
  include (punishment_type, live_stream_id, expires_at,
           broadcaster_user_id, origin_live_stream_id, origin_started_at, streams_covered)
  where revoked_at is null;

-- Admin/moderator review of a stream's punished users (mute/kick rows).
create index if not exists idx_user_punishments_stream_active
  on public.user_punishments (live_stream_id)
  where revoked_at is null and live_stream_id is not null;

-- FK support for the two new references (revoked rows included, so account deletion and
-- stream deletion never seq-scan this table). The broadcaster index also serves "who have
-- I banned" for a host.
create index if not exists idx_user_punishments_broadcaster
  on public.user_punishments (broadcaster_user_id)
  where broadcaster_user_id is not null;

create index if not exists idx_user_punishments_origin_stream
  on public.user_punishments (origin_live_stream_id)
  where origin_live_stream_id is not null;

drop trigger if exists update_user_punishments_updated_at on public.user_punishments;
create trigger update_user_punishments_updated_at
  before update on public.user_punishments
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 2.4 profanity_dictionaries — managed blocklist driving the automated filter.
-- -------------------------------------------------------------------------------------
create table if not exists public.profanity_dictionaries (
  id               uuid primary key default gen_random_uuid(),
  word_or_pattern  text not null check (length(btrim(word_or_pattern)) > 0),
  category         public.profanity_category not null default 'profanity',
  language         text,
  match_whole_word boolean not null default true,
  is_active        boolean not null default true,
  source           text not null default 'custom' check (length(btrim(source)) > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.profanity_dictionaries is
  'Blocklist for the automated chat filter. Read only by admins directly; normal clients reach it through the SECURITY DEFINER functions so the list itself cannot be scraped to craft bypasses.';
comment on column public.profanity_dictionaries.word_or_pattern is
  'A POSIX regex fragment. Keep it anchored-free — stream_mod_profanity_pattern() adds the word boundaries. To block a LITERAL word or phrase, escape the regex metacharacters \ ^ $ . | ? * + ( ) [ ] { } with a backslash (the seeded LDNOOBW rows are already escaped).';
comment on column public.profanity_dictionaries.source is
  'Where the entry came from: ''ldnoobw'' = seeded from the LDNOOBW lists by migration 20260910_05 (CC BY 4.0, Shutterstock); ''custom'' (default) = added by an admin, e.g. a future Sranantongo list. Lets admins tell curated additions apart from the imported list.';
comment on column public.profanity_dictionaries.match_whole_word is
  'true  -> wrapped in \m..\M so "assess" does not trigger on "ass".
   false -> matched anywhere, for URL/spam patterns.';
comment on column public.profanity_dictionaries.language is
  'ISO-639-1 hint (''en'', ''nl'', ''srn'') for admin curation only — the filter always applies every active row regardless of the chat language.';

create unique index if not exists uq_profanity_dictionaries_pattern
  on public.profanity_dictionaries (lower(word_or_pattern));

create index if not exists idx_profanity_dictionaries_active
  on public.profanity_dictionaries (category)
  where is_active;

drop trigger if exists update_profanity_dictionaries_updated_at on public.profanity_dictionaries;
create trigger update_profanity_dictionaries_updated_at
  before update on public.profanity_dictionaries
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 2.5 stream_reports — viewer-submitted reports for the admin queue.
--     live_stream_id is ON DELETE SET NULL for the same accountability reason as 2.2:
--     a host must not be able to delete the reports filed against them by deleting the
--     stream. reported_user_id / reporter_user_id are SET NULL so account deletion does
--     not wipe an open investigation.
--
--     REPORTED CHAT MESSAGE (user decision 2026-09-10): chat is never stored, so a report
--     about a message carries that ONE message inside the report itself — message_id (the
--     gate's id; no FK, there is no chat table to reference), message_text, message_sent_at,
--     and message_verified (did the gate's HMAC signature check out). message_text is the
--     ONLY chat text stored anywhere in this schema.
-- -------------------------------------------------------------------------------------
create table if not exists public.stream_reports (
  id                 uuid primary key default gen_random_uuid(),
  reporter_user_id   uuid references auth.users(id) on delete set null,
  live_stream_id     uuid references public.live_streams(id) on delete set null,
  reported_user_id   uuid references auth.users(id) on delete set null,
  message_id         uuid,
  message_text       text,
  message_sent_at    timestamptz,
  message_verified   boolean not null default false,
  reason_category    public.stream_report_reason not null,
  details            text,
  status             public.stream_report_status not null default 'pending',
  reviewed_by_user_id uuid references auth.users(id) on delete set null,
  reviewed_at        timestamptz,
  resolution_notes   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- The three message fields travel together: all NULL (report about the stream / a user)
  -- or all set (report about one specific message). A report can only be "verified" when it
  -- actually carries a message.
  constraint stream_reports_message_fields_chk check (
    (message_id is null and message_text is null and message_sent_at is null
       and message_verified = false)
    or
    (message_id is not null and message_text is not null and message_sent_at is not null)
  ),
  -- Same 500-character cap the gate enforces on every chat message.
  constraint stream_reports_message_text_len_chk check (
    message_text is null or char_length(message_text) <= 500
  )
  -- "A message report must name its sender (reported_user_id)" is enforced inside
  -- stream_mod_report_submit(), the only insert path — deliberately NOT as a CHECK here:
  -- reported_user_id is ON DELETE SET NULL, so such a CHECK would make that SET NULL fail,
  -- i.e. the reported person deleting their account (delete-account Edge Function) would
  -- error out for anyone who was ever reported for a message. Same reasoning as
  -- live_shares_identity_exclusive_check in file 06.
);

comment on table public.stream_reports is
  'Durable report queue. Inserted only through stream_mod_report_submit() so the anti-spam rules cannot be bypassed by a direct PostgREST insert.';
comment on column public.stream_reports.status is
  'Admin workflow state. Also doubles as the anti-spam key: a reporter may hold only ONE pending report per (stream, reported user, message).';
comment on column public.stream_reports.message_id is
  'Id the chat gate (stream_mod_chat_gate) gave the reported message. No foreign key on purpose: chat messages are never stored, so there is nothing to reference. NULL = the report is not about a specific message.';
comment on column public.stream_reports.message_text is
  'Text of the ONE reported chat message, max 500 chars. This is the ONLY place in the whole schema where chat text is stored (user decision 2026-09-10: chat is never stored; a reported message is kept only inside its report, for admin review).';
comment on column public.stream_reports.message_sent_at is
  'The gate''s sent_at for the reported message (millisecond precision). Part of the signed canonical string.';
comment on column public.stream_reports.message_verified is
  'TRUE only if the signature the reporter supplied matches the HMAC the gate issued for exactly this (message_id, stream, sender = reported_user_id, sent_at, text). FALSE = unverified: the text may have been edited or forged by the reporter. Unverified reports are still accepted (a missing/forged signature must not stop someone reporting abuse), but an admin must NEVER punish on unverified text alone.';

-- ANTI-SPAM MECHANISM (two layers, both index-supported — chosen over a time-window-only
-- rule because a pure rate check still lets one angry viewer file 20 reports against the
-- same broadcaster over 20 minutes, and a pure uniqueness rule still lets them report
-- 200 different chat messages in one minute):
--   (a) uniqueness  — at most one PENDING report per (reporter, stream, target, message).
--       "message" is the gate-issued message_id (a plain uuid, no FK — chat is not stored).
--       COALESCE sentinels are needed because NULL != NULL in a UNIQUE index, which would
--       otherwise let "report the stream itself" be filed unlimited times.
--   (b) rate limit  — enforced inside stream_mod_report_submit() against idx_..._reporter_created.
create unique index if not exists uq_stream_reports_pending_dedupe
  on public.stream_reports (
    reporter_user_id,
    coalesce(live_stream_id,   '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(reported_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(message_id,       '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'pending';

-- Admin report queue: "show me pending reports, newest first".
create index if not exists idx_stream_reports_status_created
  on public.stream_reports (status, created_at desc);

create index if not exists idx_stream_reports_reporter_created
  on public.stream_reports (reporter_user_id, created_at desc);

create index if not exists idx_stream_reports_stream_created
  on public.stream_reports (live_stream_id, created_at desc);

create index if not exists idx_stream_reports_reported_user
  on public.stream_reports (reported_user_id, created_at desc)
  where reported_user_id is not null;

drop trigger if exists update_stream_reports_updated_at on public.stream_reports;
create trigger update_stream_reports_updated_at
  before update on public.stream_reports
  for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 2.6 stream_chat_rate_state — slow-mode bookkeeping for the chat gate (7B).
--     Contains NO message text: only counters and timestamps per (stream, user).
--
--     UNLOGGED ON PURPOSE. This row is rewritten on every chat message a user sends, and
--     its content is disposable: if it is lost, the worst outcome is that everyone's slow-
--     mode cooldowns reset. An UNLOGGED table skips the write-ahead log (WAL), so each
--     update is cheaper and generates no WAL/replication/backup traffic. The price, which is
--     acceptable here: after a database crash Postgres empties unlogged tables, they are not
--     copied to read replicas, and they are not included in backups / point-in-time restore.
--
--     FOREIGN KEYS ARE ALLOWED HERE. PostgreSQL's rule runs one way only: a PERMANENT
--     (logged) table may NOT reference an UNLOGGED table ("constraints on permanent tables
--     may reference only permanent tables"), but an UNLOGGED table MAY reference a permanent
--     one. This table is the unlogged side, referencing permanent live_streams and
--     auth.users, so both FKs are valid, and ON DELETE CASCADE cleans rows up when a stream
--     or an account is deleted. Nothing may ever add an FK that points AT this table.
--     The FK check only runs on INSERT (a user's first message on a stream); the per-message
--     UPDATE does not touch the key columns, so it never re-checks the parents.
-- -------------------------------------------------------------------------------------
create unlogged table if not exists public.stream_chat_rate_state (
  live_stream_id       uuid        not null references public.live_streams(id) on delete cascade,
  user_id              uuid        not null references auth.users(id)          on delete cascade,
  window_started_at    timestamptz not null,
  messages_in_window   integer     not null default 0 check (messages_in_window >= 0),
  slow_until           timestamptz,
  last_attempt_allowed boolean     not null default true,
  updated_at           timestamptz not null default now(),
  constraint stream_chat_rate_state_pkey primary key (live_stream_id, user_id)
);

comment on table public.stream_chat_rate_state is
  'UNLOGGED slow-mode state for stream_mod_chat_gate(): one row per (stream, user who chatted). No message text. Disposable — a crash empties it, which only resets cooldowns. No client policies and no client grants; written only by the gate (SECURITY DEFINER).';
comment on column public.stream_chat_rate_state.window_started_at is
  'Normal mode: start of the current burst window. Slow mode: time of the last ALLOWED message (start of the current cooldown).';
comment on column public.stream_chat_rate_state.messages_in_window is
  'Messages allowed in the current window (normal mode) / in the current cooldown (slow mode, always 1).';
comment on column public.stream_chat_rate_state.slow_until is
  'NULL or in the past = normal mode. In the future = the user is in slow mode until then.';
comment on column public.stream_chat_rate_state.last_attempt_allowed is
  'Verdict of the most recent gate call for this row. Written by the gate''s single upsert and read back through RETURNING, so the allow/deny decision and the state change are one atomic step.';
comment on column public.stream_chat_rate_state.updated_at is
  'Last gate call for this row (set explicitly by the gate; no trigger, to keep the per-message write minimal).';

-- Optional housekeeping, deliberately NOT scheduled: rows are tiny and stale rows are
-- harmless (every decision is based on timestamps), and ended streams stop producing rows.
-- If the table ever grows large, prune it with pg_cron (already installed), e.g.
--   select cron.schedule('stream_chat_rate_state_prune', '15 4 * * *',
--     $cron$ delete from public.stream_chat_rate_state where updated_at < now() - interval '1 day' $cron$);


-- =====================================================================================
-- 3. IMMUTABILITY GUARD ON THE AUDIT LOG
-- =====================================================================================
-- UPDATE is blocked by a trigger: there is no legitimate UPDATE path for an audit row, and
-- a trigger (unlike RLS) also stops the service_role key and any future Edge Function.
-- DELETE is deliberately NOT trigger-blocked: a DELETE trigger would also abort legitimate
-- FK cascades and a GDPR account-erasure run, turning "delete my account" into a hard
-- failure. DELETE is instead closed off at both client-facing layers — no RLS DELETE policy
-- exists, and the DELETE grant is revoked below — which is sufficient for every path that
-- goes through PostgREST/anon/authenticated.
create or replace function public.stream_mod_reject_audit_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'stream_moderation_actions is an append-only audit log and cannot be modified.'
    using errcode = '42501';
end;
$$;

comment on function public.stream_mod_reject_audit_update() is
  'Trigger guard making public.stream_moderation_actions append-only.';

drop trigger if exists trg_stream_moderation_actions_immutable on public.stream_moderation_actions;
create trigger trg_stream_moderation_actions_immutable
  before update on public.stream_moderation_actions
  for each row execute function public.stream_mod_reject_audit_update();


-- =====================================================================================
-- 4. ENFORCEMENT HELPERS (the functions every policy calls)
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- 4.1 stream_mod_is_moderator — the single authority answering "may this user moderate
--     this stream?". Kept to at most three index probes so it is safe inside RLS policies.
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_is_moderator(
  p_live_stream_id uuid,
  p_user_id        uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host_user_id uuid;
  v_channel_id   uuid;
begin
  if p_user_id is null then
    return false;
  end if;

  -- Platform staff first: one index probe on user_roles, and it needs no stream at all.
  if public.has_role(p_user_id, 'admin'::public.app_role)
     or public.has_role(p_user_id, 'moderator'::public.app_role) then
    return true;
  end if;

  if p_live_stream_id is not null then
    -- PK lookup. SECURITY DEFINER is what lets this read live_streams despite that table's
    -- own RLS; only host_user_id/channel_id are read and neither is returned to the caller.
    select ls.host_user_id, ls.channel_id
      into v_host_user_id, v_channel_id
      from public.live_streams ls
     where ls.id = p_live_stream_id;

    if v_host_user_id is not null and v_host_user_id = p_user_id then
      return true;   -- the broadcaster always moderates their own room
    end if;
  end if;

  -- One probe on idx_stream_moderators_user_active. A user's active assignment set is tiny,
  -- so the three scope alternatives are filtered in memory rather than via an OR-of-indexes.
  return exists (
    select 1
      from public.stream_moderators m
     where m.user_id = p_user_id
       and m.revoked_at is null
       and (
             (p_live_stream_id is not null and m.live_stream_id = p_live_stream_id)
          or (v_channel_id is not null and m.channel_id = v_channel_id)
          or (m.live_stream_id is null and m.channel_id is null)
       )
  );
end;
$$;

comment on function public.stream_mod_is_moderator(uuid, uuid) is
  'TRUE if the user is the stream host, a stream/channel/global stream_moderators assignee, or holds app_role admin or moderator. Called by every moderation RPC and policy.';


-- -------------------------------------------------------------------------------------
-- 4.2 stream_mod_is_punished — THE hottest query in the feature.
--
--     Does one of p_types apply to p_user_id on stream p_live_stream_id right now?
--       platform_ban : unrevoked and unexpired (any stream, or p_live_stream_id NULL).
--       mute / kick  : unrevoked, unexpired, and on exactly p_live_stream_id.
--       stream_ban   : unrevoked, the stream's host is the ban's broadcaster, AND the stream
--                      is inside the ban's window:
--                        S = the origin stream
--                        OR S started after origin_started_at and
--                           count(host's streams with origin_started_at < started_at
--                                 <= S.started_at)  <=  streams_covered - 1   (= 2)
--                      i.e. S is the origin or one of the host's next 2 streams.
--
--     COST
--       * Common case (user has no unrevoked rows): ONE empty probe on
--         idx_user_punishments_active_lookup, then return false. Nothing else runs.
--       * Only rows that exist for this user are examined. Platform/mute/kick verdicts come
--         straight off the index tuples. Only when a stream_ban row exists do we read the
--         stream (one PK lookup) and, if needed, count on idx_live_streams_host_started
--         (host_user_id, started_at) — a range scan capped by LIMIT streams_covered, so it
--         reads at most 3 index entries however many streams the host has run since.
--
--     SPENT BANS ARE NOT REVOKED HERE (decision): once the window has passed the row simply
--     stops matching — no cron needed. We deliberately do NOT write (lazily revoke) from
--     this function: it must stay STABLE and side-effect free, because it runs inside the
--     join trigger, inside the chat gate and from plain read requests (PostgREST runs GET
--     calls in READ ONLY transactions, where any write would error); a write would also
--     add row locks to the hottest path. The price is one leftover row per (user,
--     broadcaster) — bounded by the unique index, reused by a re-ban, and examined only for
--     that user, so it can never slow anyone else down.
--
--     EDGE CASES (documented, by design): a stream of the same host that STARTED BEFORE the
--     origin (only possible if the host runs two broadcasts at once) is not covered; a
--     stream with started_at NULL is covered only if it is the origin itself.
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_is_punished(
  p_user_id        uuid,
  p_live_stream_id uuid,
  p_types          public.user_punishment_type[]
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  r                 record;
  v_stream_loaded   boolean := false;
  v_host_user_id    uuid;
  v_started_at      timestamptz;
  v_streams_between integer;
begin
  if p_user_id is null or p_types is null then
    return false;
  end if;

  -- ONE index-only scan over this user's unrevoked rows; every filter below is evaluated
  -- on the index tuple. Non-stream-ban rows sort first, so the cheap verdicts win before
  -- any stream lookup is made.
  for r in
    select p.punishment_type, p.broadcaster_user_id, p.origin_live_stream_id,
           p.origin_started_at, p.streams_covered
      from public.user_punishments p
     where p.user_id = p_user_id
       and p.revoked_at is null
       and p.punishment_type = any (p_types)
       and (p.expires_at is null or p.expires_at > now())            -- stream_ban: always NULL
       and (p.punishment_type not in ('mute', 'kick')
            or p.live_stream_id = p_live_stream_id)                  -- mute/kick: this stream only
       and (p.punishment_type <> 'stream_ban'
            or p_live_stream_id is not null)                         -- stream_ban needs a stream
     order by (p.punishment_type = 'stream_ban')
  loop
    if r.punishment_type <> 'stream_ban' then
      return true;   -- platform_ban anywhere, or mute/kick on this stream — all unexpired
    end if;

    -- ---- stream_ban: broadcaster-scoped, window counted in streams ------------------
    if not v_stream_loaded then
      select s.host_user_id, s.started_at
        into v_host_user_id, v_started_at
        from public.live_streams s
       where s.id = p_live_stream_id;                                -- PK lookup
      v_stream_loaded := true;
    end if;

    if v_host_user_id is null or r.broadcaster_user_id <> v_host_user_id then
      continue;      -- ban belongs to a different broadcaster
    end if;

    if r.origin_live_stream_id is not null and r.origin_live_stream_id = p_live_stream_id then
      return true;   -- the stream the ban was issued on
    end if;

    if v_started_at is null or v_started_at <= r.origin_started_at then
      continue;      -- not a LATER stream of this broadcaster
    end if;

    -- How many of the host's streams started after the origin, up to and including S?
    -- Range scan on idx_live_streams_host_started, capped at streams_covered entries.
    select count(*)
      into v_streams_between
      from (select 1
              from public.live_streams h
             where h.host_user_id = v_host_user_id
               and h.started_at >  r.origin_started_at
               and h.started_at <= v_started_at
             limit r.streams_covered) w;

    if v_streams_between <= r.streams_covered - 1 then
      return true;   -- S is one of the next (streams_covered - 1) streams
    end if;
    -- Window already used up: the ban no longer applies (no revoke — see header).
  end loop;

  return false;
end;
$$;

comment on function public.stream_mod_is_punished(uuid, uuid, public.user_punishment_type[]) is
  'TRUE if a punishment of one of the given types applies to the user right now: platform_ban (unexpired, anywhere), mute/kick (unexpired, on p_live_stream_id), or stream_ban (the stream''s host banned the user and the stream is the origin or one of that host''s next streams_covered-1 streams by started_at). Common case = one empty index-only probe on idx_user_punishments_active_lookup; stream-ban windows add one PK lookup + a LIMIT-capped range scan on idx_live_streams_host_started. Side-effect free: spent stream bans are not revoked here.';


-- =====================================================================================
-- 5. MODERATION RPCs — the only write path into the three enforcement tables
-- =====================================================================================

-- Internal guard shared by every action RPC.
create or replace function public.stream_mod_assert_can_act(
  p_live_stream_id uuid,
  p_actor_user_id  uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host_user_id uuid;
  v_is_admin     boolean;
begin
  if p_actor_user_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if p_target_user_id is null then
    raise exception 'A target user is required.' using errcode = '22023';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'You cannot moderate yourself.' using errcode = '42501';
  end if;
  if not public.stream_mod_is_moderator(p_live_stream_id, p_actor_user_id) then
    raise exception 'You are not a moderator of this stream.' using errcode = '42501';
  end if;

  v_is_admin := public.has_role(p_actor_user_id, 'admin'::public.app_role);
  if v_is_admin then
    return;   -- platform admins may act on anyone, including hosts and other moderators
  end if;

  select ls.host_user_id into v_host_user_id
    from public.live_streams ls where ls.id = p_live_stream_id;

  -- A room moderator must never be able to mute/kick/ban the broadcaster who appointed them.
  if v_host_user_id is not null and v_host_user_id = p_target_user_id then
    raise exception 'Only a platform admin can moderate the broadcaster of a stream.'
      using errcode = '42501';
  end if;

  -- Nor another moderator — unless the actor is the host (who owns the room's mod team).
  if (v_host_user_id is null or v_host_user_id <> p_actor_user_id)
     and public.stream_mod_is_moderator(p_live_stream_id, p_target_user_id) then
    raise exception 'Only the broadcaster or a platform admin can moderate another moderator.'
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.stream_mod_assert_can_act(uuid, uuid, uuid) is
  'Raises 42501 unless the actor may take a moderation action against the target on this stream. Blocks self-moderation, mod-on-host and mod-on-mod escalation.';


-- Internal: close every open viewer session of a user on a stream (kick/ban side effect).
create or replace function public.stream_mod_close_sessions(
  p_live_stream_id uuid,
  p_target_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_target_user_id is null then
    return 0;
  end if;

  -- p_live_stream_id NULL = close the target's open sessions on EVERY stream. Only the
  -- platform-ban path passes NULL (kick and stream ban always pass a stream id), so a
  -- platform-banned user stops being counted as a viewer everywhere at once.
  --
  -- The live viewer counter (live_stream_runtime.current_concurrent_viewers, file 01) is
  -- decremented in the SAME statement, per stream, by exactly the number of sessions
  -- closed there. Without this, every kick/ban left the on-screen viewer count one too
  -- high for the rest of the broadcast and could inflate the recorded peak on the next join.
  with closed as (
    update public.live_stream_viewer_sessions s
       set left_at          = now(),
           duration_seconds = greatest(0, floor(extract(epoch from (now() - s.joined_at)))::int),
           leave_reason     = 'kicked'
     where s.viewer_user_id = p_target_user_id
       and s.left_at is null
       and (p_live_stream_id is null or s.live_stream_id = p_live_stream_id)
    returning s.live_stream_id
  ),
  per_stream as (
    select c.live_stream_id, count(*)::bigint as n
      from closed c
     group by c.live_stream_id
  ),
  dec as (
    update public.live_stream_runtime rt
       set current_concurrent_viewers = greatest(rt.current_concurrent_viewers - ps.n, 0),
           updated_at                 = now()
      from per_stream ps
     where rt.live_stream_id = ps.live_stream_id
    returning 1
  )
  select coalesce(sum(ps.n), 0)::int into v_rows
    from per_stream ps;

  return v_rows;
end;
$$;

comment on function public.stream_mod_close_sessions(uuid, uuid) is
  'Closes the target''s open live_stream_viewer_sessions rows with leave_reason = ''kicked'' and decrements each affected stream''s live viewer counter by the same amount. p_live_stream_id NULL = every stream (platform-ban path only). The RTC disconnect itself is issued client/edge-side against ZegoCloud; this only records it.';


-- -------------------------------------------------------------------------------------
-- 5.1 MUTE
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_mute(
  p_live_stream_id  uuid,
  p_target_user_id  uuid,
  p_duration_seconds integer default 600,
  p_reason          text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_action_id  uuid;
  v_expires_at timestamptz;
begin
  if p_live_stream_id is null then
    raise exception 'A stream is required to mute a viewer.' using errcode = '22023';
  end if;
  if p_duration_seconds is not null and p_duration_seconds <= 0 then
    raise exception 'Mute duration must be greater than zero seconds.' using errcode = '22023';
  end if;

  perform public.stream_mod_assert_can_act(p_live_stream_id, v_actor, p_target_user_id);

  v_expires_at := case when p_duration_seconds is null
                       then null
                       else now() + make_interval(secs => p_duration_seconds) end;

  insert into public.stream_moderation_actions
    (live_stream_id, moderator_user_id, target_user_id, action_type, duration_seconds, reason)
  values
    (p_live_stream_id, v_actor, p_target_user_id, 'mute', p_duration_seconds, p_reason)
  returning id into v_action_id;

  -- One live row per (user, stream, type): re-muting extends instead of stacking.
  insert into public.user_punishments
    (user_id, live_stream_id, punishment_type, reason, issued_by_user_id, expires_at)
  values
    (p_target_user_id, p_live_stream_id, 'mute', p_reason, v_actor, v_expires_at)
  on conflict (user_id, live_stream_id, punishment_type)
    where revoked_at is null and live_stream_id is not null
  do update set
    expires_at        = case
                          when excluded.expires_at is null then null
                          when user_punishments.expires_at is null then null
                          else greatest(user_punishments.expires_at, excluded.expires_at)
                        end,
    reason            = coalesce(excluded.reason, user_punishments.reason),
    issued_by_user_id = excluded.issued_by_user_id;

  return v_action_id;
end;
$$;

comment on function public.stream_mod_mute(uuid, uuid, integer, text) is
  'Host/moderator mutes a viewer on one stream. Writes the audit row and the punishment row in one transaction. p_duration_seconds NULL = mute until explicitly lifted.';


-- -------------------------------------------------------------------------------------
-- 5.2 UNMUTE (reversal — audited, never a delete)
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_unmute(
  p_live_stream_id uuid,
  p_target_user_id uuid,
  p_reason         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_action_id uuid;
begin
  perform public.stream_mod_assert_can_act(p_live_stream_id, v_actor, p_target_user_id);

  insert into public.stream_moderation_actions
    (live_stream_id, moderator_user_id, target_user_id, action_type, reason)
  values
    (p_live_stream_id, v_actor, p_target_user_id, 'unmute', p_reason)
  returning id into v_action_id;

  update public.user_punishments
     set revoked_at = now(),
         revoked_by_user_id = v_actor
   where user_id = p_target_user_id
     and live_stream_id = p_live_stream_id
     and punishment_type = 'mute'
     and revoked_at is null;

  return v_action_id;
end;
$$;

comment on function public.stream_mod_unmute(uuid, uuid, text) is
  'Lifts a stream mute. Revokes the punishment row (never deletes it) and appends an ''unmute'' audit row.';


-- -------------------------------------------------------------------------------------
-- 5.3 KICK — removes the viewer AND locks them out of THIS stream for 15 minutes
--     (user decision 2026-09-10). The lockout is a 'kick' row in user_punishments; the
--     join trigger (10.2) refuses them with "You can rejoin in N minutes" and the chat gate
--     answers 'kicked'. A re-kick restarts the 15 minutes from now. The host/a moderator can
--     let them back early with stream_mod_unban (stream scope), which also lifts the kick.
--     Other streams (even the same host's) are unaffected — that is what a ban is for.
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_kick(
  p_live_stream_id uuid,
  p_target_user_id uuid,
  p_reason         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_kick_lockout_seconds constant integer := 15 * 60;   -- 900 = 15-minute lockout
  v_actor     uuid := auth.uid();
  v_action_id uuid;
begin
  if p_live_stream_id is null then
    raise exception 'A stream is required to kick a viewer.' using errcode = '22023';
  end if;

  perform public.stream_mod_assert_can_act(p_live_stream_id, v_actor, p_target_user_id);

  insert into public.stream_moderation_actions
    (live_stream_id, moderator_user_id, target_user_id, action_type, duration_seconds, reason)
  values
    (p_live_stream_id, v_actor, p_target_user_id, 'kick', c_kick_lockout_seconds, p_reason)
  returning id into v_action_id;

  -- One live 'kick' row per (user, stream). A re-kick RESTARTS the lockout from now
  -- (plain assignment, not greatest()), exactly as the product rule says.
  insert into public.user_punishments
    (user_id, live_stream_id, punishment_type, reason, issued_by_user_id, expires_at)
  values
    (p_target_user_id, p_live_stream_id, 'kick', p_reason, v_actor,
     now() + make_interval(secs => c_kick_lockout_seconds))
  on conflict (user_id, live_stream_id, punishment_type)
    where revoked_at is null and live_stream_id is not null
  do update set
    expires_at        = excluded.expires_at,
    reason            = coalesce(excluded.reason, user_punishments.reason),
    issued_by_user_id = excluded.issued_by_user_id;

  perform public.stream_mod_close_sessions(p_live_stream_id, p_target_user_id);

  return v_action_id;
end;
$$;

comment on function public.stream_mod_kick(uuid, uuid, text) is
  'Host/moderator kicks a viewer: audit row (duration_seconds = 900), a ''kick'' punishment on this stream expiring in 15 minutes (a re-kick restarts it), and their open viewer sessions closed with leave_reason=''kicked''. Rejoining this stream is refused until the lockout ends or stream_mod_unban lifts it.';


-- -------------------------------------------------------------------------------------
-- 5.4 BAN (broadcaster-scoped stream ban, or platform-wide)
--
--   p_platform_wide = false  (host / moderator)  -> STREAM BAN
--     Scoped to the stream's BROADCASTER for a window of c_stream_ban_streams_covered (3)
--     streams: this stream + that broadcaster's next 2 streams by started_at. It then stops
--     applying by itself (see stream_mod_is_punished). No duration. Re-banning the same user
--     by the same broadcaster RESTARTS the window from p_live_stream_id.
--
--   p_platform_wide = true   (platform admin only) -> PLATFORM BAN
--     Exactly c_platform_ban_seconds (7 days). Re-banning extends it to
--     greatest(existing expiry, now() + 7 days). There is no permanent option any more; one
--     can be added later (e.g. a p_permanent flag writing expires_at = NULL — the table and
--     stream_mod_is_punished already treat NULL as permanent) if the product wants it.
--
-- SIGNATURE CHANGE (2026-09-10): p_duration_seconds was removed. The old 5-argument version
-- is dropped first; leaving it would create an overload that PostgREST cannot pick between.
-- -------------------------------------------------------------------------------------
drop function if exists public.stream_mod_ban(uuid, uuid, boolean, integer, text);

create or replace function public.stream_mod_ban(
  p_live_stream_id   uuid,
  p_target_user_id   uuid,
  p_platform_wide    boolean default false,
  p_reason           text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_stream_ban_streams_covered constant smallint := 3;                 -- this stream + next 2
  c_platform_ban_seconds       constant integer  := 7 * 24 * 60 * 60;  -- 604800 = 7 days
  v_actor          uuid := auth.uid();
  v_action_id      uuid;
  v_stream_id      uuid;
  v_host_user_id   uuid;
  v_started_at     timestamptz;
begin
  p_platform_wide := coalesce(p_platform_wide, false);

  if not p_platform_wide and p_live_stream_id is null then
    raise exception 'A stream is required for a stream ban.' using errcode = '22023';
  end if;

  perform public.stream_mod_assert_can_act(p_live_stream_id, v_actor, p_target_user_id);

  -- A broadcaster owns their own room, not the platform. Locking a user out of the entire
  -- app is a platform decision, so platform_ban is admin-only.
  if p_platform_wide and not public.has_role(v_actor, 'admin'::public.app_role) then
    raise exception 'Only a platform admin can issue a platform-wide ban.' using errcode = '42501';
  end if;

  if not p_platform_wide then
    select ls.host_user_id, ls.started_at
      into v_host_user_id, v_started_at
      from public.live_streams ls
     where ls.id = p_live_stream_id;
    if not found then
      raise exception 'Stream not found.' using errcode = 'P0002';
    end if;
    if v_host_user_id is null then
      raise exception 'This stream has no broadcaster, so a stream ban cannot be scoped to one.'
        using errcode = '22023';
    end if;
  end if;

  insert into public.stream_moderation_actions
    (live_stream_id, moderator_user_id, target_user_id, action_type, duration_seconds, reason)
  values
    (p_live_stream_id, v_actor, p_target_user_id, 'ban',
     case when p_platform_wide then c_platform_ban_seconds else null end,
     p_reason)
  returning id into v_action_id;

  if p_platform_wide then
    insert into public.user_punishments
      (user_id, live_stream_id, punishment_type, reason, issued_by_user_id, expires_at)
    values
      (p_target_user_id, null, 'platform_ban', p_reason, v_actor,
       now() + make_interval(secs => c_platform_ban_seconds))
    on conflict (user_id, punishment_type)
      where revoked_at is null and punishment_type = 'platform_ban'
    do update set
      -- Extend, never shorten. A NULL (permanent) row — none is issued today — stays permanent.
      expires_at        = case
                            when user_punishments.expires_at is null then null
                            else greatest(user_punishments.expires_at, excluded.expires_at)
                          end,
      reason            = coalesce(excluded.reason, user_punishments.reason),
      issued_by_user_id = excluded.issued_by_user_id;

  elsif v_host_user_id <> p_target_user_id then
    -- One live row per (user, broadcaster). A re-ban restarts the window from THIS stream.
    insert into public.user_punishments
      (user_id, live_stream_id, punishment_type, reason, issued_by_user_id, expires_at,
       broadcaster_user_id, origin_live_stream_id, origin_started_at, streams_covered)
    values
      (p_target_user_id, null, 'stream_ban', p_reason, v_actor, null,
       v_host_user_id, p_live_stream_id, coalesce(v_started_at, now()),
       c_stream_ban_streams_covered)
    on conflict (user_id, broadcaster_user_id)
      where punishment_type = 'stream_ban' and revoked_at is null
    do update set
      origin_live_stream_id = excluded.origin_live_stream_id,
      origin_started_at     = excluded.origin_started_at,
      streams_covered       = excluded.streams_covered,
      reason                = coalesce(excluded.reason, user_punishments.reason),
      issued_by_user_id     = excluded.issued_by_user_id;
  end if;
  -- (else) The target IS this stream's broadcaster — only a platform admin can get here
  -- (stream_mod_assert_can_act). A broadcaster cannot be banned from their own streams, so
  -- no stream_ban row is written (it would block them from chatting in their own room);
  -- their running stream is still ended below. To keep a broadcaster off air, use
  -- p_platform_wide = true.

  -- The target's own viewer session on this stream is closed FIRST, so it is recorded
  -- with the accurate leave_reason 'kicked' (ending a stream below would otherwise label
  -- it 'stream_ended'). A platform ban passes NULL, which closes the target's open
  -- sessions on EVERY stream (and fixes each stream's live viewer count), not just this one.
  perform public.stream_mod_close_sessions(
    case when p_platform_wide then null else p_live_stream_id end,
    p_target_user_id
  );

  -- ---- A banned BROADCASTER loses their running broadcast (user approved 2026-09-10) --
  -- live_stream_end_internal (file 01) has EXECUTE revoked from everyone. It is reachable
  -- here because this function is SECURITY DEFINER and owned by the same role, so it runs
  -- as that owner. end_internal also force-closes every open viewer session of the ended
  -- stream (leave_reason 'stream_ended'), writes the final metrics, and is idempotent.
  if p_platform_wide then
    -- Platform ban: end EVERY stream this user is currently hosting.
    for v_stream_id in
      select ls.id
        from public.live_streams ls
       where ls.host_user_id = p_target_user_id
         and ls.status = 'live'
    loop
      perform public.live_stream_end_internal(
        v_stream_id, 'moderation_ban'::public.live_stream_end_reason
      );
    end loop;
  elsif exists (
    select 1
      from public.live_streams ls
     where ls.id = p_live_stream_id
       and ls.host_user_id = p_target_user_id
       and ls.status = 'live'
  ) then
    -- Stream ban whose target is the HOST of that stream. Only a platform admin can reach
    -- this line: stream_mod_assert_can_act() already stops moderators from targeting hosts.
    perform public.live_stream_end_internal(
      p_live_stream_id, 'moderation_ban'::public.live_stream_end_reason
    );
  end if;

  return v_action_id;
end;
$$;

comment on function public.stream_mod_ban(uuid, uuid, boolean, text) is
  'Ban a user. p_platform_wide=false (host/mod) -> stream_ban scoped to p_live_stream_id''s BROADCASTER, covering that stream + the broadcaster''s next 2 streams (3 total), then it lapses by itself; a re-ban by the same broadcaster restarts the window. p_platform_wide=true (admin only) -> platform_ban for exactly 7 days (re-ban extends to greatest(existing, now()+7 days); no permanent option). Writes audit + punishment and closes the target''s open viewer sessions (on p_live_stream_id, or everywhere for a platform ban), all in one transaction. If the target is BROADCASTING, their stream is ended with end_reason=moderation_ban via live_stream_end_internal: a platform ban ends every stream they are hosting; a stream ban ends p_live_stream_id when they are its host (admin-only path; no stream_ban row is written for a host). A platform-banned user is also blocked from going live again by trg_stream_mod_block_banned_host.';


-- -------------------------------------------------------------------------------------
-- 5.5 UNBAN
--     Platform scope (admin only): revokes the platform_ban.
--     Stream scope (host / moderator of p_live_stream_id): revokes
--       (a) the broadcaster-scoped stream_ban this stream's HOST holds against the user
--           (whichever stream it was issued on), and
--       (b) an active 15-minute kick on THIS stream, so the host can let someone back early.
--     One 'unban' audit row either way.
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_unban(
  p_live_stream_id uuid,
  p_target_user_id uuid,
  p_platform_wide  boolean default false,
  p_reason         text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_action_id    uuid;
  v_host_user_id uuid;
begin
  p_platform_wide := coalesce(p_platform_wide, false);

  if not p_platform_wide and p_live_stream_id is null then
    raise exception 'A stream is required to lift a stream ban or kick.' using errcode = '22023';
  end if;

  perform public.stream_mod_assert_can_act(p_live_stream_id, v_actor, p_target_user_id);

  if p_platform_wide and not public.has_role(v_actor, 'admin'::public.app_role) then
    raise exception 'Only a platform admin can lift a platform-wide ban.' using errcode = '42501';
  end if;

  insert into public.stream_moderation_actions
    (live_stream_id, moderator_user_id, target_user_id, action_type, reason)
  values
    (p_live_stream_id, v_actor, p_target_user_id, 'unban', p_reason)
  returning id into v_action_id;

  if p_platform_wide then
    update public.user_punishments
       set revoked_at = now(), revoked_by_user_id = v_actor
     where user_id = p_target_user_id
       and punishment_type = 'platform_ban'
       and revoked_at is null;
  else
    select ls.host_user_id into v_host_user_id
      from public.live_streams ls
     where ls.id = p_live_stream_id;

    -- (a) the broadcaster-scoped stream ban (uq_user_punishments_stream_ban_active)
    if v_host_user_id is not null then
      update public.user_punishments
         set revoked_at = now(), revoked_by_user_id = v_actor
       where user_id = p_target_user_id
         and broadcaster_user_id = v_host_user_id
         and punishment_type = 'stream_ban'
         and revoked_at is null;
    end if;

    -- (b) an ACTIVE kick lockout on this stream (an already-expired one is left as is,
    --     so revoked_at never claims an early release that did not happen)
    update public.user_punishments
       set revoked_at = now(), revoked_by_user_id = v_actor
     where user_id = p_target_user_id
       and live_stream_id = p_live_stream_id
       and punishment_type = 'kick'
       and revoked_at is null
       and expires_at > now();
  end if;

  return v_action_id;
end;
$$;

comment on function public.stream_mod_unban(uuid, uuid, boolean, text) is
  'Lifts a platform ban (admin only, p_platform_wide=true), or — stream scope, host/mod — the broadcaster-scoped stream ban held by p_live_stream_id''s host AND any active kick lockout on p_live_stream_id. Revokes (never deletes) the punishment rows and appends one ''unban'' audit row.';


-- -------------------------------------------------------------------------------------
-- 5.6 MODERATOR ASSIGNMENT — host or admin only
-- -------------------------------------------------------------------------------------
create or replace function public.stream_mod_assign_moderator(
  p_user_id        uuid,
  p_live_stream_id uuid default null,
  p_channel_id     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_is_admin  boolean;
  v_owner     uuid;
  v_row_id    uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'A moderator user is required.' using errcode = '22023';
  end if;
  if p_live_stream_id is not null and p_channel_id is not null then
    raise exception 'Choose ONE scope: a stream, a channel, or neither (global).' using errcode = '22023';
  end if;

  v_is_admin := public.has_role(v_actor, 'admin'::public.app_role);

  if p_live_stream_id is not null then
    select ls.host_user_id into v_owner
      from public.live_streams ls where ls.id = p_live_stream_id;
    if v_owner is null then
      raise exception 'Stream not found.' using errcode = 'P0002';
    end if;
    if not v_is_admin and v_owner <> v_actor then
      raise exception 'Only the broadcaster or a platform admin can assign moderators to this stream.'
        using errcode = '42501';
    end if;
    if v_owner = p_user_id then
      raise exception 'The broadcaster already moderates their own stream.' using errcode = '22023';
    end if;

  elsif p_channel_id is not null then
    select c.user_id into v_owner
      from public.channels c where c.id = p_channel_id;
    if v_owner is null then
      raise exception 'Channel not found.' using errcode = 'P0002';
    end if;
    if not v_is_admin and v_owner <> v_actor then
      raise exception 'Only the channel owner or a platform admin can assign channel moderators.'
        using errcode = '42501';
    end if;

  else
    -- global platform moderator
    if not v_is_admin then
      raise exception 'Only a platform admin can assign a global moderator.' using errcode = '42501';
    end if;
  end if;

  -- Re-assigning an already-active moderator is a no-op that returns the existing row,
  -- so a double-tap in the UI never raises a unique violation.
  select m.id into v_row_id
    from public.stream_moderators m
   where m.user_id = p_user_id
     and m.revoked_at is null
     and m.live_stream_id is not distinct from p_live_stream_id
     and m.channel_id is not distinct from p_channel_id;

  if v_row_id is not null then
    return v_row_id;
  end if;

  insert into public.stream_moderators
    (live_stream_id, channel_id, user_id, assigned_by_user_id)
  values
    (p_live_stream_id, p_channel_id, p_user_id, v_actor)
  returning id into v_row_id;

  return v_row_id;
end;
$$;

comment on function public.stream_mod_assign_moderator(uuid, uuid, uuid) is
  'Assign a moderator. Stream scope = host or admin. Channel scope = channel owner or admin. Global scope (both NULL) = admin only. Idempotent: re-assigning an active moderator returns the existing row id.';


create or replace function public.stream_mod_revoke_moderator(
  p_moderator_row_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_is_admin boolean;
  v_row      public.stream_moderators%rowtype;
  v_owner    uuid;
begin
  if v_actor is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  select * into v_row from public.stream_moderators where id = p_moderator_row_id;
  if not found then
    raise exception 'Moderator assignment not found.' using errcode = 'P0002';
  end if;
  if v_row.revoked_at is not null then
    return false;   -- already revoked; idempotent
  end if;

  v_is_admin := public.has_role(v_actor, 'admin'::public.app_role);

  if not v_is_admin then
    if v_row.live_stream_id is not null then
      select ls.host_user_id into v_owner
        from public.live_streams ls where ls.id = v_row.live_stream_id;
    elsif v_row.channel_id is not null then
      select c.user_id into v_owner
        from public.channels c where c.id = v_row.channel_id;
    else
      v_owner := null;   -- global rows are admin-only
    end if;

    -- A moderator may always step down from their own assignment.
    if v_row.user_id <> v_actor and (v_owner is null or v_owner <> v_actor) then
      raise exception 'Only the broadcaster, a platform admin, or the moderator themselves can revoke this.'
        using errcode = '42501';
    end if;
  end if;

  update public.stream_moderators
     set revoked_at = now(), revoked_by_user_id = v_actor
   where id = p_moderator_row_id;

  return true;
end;
$$;

comment on function public.stream_mod_revoke_moderator(uuid) is
  'Soft-revokes a moderator assignment (keeps the row for audit). Allowed for the host/channel owner, a platform admin, or the moderator themselves.';


-- =====================================================================================
-- 6. REPORTING
-- =====================================================================================
-- The signature changed on 2026-09-10 (reported message is now carried inside the report),
-- so the previous 5-argument version is dropped first. Leaving it would create an overload,
-- and PostgREST cannot choose between overloads whose trailing parameters all have defaults.
drop function if exists public.stream_mod_report_submit(uuid, public.stream_report_reason, uuid, uuid, text);

create or replace function public.stream_mod_report_submit(
  p_live_stream_id    uuid,
  p_reason_category   public.stream_report_reason,
  p_reported_user_id  uuid        default null,
  p_details           text        default null,
  -- Reporting ONE chat message: pass all of the fields below exactly as they arrived in the
  -- relay's broadcast envelope (the gate's message_id / sent_at / body / signature), with
  -- p_reported_user_id = the envelope's sender_user_id. Leave all NULL for a report about
  -- the stream or a user in general.
  p_message_id        uuid        default null,
  p_message_text      text        default null,
  p_message_sent_at   timestamptz default null,
  p_message_signature text        default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_recent      integer;
  v_report_id   uuid;
  v_has_message boolean;
  v_verified    boolean := false;
  c_max_per_hour constant integer := 10;
begin
  if v_actor is null then
    raise exception 'Please sign in to report.' using errcode = '42501';
  end if;
  if p_live_stream_id is null then
    raise exception 'A stream is required to file a report.' using errcode = '22023';
  end if;
  if p_reported_user_id is not null and p_reported_user_id = v_actor then
    raise exception 'You cannot report yourself.' using errcode = '22023';
  end if;
  if p_details is not null and length(p_details) > 2000 then
    raise exception 'Report details must be 2000 characters or fewer.' using errcode = '22023';
  end if;

  -- ---- reported chat message (optional) ----------------------------------------------
  v_has_message := num_nonnulls(p_message_id, p_message_text, p_message_sent_at) > 0;

  if v_has_message then
    if num_nonnulls(p_message_id, p_message_text, p_message_sent_at) <> 3 then
      raise exception 'To report a chat message, send its id, text and sent time together.'
        using errcode = '22023';
    end if;
    -- The sender of the message is the person being reported. Enforced here rather than
    -- as a table CHECK — see the note under stream_reports' constraints.
    if p_reported_user_id is null then
      raise exception 'A reported chat message must name its sender (p_reported_user_id).'
        using errcode = '22023';
    end if;
    if char_length(p_message_text) > 500 then
      raise exception 'A chat message is at most 500 characters.' using errcode = '22023';
    end if;

    -- Recompute the gate's HMAC over the same canonical string. A mismatch or a missing
    -- signature does NOT reject the report: someone being abused must always be able to
    -- report it, even from an old app version or after the envelope was lost. The report is
    -- simply stored as UNVERIFIED so the admin knows the text is only the reporter's claim
    -- and must never punish on that text alone.
    if p_message_signature is not null then
      v_verified := coalesce(
                      lower(btrim(p_message_signature)) = public.stream_mod_chat_signature(
                        p_message_id, p_live_stream_id, p_reported_user_id,
                        p_message_sent_at, p_message_text),
                      false);
    end if;
  end if;

  -- Anti-spam layer (b): volume cap. Uses idx_stream_reports_reporter_created.
  select count(*) into v_recent
    from public.stream_reports r
   where r.reporter_user_id = v_actor
     and r.created_at > now() - interval '1 hour';

  if v_recent >= c_max_per_hour then
    raise exception 'You have filed too many reports in the last hour. Please try again later.'
      using errcode = 'P0001';
  end if;

  -- Anti-spam layer (a): uniqueness. Re-reporting the same target while the first report is
  -- still pending returns the ORIGINAL report id instead of erroring, so the UI can show
  -- "already reported" without needing a second round trip.
  begin
    insert into public.stream_reports
      (reporter_user_id, live_stream_id, reported_user_id,
       message_id, message_text, message_sent_at, message_verified,
       reason_category, details)
    values
      (v_actor, p_live_stream_id, p_reported_user_id,
       p_message_id, p_message_text, p_message_sent_at, v_verified,
       p_reason_category, p_details)
    returning id into v_report_id;
  exception when unique_violation then
    select r.id into v_report_id
      from public.stream_reports r
     where r.reporter_user_id = v_actor
       and r.status = 'pending'
       and r.live_stream_id is not distinct from p_live_stream_id
       and r.reported_user_id is not distinct from p_reported_user_id
       and r.message_id is not distinct from p_message_id
     limit 1;
  end;

  return v_report_id;
end;
$$;

comment on function public.stream_mod_report_submit(uuid, public.stream_report_reason, uuid, text, uuid, text, timestamptz, text) is
  'Any authenticated viewer files a report. Optionally carries ONE chat message (id + text + sent_at + the gate''s signature; p_reported_user_id must be its sender): the text is stored in the report — the only stored chat text in the schema — and message_verified records whether the HMAC matched. Unverified reports are accepted but flagged. Anti-spam: max 10 reports per reporter per hour, and at most one PENDING report per (reporter, stream, reported user, message) — a duplicate returns the existing report id rather than failing.';


create or replace function public.stream_mod_report_set_status(
  p_report_id        uuid,
  p_status           public.stream_report_status,
  p_resolution_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.has_role(v_actor, 'admin'::public.app_role) then
    raise exception 'Only a platform admin can process reports.' using errcode = '42501';
  end if;

  update public.stream_reports
     set status              = p_status,
         resolution_notes    = coalesce(p_resolution_notes, resolution_notes),
         reviewed_by_user_id = v_actor,
         reviewed_at         = now()
   where id = p_report_id;

  return found;
end;
$$;

comment on function public.stream_mod_report_set_status(uuid, public.stream_report_status, text) is
  'Admin report-queue workflow: move a report to reviewed/resolved/dismissed and stamp the reviewer.';


-- =====================================================================================
-- 7. PROFANITY FILTER
-- =====================================================================================
-- PERFORMANCE CHOICE, stated honestly.
-- The filter runs on every chat message, so the obvious "one row per word, one LIKE per
-- row" loop is out. Three options were considered:
--   1. pg_trgm similarity  -> not available (extension not enabled on this project) and
--                             fuzzy matching would produce false positives on chat slang.
--   2. A materialised cache table holding the pre-compiled regex -> fastest (one PK read),
--      but it needs a sixth table, which is outside this file's ownership.
--   3. Aggregate the active rows into ONE alternation regex per call and run a single ~*.
-- Option 3 is implemented. Re-checked for the LDNOOBW seed (section 8: 592 rows =
-- en 403 + nl 189, about 10 KB of pattern text once wrapped in \m(?:...)\M):
--   * REGEX COMPILE — paid ONCE, not per call. PostgreSQL keeps a per-connection cache of
--     compiled regular expressions keyed by the exact pattern TEXT (+ flags + collation;
--     src/backend/utils/adt/regexp.c, 32 entries). The pattern text is byte-identical on
--     every call until someone edits the dictionary, so after the first message on a pooled
--     connection the ~600-branch regex is a cache hit (a length check + memcmp). Compiling
--     it after a dictionary change costs an estimated few milliseconds, once per connection.
--     The ORDER BY in stream_mod_profanity_pattern() exists to GUARANTEE that identical text
--     (a plan or physical-order change must never cause a silent recompile per call).
--   * PER CALL — one sequential scan of ~600 short rows (all in shared buffers), a sort of
--     ~600 uuids and a string_agg of ~10 KB, plus the regex match over at most 500 chars.
--     Estimated ~100-300 us, still well below the network round trip of the chat-gate call
--     it rides along with, and always correct because there is no cache to go stale.
--     (Estimates, not measurements — time `select public.stream_mod_contains_profanity('hello
--     world');` in the SQL Editor after running to confirm on the real instance.)
-- PRODUCT DECISION (user, 2026-09-10): a message containing blocked words is BLOCKED by the
-- gate (7B) and never broadcast — it is not masked with ***. There is therefore no masking
-- function in this schema.
-- HONEST LIMIT: this is O(dictionary) per call. Past roughly 5,000 active entries the
-- string_agg starts to dominate (and a single regex that large risks PostgreSQL's
-- "regular expression is too complex" limit); at that point move the compiled pattern into
-- a one-row cache table refreshed by a trigger on this table (option 2). Documented, not
-- premature — today's list is about an eighth of that.
create or replace function public.stream_mod_profanity_pattern()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select string_agg(
           case
             when d.match_whole_word then '\m(?:' || d.word_or_pattern || ')\M'
             else '(?:' || d.word_or_pattern || ')'
           end,
           '|'
           order by d.id      -- deterministic text => compiled-regex cache hit (see above)
         )
    from public.profanity_dictionaries d
   where d.is_active;
$$;

comment on function public.stream_mod_profanity_pattern() is
  'Compiles all active blocklist rows into a single POSIX alternation regex. NULL when the dictionary is empty.';


create or replace function public.stream_mod_contains_profanity(p_text text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pattern text;
begin
  if p_text is null or btrim(p_text) = '' then
    return false;
  end if;
  v_pattern := public.stream_mod_profanity_pattern();
  if v_pattern is null then
    return false;
  end if;
  return p_text ~* v_pattern;
end;
$$;

comment on function public.stream_mod_contains_profanity(text) is
  'TRUE if the text matches any active blocklist entry (case-insensitive). Used by stream_mod_chat_gate() to BLOCK a message (never mask). Also client-callable for a pre-send UI hint; the gate is the authority.';


-- =====================================================================================
-- 7A. CHAT SIGNING KEY (Supabase Vault) + canonical signature
-- =====================================================================================
-- Every message the gate allows gets an HMAC-SHA256 signature over
--     message_id | live_stream_id | sender_user_id | sent_at (epoch milliseconds) | body
-- The relay broadcasts the signature with the message. If a viewer later reports that
-- message, stream_mod_report_submit() recomputes the HMAC: a match proves the reported text
-- is exactly what the gate let through from that sender, at that time, on that stream —
-- even though the database never stored the message.
--
-- The key lives in Supabase Vault (encrypted at rest), NOT in a table or in this file. It is
-- created ONCE, only if absent — re-running this migration never rotates it (rotating would
-- turn every not-yet-reviewed report with a signature into "unverified").
do $$
declare
  c_secret_name constant text := 'live_chat_signing_key';
begin
  if to_regnamespace('vault') is null
     or to_regclass('vault.secrets') is null
     or to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1
                      from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'vault' and p.proname = 'create_secret') then
    raise exception 'Supabase Vault is not available (schema "vault" / vault.create_secret missing). '
                    'Enable the supabase_vault extension under Database > Extensions, then re-run this migration. '
                    'The live chat signing key cannot be created without it.';
  end if;

  begin
    if not exists (select 1 from vault.secrets s where s.name = c_secret_name) then
      perform vault.create_secret(
        encode(extensions.gen_random_bytes(32), 'hex'),
        c_secret_name,
        'LukuLuku live chat: HMAC-SHA256 key used by public.stream_mod_chat_gate() to sign '
        'broadcast chat messages and by public.stream_mod_report_submit() to verify reported '
        'messages. Created by migration 20260910_05. Do NOT rotate casually: signatures made '
        'with the old key stop verifying.'
      );
    end if;
  exception when others then
    raise exception 'Could not create the Vault secret "%" for live chat signing: % (SQLSTATE %). '
                    'Run this migration as the "postgres" role (the Supabase SQL Editor default).',
                    c_secret_name, sqlerrm, sqlstate;
  end;
end $$;


-- Private: the ONLY place that reads the key. Revoked from every client role below
-- (including service_role); reachable only from the SECURITY DEFINER functions of this file,
-- which run as the owner. Never returned to any caller.
create or replace function public.stream_mod_chat_signing_key()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  select ds.decrypted_secret
    into v_key
    from vault.decrypted_secrets ds
   where ds.name = 'live_chat_signing_key'
   limit 1;

  if v_key is null or v_key = '' then
    -- Configuration error, not a user situation: raise so it is noticed immediately.
    raise exception 'Vault secret "live_chat_signing_key" is missing — re-run migration 20260910_05.'
      using errcode = 'P0002';
  end if;

  return v_key;
end;
$$;

comment on function public.stream_mod_chat_signing_key() is
  'PRIVATE. Reads the live chat HMAC key from Supabase Vault (vault.decrypted_secrets). EXECUTE revoked from public, anon, authenticated and service_role. Never expose its result.';


-- Private: the single definition of the canonical string + HMAC, shared by the gate (sign)
-- and the report RPC (verify) so the two can never drift apart.
--   * uuids are rendered in Postgres' canonical lower-case text form;
--   * sent_at is rendered as whole epoch MILLISECONDS (the gate truncates sent_at to ms, so
--     a JavaScript Date — which only keeps ms — round-trips it exactly);
--   * body is the exact text passed to the gate, byte for byte (the relay must broadcast it
--     unchanged; the report must send it back unchanged).
-- Returns lower-case hex.
create or replace function public.stream_mod_chat_signature(
  p_message_id     uuid,
  p_live_stream_id uuid,
  p_sender_user_id uuid,
  p_sent_at        timestamptz,
  p_body           text
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_message_id is null or p_live_stream_id is null or p_sender_user_id is null
     or p_sent_at is null or p_body is null then
    return null;
  end if;

  return encode(
    extensions.hmac(
      p_message_id::text
        || '|' || p_live_stream_id::text
        || '|' || p_sender_user_id::text
        || '|' || floor(extract(epoch from p_sent_at) * 1000)::bigint::text
        || '|' || p_body,
      public.stream_mod_chat_signing_key(),
      'sha256'
    ),
    'hex'
  );
end;
$$;

comment on function public.stream_mod_chat_signature(uuid, uuid, uuid, timestamptz, text) is
  'PRIVATE. HMAC-SHA256 (hex) over message_id|live_stream_id|sender_user_id|sent_at_epoch_ms|body with the Vault key. Used by stream_mod_chat_gate (sign) and stream_mod_report_submit (verify). Not client-callable: it would be a signing oracle.';


-- =====================================================================================
-- 7B. THE CHAT MESSAGE GATE
-- =====================================================================================
-- Chat messages are never stored (user decision 2026-09-10), but mute / ban / profanity /
-- slow mode must still be enforced by the SERVER, not trusted to the phone. So the app's
-- relay (an Edge Function, implementation phase) calls this ONCE PER MESSAGE with the
-- SENDER's JWT — auth.uid() is therefore the trusted sender — and only broadcasts the
-- message if it returns allowed = true.
--
-- WHY A DATABASE CALL PER MESSAGE IS ACCEPTABLE
--   * It costs a few milliseconds: a handful of primary-key / index probes, one regex match,
--     two single-row upserts. No message text is written anywhere.
--   * It is the only place that can answer "is this user muted/banned RIGHT NOW"
--     authoritatively — the mute/ban records live here, and a moderator's mute must take
--     effect on the very next message, not whenever a cache refreshes.
--   * UX: the relay/app should show the sender their own message optimistically, straight
--     away, and only mark it as failed if the gate denies it — so the sender never feels
--     this round trip.
--
-- CHECK ORDER (first failing check wins):
--   not_authenticated -> empty / too_long (500 chars) -> stream_not_live
--   -> banned / kicked / muted -> profanity (blocked, never masked)
--   -> slow_mode (host + moderators exempt) -> ALLOW
--   ('banned' covers a platform ban and a broadcaster-scoped stream ban whose 3-stream
--    window includes this stream; 'kicked' = the 15-minute lockout on this stream.)
--
-- RESPONSES (never raises for a normal denial, so the relay can show a clean message):
--   allow: {allowed: true, message_id, sent_at, sender_user_id, signature}
--   deny : {allowed: false, reason: <code>, retry_after_seconds: <int | null>}
-- It raises only on programmer/config error (NULL stream id, missing Vault key).
--
-- SLOW MODE RULE
--   Normal mode: a fixed 5-second window; the 4th message inside one window ("more than 3
--   messages within 5 seconds") is denied and puts the user into slow mode for 60 seconds.
--   Slow mode: at most 1 message per 10 seconds; entering slow mode starts the first 10-second
--   cooldown immediately. Denied attempts do not extend anything. A fixed window (rather than
--   a sliding log of timestamps) keeps the state to one tiny row with no text.
--   RACE SAFETY: the whole read-decide-write happens in ONE INSERT ... ON CONFLICT DO UPDATE.
--   Its row lock serialises one user's concurrent sends on a stream: the second call waits,
--   then evaluates against the first call's committed result — two parallel sends can never
--   both slip through on the same stale count.
create or replace function public.stream_mod_chat_gate(
  p_live_stream_id uuid,
  p_body           text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  -- ---- tunables -------------------------------------------------------------------
  c_max_body_chars      constant integer  := 500;
  c_burst_max_messages  constant integer  := 3;                     -- allowed per burst window
  c_burst_window        constant interval := interval '5 seconds';  -- burst window length
  c_slow_mode_duration  constant interval := interval '60 seconds'; -- how long slow mode lasts
  c_slow_mode_interval  constant interval := interval '10 seconds'; -- 1 message per this, in slow mode

  v_uid          uuid := auth.uid();
  v_now          timestamptz := now();
  v_sent_at      timestamptz;
  v_mute_until   timestamptz;
  v_kick_until   timestamptz;
  v_permanent    boolean;
  v_rate_allowed boolean;
  v_rate_window  timestamptz;
  v_message_id   uuid;
  v_signature    text;
begin
  -- Programmer error, not a user situation.
  if p_live_stream_id is null then
    raise exception 'stream_mod_chat_gate: p_live_stream_id is required' using errcode = '22023';
  end if;

  -- 1. authenticated sender
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_authenticated',
                              'retry_after_seconds', null);
  end if;

  -- 2. body
  if p_body is null or btrim(p_body) = '' then
    return jsonb_build_object('allowed', false, 'reason', 'empty', 'retry_after_seconds', null);
  end if;
  if char_length(p_body) > c_max_body_chars then
    return jsonb_build_object('allowed', false, 'reason', 'too_long', 'retry_after_seconds', null);
  end if;

  -- 3. stream must be live (unknown stream id -> NULL -> not live)
  if public.live_chat_stream_status(p_live_stream_id) is distinct from 'live' then
    return jsonb_build_object('allowed', false, 'reason', 'stream_not_live',
                              'retry_after_seconds', null);
  end if;

  -- 4. ban / kick / mute. One index-only probe in the common case (no punishment at all);
  --    the detail queries below run only for users who actually are punished.
  if public.stream_mod_is_punished(
       v_uid, p_live_stream_id,
       array['mute', 'kick', 'stream_ban', 'platform_ban']::public.user_punishment_type[]) then

    -- Platform ban, or a broadcaster-scoped stream ban whose window covers this stream.
    if public.stream_mod_is_punished(
         v_uid, p_live_stream_id,
         array['stream_ban', 'platform_ban']::public.user_punishment_type[]) then
      return jsonb_build_object('allowed', false, 'reason', 'banned',
                                'retry_after_seconds', null);
    end if;

    -- Kicked: 15-minute lockout on this stream (always timed, user_punishments_kick_expiry_chk).
    -- Probe on uq_user_punishments_stream_scope_active.
    select max(p.expires_at)
      into v_kick_until
      from public.user_punishments p
     where p.user_id         = v_uid
       and p.live_stream_id  = p_live_stream_id
       and p.punishment_type = 'kick'
       and p.revoked_at is null
       and p.expires_at > v_now;

    if v_kick_until is not null then
      return jsonb_build_object(
        'allowed', false,
        'reason',  'kicked',
        'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_kick_until - v_now))))::int
      );
    end if;

    -- Muted. Mutes are always stream-scoped (user_punishments_scope_chk).
    select bool_or(p.expires_at is null), max(p.expires_at)
      into v_permanent, v_mute_until
      from public.user_punishments p
     where p.user_id         = v_uid
       and p.live_stream_id  = p_live_stream_id
       and p.punishment_type = 'mute'
       and p.revoked_at is null
       and (p.expires_at is null or p.expires_at > v_now);

    return jsonb_build_object(
      'allowed', false,
      'reason',  'muted',
      'retry_after_seconds',
        case when coalesce(v_permanent, true) or v_mute_until is null then null
             else greatest(1, ceil(extract(epoch from (v_mute_until - v_now))))::int
        end
    );
  end if;

  -- 5. profanity: BLOCK (user decision) — the message is never broadcast, never masked.
  if public.stream_mod_contains_profanity(p_body) then
    return jsonb_build_object('allowed', false, 'reason', 'profanity', 'retry_after_seconds', null);
  end if;

  -- 6. slow mode — the host and moderators are exempt (and leave no rate row behind).
  if not public.stream_mod_is_moderator(p_live_stream_id, v_uid) then
    -- Every SET expression below reads the row's OLD values (that is how ON CONFLICT DO
    -- UPDATE works), so each column is computed from the same starting state. Cases:
    --   in slow mode, cooldown over        -> allow, restart the 10s cooldown
    --   in slow mode, cooldown running     -> deny,  state unchanged
    --   normal, burst window expired       -> allow, start a new window (count 1)
    --   normal, window running, under max  -> allow, count + 1
    --   normal, window running, over max   -> deny,  ENTER slow mode (60s) + first cooldown
    insert into public.stream_chat_rate_state as r
           (live_stream_id, user_id, window_started_at, messages_in_window, slow_until,
            last_attempt_allowed, updated_at)
    values (p_live_stream_id, v_uid, v_now, 1, null, true, v_now)
    on conflict (live_stream_id, user_id) do update
    set window_started_at = case
          when r.slow_until > v_now then
            case when v_now >= r.window_started_at + c_slow_mode_interval
                 then v_now else r.window_started_at end
          when v_now >= r.window_started_at + c_burst_window         then v_now
          when r.messages_in_window + 1 > c_burst_max_messages        then v_now
          else r.window_started_at
        end,
        messages_in_window = case
          when r.slow_until > v_now then
            case when v_now >= r.window_started_at + c_slow_mode_interval
                 then 1 else r.messages_in_window end
          when v_now >= r.window_started_at + c_burst_window         then 1
          when r.messages_in_window + 1 > c_burst_max_messages        then 1
          else r.messages_in_window + 1
        end,
        slow_until = case
          when r.slow_until > v_now                                   then r.slow_until
          when v_now >= r.window_started_at + c_burst_window         then null
          when r.messages_in_window + 1 > c_burst_max_messages        then v_now + c_slow_mode_duration
          else null
        end,
        last_attempt_allowed = case
          when r.slow_until > v_now then v_now >= r.window_started_at + c_slow_mode_interval
          when v_now >= r.window_started_at + c_burst_window         then true
          else r.messages_in_window + 1 <= c_burst_max_messages
        end,
        updated_at = v_now
    returning r.last_attempt_allowed, r.window_started_at
      into v_rate_allowed, v_rate_window;

    if not v_rate_allowed then
      -- In both deny cases window_started_at is the start of the running cooldown.
      return jsonb_build_object(
        'allowed', false,
        'reason',  'slow_mode',
        'retry_after_seconds',
          greatest(1, ceil(extract(epoch from (v_rate_window + c_slow_mode_interval - v_now))))::int
      );
    end if;
  end if;

  -- 7. ALLOW. Build and sign the envelope FIRST, and bump the per-stream counter LAST: the
  --    counter row is shared by everyone chatting on this stream, so its row lock should be
  --    held for the shortest possible time (from this statement until commit).
  v_message_id := gen_random_uuid();
  v_sent_at    := date_trunc('milliseconds', v_now);   -- ms precision: see stream_mod_chat_signature
  v_signature  := public.stream_mod_chat_signature(
                    v_message_id, p_live_stream_id, v_uid, v_sent_at, p_body);

  -- SCALING NOTE: one increment per allowed message on one row per stream. Fine for normal
  -- chat rates (the lock is held for well under a millisecond plus commit). If a single
  -- stream ever sustains hundreds of messages per second, shard this counter (N rows per
  -- stream, summed on read) — a later, additive change.
  insert into public.live_stream_chat_counts as cc (live_stream_id, total_chat_messages)
  values (p_live_stream_id, 1)
  on conflict (live_stream_id) do update
    set total_chat_messages = cc.total_chat_messages + 1;

  return jsonb_build_object(
    'allowed',        true,
    'message_id',     v_message_id,
    'sent_at',        v_sent_at,
    'sender_user_id', v_uid,
    'signature',      v_signature
  );
end;
$$;

comment on function public.stream_mod_chat_gate(uuid, text) is
  'THE live chat message gate. Called once per message by the app''s relay with the SENDER''s JWT. Checks, in order: not_authenticated, empty / too_long (500), stream_not_live, banned (platform ban, or a stream ban whose 3-stream window covers this stream) / kicked (15-minute lockout, +retry_after_seconds) / muted (+retry_after_seconds for a timed mute), profanity (blocked, never masked), slow_mode (>3 msgs in 5s -> 60s of 1 msg per 10s; host + moderators exempt; +retry_after_seconds). On allow: increments live_stream_chat_counts and returns {allowed:true, message_id, sent_at (ms), sender_user_id, signature (HMAC-SHA256 hex)}; the relay broadcasts those with the body. On deny: {allowed:false, reason, retry_after_seconds}. Never stores message text. Raises only on a NULL stream id or a missing Vault key.';


-- =====================================================================================
-- 8. SEED — LDNOOBW word lists, English + Dutch ONLY (user decision 2026-09-10)
-- =====================================================================================
-- SOURCE + LICENSE (attribution required by the license):
--   "List of Dirty, Naughty, Obscene, and Otherwise Bad Words" (LDNOOBW)
--   https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
--   files `en` and `nl` of the master branch, fetched 2026-09-10.
--   (c) 2012-2020 Shutterstock, Inc. Licensed under Creative Commons Attribution 4.0
--   International (CC BY 4.0) — verified from the repository's LICENSE file (the full CC BY
--   4.0 legal text) and README. Changes made here: entries trimmed, lower-cased,
--   de-duplicated and regex-escaped; nothing was added.
--
-- HOW THE ROWS ARE BUILT
--   * Every LDNOOBW entry is a LITERAL word or phrase, but word_or_pattern is a regex
--     fragment, so every regex metacharacter  \ ^ $ . | ? * + ( ) [ ] { }  was escaped with a
--     backslash when this seed was generated (single quotes are doubled for SQL).
--   * category 'profanity', match_whole_word = true (\m..\M word boundaries, so e.g. "ass"
--     does not fire on "assess"), source 'ldnoobw', language 'en' / 'nl'.
--     ONE EXCEPTION: the middle-finger emoji entry has no letter or digit at all, and a word
--     boundary can never match next to a non-word character — with match_whole_word = true
--     that row could never fire — so it is seeded with match_whole_word = false.
--   * An entry present in BOTH lists is seeded once, under 'en'.
--   * Idempotent: ON CONFLICT DO NOTHING against uq_profanity_dictionaries_pattern.
--   * No leetspeak / spelling-variant detection (not part of this decision).
--   * The previous hand-written starter seed (29 rows, incl. 3 spam-link patterns) is
--     REPLACED by this list. The categories hate_speech / spam_link / sexual_content stay in
--     the enum for admin-added rows.
--
-- ADMIN REVIEW NEEDED — FALSE POSITIVES. LDNOOBW was built to filter image-search
-- keywords, not chat, and a blocked message is simply not sent. Several entries are also
-- ordinary words in everyday chat and should be reviewed and switched off with
-- `update public.profanity_dictionaries set is_active = false where ...` if they cause
-- trouble, e.g.
--   Dutch  : 'anita', 'johny' (first names), 'asbak' (ashtray), 'balen', 'beurt' (turn),
--            'gat' (hole/gap), 'hol' (cave), 'muts' (hat), 'pot', 'paal', 'poot' (paw),
--            'schatje' (sweetie), 'standje', 'nicht' (niece/cousin), 'naakt', 'zuigen',
--            'gras maaien', 'de hond uitlaten' (walk the dog).
--   English: 'xx' (kisses at the end of a chat message), 'suck' / 'sucks', 'butt', 'dick'
--            (a first name), 'sex' / 'sexy', 'nude', 'escort'.
-- KNOWN GAPS: entries are matched as exact whole words, with no inflections. Common words
-- that are NOT in LDNOOBW — and were in the old starter seed — are therefore no longer
-- blocked, e.g. 'kanker', 'tering', 'tyfus', 'mongool', 'godver...' (nl) and 'retard',
-- 'fucker', 'fucked' (en). Admins can add them as 'custom' rows.
-- SRANANTONGO: LDNOOBW has NO Sranantongo list, so nothing is seeded for 'srn'. Admins can
-- add their own rows (they get source = 'custom' by default).
-- Row counts: en = 403, nl = 189, total = 592.

-- ---- English (`en`): 403 rows ----
insert into public.profanity_dictionaries
       (word_or_pattern, category, language, match_whole_word, source, is_active)
select t.w, 'profanity'::public.profanity_category, 'en', true, 'ldnoobw',
       -- Reviewed false positives (user decision 2026-09-10): seeded INACTIVE, not deleted, so
       -- an admin can see they were reviewed and re-enable them. ON CONFLICT DO NOTHING means a
       -- re-run never overrides an admin's later choice.
       t.w <> all (array['sexy', 'sucks', 'xx'])
  from unnest(array[
    '2g1c', '2 girls 1 cup', 'acrotomophilia', 'alabama hot pocket', 'alaskan pipeline',
    'anal', 'anilingus', 'anus', 'apeshit', 'arsehole', 'ass', 'asshole', 'assmunch',
    'auto erotic', 'autoerotic', 'babeland', 'baby batter', 'baby juice', 'ball gag',
    'ball gravy', 'ball kicking', 'ball licking', 'ball sack', 'ball sucking', 'bangbros',
    'bangbus', 'bareback', 'barely legal', 'barenaked', 'bastard', 'bastardo', 'bastinado',
    'bbw', 'bdsm', 'beaner', 'beaners', 'beaver cleaver', 'beaver lips', 'beastiality',
    'bestiality', 'big black', 'big breasts', 'big knockers', 'big tits', 'bimbos', 'birdlock',
    'bitch', 'bitches', 'black cock', 'blonde action', 'blonde on blonde action', 'blowjob',
    'blow job', 'blow your load', 'blue waffle', 'blumpkin', 'bollocks', 'bondage', 'boner',
    'boob', 'boobs', 'booty call', 'brown showers', 'brunette action', 'bukkake', 'bulldyke',
    'bullet vibe', 'bullshit', 'bung hole', 'bunghole', 'busty', 'butt', 'buttcheeks',
    'butthole', 'camel toe', 'camgirl', 'camslut', 'camwhore', 'carpet muncher',
    'carpetmuncher', 'chocolate rosebuds', 'cialis', 'circlejerk', 'cleveland steamer', 'clit',
    'clitoris', 'clover clamps', 'clusterfuck', 'cock', 'cocks', 'coprolagnia', 'coprophilia',
    'cornhole', 'coon', 'coons', 'creampie', 'cum', 'cumming', 'cumshot', 'cumshots',
    'cunnilingus', 'cunt', 'darkie', 'date rape', 'daterape', 'deep throat', 'deepthroat',
    'dendrophilia', 'dick', 'dildo', 'dingleberry', 'dingleberries', 'dirty pillows',
    'dirty sanchez', 'doggie style', 'doggiestyle', 'doggy style', 'doggystyle', 'dog style',
    'dolcett', 'domination', 'dominatrix', 'dommes', 'donkey punch', 'double dong',
    'double penetration', 'dp action', 'dry hump', 'dvda', 'eat my ass', 'ecchi',
    'ejaculation', 'erotic', 'erotism', 'escort', 'eunuch', 'fag', 'faggot', 'fecal', 'felch',
    'fellatio', 'feltch', 'female squirting', 'femdom', 'figging', 'fingerbang', 'fingering',
    'fisting', 'foot fetish', 'footjob', 'frotting', 'fuck', 'fuck buttons', 'fuckin',
    'fucking', 'fucktards', 'fudge packer', 'fudgepacker', 'futanari', 'gangbang', 'gang bang',
    'gay sex', 'genitals', 'giant cock', 'girl on', 'girl on top', 'girls gone wild', 'goatcx',
    'goatse', 'god damn', 'gokkun', 'golden shower', 'goodpoop', 'goo girl', 'goregasm',
    'grope', 'group sex', 'g-spot', 'guro', 'hand job', 'handjob', 'hard core', 'hardcore',
    'hentai', 'homoerotic', 'honkey', 'hooker', 'horny', 'hot carl', 'hot chick',
    'how to kill', 'how to murder', 'huge fat', 'humping', 'incest', 'intercourse', 'jack off',
    'jail bait', 'jailbait', 'jelly donut', 'jerk off', 'jigaboo', 'jiggaboo', 'jiggerboo',
    'jizz', 'juggs', 'kike', 'kinbaku', 'kinkster', 'kinky', 'knobbing', 'leather restraint',
    'leather straight jacket', 'lemon party', 'livesex', 'lolita', 'lovemaking',
    'make me come', 'male squirting', 'masturbate', 'masturbating', 'masturbation',
    'menage a trois', 'milf', 'missionary position', 'mong', 'motherfucker', 'mound of venus',
    'mr hands', 'muff diver', 'muffdiving', 'nambla', 'nawashi', 'negro', 'neonazi', 'nigga',
    'nigger', 'nig nog', 'nimphomania', 'nipple', 'nipples', 'nsfw', 'nsfw images', 'nude',
    'nudity', 'nutten', 'nympho', 'nymphomania', 'octopussy', 'omorashi', 'one cup two girls',
    'one guy one jar', 'orgasm', 'orgy', 'paedophile', 'paki', 'panties', 'panty', 'pedobear',
    'pedophile', 'pegging', 'penis', 'phone sex', 'piece of shit', 'pikey', 'pissing',
    'piss pig', 'pisspig', 'playboy', 'pleasure chest', 'pole smoker', 'ponyplay', 'poof',
    'poon', 'poontang', 'punany', 'poop chute', 'poopchute', 'porn', 'porno', 'pornography',
    'prince albert piercing', 'pthc', 'pubes', 'pussy', 'queaf', 'queef', 'quim', 'raghead',
    'raging boner', 'rape', 'raping', 'rapist', 'rectum', 'reverse cowgirl', 'rimjob',
    'rimming', 'rosy palm', 'rosy palm and her 5 sisters', 'rusty trombone', 'sadism',
    'santorum', 'scat', 'schlong', 'scissoring', 'semen', 'sex', 'sexcam', 'sexo', 'sexy',
    'sexual', 'sexually', 'sexuality', 'shaved beaver', 'shaved pussy', 'shemale', 'shibari',
    'shit', 'shitblimp', 'shitty', 'shota', 'shrimping', 'skeet', 'slanteye', 'slut', 's&m',
    'smut', 'snatch', 'snowballing', 'sodomize', 'sodomy', 'spastic', 'spic', 'splooge',
    'splooge moose', 'spooge', 'spread legs', 'spunk', 'strap on', 'strapon', 'strappado',
    'strip club', 'style doggy', 'suck', 'sucks', 'suicide girls', 'sultry women', 'swastika',
    'swinger', 'tainted love', 'taste my', 'tea bagging', 'threesome', 'throating',
    'thumbzilla', 'tied up', 'tight white', 'tit', 'tits', 'titties', 'titty', 'tongue in a',
    'topless', 'tosser', 'towelhead', 'tranny', 'tribadism', 'tub girl', 'tubgirl', 'tushy',
    'twat', 'twink', 'twinkie', 'two girls one cup', 'undressing', 'upskirt', 'urethra play',
    'urophilia', 'vagina', 'venus mound', 'viagra', 'vibrator', 'violet wand', 'vorarephilia',
    'voyeur', 'voyeurweb', 'voyuer', 'vulva', 'wank', 'wetback', 'wet dream', 'white power',
    'whore', 'worldsex', 'wrapping men', 'wrinkled starfish', 'xx', 'xxx', 'yaoi',
    'yellow showers', 'yiffy', 'zoophilia'
  ]::text[]) as t(w)
on conflict do nothing;

-- No letter/digit at the edge -> a word boundary could never match -> match_whole_word = false.
insert into public.profanity_dictionaries
       (word_or_pattern, category, language, match_whole_word, source)
values
  ('🖕', 'profanity', 'en', false, 'ldnoobw')
on conflict do nothing;

-- ---- Dutch (`nl`): 189 rows ----
insert into public.profanity_dictionaries
       (word_or_pattern, category, language, match_whole_word, source, is_active)
select t.w, 'profanity'::public.profanity_category, 'nl', true, 'ldnoobw',
       -- Reviewed false positives (user decision 2026-09-10): ordinary Dutch words / first names
       -- (anita, johny = names; schatje = sweetheart; pot = pot/jar; nicht = niece; asbak =
       -- ashtray; muts = woolly hat). Seeded INACTIVE so everyday chat is not blocked.
       t.w <> all (array['anita', 'johny', 'schatje', 'pot', 'nicht', 'asbak', 'muts'])
  from unnest(array[
    'aardappels afgieten', 'achter het raam zitten', 'afberen', 'aflebberen', 'afrossen',
    'afrukken', 'aftrekken', 'afwerkplaats', 'afzeiken', 'afzuigen',
    'een halve man en een paardekop', 'anita', 'asbak', 'aso', 'bagger schijten', 'balen',
    'bedonderen', 'befborstel', 'beffen', 'bekken', 'belazeren', 'besodemieterd zijn',
    'besodemieteren', 'beurt', 'boemelen', 'boerelul', 'boerenpummel', 'bokkelul', 'botergeil',
    'broekhoesten', 'brugpieper', 'buffelen', 'buiten de pot piesen',
    'da''s kloten van de bok', 'de ballen', 'de hoer spelen', 'de hond uitlaten',
    'de koffer induiken', 'del', 'de pijp uitgaan', 'dombo', 'draaikont',
    'driehoog achter wonen', 'drol', 'drooggeiler', 'droogkloot', 'een beurt geven',
    'een nummertje maken', 'een wip maken', 'eikel', 'engerd', 'flamoes', 'flikken', 'flikker',
    'gadverdamme', 'galbak', 'gat', 'gedoogzone', 'geilneef', 'gesodemieter', 'godverdomme',
    'graftak', 'gras maaien', 'gratenkut', 'greppeldel', 'griet', 'hoempert', 'hoer',
    'hoerenbuurt', 'hoerenloper', 'hoerig', 'hol', 'hufter', 'huisdealer', 'johny', 'kanen',
    'kettingzeug', 'klaarkomen', 'klerebeer', 'klojo', 'klooien', 'klootjesvolk', 'klootoog',
    'klootzak', 'kloten', 'knor', 'kont', 'kontneuken', 'krentekakker', 'kut',
    'kuttelikkertje', 'kwakkie', 'liefdesgrot', 'lul', 'lul-de-behanger', 'lulhannes',
    'lummel', 'mafketel', 'matennaaier', 'matje', 'mof', 'muts', 'naaien', 'naakt', 'neuken',
    'neukstier', 'nicht', 'oetlul', 'opgeilen', 'opkankeren', 'oprotten', 'opsodemieteren',
    'op z''n hondjes', 'op z''n sodemieter geven', 'opzouten', 'ouwehoer', 'ouwehoeren',
    'ouwe rukker', 'paal', 'paardelul', 'palen', 'penoze', 'piesen', 'pijpbekkieg', 'pijpen',
    'pik', 'pleurislaaier', 'poep', 'poepen', 'poot', 'portiekslet', 'pot', 'potverdorie',
    'publiciteitsgeil', 'raaskallen', 'reet', 'reetridder', 'reet trappen, voor zijn',
    'remsporen', 'reutelen', 'rothoer', 'rotzak', 'rukhond', 'rukken', 'schatje', 'schijt',
    'schijten', 'schoft', 'schuinsmarcheerder', 'slempen', 'slet', 'sletterig',
    'slik mijn zaad', 'snol', 'spuiten', 'standje', 'standje-69', 'stoephoer', 'stootje',
    'stront', 'sufferd', 'tapijtnek', 'teef', 'temeier', 'teringlijer', 'toeter', 'tongzoeng',
    'triootjeg', 'trottoir prostituée', 'trottoirteef', 'vergallen', 'verkloten', 'verneuken',
    'viespeuk', 'vingeren', 'vleesroos', 'voor jan lul', 'voor jan-met-de-korte-achternaam',
    'watje', 'welzijnsmafia', 'wijf', 'wippen', 'wuftje', 'zaadje', 'zakkenwasser', 'zeiken',
    'zeiker', 'zuigen', 'zuiplap'
  ]::text[]) as t(w)
on conflict do nothing;

-- ---- Custom additions (user decision 2026-09-10) ----------------------------------------
-- Very common Dutch / Surinamese-Dutch curses and English variants that LDNOOBW does not
-- contain. source = 'custom' so admins can tell them apart from the imported list.
-- Ableist slurs are categorised hate_speech rather than plain profanity.
insert into public.profanity_dictionaries
       (word_or_pattern, category, language, match_whole_word, source)
values
  ('kanker',  'profanity',   'nl', true, 'custom'),
  ('tering',  'profanity',   'nl', true, 'custom'),
  ('tyfus',   'profanity',   'nl', true, 'custom'),
  ('mongool', 'hate_speech', 'nl', true, 'custom'),
  ('retard',  'hate_speech', 'en', true, 'custom'),
  ('fucker',  'profanity',   'en', true, 'custom'),
  ('fucked',  'profanity',   'en', true, 'custom')
on conflict do nothing;


-- =====================================================================================
-- 9. RLS + GRANTS
-- =====================================================================================

alter table public.stream_moderators          enable row level security;
alter table public.stream_moderation_actions  enable row level security;
alter table public.user_punishments           enable row level security;
alter table public.profanity_dictionaries     enable row level security;
alter table public.stream_reports             enable row level security;
alter table public.stream_chat_rate_state     enable row level security;

-- ---- stream_moderators ---------------------------------------------------------------
-- DECISION: active assignments are PUBLIC-READ. The UI has to paint a "MOD" badge next to
-- every moderator in chat for every viewer (including anonymous ones), so this data is
-- already on screen; hiding the table would only force an expensive per-message RPC. The
-- alternative — a per-row EXISTS against live_streams — would need an index on
-- live_streams.channel_id, and we are not allowed to add one to that pre-existing table.
-- Revoked rows stay private (self / admin) because past-moderator history is not UI data.
drop policy if exists "Anyone can read active stream moderators" on public.stream_moderators;
create policy "Anyone can read active stream moderators"
  on public.stream_moderators for select to anon, authenticated
  using (
    revoked_at is null
    or user_id = auth.uid()
    or assigned_by_user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
-- No client INSERT/UPDATE/DELETE policies: assignment goes through the RPCs only.

-- ---- stream_moderation_actions -------------------------------------------------------
-- Readable by the stream's moderators, by the moderator who acted, and by the target (the
-- app must be able to tell a user "you were muted by X for Y"). NOT world-readable: the
-- transient in-room banner already announces the action, and that is a different surface
-- from a permanently queryable enforcement history of every user on the platform.
drop policy if exists "Moderators and the target can read moderation actions" on public.stream_moderation_actions;
create policy "Moderators and the target can read moderation actions"
  on public.stream_moderation_actions for select to authenticated
  using (
    target_user_id = auth.uid()
    or moderator_user_id = auth.uid()
    or public.stream_mod_is_moderator(live_stream_id, auth.uid())
  );
-- No INSERT policy (RPC-only), no UPDATE policy (+ trigger guard), no DELETE policy.

-- ---- user_punishments ----------------------------------------------------------------
-- A user MUST be able to read their own punishment so the client can explain why chat is
-- disabled and when it expires. Admins see all of them. Moderators see:
--   * mute / kick rows of a stream they moderate (live_stream_id), and
--   * stream_ban rows (broadcaster-scoped, live_stream_id NULL): the BROADCASTER sees every
--     ban held in their name; moderators of the ORIGIN stream (which includes that
--     channel's and global moderators) see it too. A stream-only moderator of a LATER
--     stream cannot list it, but the ban is still enforced there and they can still lift it
--     with stream_mod_unban.
-- NOTE: a stream_ban row whose 3-stream window has passed stays unrevoked (see 4.2) — the
-- client must ask stream_mod_is_punished(), not "a row exists", whether a ban applies.
-- Every branch is an index probe or a cheap check; the is_moderator calls only run for rows
-- the earlier branches did not already allow.
drop policy if exists "Users read own punishments, moderators read their stream's" on public.user_punishments;
create policy "Users read own punishments, moderators read their stream's"
  on public.user_punishments for select to authenticated
  using (
    user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
    or (live_stream_id is not null and public.stream_mod_is_moderator(live_stream_id, auth.uid()))
    or (punishment_type = 'stream_ban'
        and (broadcaster_user_id = auth.uid()
             or (origin_live_stream_id is not null
                 and public.stream_mod_is_moderator(origin_live_stream_id, auth.uid()))))
  );
-- No client write policies: every mutation goes through the SECURITY DEFINER RPCs.

-- ---- profanity_dictionaries ----------------------------------------------------------
-- Admin-only read. Publishing the blocklist would hand every spammer the exact bypass list;
-- clients get the behaviour through the chat gate (and stream_mod_contains_profanity) instead.
drop policy if exists "Admins manage the profanity dictionary" on public.profanity_dictionaries;
create policy "Admins manage the profanity dictionary"
  on public.profanity_dictionaries for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Admins can insert profanity rules" on public.profanity_dictionaries;
create policy "Admins can insert profanity rules"
  on public.profanity_dictionaries for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Admins can update profanity rules" on public.profanity_dictionaries;
create policy "Admins can update profanity rules"
  on public.profanity_dictionaries for update to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Admins can delete profanity rules" on public.profanity_dictionaries;
create policy "Admins can delete profanity rules"
  on public.profanity_dictionaries for delete to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- stream_reports ------------------------------------------------------------------
-- Reporter + admins only. The REPORTED user must never see reports filed against them:
-- that turns the report button into a retaliation trigger.
drop policy if exists "Reporters and admins can read stream reports" on public.stream_reports;
create policy "Reporters and admins can read stream reports"
  on public.stream_reports for select to authenticated
  using (
    reporter_user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );

drop policy if exists "Admins can process stream reports" on public.stream_reports;
create policy "Admins can process stream reports"
  on public.stream_reports for update to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
-- No client INSERT policy: submission goes through stream_mod_report_submit() so the
-- rate limit and the self-report check cannot be skipped with a direct PostgREST call.
-- (It also means a non-admin can never set message_verified: on insert it comes only from
-- the server's HMAC check. Admins can still edit report rows through the UPDATE policy above.)

-- ---- stream_chat_rate_state ----------------------------------------------------------
-- RLS enabled with NO policies at all, and no client grants (revoked below): clients can
-- neither read nor write slow-mode state. Only stream_mod_chat_gate() (SECURITY DEFINER,
-- runs as the owner) touches it.

-- ---- grants --------------------------------------------------------------------------
grant select on public.stream_moderators         to anon, authenticated;
grant select on public.stream_moderation_actions to authenticated;
grant select on public.user_punishments          to authenticated;
grant select on public.profanity_dictionaries    to authenticated;
grant select, update on public.stream_reports    to authenticated;
grant insert, update, delete on public.profanity_dictionaries to authenticated;  -- RLS = admin only

revoke delete on public.stream_moderation_actions from anon, authenticated;
revoke insert, update on public.stream_moderation_actions from anon, authenticated;
revoke insert, update, delete on public.user_punishments from anon, authenticated;
revoke insert, update, delete on public.stream_moderators from anon, authenticated;
revoke insert, delete on public.stream_reports from anon, authenticated;
-- Supabase default privileges grant ALL on new tables to anon/authenticated; take it all back.
revoke all on table public.stream_chat_rate_state from public, anon, authenticated;

-- ---- function execution --------------------------------------------------------------
-- Supabase grants EXECUTE on new functions to anon/authenticated directly, so every revoke
-- names them explicitly — "from public" alone is NOT enough.
revoke execute on function public.stream_mod_assert_can_act(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.stream_mod_close_sessions(uuid, uuid)       from public, anon, authenticated;
revoke execute on function public.stream_mod_reject_audit_update()            from public, anon, authenticated;
-- Chat signing internals: the key reader and the signing oracle are callable by NOBODY but
-- the owner (the SECURITY DEFINER gate / report functions). service_role is revoked too —
-- the relay calls the gate with the sender's JWT and never needs the key or the oracle.
revoke all on function public.stream_mod_chat_signing_key()                                   from public, anon, authenticated, service_role;
revoke all on function public.stream_mod_chat_signature(uuid, uuid, uuid, timestamptz, text)  from public, anon, authenticated, service_role;
-- The gate and the (re-signatured) report RPC: revoke everything first, then re-open to
-- signed-in users only.
revoke all on function public.stream_mod_chat_gate(uuid, text)                                                   from public, anon, authenticated;
revoke all on function public.stream_mod_report_submit(uuid, public.stream_report_reason, uuid, text, uuid, text, timestamptz, text) from public, anon, authenticated;
-- Functions whose behaviour / signature changed on 2026-09-10 (kick lockout, broadcaster-
-- scoped stream ban, 7-day platform ban): same pattern — revoke everything, then grant only
-- what is intended. stream_mod_ban has a NEW signature (p_duration_seconds removed; the old
-- one is dropped in 5.4), so its grants are issued fresh here.
revoke all on function public.stream_mod_is_punished(uuid, uuid, public.user_punishment_type[])  from public, anon, authenticated;
revoke all on function public.stream_mod_kick(uuid, uuid, text)                                  from public, anon, authenticated;
revoke all on function public.stream_mod_ban(uuid, uuid, boolean, text)                          from public, anon, authenticated;
revoke all on function public.stream_mod_unban(uuid, uuid, boolean, text)                        from public, anon, authenticated;

grant execute on function public.stream_mod_is_moderator(uuid, uuid)                                       to anon, authenticated;
grant execute on function public.stream_mod_is_punished(uuid, uuid, public.user_punishment_type[])         to anon, authenticated;
grant execute on function public.stream_mod_mute(uuid, uuid, integer, text)                                to authenticated;
grant execute on function public.stream_mod_unmute(uuid, uuid, text)                                       to authenticated;
grant execute on function public.stream_mod_kick(uuid, uuid, text)                                         to authenticated;
grant execute on function public.stream_mod_ban(uuid, uuid, boolean, text)                                 to authenticated;
grant execute on function public.stream_mod_unban(uuid, uuid, boolean, text)                               to authenticated;
grant execute on function public.stream_mod_assign_moderator(uuid, uuid, uuid)                             to authenticated;
grant execute on function public.stream_mod_revoke_moderator(uuid)                                         to authenticated;
grant execute on function public.stream_mod_report_submit(uuid, public.stream_report_reason, uuid, text, uuid, text, timestamptz, text) to authenticated;
grant execute on function public.stream_mod_report_set_status(uuid, public.stream_report_status, text)     to authenticated;
-- stream_mod_profanity_pattern() returns the ENTIRE compiled blocklist, so it is NOT client-callable:
-- publishing it would hand spammers the bypass list. It is only called internally by
-- stream_mod_contains_profanity() (SECURITY DEFINER, runs as the owner). Admins read the list via the table policy.
revoke all on function public.stream_mod_profanity_pattern() from public, anon, authenticated;
grant execute on function public.stream_mod_contains_profanity(text)                                       to authenticated;
grant execute on function public.stream_mod_chat_gate(uuid, text)                                          to authenticated;


-- =====================================================================================
-- 10. CROSS-FILE HARDENING
--     10.2 touches only a table created by file 01 of THIS feature set.
--     10.3 is the ONE exception: it adds a trigger to the PRE-EXISTING public.live_streams
--     table, with the user's explicit permission (2026-09-10). It changes no column,
--     default, constraint or policy there.
-- =====================================================================================

-- ---- 10.1 (intentionally empty) ------------------------------------------------------
-- Chat messages are never stored (user decision 2026-09-10), so there is no chat table
-- to harden. Mute / kick / ban / profanity / slow-mode enforcement for chat lives entirely in
-- stream_mod_chat_gate() (7B), which the relay must call before every broadcast.
-- Numbering of 10.2 / 10.3 is kept so existing references stay valid.

-- ---- 10.2 live_stream_viewer_sessions: banned / kicked users cannot join -------------
-- Implemented as a BEFORE INSERT trigger rather than by re-creating file 01's INSERT
-- policy, for two reasons: (1) this file does not know file 01's policy name, and blindly
-- dropping the wrong one would silently open the table up; (2) a trigger also covers
-- inserts made by the service_role key or an Edge Function, which RLS does not.
-- Refuses: a platform ban; a stream ban whose broadcaster window (origin + next 2 streams)
-- covers this stream; a running 15-minute kick lockout on this stream. Common case = one
-- empty index probe (stream_mod_is_punished); the follow-up queries run only for users who
-- actually have a matching punishment.
create or replace function public.stream_mod_block_banned_join()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kick_until timestamptz;
  v_seconds    integer;
  v_minutes    integer;
begin
  if new.viewer_user_id is null then
    return new;   -- anonymous/guest viewing, nothing to check
  end if;

  if not public.stream_mod_is_punished(
       new.viewer_user_id,
       new.live_stream_id,
       array['kick', 'stream_ban', 'platform_ban']::public.user_punishment_type[]
     ) then
    return new;   -- the common case
  end if;

  if public.stream_mod_is_punished(
       new.viewer_user_id,
       new.live_stream_id,
       array['stream_ban', 'platform_ban']::public.user_punishment_type[]
     ) then
    raise exception 'You are banned and cannot join this stream.' using errcode = '42501';
  end if;

  -- Otherwise it is a kick lockout on this stream (probe on uq_user_punishments_stream_scope_active).
  select max(p.expires_at)
    into v_kick_until
    from public.user_punishments p
   where p.user_id         = new.viewer_user_id
     and p.live_stream_id  = new.live_stream_id
     and p.punishment_type = 'kick'
     and p.revoked_at is null
     and p.expires_at > now();

  if v_kick_until is not null then
    v_seconds := greatest(1, ceil(extract(epoch from (v_kick_until - now())))::int);
    v_minutes := greatest(1, ceil(v_seconds / 60.0)::int);   -- round UP: never promise too early
    raise exception 'You were removed from this stream. You can rejoin in % %.',
                    v_minutes, case when v_minutes = 1 then 'minute' else 'minutes' end
      using errcode = '42501',
            detail  = format('reason=kicked; retry_after_seconds=%s', v_seconds);
  end if;

  return new;
end;
$$;

comment on function public.stream_mod_block_banned_join() is
  'BEFORE INSERT guard on live_stream_viewer_sessions. Blocks platform-banned users, users whose broadcaster-scoped stream ban covers this stream, and users inside a 15-minute kick lockout on this stream (message "You can rejoin in N minutes", DETAIL carries retry_after_seconds) from opening a new watch session.';

drop trigger if exists trg_stream_mod_block_banned_join on public.live_stream_viewer_sessions;
create trigger trg_stream_mod_block_banned_join
  before insert on public.live_stream_viewer_sessions
  for each row execute function public.stream_mod_block_banned_join();

-- ---- 10.3 live_streams: a platform-banned user cannot go live ------------------------
-- *************************************************************************************
-- *** USER PERMISSION GRANTED (2026-09-10) — CHANGE TO A PRE-EXISTING TABLE ***
-- This is the ONLY statement in this file that touches a pre-existing table.
--
-- WHAT IT AFFECTS
--   public.live_streams (the website's table). "Going live" = inserting a row there, and
--   the website does that directly under its own host-only INSERT policy — no RPC of ours
--   is in the path. A trigger is therefore the only airtight place to stop a banned user:
--   it fires for the website, the mobile app, PostgREST, the service_role key and any
--   future Edge Function alike.
--
-- WHAT IT DOES
--   BEFORE INSERT, or BEFORE an UPDATE that sets `status`, for each row: if the row is
--   BECOMING live (a new row with status 'live', or an existing row flipped from anything
--   else back to 'live') AND its host has an active, unexpired, unrevoked platform_ban,
--   the statement is rejected with SQLSTATE 42501 and a clear message. Stream bans (and
--   kicks / mutes) are ignored on purpose: they restrict WATCHING / CHATTING in a
--   broadcaster's streams, never the banned user's own ability to broadcast.
--
-- WHY IT IS NON-BREAKING
--   * It only ADDS a trigger. No column, default, constraint, index or RLS policy on
--     live_streams is added, changed or removed by this file.
--   * It never modifies the row — it either returns NEW untouched or raises.
--   * It can only reject a user who is platform-banned at that moment. Every other
--     INSERT/UPDATE behaves exactly as it does today.
--   * Ending a stream (status -> 'ended'), metadata edits, live_stream_init/join (which do
--     not set status) and the cron sweeper never meet the "becoming live" condition.
--   * Existing rows are not scanned or re-checked; triggers only see new writes.
--   * Note: BEFORE triggers see column defaults already applied, so a website INSERT that
--     omits `status` (default 'live') is still correctly caught.
--   * Cost: one index-only probe on idx_user_punishments_active_lookup per stream start.
--
-- ONE-LINE ROLLBACK
--   drop trigger if exists trg_stream_mod_block_banned_host on public.live_streams;
-- *************************************************************************************
create or replace function public.stream_mod_block_banned_host()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Not "going live" at all -> nothing to check.
  if new.host_user_id is null or new.status is distinct from 'live' then
    return new;
  end if;

  -- Already live before this UPDATE -> a metadata edit, not a new broadcast.
  -- (Nested IF so OLD is only ever read on UPDATE, never on INSERT.)
  if tg_op = 'UPDATE' then
    if old.status is not distinct from 'live' then
      return new;
    end if;
  end if;

  if public.stream_mod_is_punished(
       new.host_user_id,
       null,
       array['platform_ban']::public.user_punishment_type[]
     ) then
    raise exception 'Your account is banned from the platform, so you cannot start a live stream.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.stream_mod_block_banned_host() is
  'BEFORE INSERT / UPDATE OF status guard on the PRE-EXISTING public.live_streams (user-approved 2026-09-10). Rejects (42501) a row that is becoming live when its host has an active platform_ban. Never modifies the row; affects no one else.';

-- Trigger functions cannot be called directly, and firing a trigger does not check
-- EXECUTE, so this only removes Postgres's default PUBLIC grant for tidiness.
revoke execute on function public.stream_mod_block_banned_host() from public, anon, authenticated;

drop trigger if exists trg_stream_mod_block_banned_host on public.live_streams;
create trigger trg_stream_mod_block_banned_host
  before insert or update of status on public.live_streams
  for each row execute function public.stream_mod_block_banned_host();

commit;


-- =====================================================================================
-- ROLLBACK (manual) — run inside a transaction, in this order.
-- =====================================================================================
-- begin;
--
-- -- ---- Reverses the USER-APPROVED (2026-09-10) change to the PRE-EXISTING public.live_streams (10.3)
-- drop trigger if exists trg_stream_mod_block_banned_host on public.live_streams;
-- drop function if exists public.stream_mod_block_banned_host();
-- -- ---- (nothing else on live_streams was changed by this file)
--
-- drop trigger if exists trg_stream_mod_block_banned_join on public.live_stream_viewer_sessions;
-- drop function if exists public.stream_mod_block_banned_join();
--
-- -- ---- chat gate + signing (7A / 7B)
-- drop function if exists public.stream_mod_chat_gate(uuid, text);
-- drop function if exists public.stream_mod_chat_signature(uuid, uuid, uuid, timestamptz, text);
-- drop function if exists public.stream_mod_chat_signing_key();
-- -- The Vault secret is left in place on purpose (harmless on its own, and deleting it makes
-- -- every signed reported message unverifiable). Only if you really want it gone:
-- --   delete from vault.secrets where name = 'live_chat_signing_key';
--
-- drop function if exists public.stream_mod_contains_profanity(text);
-- drop function if exists public.stream_mod_profanity_pattern();
-- drop function if exists public.stream_mod_report_set_status(uuid, public.stream_report_status, text);
-- drop function if exists public.stream_mod_report_submit(uuid, public.stream_report_reason, uuid, text, uuid, text, timestamptz, text);
-- drop function if exists public.stream_mod_revoke_moderator(uuid);
-- drop function if exists public.stream_mod_assign_moderator(uuid, uuid, uuid);
-- drop function if exists public.stream_mod_unban(uuid, uuid, boolean, text);
-- drop function if exists public.stream_mod_ban(uuid, uuid, boolean, text);
-- drop function if exists public.stream_mod_ban(uuid, uuid, boolean, integer, text);  -- pre-2026-09-10 signature, if it ever existed
-- drop function if exists public.stream_mod_kick(uuid, uuid, text);
-- drop function if exists public.stream_mod_unmute(uuid, uuid, text);
-- drop function if exists public.stream_mod_mute(uuid, uuid, integer, text);
-- drop function if exists public.stream_mod_close_sessions(uuid, uuid);
-- drop function if exists public.stream_mod_assert_can_act(uuid, uuid, uuid);
-- drop function if exists public.stream_mod_is_punished(uuid, uuid, public.user_punishment_type[]);
-- drop function if exists public.stream_mod_is_moderator(uuid, uuid);
--
-- drop trigger  if exists trg_stream_moderation_actions_immutable on public.stream_moderation_actions;
-- drop function if exists public.stream_mod_reject_audit_update();
--
-- drop table if exists public.stream_chat_rate_state;   -- UNLOGGED, disposable
-- drop table if exists public.stream_reports;           -- NOTE: also deletes stored reported-message text
-- drop table if exists public.profanity_dictionaries;   -- also removes the LDNOOBW seed + admin rows
-- drop table if exists public.user_punishments;         -- also removes its indexes (incl. stream-ban ones)
-- drop table if exists public.stream_moderation_actions;
-- drop table if exists public.stream_moderators;
--
-- drop type if exists public.stream_report_status;
-- drop type if exists public.stream_report_reason;
-- drop type if exists public.profanity_category;
-- drop type if exists public.user_punishment_type;
-- drop type if exists public.stream_moderation_action_type;
--
-- commit;
