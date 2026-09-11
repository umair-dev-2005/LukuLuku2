-- =====================================================================================
-- LukuLuku Live Streaming — Migration 01 of 05
-- Feature: Core Live Streaming Infrastructure (Broadcaster & Viewer Engine)
-- Spec:    specs/archive/01-core-live-streaming-infrastructure.md (archived — outdated, history only)
-- Target:  Supabase / PostgreSQL 17
--
-- CREATES
--   enums     : live_stream_end_reason, live_viewer_leave_reason
--   tables    : public.stream_categories
--               public.live_stream_runtime           (1:1 hot-path side table)
--               public.live_stream_viewer_sessions
--   extends   : public.live_streams  <-- PRE-EXISTING TABLE, ADD-ONLY, see section 4.
--                                        *** USER PERMISSION GRANTED 2026-09-10 ***
--   functions : public.live_stream_init(uuid, uuid)
--               public.live_stream_heartbeat(uuid)
--               public.live_stream_join(uuid, text)
--               public.live_stream_leave(uuid, live_viewer_leave_reason)
--               public.live_stream_end(uuid, live_stream_end_reason)
--               public.live_stream_end_internal(uuid, live_stream_end_reason)  [private]
--               public.live_stream_force_end_abandoned(integer)
--   schedules : pg_cron job 'lk_live_force_end_abandoned' (every minute, 2-minute timeout)
--               -- only if pg_cron is installed, see section 10.
--               *** USER APPROVED 2026-09-10 ***
--
-- RUN ORDER: this file is FIRST. Nothing must run before it.
--            Files 02 (chat), 03 (battles), 04 (economy), 05 (moderation) depend on it.
--
-- WHERE THE METRICS LIVE — and why it is split across two tables:
--   * DURABLE, WRITTEN ONCE  (category_id, end_reason, duration_seconds, total_views,
--     unique_viewers, peak_concurrent_viewers)  -> columns ON public.live_streams.
--     They belong with the stream and the discovery feed can read them without a join.
--   * HOT, WRITTEN ON EVERY JOIN/LEAVE/HEARTBEAT (current_concurrent_viewers,
--     total_views_live, host_last_seen_at) -> public.live_stream_runtime.
--     Postgres rewrites a whole row on every UPDATE, so ticking these on live_streams
--     would fill the main discovery table with dead tuples and slow "what's live now"
--     down between vacuums. Keep the churn off the table everybody reads.
--   * total_views_live is the RUNNING "total views" shown while the stream is live. It is
--     bumped inside the same runtime write live_stream_join() already does (no extra
--     write), and live_stream_end_internal() sets it to the exact final count, the same
--     number it writes to live_streams.total_views.
--   DO NOT "simplify" the runtime counters onto live_streams. That is the whole point.
--
-- SAFE TO RE-RUN: fully idempotent (add-column-if-not-exists, guarded constraints,
--                 create-if-not-exists, drop-policy-before-create, drop+create functions,
--                 on-conflict-do-nothing seed data, unschedule-then-schedule cron job).
-- =====================================================================================

begin;

-- -------------------------------------------------------------------------------------
-- 1. ENUMS
-- -------------------------------------------------------------------------------------

-- Why a stream stopped. 'moderation_ban' is written by migration 05 (moderation).
do $$
begin
    create type public.live_stream_end_reason as enum (
        'broadcaster_ended',   -- host tapped "End Stream" and confirmed
        'disconnected',        -- host went away and never came back within the timeout
        'moderation_ban'       -- admin / moderator killed the stream (file 05)
    );
exception when duplicate_object then null;
end $$;

-- Why a viewer's watch session closed. 'kicked' is written by migration 05 (moderation).
do $$
begin
    create type public.live_viewer_leave_reason as enum (
        'swiped_away',         -- swiped to the next stream in the live feed
        'manual_exit',         -- closed the player / backed out
        'stream_ended',        -- the broadcast ended under them
        'kicked',              -- removed by host/moderator (file 05) -- REQUIRED VALUE
        'connection_lost'      -- app died / never sent a leave; closed by the server
    );
exception when duplicate_object then null;
end $$;


-- -------------------------------------------------------------------------------------
-- 2. public.stream_categories — small static reference table
-- -------------------------------------------------------------------------------------

create table if not exists public.stream_categories (
    id          uuid        primary key default gen_random_uuid(),
    name        text        not null,
    slug        text        not null,
    is_active   boolean     not null default true,
    sort_order  integer     not null default 0,
    created_at  timestamptz not null default now(),
    constraint stream_categories_slug_key   unique (slug),
    constraint stream_categories_name_check check (length(btrim(name)) between 1 and 60),
    constraint stream_categories_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

comment on table  public.stream_categories is
    'Reference list of live-stream categories shown in the preview/"Go Live" screen and used by the live discovery feed. Client-read-only; managed by admins.';
comment on column public.stream_categories.slug is
    'Stable machine key. Use this (never the uuid or the display name) as the i18n key in lib/i18n.ts so category labels can be translated to nl / en / srn.';
comment on column public.stream_categories.is_active is
    'false = hidden from the "Go Live" picker but kept so historical live_streams.category_id values still resolve.';
comment on column public.stream_categories.sort_order is
    'Ascending display order in the category picker; ties broken by name.';

-- Discovery/picker path: active categories in display order.
create index if not exists idx_stream_categories_active_order
    on public.stream_categories (sort_order, name)
    where is_active;

-- Seed. Idempotent: re-running never duplicates and never overwrites admin edits.
-- Note: the app has NO pre-existing category constant list to mirror (videos/community_posts
-- use free-text `tags`, and public.user_category_interests.category is free text), so this is
-- a fresh, deliberately small starter set for a Suriname / Caribbean social video app.
insert into public.stream_categories (name, slug, sort_order) values
    ('Just Chatting',        'just-chatting',   10),
    ('Music & DJ',           'music',           20),
    ('Dance',                'dance',           30),
    ('Comedy',               'comedy',          40),
    ('Gaming',               'gaming',          50),
    ('Sports',               'sports',          60),
    ('Food & Cooking',       'food',            70),
    ('Beauty & Fashion',     'beauty-fashion',  80),
    ('News & Talk',          'news-talk',       90),
    ('Faith & Inspiration',  'faith',          100),
    ('Education',            'education',      110),
    ('Business & Hustle',    'business',       120),
    ('Events & Parties',     'events',         130),
    ('Travel & Nature',      'travel',         140),
    ('Other',                'other',          999)
on conflict (slug) do nothing;


-- -------------------------------------------------------------------------------------
-- 3. CLEAN-UP OF THE SUPERSEDED DRAFT SIDE TABLE (safe no-op on a fresh database)
-- -------------------------------------------------------------------------------------
-- An earlier draft of this migration created public.live_stream_stats. Its durable
-- columns now live on public.live_streams and its hot columns live in
-- public.live_stream_runtime. This drops the old table ONLY if it exists AND is empty,
-- so it can never destroy data. If it exists and has rows, it is left alone and must be
-- migrated by hand.
-- Dynamic SQL on purpose: PL/pgSQL parses a whole IF condition before evaluating it, so
-- writing `... and not exists (select 1 from public.live_stream_stats)` directly fails with
-- 42P01 on a fresh database (where the table has never existed) even though the
-- to_regclass() test would have been false. EXECUTE defers that table reference until we
-- know the table is there.
do $$
declare
    v_has_rows boolean;
begin
    if to_regclass('public.live_stream_stats') is not null then
        execute 'select exists (select 1 from public.live_stream_stats)' into v_has_rows;
        if not v_has_rows then
            execute 'drop table public.live_stream_stats';
        end if;
    end if;
end $$;


-- =====================================================================================
-- 4. EXTENDING THE PRE-EXISTING public.live_streams TABLE
--
-- *** USER PERMISSION GRANTED (2026-09-10) ***
-- CLAUDE.md forbids modifying pre-existing structures without explicit permission.
-- The user reviewed the trade-off and approved BOTH of the following, on the condition
-- that nothing existing may break:
--   (1) adding the missing metric/summary columns directly onto live_streams, and
--   (2) an industry-standard fix for "only the host can touch a stream".
--
-- WHY THIS IS NON-BREAKING — every statement here is ADD-ONLY:
--   * No column is dropped, renamed, or has its type changed.
--   * No existing constraint, trigger, default or RLS policy is dropped or edited.
--   * New columns are either nullable or NOT NULL with a constant DEFAULT. On
--     PostgreSQL 11+ (this DB is 17.6) that is a catalog-only change — no table
--     rewrite, no long lock, instant even on a large table.
--   * The website's existing INSERTs never name these columns, so they keep working
--     unchanged and simply get the defaults.
--   * The website's existing SELECTs either name columns explicitly (unaffected) or
--     use `select *` (which just returns extra keys — harmless for PostgREST clients).
--   * RLS policies in PostgreSQL are OR'd together. Adding a PERMISSIVE policy can
--     only WIDEN access; it can never revoke what the existing host-only policies
--     already allow. The three original host policies are left byte-for-byte intact.
--   * Indexes change performance only, never results.
-- =====================================================================================


-- ---- 4.1 New columns ---------------------------------------------------------------
-- These are the fields spec 01 wanted on live_streams but which do not exist there.
-- `category` (free text, written by the website) is deliberately left alone; the new
-- `category_id` is the normalised foreign key the mobile app will use.

alter table public.live_streams
    add column if not exists category_id              uuid,
    add column if not exists end_reason               public.live_stream_end_reason,
    add column if not exists duration_seconds         integer,
    add column if not exists total_views              bigint not null default 0,
    add column if not exists unique_viewers           bigint not null default 0,
    add column if not exists peak_concurrent_viewers  bigint not null default 0;

comment on column public.live_streams.category_id is
    'FK -> stream_categories. Normalised replacement for the free-text `category` column used by the website. Both coexist; `category` is untouched.';
comment on column public.live_streams.end_reason is
    'Why the broadcast stopped. NULL while still live. Set by live_stream_end().';
comment on column public.live_streams.duration_seconds is
    'ended_at - started_at, materialised once at end so the summary needs no recompute. NULL while live.';
comment on column public.live_streams.total_views is
    'COUNT(*) of live_stream_viewer_sessions for this stream (repeat joins count separately). Cached at end.';
comment on column public.live_streams.unique_viewers is
    'COUNT(DISTINCT viewer) for this stream. Cached at end.';
comment on column public.live_streams.peak_concurrent_viewers is
    'Highest simultaneous viewer count reached. Maintained incrementally during the stream — it cannot be derived from session rows after the fact.';


-- ---- 4.2 Constraints on the new columns only ---------------------------------------
-- Added separately (not inline) so the whole section stays re-runnable: `ADD COLUMN
-- IF NOT EXISTS` skips its inline constraints when the column already exists.
-- NOT VALID + VALIDATE is unnecessary here because every existing row already satisfies
-- these (the columns were just created with constant defaults), but each is guarded so
-- a second run is a no-op.

do $$
begin
    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_streams'::regclass
                      and conname  = 'live_streams_category_id_fkey') then
        alter table public.live_streams
            add constraint live_streams_category_id_fkey
            foreign key (category_id) references public.stream_categories(id)
            on delete set null;
    end if;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_streams'::regclass
                      and conname  = 'live_streams_duration_seconds_check') then
        alter table public.live_streams
            add constraint live_streams_duration_seconds_check
            check (duration_seconds is null or duration_seconds >= 0);
    end if;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_streams'::regclass
                      and conname  = 'live_streams_total_views_check') then
        alter table public.live_streams
            add constraint live_streams_total_views_check check (total_views >= 0);
    end if;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_streams'::regclass
                      and conname  = 'live_streams_unique_viewers_check') then
        alter table public.live_streams
            add constraint live_streams_unique_viewers_check check (unique_viewers >= 0);
    end if;

    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_streams'::regclass
                      and conname  = 'live_streams_peak_viewers_check') then
        alter table public.live_streams
            add constraint live_streams_peak_viewers_check check (peak_concurrent_viewers >= 0);
    end if;
end $$;

-- NOTE: deliberately NO check constraint on `status`. The website writes that column and
-- we have not audited every value it can produce; adding a CHECK could start rejecting
-- writes that work today. Status stays free text, exactly as it is now.


-- ---- 4.3 Indexes ------------------------------------------------------------------
-- live_streams currently has ONLY its primary key. Every one of these supports a query
-- path this feature introduces; none change any result.

-- The discovery feed: "what is live right now, newest first".
create index if not exists idx_live_streams_status_started
    on public.live_streams (status, started_at desc);

-- A host opening their own past-broadcast history.
create index if not exists idx_live_streams_host_started
    on public.live_streams (host_user_id, started_at desc);

-- Unindexed FK today: every DELETE on channels must seq-scan live_streams to check it.
create index if not exists idx_live_streams_channel
    on public.live_streams (channel_id);

-- Browsing live streams inside one category. Partial: only live rows are ever browsed.
create index if not exists idx_live_streams_live_by_category
    on public.live_streams (category_id, started_at desc)
    where status = 'live';

-- Resolving a ZegoCloud webhook/callback back to our row.
create index if not exists idx_live_streams_zego_room
    on public.live_streams (zego_room_id);


-- ---- 4.4 Admin / moderator access ---------------------------------------------------
-- THE "HOST-ONLY" PROBLEM, SOLVED THE SAME WAY THIS DATABASE ALREADY SOLVES IT.
--
-- Today live_streams has four policies and all of them are host-scoped:
--   SELECT  ... USING (status = 'live' OR host_user_id = auth.uid())
--   INSERT/UPDATE/DELETE ... host_user_id = auth.uid()
-- Consequences:
--   * A moderator cannot shut down an abusive broadcast.
--   * An admin investigating a report on an ENDED stream cannot even read the row.
--   * Nothing can mark an abandoned stream 'ended', so it shows as live forever.
--
-- The fix mirrors the pattern already used in this same database on
-- wallet_withdrawals ("Admins view all withdrawals" / "Admins update withdrawals"),
-- channel_tips and content_claims: a separate PERMISSIVE policy gated on the existing
-- SECURITY DEFINER has_role() helper. The original host policies are NOT touched.

drop policy if exists "Admins and moderators can view all live streams" on public.live_streams;
create policy "Admins and moderators can view all live streams"
    on public.live_streams
    as permissive for select
    to authenticated
    using (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        or public.has_role(auth.uid(), 'moderator'::public.app_role)
    );

comment on policy "Admins and moderators can view all live streams" on public.live_streams is
    'Additive. Lets staff read ended/abandoned streams for moderation review. PERMISSIVE policies are OR''d, so ordinary users keep exactly the access the original host policies gave them.';

drop policy if exists "Admins and moderators can update any live stream" on public.live_streams;
create policy "Admins and moderators can update any live stream"
    on public.live_streams
    as permissive for update
    to authenticated
    using (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        or public.has_role(auth.uid(), 'moderator'::public.app_role)
    )
    with check (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        or public.has_role(auth.uid(), 'moderator'::public.app_role)
    );

comment on policy "Admins and moderators can update any live stream" on public.live_streams is
    'Additive. Lets staff force-end an abusive or abandoned broadcast. No DELETE counterpart on purpose: streams must be ENDED, never erased, so the gift ledger and moderation audit trail keep their references.';

-- Deliberately NOT added: an admin DELETE policy. gift_transactions.live_stream_id is
-- ON DELETE RESTRICT (migration 04), so deleting a stream that received gifts would fail
-- anyway, and erasing a stream would orphan its moderation audit trail. Ending is the
-- correct operation; live_stream_end() provides it.
--
-- The automated force-end path (broadcaster disconnected, no heartbeat) does NOT rely on
-- these policies at all: a cron job has no auth.uid(). It runs through the SECURITY
-- DEFINER function live_stream_force_end_abandoned(), which bypasses RLS by design.


-- -------------------------------------------------------------------------------------
-- 5. public.live_stream_runtime — 1:1 HOT-PATH side table on public.live_streams
-- -------------------------------------------------------------------------------------
-- Only the fields that are written many times per broadcast live here, so that churn
-- never touches the main discovery table. Everything durable is on live_streams (sec. 4).

create table if not exists public.live_stream_runtime (
    live_stream_id             uuid primary key
        references public.live_streams(id) on delete cascade,
    current_concurrent_viewers bigint      not null default 0,
    total_views_live           bigint      not null default 0,
    host_last_seen_at          timestamptz null,
    created_at                 timestamptz not null default now(),
    updated_at                 timestamptz not null default now(),
    constraint live_stream_runtime_current_check check (current_concurrent_viewers >= 0),
    constraint live_stream_runtime_total_views_live_check check (total_views_live >= 0)
);

-- `create table if not exists` does NOT add a new column to a table that already exists
-- (e.g. from an earlier run of this file), so the column and its CHECK are also added
-- here idempotently. This is OUR table (created by this file), so altering it is allowed.
-- NOT NULL + constant DEFAULT is a catalog-only change on PostgreSQL 11+ (no rewrite).
alter table public.live_stream_runtime
    add column if not exists total_views_live bigint not null default 0;

do $$
begin
    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.live_stream_runtime'::regclass
                      and conname  = 'live_stream_runtime_total_views_live_check') then
        alter table public.live_stream_runtime
            add constraint live_stream_runtime_total_views_live_check
            check (total_views_live >= 0);
    end if;
end $$;

comment on table  public.live_stream_runtime is
    'Volatile per-broadcast runtime state (live viewer counter, running total-views counter + broadcaster heartbeat). Deliberately separate from public.live_streams so that high-frequency join/leave/heartbeat UPDATEs do not churn the row that the discovery feed reads. Exactly one row per stream, created lazily by live_stream_init() or by the first viewer join. Never written directly by clients — all writes go through the live_* SECURITY DEFINER RPCs so the counters cannot be forged.';
comment on column public.live_stream_runtime.current_concurrent_viewers is
    'Live concurrency counter (+1 on join, -1 on leave). Its high-water mark is pushed to live_streams.peak_concurrent_viewers. The on-screen viewer count should come from a realtime/presence channel, not from polling this column.';
comment on column public.live_stream_runtime.total_views_live is
    'Running count of watch sessions opened on this stream while it is live (repeat joins count separately) — the same definition as the end-of-stream live_streams.total_views. +1 per new live_stream_viewer_sessions row, bumped by live_stream_join() inside the runtime upsert it already does, so it costs no extra write; a join that reuses an already-open session does not count. live_stream_end_internal() sets it to the exact final count (reconciling any drift). Shown as "total views" during the live; once ended, read live_streams.total_views.';
comment on column public.live_stream_runtime.host_last_seen_at is
    'Broadcaster heartbeat, bumped by live_stream_heartbeat(). live_stream_force_end_abandoned() uses it to detect a dead room (spec item 8).';

-- Monitoring / sweeper support. The abandoned-stream sweep itself is driven from
-- live_streams (idx_live_streams_status_started) and joins this table by primary key.
create index if not exists idx_live_stream_runtime_open
    on public.live_stream_runtime (host_last_seen_at);

drop trigger if exists set_live_stream_runtime_updated_at on public.live_stream_runtime;
create trigger set_live_stream_runtime_updated_at
    before update on public.live_stream_runtime
    for each row execute function public.update_updated_at_column();


-- -------------------------------------------------------------------------------------
-- 6. public.live_stream_viewer_sessions — one row per (viewer, single watch session)
-- -------------------------------------------------------------------------------------
-- Repeat joins on the same stream deliberately create a NEW row each time; that is how
-- total_views (all rows) and unique_viewers (distinct identity) stay separable.

create table if not exists public.live_stream_viewer_sessions (
    id               uuid primary key default gen_random_uuid(),
    live_stream_id   uuid not null
        references public.live_streams(id) on delete cascade,
    viewer_user_id   uuid null
        references auth.users(id) on delete cascade,
    guest_key        text null,
    joined_at        timestamptz not null default now(),
    left_at          timestamptz null,
    duration_seconds integer null,
    leave_reason     public.live_viewer_leave_reason null,
    constraint live_viewer_sessions_identity_check
        check (viewer_user_id is not null or guest_key is not null),
    constraint live_viewer_sessions_guest_key_check
        check (guest_key is null or length(guest_key) between 8 and 64),
    constraint live_viewer_sessions_duration_check
        check (duration_seconds is null or duration_seconds >= 0),
    constraint live_viewer_sessions_closed_check
        check ((left_at is null and duration_seconds is null and leave_reason is null)
            or (left_at is not null and leave_reason is not null))
);

comment on table  public.live_stream_viewer_sessions is
    'One row per watch session. Opened by live_stream_join(), closed by live_stream_leave(), force-closed by live_stream_end(). Swiping to the next stream = leave current + join next. Silent auto-reconnect must NOT create a new row.';
comment on column public.live_stream_viewer_sessions.viewer_user_id is
    'NULL for guest (not signed in) viewers. Guest viewing is ALLOWED by default because LukuLuku already lets signed-out users browse video/Bangi content; chat and gifting still require a login and are enforced in migrations 02 and 04.';
comment on column public.live_stream_viewer_sessions.guest_key is
    'Opaque, client-generated, device-scoped random id (store it once in AsyncStorage) used only to (a) de-duplicate guest reconnects and (b) count unique guest viewers. Contains no PII, is never exposed to other clients, and is ignored entirely once viewer_user_id is set.';
comment on column public.live_stream_viewer_sessions.joined_at is
    'Doubles as this row''s created_at; the row is immutable apart from being closed.';
comment on column public.live_stream_viewer_sessions.duration_seconds is
    'Computed at close time as left_at - joined_at.';

-- Real query paths:
-- (a) count / list currently-open sessions for one stream (concurrency, kick lists)
create index if not exists idx_live_viewer_sessions_open_by_stream
    on public.live_stream_viewer_sessions (live_stream_id)
    where left_at is null;

-- (b) a stream's full session history (end-of-stream aggregation, host analytics)
create index if not exists idx_live_viewer_sessions_stream_joined
    on public.live_stream_viewer_sessions (live_stream_id, joined_at desc);

-- (c) a viewer's own watch history
create index if not exists idx_live_viewer_sessions_viewer_joined
    on public.live_stream_viewer_sessions (viewer_user_id, joined_at desc)
    where viewer_user_id is not null;

-- (d) "at most one OPEN session per (stream, identity)" - makes the stale-session cleanup
--     in live_stream_join() provably correct instead of best-effort.
create unique index if not exists uq_live_viewer_sessions_open_user
    on public.live_stream_viewer_sessions (live_stream_id, viewer_user_id)
    where left_at is null and viewer_user_id is not null;

create unique index if not exists uq_live_viewer_sessions_open_guest
    on public.live_stream_viewer_sessions (live_stream_id, guest_key)
    where left_at is null and viewer_user_id is null and guest_key is not null;


-- -------------------------------------------------------------------------------------
-- 7. RLS + GRANTS on the NEW tables
-- -------------------------------------------------------------------------------------

alter table public.stream_categories            enable row level security;
alter table public.live_stream_runtime          enable row level security;
alter table public.live_stream_viewer_sessions  enable row level security;

-- --- stream_categories: world-readable reference data, admin-managed ------------------
drop policy if exists "Anyone can view active stream categories" on public.stream_categories;
create policy "Anyone can view active stream categories"
    on public.stream_categories
    as permissive for select
    to public
    using (is_active);

drop policy if exists "Admins can manage stream categories" on public.stream_categories;
create policy "Admins can manage stream categories"
    on public.stream_categories
    as permissive for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role))
    with check (public.has_role(auth.uid(), 'admin'::public.app_role));

grant select on public.stream_categories to anon, authenticated;
grant insert, update, delete on public.stream_categories to authenticated; -- narrowed by RLS to admins

-- --- live_stream_runtime: readable wherever the parent stream is readable -------------
-- NO client INSERT/UPDATE/DELETE policy at all. The counter is written only by the
-- SECURITY DEFINER live_* RPCs, so a host cannot inflate their own viewer numbers.
drop policy if exists "Anyone can view runtime of visible streams" on public.live_stream_runtime;
create policy "Anyone can view runtime of visible streams"
    on public.live_stream_runtime
    as permissive for select
    to public
    using (exists (
        select 1
        from public.live_streams ls
        where ls.id = live_stream_runtime.live_stream_id
    ));

-- Redundant on paper now that section 4.4 lets staff read every live_streams row (the
-- EXISTS above would already succeed for them), but kept explicit so this table's staff
-- access does not silently depend on a policy defined on another table.
drop policy if exists "Admins can view all live stream runtime" on public.live_stream_runtime;
create policy "Admins can view all live stream runtime"
    on public.live_stream_runtime
    as permissive for select
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role));

grant select on public.live_stream_runtime to anon, authenticated;

-- --- live_stream_viewer_sessions: own history + host of the stream + admin ------------
-- Deliberately NOT gated on parent-stream visibility: a viewer must keep access to their
-- own watch history after the stream ends. Guests get no SELECT at all - they have no
-- provable identity, and the session id returned by live_stream_join() is all their
-- client needs.
drop policy if exists "Viewers can read their own watch sessions" on public.live_stream_viewer_sessions;
create policy "Viewers can read their own watch sessions"
    on public.live_stream_viewer_sessions
    as permissive for select
    to authenticated
    using (viewer_user_id = auth.uid());

drop policy if exists "Hosts can read viewer sessions of their streams" on public.live_stream_viewer_sessions;
create policy "Hosts can read viewer sessions of their streams"
    on public.live_stream_viewer_sessions
    as permissive for select
    to authenticated
    using (exists (
        select 1
        from public.live_streams ls
        where ls.id = live_stream_viewer_sessions.live_stream_id
          and ls.host_user_id = auth.uid()
    ));

drop policy if exists "Admins can read all viewer sessions" on public.live_stream_viewer_sessions;
create policy "Admins can read all viewer sessions"
    on public.live_stream_viewer_sessions
    as permissive for select
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role));

grant select on public.live_stream_viewer_sessions to authenticated;
-- No INSERT/UPDATE/DELETE grant and no write policy: writes are RPC-only, on purpose.


-- -------------------------------------------------------------------------------------
-- 8. RPCs (all SECURITY DEFINER, all validate auth.uid() themselves)
-- -------------------------------------------------------------------------------------
-- Dropped before creation because an earlier draft of this file declared some of these
-- with different return types, and CREATE OR REPLACE cannot change a return type.
-- All grants are re-issued in section 9, so dropping loses nothing.

drop function if exists public.live_stream_init_stats(uuid, uuid);   -- renamed to live_stream_init
drop function if exists public.live_stream_init(uuid, uuid);
drop function if exists public.live_stream_end(uuid, public.live_stream_end_reason);
drop function if exists public.live_stream_end_internal(uuid, public.live_stream_end_reason);


-- 8.1 live_stream_init -----------------------------------------------------------------
-- Called by the broadcaster immediately AFTER the live_streams row is inserted (which the
-- host does itself under the existing host-only INSERT policy, only once ZegoCloud has
-- confirmed publish). Sets the normalised category on the stream and creates the 1:1
-- runtime row.
create or replace function public.live_stream_init(
    p_live_stream_id uuid,
    p_category_id    uuid default null
)
returns public.live_streams
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid  uuid := auth.uid();
    v_host uuid;
    v_row  public.live_streams;
begin
    if v_uid is null then
        raise exception 'live_stream_init: authentication required'
            using errcode = '28000';
    end if;

    select ls.host_user_id into v_host
    from public.live_streams ls
    where ls.id = p_live_stream_id;

    if not found then
        raise exception 'live_stream_init: stream % not found', p_live_stream_id
            using errcode = 'P0002';
    end if;

    -- Host-only on purpose: initialising someone else's broadcast is never legitimate.
    if v_host is distinct from v_uid then
        raise exception 'live_stream_init: only the host may initialise this stream'
            using errcode = '42501';
    end if;

    if p_category_id is not null
       and not exists (select 1 from public.stream_categories c where c.id = p_category_id) then
        raise exception 'live_stream_init: unknown category %', p_category_id
            using errcode = '23503';
    end if;

    update public.live_streams ls
       set category_id = coalesce(p_category_id, ls.category_id)
     where ls.id = p_live_stream_id
    returning ls.* into v_row;

    insert into public.live_stream_runtime as rt (live_stream_id, host_last_seen_at)
    values (p_live_stream_id, now())
    on conflict (live_stream_id) do update
        set host_last_seen_at = now(),
            updated_at        = now();

    return v_row;
end;
$$;

comment on function public.live_stream_init(uuid, uuid) is
    'Host-only. Sets live_streams.category_id on a freshly started stream and creates its live_stream_runtime row. Idempotent - safe to call again on reconnect. Returns the canonical live_streams row.';


-- 8.2 live_stream_heartbeat ------------------------------------------------------------
-- The broadcaster app MUST call this every 30 seconds while publishing. The abandoned-
-- stream sweeper (8.7) ends a stream after 2 minutes of silence = 4 missed heartbeats,
-- so a longer interval would get healthy streams killed.
-- This is the ONLY per-tick write and it touches a single runtime row - never live_streams.
create or replace function public.live_stream_heartbeat(p_live_stream_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid  uuid := auth.uid();
    v_host uuid;
begin
    if v_uid is null then
        raise exception 'live_stream_heartbeat: authentication required'
            using errcode = '28000';
    end if;

    select ls.host_user_id into v_host
    from public.live_streams ls
    where ls.id = p_live_stream_id and ls.status = 'live';

    if not found or v_host is distinct from v_uid then
        -- Silently ignore: a stale timer firing after the stream ended is normal and must
        -- never surface as an error in the broadcasting UI.
        return;
    end if;

    insert into public.live_stream_runtime as rt (live_stream_id, host_last_seen_at)
    values (p_live_stream_id, now())
    on conflict (live_stream_id) do update
        set host_last_seen_at = now(),
            updated_at        = now();
end;
$$;

comment on function public.live_stream_heartbeat(uuid) is
    'Broadcaster liveness ping - call every 30 seconds while publishing (the sweeper ends a stream after 2 minutes = 4 missed heartbeats). Writes only live_stream_runtime.host_last_seen_at, which feeds live_stream_force_end_abandoned(). No-ops silently once the stream is no longer live.';


-- 8.3 live_stream_join -----------------------------------------------------------------
-- Opens a viewer session, closes any stale open session for the same (stream, identity),
-- and maintains the concurrency counters. Returns the new session id, which the client
-- holds in memory and passes back to live_stream_leave().
create or replace function public.live_stream_join(
    p_live_stream_id uuid,
    p_guest_key      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid       uuid := auth.uid();
    v_guest_key text := nullif(btrim(coalesce(p_guest_key, '')), '');
    v_status    text;
    v_closed    integer := 0;
    v_delta     integer;
    v_current   bigint;
    v_session   uuid;
begin
    -- FOR KEY SHARE closes the join-vs-end race: live_stream_end_internal() takes FOR UPDATE
    -- on this row, which conflicts with KEY SHARE. So a join that is mid-flight when the host
    -- ends the stream makes the end wait until the join commits (and the end then closes
    -- that new session too), and a join that arrives after the end re-reads the row, sees
    -- 'ended' and is refused. Without it, a join racing an end could leave a session open
    -- forever on an ended stream.
    -- KEY SHARE (not SHARE) on purpose: later in this function the join UPDATEs this same
    -- row's peak_concurrent_viewers, which takes FOR NO KEY UPDATE. NO KEY UPDATE does not
    -- conflict with other joins' KEY SHARE, whereas plain SHARE would let two simultaneous
    -- joins deadlock on each other at that UPDATE.
    select ls.status into v_status
    from public.live_streams ls
    where ls.id = p_live_stream_id
    for key share;

    if not found then
        raise exception 'live_stream_join: stream % not found', p_live_stream_id
            using errcode = 'P0002';
    end if;

    if v_status is distinct from 'live' then
        raise exception 'live_stream_join: stream % is not live', p_live_stream_id
            using errcode = 'P0001';
    end if;

    if v_uid is null then
        -- GUEST VIEWING. Fall back to a per-session random key so the call never fails;
        -- unique_viewers is only accurate when the client persists one stable key.
        -- To switch LukuLuku to "must be logged in to watch", simply run:
        --   revoke execute on function public.live_stream_join(uuid, text) from anon;
        v_guest_key := coalesce(v_guest_key, gen_random_uuid()::text);
    else
        v_guest_key := null;   -- identity always wins over the device key
    end if;

    -- Close any session this identity left open on this stream (app crash, hard kill,
    -- missed leave call). The UPDATE takes row locks, so a concurrent join of the same
    -- identity serialises behind it.
    update public.live_stream_viewer_sessions s
       set left_at          = now(),
           duration_seconds = greatest(0, floor(extract(epoch from (now() - s.joined_at)))::integer),
           leave_reason     = 'connection_lost'::public.live_viewer_leave_reason
     where s.live_stream_id = p_live_stream_id
       and s.left_at is null
       and ((v_uid is not null and s.viewer_user_id = v_uid)
         or (v_uid is null and s.viewer_user_id is null and s.guest_key = v_guest_key));
    get diagnostics v_closed = row_count;

    begin
        insert into public.live_stream_viewer_sessions (live_stream_id, viewer_user_id, guest_key)
        values (p_live_stream_id, v_uid, v_guest_key)
        returning id into v_session;
    exception when unique_violation then
        -- Another transaction opened a session for the same identity a moment ago and
        -- committed first. Reuse it instead of erroring at the viewer, and undo the
        -- stale-close decrement we owe (the winning transaction already counted itself).
        select s.id into v_session
        from public.live_stream_viewer_sessions s
        where s.live_stream_id = p_live_stream_id
          and s.left_at is null
          and ((v_uid is not null and s.viewer_user_id = v_uid)
            or (v_uid is null and s.viewer_user_id is null and s.guest_key = v_guest_key))
        limit 1;

        if v_closed > 0 then
            update public.live_stream_runtime rt
               set current_concurrent_viewers = greatest(rt.current_concurrent_viewers - v_closed, 0),
                   updated_at                 = now()
             where rt.live_stream_id = p_live_stream_id;
        end if;
        return v_session;
    end;

    v_delta := 1 - v_closed;

    -- ---------------------------------------------------------------------------------
    -- CONCURRENCY - DO NOT "SIMPLIFY" THIS INTO ONE STATEMENT AGAIN.
    -- The live counter and the peak now live on two different tables, so the read-modify-
    -- write can no longer be a single atomic UPSERT. Correctness comes from step 1: this
    -- INSERT ... ON CONFLICT DO UPDATE takes an exclusive lock on the runtime row and
    -- HOLDS IT UNTIL COMMIT. Any other transaction joining the same stream blocks there,
    -- so it can only read the counter after ours is committed. Two simultaneous joins
    -- therefore serialise and no peak update can ever be lost.
    -- Step 2 must stay AFTER step 1 and inside the same transaction.
    --
    -- TOTAL VIEWS (running): this point is reached ONLY when a NEW session row was
    -- inserted above (the unique_violation reuse path returned early), so the same upsert
    -- adds exactly 1 to total_views_live. It therefore always equals the number of session
    -- rows = the final live_streams.total_views that live_stream_end_internal() computes.
    -- A brand-new runtime row starts at 1 (this join is its first view).
    -- ---------------------------------------------------------------------------------
    insert into public.live_stream_runtime as rt (live_stream_id, current_concurrent_viewers, total_views_live)
    values (p_live_stream_id, greatest(v_delta, 0), 1)
    on conflict (live_stream_id) do update
        set current_concurrent_viewers = greatest(rt.current_concurrent_viewers + v_delta, 0),
            total_views_live           = rt.total_views_live + 1,
            updated_at                 = now()
    returning rt.current_concurrent_viewers into v_current;

    update public.live_streams ls
       set peak_concurrent_viewers = greatest(ls.peak_concurrent_viewers, v_current)
     where ls.id = p_live_stream_id
       and ls.peak_concurrent_viewers < v_current;

    return v_session;
end;
$$;

comment on function public.live_stream_join(uuid, text) is
    'Opens a viewer watch session on a live stream and returns its id. Closes any stale open session for the same viewer first, increments live_stream_runtime.current_concurrent_viewers and (only when a new session row was created) live_stream_runtime.total_views_live in one upsert, then raises live_streams.peak_concurrent_viewers to that value. The runtime row lock taken in step one is what makes the two-table peak update race-free. Callable by guests (auth.uid() IS NULL) - pass a stable device key so guests are not double-counted.';


-- 8.4 live_stream_leave ----------------------------------------------------------------
create or replace function public.live_stream_leave(
    p_session_id   uuid,
    p_leave_reason public.live_viewer_leave_reason default 'manual_exit'
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid    uuid := auth.uid();
    v_owner  uuid;
    v_stream uuid;
    v_open   boolean;
begin
    select s.viewer_user_id, s.live_stream_id, (s.left_at is null)
      into v_owner, v_stream, v_open
    from public.live_stream_viewer_sessions s
    where s.id = p_session_id
    for update;

    if not found then
        return false;                      -- unknown id: nothing to do, not an error
    end if;

    -- A session owned by a signed-in user may only be closed by that user (or an admin).
    -- A guest session is bearer-authenticated by its own uuid, which only that client has.
    if v_owner is not null
       and v_owner is distinct from v_uid
       and not public.has_role(v_uid, 'admin'::public.app_role) then
        raise exception 'live_stream_leave: not your session'
            using errcode = '42501';
    end if;

    if not v_open then
        return false;                      -- already closed (double leave / stream ended)
    end if;

    update public.live_stream_viewer_sessions s
       set left_at          = now(),
           duration_seconds = greatest(0, floor(extract(epoch from (now() - s.joined_at)))::integer),
           leave_reason     = p_leave_reason
     where s.id = p_session_id;

    update public.live_stream_runtime rt
       set current_concurrent_viewers = greatest(rt.current_concurrent_viewers - 1, 0),
           updated_at                 = now()
     where rt.live_stream_id = v_stream;

    return true;
end;
$$;

comment on function public.live_stream_leave(uuid, public.live_viewer_leave_reason) is
    'Closes one viewer watch session (left_at, duration_seconds, leave_reason) and decrements live_stream_runtime.current_concurrent_viewers. Returns false if the session is unknown or already closed - safe to call twice.';


-- 8.5 live_stream_end_internal (PRIVATE - no auth check, never granted to clients) ------
-- The shared body behind live_stream_end() (host/admin initiated),
-- live_stream_force_end_abandoned() (cron initiated, no auth.uid() at all) and, from
-- migration 05, stream_mod_ban() (banning a broadcaster ends their running stream with
-- end_reason 'moderation_ban'). All callers are SECURITY DEFINER, so they run as the
-- function owner and may execute this.
create or replace function public.live_stream_end_internal(
    p_live_stream_id uuid,
    p_end_reason     public.live_stream_end_reason
)
returns public.live_streams
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_status   text;
    v_started  timestamptz;
    v_ended    timestamptz;
    v_was_live boolean;
    v_total    bigint;
    v_unique   bigint;
    v_row      public.live_streams;
begin
    select ls.status, ls.started_at, ls.ended_at
      into v_status, v_started, v_ended
    from public.live_streams ls
    where ls.id = p_live_stream_id
    for update;

    if not found then
        raise exception 'live_stream_end: stream % not found', p_live_stream_id
            using errcode = 'P0002';
    end if;

    v_was_live := v_status is distinct from 'ended';
    v_ended    := coalesce(v_ended, now());

    -- Force-close every still-open viewer session on this stream.
    update public.live_stream_viewer_sessions s
       set left_at          = v_ended,
           duration_seconds = greatest(0, floor(extract(epoch from (v_ended - s.joined_at)))::integer),
           leave_reason     = 'stream_ended'::public.live_viewer_leave_reason
     where s.live_stream_id = p_live_stream_id
       and s.left_at is null;

    -- Final aggregates. Guests count as unique by device key, signed-in viewers by uid.
    -- ('u:' || NULL) is NULL in Postgres, so COALESCE picks the guest branch correctly.
    select count(*),
           count(distinct coalesce('u:' || s.viewer_user_id::text, 'g:' || s.guest_key))
      into v_total, v_unique
    from public.live_stream_viewer_sessions s
    where s.live_stream_id = p_live_stream_id;

    -- One UPDATE, one table: status, timing, reason and all three cached metrics.
    update public.live_streams ls
       set status                  = 'ended',
           ended_at                = v_ended,
           end_reason              = case when v_was_live
                                          then p_end_reason
                                          else coalesce(ls.end_reason, p_end_reason)
                                     end,
           duration_seconds        = greatest(0, floor(extract(epoch from (v_ended - coalesce(v_started, v_ended))))::integer),
           total_views             = v_total,
           unique_viewers          = v_unique
     where ls.id = p_live_stream_id
    returning ls.* into v_row;

    -- Zero the live counter and reconcile the running total-views counter to the exact
    -- final count, so the runtime row and live_streams.total_views always agree once ended.
    update public.live_stream_runtime rt
       set current_concurrent_viewers = 0,
           total_views_live           = v_total,
           updated_at                 = now()
     where rt.live_stream_id = p_live_stream_id;

    -- LK BATTLE HOOK (migration 03). A broadcaster leaving must close any battle their
    -- stream is part of: co-host gone -> host wins, host gone -> decided by current
    -- score, open invite -> cancelled / expired (see lk_battle_on_stream_ended).
    -- * Placed HERE, inside the one shared end path, so it fires for EVERY way a stream
    --   ends: host end and admin/moderator end (live_stream_end), moderation ban
    --   (stream_mod_ban, file 05) and the abandoned-stream sweeper
    --   (live_stream_force_end_abandoned).
    -- * Only when the stream was actually live at call time (v_was_live), so re-ending
    --   an already-ended stream does nothing new.
    -- * DYNAMIC on purpose: file 03 runs AFTER this file. A static call would make
    --   every stream end fail with "function does not exist" whenever file 03 is not
    --   applied yet (or has been rolled back). to_regprocedure() returns NULL when the
    --   function is missing, and the call is then skipped — no hard dependency.
    -- * The hook is SECURITY DEFINER and granted to no client role; it runs as the
    --   function owner (the same role that owns this function).
    if v_was_live and to_regprocedure('public.lk_battle_on_stream_ended(uuid)') is not null then
        execute 'select public.lk_battle_on_stream_ended($1)' using p_live_stream_id;
    end if;

    -- CO-HOSTING HOOK (migration 03, user approved 2026-09-11). A stream that ends must
    -- also break its co-host link: live session -> ended (host_left / cohost_left, the
    -- partner simply continues solo), open co-host invite -> cancelled / expired (see
    -- live_cohost_on_stream_ended).
    -- * Deliberately AFTER the battle hook above: if the two streams were battling inside
    --   the co-hosting, the battle is closed first by the battle rules (co-host gone ->
    --   host wins, ...) and only then the co-host session ends.
    -- * Same guards as the battle hook: only when the stream was actually live, and
    --   DYNAMIC via to_regprocedure() so there is no hard dependency on file 03.
    if v_was_live and to_regprocedure('public.live_cohost_on_stream_ended(uuid)') is not null then
        execute 'select public.live_cohost_on_stream_ended($1)' using p_live_stream_id;
    end if;

    return v_row;
end;
$$;

comment on function public.live_stream_end_internal(uuid, public.live_stream_end_reason) is
    'PRIVATE. Performs the end-of-broadcast work with NO permission check: force-closes open viewer sessions (leave_reason=stream_ended), computes total_views / unique_viewers / duration_seconds and writes them plus status/ended_at/end_reason onto live_streams in one UPDATE, zeroes the runtime viewer counter and sets live_stream_runtime.total_views_live to the same exact total_views (reconciling any drift). Idempotent; re-ending keeps the original end_reason. Only callable from SECURITY DEFINER wrappers (live_stream_end, live_stream_force_end_abandoned, and stream_mod_ban from migration 05) - never granted to anon/authenticated.';


-- 8.6 live_stream_end ------------------------------------------------------------------
-- Host-or-admin entry point. SECURITY DEFINER, so an admin can stop someone else's stream
-- even before section 4.4's staff UPDATE policy is consulted.
create or replace function public.live_stream_end(
    p_live_stream_id uuid,
    p_end_reason     public.live_stream_end_reason default 'broadcaster_ended'
)
returns public.live_streams
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid  uuid := auth.uid();
    v_host uuid;
begin
    if v_uid is null then
        raise exception 'live_stream_end: authentication required'
            using errcode = '28000';
    end if;

    select ls.host_user_id into v_host
    from public.live_streams ls
    where ls.id = p_live_stream_id;

    if not found then
        raise exception 'live_stream_end: stream % not found', p_live_stream_id
            using errcode = 'P0002';
    end if;

    if v_host is distinct from v_uid
       and not public.has_role(v_uid, 'admin'::public.app_role)
       and not public.has_role(v_uid, 'moderator'::public.app_role) then
        raise exception 'live_stream_end: only the host, an admin or a moderator may end this stream'
            using errcode = '42501';
    end if;

    return public.live_stream_end_internal(p_live_stream_id, p_end_reason);
end;
$$;

comment on function public.live_stream_end(uuid, public.live_stream_end_reason) is
    'Host / admin / moderator. Ends a broadcast and returns the finished live_streams row for the broadcaster summary screen (duration, total views, unique viewers, peak concurrent). Idempotent.';


-- 8.7 live_stream_force_end_abandoned --------------------------------------------------
-- Spec item 8: a broadcaster who disconnects and never returns must not leave a stream
-- "live" forever with a dead ZegoCloud room.
-- TIMING (user approved 2026-09-10):
--   * the broadcaster sends a heartbeat every 30 seconds (8.2);
--   * a stream is "abandoned" after 2 minutes without one = 4 missed heartbeats, which
--     rides out a short network blip or an app switch without killing a healthy stream;
--   * the pg_cron sweeper (section 10) runs every minute, so a dead stream is closed
--     within ~2-3 minutes of its broadcaster going away.
-- Changing only the DEFAULT value of an existing parameter is allowed by CREATE OR
-- REPLACE (same type, same parameter list), so no drop is needed on a re-run.
create or replace function public.live_stream_force_end_abandoned(
    p_timeout_minutes integer default 2
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_uid    uuid := auth.uid();
    v_cutoff timestamptz;
    v_id     uuid;
    v_count  integer := 0;
begin
    -- auth.uid() IS NULL means service_role / pg_cron / psql, which is the intended caller.
    if v_uid is not null and not public.has_role(v_uid, 'admin'::public.app_role) then
        raise exception 'live_stream_force_end_abandoned: admin or service role required'
            using errcode = '42501';
    end if;

    if p_timeout_minutes is null or p_timeout_minutes < 1 then
        p_timeout_minutes := 2;   -- keep in step with the default above
    end if;
    v_cutoff := now() - make_interval(mins => p_timeout_minutes);

    -- ONLY streams whose broadcaster has opted into heartbeats are ever swept.
    -- The website also creates live_streams rows, but it never calls live_stream_init()
    -- or live_stream_heartbeat(), so its streams have no host_last_seen_at. Sweeping on
    -- started_at (or on "no runtime row") would end every website broadcast ~2 minutes
    -- after it began, and would flip every legacy "live" row in production to 'ended' on
    -- the first run — breaking existing site behaviour, which CLAUDE.md forbids.
    -- A runtime row alone is NOT proof of opt-in either: live_stream_join() creates one
    -- (with host_last_seen_at NULL) when a mobile viewer joins a website stream. So the
    -- test is "host_last_seen_at IS NOT NULL", which only live_stream_init() and
    -- live_stream_heartbeat() — i.e. the mobile broadcaster — ever set.
    -- Known limit: a mobile broadcaster whose app dies between creating the stream row
    -- and its first live_stream_init()/heartbeat call is never swept; the app calls
    -- live_stream_init() immediately after the insert, so that window is milliseconds.
    for v_id in
        select ls.id
        from public.live_streams ls
        join public.live_stream_runtime rt on rt.live_stream_id = ls.id
        where ls.status = 'live'
          and rt.host_last_seen_at is not null
          and rt.host_last_seen_at < v_cutoff
        order by ls.started_at
    loop
        perform public.live_stream_end_internal(
            v_id, 'disconnected'::public.live_stream_end_reason
        );
        v_count := v_count + 1;
    end loop;

    return v_count;
end;
$$;

comment on function public.live_stream_force_end_abandoned(integer) is
    'Sweeper for spec item 8. Ends every stream still marked live whose broadcaster heartbeat (live_stream_runtime.host_last_seen_at, falling back to live_streams.started_at) is older than p_timeout_minutes (default 2 = 4 missed 30-second heartbeats), with end_reason=disconnected. Run every minute by the pg_cron job lk_live_force_end_abandoned, so a dead stream closes within ~2-3 minutes. NOT for the mobile client. Returns how many streams it closed.';


-- -------------------------------------------------------------------------------------
-- 9. FUNCTION GRANTS
-- -------------------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC by default, so every function is explicitly revoked
-- first and then granted only to the roles that should have it.

-- SECURITY: Supabase grants EXECUTE on every new public function to anon, authenticated and
-- service_role through ALTER DEFAULT PRIVILEGES. "revoke ... from public" alone does NOT remove
-- those explicit role grants, so every revoke below names anon and authenticated too; the grants
-- that follow re-open only what clients are meant to call. Do not shorten these back to "from public".
revoke all on function public.live_stream_init(uuid, uuid)                                    from public, anon, authenticated;
revoke all on function public.live_stream_heartbeat(uuid)                                     from public, anon, authenticated;
revoke all on function public.live_stream_join(uuid, text)                                    from public, anon, authenticated;
revoke all on function public.live_stream_leave(uuid, public.live_viewer_leave_reason)        from public, anon, authenticated;
revoke all on function public.live_stream_end(uuid, public.live_stream_end_reason)            from public, anon, authenticated;
revoke all on function public.live_stream_end_internal(uuid, public.live_stream_end_reason)   from public, anon, authenticated;
revoke all on function public.live_stream_force_end_abandoned(integer)                        from public, anon, authenticated;

grant execute on function public.live_stream_init(uuid, uuid)                                 to authenticated;
grant execute on function public.live_stream_heartbeat(uuid)                                  to authenticated;
grant execute on function public.live_stream_join(uuid, text)                                 to authenticated, anon;
grant execute on function public.live_stream_leave(uuid, public.live_viewer_leave_reason)     to authenticated, anon;
grant execute on function public.live_stream_end(uuid, public.live_stream_end_reason)         to authenticated;
grant execute on function public.live_stream_force_end_abandoned(integer)                     to service_role;
-- live_stream_end_internal is granted to NOBODY on purpose. It is reachable only from
-- SECURITY DEFINER wrappers owned by the same role (live_stream_end and
-- live_stream_force_end_abandoned above, stream_mod_ban in migration 05), which execute
-- as the function owner.


-- -------------------------------------------------------------------------------------
-- 10. SCHEDULING - automatic force-end of abandoned streams
-- -------------------------------------------------------------------------------------
-- *** USER APPROVED 2026-09-10 *** : switch the sweeper ON, every minute, 2-minute timeout.
--
-- What it does: every minute pg_cron runs live_stream_force_end_abandoned(2), which ends
-- any stream still marked 'live' whose broadcaster has not sent a heartbeat for 2 minutes.
--
-- Security: pg_cron runs the job as the role that scheduled it (the SQL Editor's
-- `postgres` role, which also owns the function - so the REVOKE FROM PUBLIC in section 9
-- does not block it). The job carries no JWT, so auth.uid() is NULL inside the function,
-- which the function explicitly allows (see its first check in 8.7).
--
-- Idempotent: any existing job with the same name is unscheduled first, then created
-- again, so re-running this file never produces duplicate jobs. The earlier draft of this
-- file suggested scheduling the same sweep by hand under the name
-- 'live-stream-force-end-abandoned'; if someone did that, it is removed too so the sweep
-- never runs twice a minute.
-- If pg_cron is not installed the block does nothing except raise a NOTICE.
--
-- Check it is scheduled :  select * from cron.job;
-- See recent runs       :  select * from cron.job_run_details order by start_time desc limit 20;
-- Turn it off           :  select cron.unschedule('lk_live_force_end_abandoned');
do $lk_cron$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.unschedule(j.jobid)
           from cron.job j
          where j.jobname in ('lk_live_force_end_abandoned',
                              'live-stream-force-end-abandoned');   -- old hand-run draft name

        perform cron.schedule(
            'lk_live_force_end_abandoned',
            '* * * * *',                                            -- every minute
            $cmd$select public.live_stream_force_end_abandoned(2);$cmd$
        );
    else
        raise notice 'pg_cron is not installed: job lk_live_force_end_abandoned was NOT scheduled. Abandoned streams will stay "live" until pg_cron is enabled and this file is re-run (or live_stream_force_end_abandoned() is called some other way).';
    end if;
end $lk_cron$;


commit;


-- =====================================================================================
-- ROLLBACK (manual) - run top to bottom. Uncomment only if you really mean it.
-- =====================================================================================
-- begin;
--
-- -- ---- 10.1 New objects created by this migration --------------------------------
-- select cron.unschedule('lk_live_force_end_abandoned');   -- stop the sweeper first (user-approved job, section 10)
-- drop function if exists public.live_stream_force_end_abandoned(integer);
-- drop function if exists public.live_stream_end(uuid, public.live_stream_end_reason);
-- drop function if exists public.live_stream_end_internal(uuid, public.live_stream_end_reason);
-- drop function if exists public.live_stream_leave(uuid, public.live_viewer_leave_reason);
-- drop function if exists public.live_stream_join(uuid, text);
-- drop function if exists public.live_stream_heartbeat(uuid);
-- drop function if exists public.live_stream_init(uuid, uuid);
-- drop table if exists public.live_stream_viewer_sessions;
-- drop table if exists public.live_stream_runtime;          -- also drops total_views_live + its CHECK
-- --   Partial alternative (undo ONLY the running total-views counter, keep the table):
-- --   the functions above must be re-created from a version of this file without it first.
-- -- alter table public.live_stream_runtime drop constraint if exists live_stream_runtime_total_views_live_check;
-- -- alter table public.live_stream_runtime drop column     if exists total_views_live;
--
-- -- ---- 10.2 REVERSING THE PERMISSION-GRANTED CHANGE TO public.live_streams --------
-- -- *** DESTRUCTIVE ***  These drops delete every live-stream metric permanently.
-- -- Section 4 was approved by the user on 2026-09-10; undo it only on their say-so.
-- -- Order matters: policies, then indexes, then constraints, then columns, then the
-- -- reference table the FK points at.
-- drop policy if exists "Admins and moderators can update any live stream" on public.live_streams;
-- drop policy if exists "Admins and moderators can view all live streams"  on public.live_streams;
-- --   (the four ORIGINAL host-scoped policies were never touched and stay as they are)
-- drop index if exists public.idx_live_streams_zego_room;
-- drop index if exists public.idx_live_streams_live_by_category;
-- drop index if exists public.idx_live_streams_channel;
-- drop index if exists public.idx_live_streams_host_started;
-- drop index if exists public.idx_live_streams_status_started;
-- alter table public.live_streams drop constraint if exists live_streams_peak_viewers_check;
-- alter table public.live_streams drop constraint if exists live_streams_unique_viewers_check;
-- alter table public.live_streams drop constraint if exists live_streams_total_views_check;
-- alter table public.live_streams drop constraint if exists live_streams_duration_seconds_check;
-- alter table public.live_streams drop constraint if exists live_streams_category_id_fkey;
-- alter table public.live_streams
--     drop column if exists peak_concurrent_viewers,
--     drop column if exists unique_viewers,
--     drop column if exists total_views,
--     drop column if exists duration_seconds,
--     drop column if exists end_reason,
--     drop column if exists category_id;
-- --   (`category`, `status`, `zego_room_id`, `started_at`, `ended_at`, `title`,
-- --    `host_user_id`, `channel_id`, `id` are original columns - do NOT drop them)
--
-- -- ---- 10.3 Reference table and types ---------------------------------------------
-- drop table if exists public.stream_categories;
-- drop type  if exists public.live_viewer_leave_reason;
-- drop type  if exists public.live_stream_end_reason;
-- commit;
