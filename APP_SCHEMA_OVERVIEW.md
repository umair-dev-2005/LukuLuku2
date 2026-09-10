# LukuLuku — Mobile App Database Context

| | |
|---|---|
| **Generated** | 2026-09-11 |
| **Source dump** | `supabase/lukuluku_public_schema_dump.sql` (3072 lines, dumped 2026-09-09 15:25 UTC from live DB, PostgreSQL 17.6) — **predates the live-streaming migrations** |
| **Live-streaming schema** | Included. Migrations `supabase/migrations/20260910_01_live_streaming_core.sql` … `20260910_06_engagement_shares_deeplinks.sql`, run in order 01→06 in the Supabase SQL Editor and **applied successfully 2026-09-11**. Documented from those files (they are exactly what ran). |
| **Tables in `public`** | 70 total → **46 documented** (19 APP-USED + 4 SHARED + 23 LIVE STREAMING), 24 excluded as web/admin-only |
| **Views in `public`** | 3 total → 2 documented (`public_ads_active`, `broadcaster_public_points`), 1 excluded (`creator_stats`) |
| **Classification signal** | `.from('…')` / `.rpc('…')` / `storage.from('…')` grep across all RN `.ts`/`.tsx`, then FK + RPC-dependency analysis |

Read-only reference. Contains no migration or `ALTER` statements — it describes the resulting state only.
Pre-existing objects are documented from the dump above; everything created or changed by live-streaming
migrations 01–06 is documented from the migration files. If the dump is regenerated, re-verify this file against it.

---

## Architecture Overview

Auth is the root of everything: a Supabase session UID (`auth.uid()`) is the app's only identity key
(`lib/auth.ts`, `resolveExistingUserId` returns `user.id` verbatim — no fuzzy matching). On first
insert into `auth.users`, the `on_auth_user_created` trigger creates a `profiles` row; `lib/auth.ts`
also does this defensively via `ensureSupabaseProfile`, then `ensureChannelExists` inserts the
user's one `channels` row (`channels.user_id` is UNIQUE — strictly one channel per user).
`FOUNDER_ENTITLED_USER_IDS` patches monetization columns on `profiles` at every login.

Content hangs off `channels`: `videos` (canonical shape = `Video` in `lib/supabase.ts:248`) and
`shorts` (`Short`, line 265). Momenti are written to `shorts`, and the `sync_short_to_video` trigger
mirrors every row into `videos` with `is_short = true` **sharing the same `id`** — so momenti exist
twice and any aggregate must dedupe (see `fetchLeaderboard`, `lib/supabase.ts:131-142`). Publishing a
long-form video fires `auto_promote_video`, which auto-inserts a `community_posts` row (`CommunityPost`,
line 292) — that is why the Bangi feed contains machine-made posts (`auto_generated = true`).

Social interactions are per-user child tables: `tapins` (follow, `TapIn` line 355), `video_likes`
(`VideoLike` line 316), `post_likes` (`PostLike` line 309), `comments` (`Comment` line 280),
`video_reactions` (`VideoReaction` line 335), `video_responses` (`VideoResponse` line 324). **Almost
all of these are SELECT-restricted to `auth.uid() = user_id`**, so a client can never count other
users' rows — hence the denormalized counters (`channels.tapiners`, `videos.likes`, `comments.likes`)
and the client-side aggregation in `lib/supabase.ts`. Triggers `notify_on_comment`, `notify_on_tapin`
and `notify_tapiners_on_new_video` fan out into `notifications`.

Money: `wallets` holds one balance row per user; payouts go exclusively through the
`create_withdrawal` RPC (SECURITY DEFINER — debits the wallet and inserts `wallet_withdrawals`
atomically; a direct client INSERT would bypass the balance check). `channel_tips` and
`channel_memberships`/`channel_members` are the channel-level monetization surfaces.

Live streaming (mobile app only — the website does not run it; see *LIVE STREAMING* below) runs its
video on the **ZegoCloud low-level SDK**; the database only holds state. `live_streams` stays **one row
per broadcast** — a pre-existing table, extended add-only (metric columns, indexes, two staff policies,
one banned-host trigger); the host still inserts the row directly and then calls `live_stream_init`.
Everything that changes on every join/leave/tap/message lives in **hot side tables** —
`live_stream_runtime` (live viewers, running views, heartbeat), `live_stream_reaction_counts`,
`live_stream_chat_counts` — so the discovery table never churns. **Chat messages are never stored**:
each message passes the server gate `stream_mod_chat_gate()` (mute/kick/ban, profanity block, slow
mode), which increments the chat count and returns an **HMAC-signed** envelope (Vault key) for the
relay to broadcast; only the text of a *reported* message is kept, inside `stream_reports`. The
**coin/points economy** (`viewer_wallets`, `gift_transactions`, `broadcaster_earnings`) is completely
separate from the SRD cash `wallets` — no bridge between them exists yet. **LK battles and co-hosting**
both pair two already-live streams and share one guard (`lk_battles_assert_single_active()`): one active
pairing per stream, except a battle fought inside its own live co-host session. Every money and
moderation write goes through **SECURITY DEFINER RPCs**; those tables have no client write policy.

---

# APP-USED TABLES

Referenced directly by React Native code.

---

## public.profiles

Canonical TS shape: `Profile` (`lib/supabase.ts:202`). Read/written by `lib/auth.ts`, `ProfileScreen`,
`SearchScreen`, `HomeScreen`, `ShortsScreen`, `BangiPostScreen`, `VideoPlayerScreen`,
`NotificationsScreen`, `ChannelScreen`, `VideoCard`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| display_name | text | NULL | — |
| username | text | NULL | — |
| avatar_url | text | NULL | — |
| bio | text | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| verification_type | text | NULL | `'none'` |
| is_admin | boolean | NULL | `false` |
| is_founder_team | boolean | NULL | `false` |
| is_monetized | boolean | NULL | `false` |
| standard_share_pct | numeric | NULL | `70.00` |
| bonus_share_pct | numeric | NULL | `0.00` |
| is_verified | boolean | NULL | `false` |
| notify_telegram | boolean | NOT NULL | `true` |
| notify_push | boolean | NOT NULL | `true` |
| notify_new_video_from_tapins | boolean | NOT NULL | `true` |

**CHECK:** `verification_type IN ('none','default','music','business_politics','film')`

**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` · UNIQUE `(user_id)`, UNIQUE `(username)`
**Referenced by:** `comments.user_id → profiles.user_id`
**Indexes:** `profiles_pkey (id)`, `profiles_user_id_key (user_id)`, `profiles_username_key (username)`

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
```
→ Any visitor, signed in or not, can read every profile row.

```sql
CREATE POLICY "Users can insert their own profile" ON public.profiles
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
```
→ You may only create a profile row for yourself.

```sql
CREATE POLICY "Admins can update verification status" ON public.profiles
    AS PERMISSIVE FOR UPDATE TO {public}
    USING (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::app_role)))) OR (auth.uid() = user_id)));
```
→ Admins (via a direct `user_roles` lookup, not `has_role()`) or the owner may update. Note: it has no `WITH CHECK`, so the privileged-column lock below is what actually constrains a self-update.

```sql
CREATE POLICY "Users can update their own profile safe" ON public.profiles
    AS PERMISSIVE FOR UPDATE TO {public}
    USING ((auth.uid() = user_id))
    WITH CHECK (((auth.uid() = user_id) AND (NOT (is_admin IS DISTINCT FROM ( SELECT p.is_admin
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (is_founder_team IS DISTINCT FROM ( SELECT p.is_founder_team
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (is_monetized IS DISTINCT FROM ( SELECT p.is_monetized
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (is_verified IS DISTINCT FROM ( SELECT p.is_verified
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (verification_type IS DISTINCT FROM ( SELECT p.verification_type
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (standard_share_pct IS DISTINCT FROM ( SELECT p.standard_share_pct
   FROM profiles p
  WHERE (p.user_id = auth.uid())))) AND (NOT (bonus_share_pct IS DISTINCT FROM ( SELECT p.bonus_share_pct
   FROM profiles p
  WHERE (p.user_id = auth.uid()))))));
```
→ You may edit your own profile but cannot change your own `is_admin`, `is_founder_team`, `is_monetized`, `is_verified`, `verification_type`, `standard_share_pct` or `bonus_share_pct` — each must stay equal to its stored value.

**Triggers:** `update_profiles_updated_at` BEFORE UPDATE → `update_updated_at_column()` (stamps `updated_at = now()`).
**Related:** `handle_new_user()` fires on `auth.users` INSERT and inserts the `profiles` row (display name from `raw_user_meta_data`, falling back to the email local-part).

---

## public.channels

Canonical TS shape: `Channel` (`lib/supabase.ts:235`). One row per user (UNIQUE `user_id`).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| name | text | NOT NULL | — |
| handle | text | NULL | — |
| description | text | NULL | — |
| avatar_url | text | NULL | — |
| banner_url | text | NULL | — |
| tapiners | integer | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| creator_boost | boolean | NOT NULL | `true` |
| creator_boost_until | timestamptz | NULL | `now() + '30 days'` |
| monetization_enabled | boolean | NOT NULL | `false` |

**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` · UNIQUE `(handle)`, UNIQUE `(user_id)`
**Referenced by (11 FKs):** `videos`, `shorts`, `community_posts`, `tapins`, `channel_tips`, `channel_memberships`, `channel_members`, `channel_social_links`, `playlists`, `live_streams`, `stream_moderators` (`ON DELETE CASCADE`, channel-scoped moderators — live-streaming migration 05)
**Indexes:** `channels_pkey (id)`, `channels_handle_key (handle)`, `channels_user_id_unique (user_id)`

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Channels are viewable by everyone" ON public.channels
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
```
→ All channels are publicly readable — this is why `tapiners` is usable as a public counter.

```sql
CREATE POLICY "Users can create their own channel" ON public.channels
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own channel" ON public.channels
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own channel" ON public.channels
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Create / update / delete are each restricted to the channel's own owner.

**Triggers:** `update_channels_updated_at` BEFORE UPDATE → `update_updated_at_column()`.
**Written indirectly by:** `tapins_sync_channel_count()` (recounts `tapiners`) and `update_channel_tapiners(p_channel_id)`.

---

## public.videos

Canonical TS shape: `Video` (`lib/supabase.ts:248`). The single most central content table (10 inbound FKs). Holds long-form video **and** a mirror of every `shorts` row (`is_short = true`, same `id`).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| channel_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| title | text | NOT NULL | — |
| description | text | NULL | — |
| thumbnail_url | text | NULL | — |
| video_url | text | NULL | — |
| duration | **text** | NULL | — |
| views | integer | NOT NULL | `0` |
| likes | integer | NOT NULL | `0` |
| dislikes | integer | NOT NULL | `0` |
| status | text | NOT NULL | `'draft'` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| is_short | boolean | NOT NULL | `false` |
| tags | text[] | NULL | `'{}'` |
| timestamps | text | NULL | — |
| premiere_at | timestamptz | NULL | — |
| thumbnail_test_status | text | NOT NULL | `'idle'` |
| thumbnail_winner_variant_id | uuid | NULL | — |
| ai_insights | jsonb | NULL | — |
| ai_insights_generated_at | timestamptz | NULL | — |

**CHECK:** `status IN ('draft','published','unlisted','private')`

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE`
**Referenced by (10 FKs):** `comments`, `community_posts` (`ON DELETE SET NULL`), `content_claims`, `notifications`, `video_likes`, `video_views`, `video_engagements`, `video_subtitles`, `video_thumbnail_variants`, `playlist_videos`
**Indexes:** `videos_pkey (id)` · `idx_video_type_date (is_short, created_at)` · `idx_videos_status_short_created (status, is_short, created_at DESC) WHERE status='published' AND is_short=false` · `idx_videos_tags` GIN `(tags)` · `videos_premiere_at_idx (premiere_at) WHERE premiere_at IS NOT NULL`

**RLS: ENABLED** (5 policies)

```sql
CREATE POLICY "Published videos are viewable by everyone" ON public.videos
    AS PERMISSIVE FOR SELECT TO {public}
    USING (((status = 'published'::text) OR (auth.uid() = user_id)));
```
→ Anyone can read published videos; drafts/private are visible only to their owner.

```sql
CREATE POLICY "Users can upload videos" ON public.videos
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own videos" ON public.videos
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Creators can update own videos" ON public.videos
    AS PERMISSIVE FOR UPDATE TO {public}
    USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own videos" ON public.videos
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Owner-only writes. Two overlapping UPDATE policies exist (duplicate rules, same effect).

**Triggers:**
- `on_video_published` AFTER INSERT → `auto_promote_video()` — when `status='published'` and `is_short=false`, auto-inserts a `community_posts` row (`'🎬 ' || title`, `auto_generated=true`) unless one already exists for that `video_id`.
- `trg_notify_tapiners_on_new_video` AFTER INSERT OR UPDATE → `notify_tapiners_on_new_video()` — fans a `'new_video'` notification out to every tapiner who has `profiles.notify_new_video_from_tapins = true`; skips shorts and skips re-publishes.
- `update_videos_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.shorts

Canonical TS shape: `Short` (`lib/supabase.ts:265`). Momenti source table; mirrored into `videos`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| channel_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| title | text | NOT NULL | — |
| description | text | NULL | — |
| video_url | text | NULL | — |
| thumbnail_url | text | NULL | — |
| views | integer | NOT NULL | `0` |
| likes | integer | NOT NULL | `0` |
| dislikes | integer | NOT NULL | `0` |
| status | text | NOT NULL | `'published'` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE`
**No CHECK constraints** — unlike `videos`, `status` is unconstrained here.
**Indexes:** `shorts_pkey (id)` only.

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Published shorts viewable by everyone" ON public.shorts
    AS PERMISSIVE FOR SELECT TO {public}
    USING (((status = 'published'::text) OR (auth.uid() = user_id)));
CREATE POLICY "Users can upload shorts" ON public.shorts
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own shorts" ON public.shorts
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete own shorts" ON public.shorts
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Same shape as `videos`: published rows public, writes owner-only.

**Triggers:**
- `sync_short_to_video_trigger` AFTER INSERT OR UPDATE → `sync_short_to_video()` — upserts the row into `videos` **reusing the same `id`**, with `is_short=true`, `tags='{}'`, and `views/likes/dislikes = GREATEST(existing, new)` so mirrored counters never regress.
- `delete_synced_short_video_trigger` AFTER DELETE → `delete_synced_short_video()` — deletes `videos WHERE id = OLD.id AND is_short = true`.

> Consequence for any new aggregate: a momento is two rows. The app's dedupe key is
> `user_id|channel_id|video_url|title|thumbnail_url` (`lib/supabase.ts:138`).

---

## public.community_posts

Canonical TS shape: `CommunityPost` (`lib/supabase.ts:292`). The "Bangi" feed.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| channel_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| content | text | NOT NULL | — |
| image_url | text | NULL | — |
| likes | integer | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| video_id | uuid | NULL | — |
| auto_generated | boolean | NOT NULL | `false` |
| background_color | text | NULL | — |
| text_color | text | NULL | — |
| background_style | text | NULL | — |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE` · FK `video_id → videos(id) ON DELETE SET NULL`
**Referenced by:** `comments.post_id`, `post_likes.post_id`
**Indexes:** `community_posts_pkey (id)` only — no index on `channel_id` or `created_at` despite the feed ordering by them.

**RLS: ENABLED** (6 policies — three redundant pairs)

```sql
CREATE POLICY "Allow read posts" ON public.community_posts
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
CREATE POLICY "Community posts are viewable by everyone" ON public.community_posts
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
```
→ Every post is publicly readable (two identical policies).

```sql
CREATE POLICY "Allow insert posts" ON public.community_posts
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can create posts for their channels" ON public.community_posts
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
```
→ You may insert posts authored as yourself. Note: despite the second policy's name, **channel ownership is not checked** — only `user_id`.

```sql
CREATE POLICY "Users can update their own posts" ON public.community_posts
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own posts" ON public.community_posts
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Update/delete owner-only.

**Triggers:** `update_community_posts_updated_at` BEFORE UPDATE → `update_updated_at_column()`.
**Written indirectly by:** `auto_promote_video()` (from `videos`) and `increment_post_likes(post_id)` (bumps `likes`; **not** SECURITY DEFINER and has no `search_path` set).

---

## public.comments

Canonical TS shape: `Comment` (`lib/supabase.ts:280`). Serves video comments, post comments, and replies (self-FK).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| video_id | uuid | NULL | — |
| user_id | uuid | NOT NULL | — |
| content | text | NOT NULL | — |
| likes | integer | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| post_id | uuid | NULL | — |
| parent_id | uuid | NULL | — |

**Keys:** PK `(id)` · FK `video_id → videos(id) ON DELETE CASCADE` · FK `post_id → community_posts(id) ON DELETE CASCADE` · FK `parent_id → comments(id) ON DELETE CASCADE` · FK `user_id → **profiles(user_id)** ON DELETE CASCADE`
> `comments` is the **only** table whose `user_id` points at `profiles(user_id)` instead of `auth.users(id)`. A comment therefore cannot be inserted before the author's `profiles` row exists.

**Indexes:** `comments_pkey (id)` only — no index on `video_id` or `post_id`, though every comment read filters on one of them.
**No CHECK constraint** enforcing exactly one of `video_id` / `post_id`.

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Comments are viewable by everyone" ON public.comments
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
CREATE POLICY "Authenticated users can post comments" ON public.comments
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own comments" ON public.comments
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own comments" ON public.comments
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ All comments publicly readable; write/edit/delete restricted to the author.
> Comments are the one interaction table with a public SELECT — likes/reactions/tapins are all owner-only.

**Triggers:** `trg_notify_on_comment` AFTER INSERT → `notify_on_comment()` — on video comments only (`video_id NOT NULL`), inserts a `'comment'` notification for the video owner (skipped when self-commenting); notification body is Dutch (`'Nieuwe reactie'`).

---

## public.post_likes

Canonical TS shape: `PostLike` (`lib/supabase.ts:309`).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| post_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| reaction_type | text | NOT NULL | `'like'` |

**Keys:** PK `(id)` · FK `post_id → community_posts(id) ON DELETE CASCADE` · UNIQUE `(post_id, user_id)`
> `user_id` has **no FK** to `auth.users`. `reaction_type` has **no CHECK** — any string is accepted.

**Indexes:** `post_likes_pkey (id)`, `post_likes_post_id_user_id_key (post_id, user_id)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view their own post likes" ON public.post_likes
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
```
→ **You can only read your own likes.** A client-side `count` of this table returns only your own rows — post like totals must come from `community_posts.likes` or the `post_like_counts(uuid[])` RPC.

```sql
CREATE POLICY "Users can insert own post likes" ON public.post_likes
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete own post likes" ON public.post_likes
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Like / unlike as yourself only.

**Triggers:** none — nothing syncs `post_likes` into `community_posts.likes`; the counter is bumped separately via `increment_post_likes()` or a direct update.

---

## public.video_likes

Canonical TS shape: `VideoLike` (`lib/supabase.ts:316`).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| video_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| like_type | text | NOT NULL | `'like'` |
| created_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `like_type IN ('like','heart')`
**Keys:** PK `(id)` · FK `video_id → videos(id) ON DELETE CASCADE` · UNIQUE `(video_id, user_id, like_type)`
> `user_id` has **no FK**. The UNIQUE includes `like_type`, so one user may hold both a `like` and a `heart` on the same video.

**Indexes:** `video_likes_pkey (id)`, `video_likes_video_id_user_id_like_type_key (video_id, user_id, like_type)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view their own video likes" ON public.video_likes
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
```
→ **Own likes only.** Public totals must come from `videos.likes` or the `video_like_counts(uuid[])` RPC.

```sql
CREATE POLICY "Users can insert their own likes" ON public.video_likes
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own likes" ON public.video_likes
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Like / unlike as yourself only.

**Triggers:** none — `videos.likes` is not maintained from this table.

---

## public.video_reactions

Canonical TS shape: `VideoReaction` (`lib/supabase.ts:335`). Timeline emoji reactions, used by `components/VideoInteractionLayers.tsx`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| video_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| emoji | text | NOT NULL | — |
| timestamp_seconds | integer | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` only — **no FKs at all**, no UNIQUE, no CHECK. `video_id` is not referentially enforced, so reaction rows survive video deletion.
**Indexes:** `video_reactions_pkey (id)`, `idx_video_reactions_video (video_id, timestamp_seconds)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view their own reactions" ON public.video_reactions
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users add own reactions" ON public.video_reactions
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users delete own reactions" ON public.video_reactions
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Own reactions only, in all three directions. There is **no UPDATE policy**, so reactions are immutable.
> A client cannot read other viewers' reactions. The `list_video_reactions(p_video_id)` RPC exists for aggregated reads.

**Triggers:** none.

---

## public.video_responses

Canonical TS shape: `VideoResponse` (`lib/supabase.ts:324`). Links a response/duet video to its source; used by `ShortsScreen`, `VideoPlayerScreen`, `VideoInteractionLayers`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| source_video_id | uuid | NOT NULL | — |
| source_kind | text | NOT NULL | `'video'` |
| response_video_id | uuid | NOT NULL | — |
| response_kind | text | NOT NULL | `'video'` |
| response_type | text | NOT NULL | `'response'` |
| user_id | uuid | NOT NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · UNIQUE `(source_video_id, response_video_id)` — **no FKs, no CHECKs.**
> `source_kind` / `response_kind` / `response_type` are free text in the DB; the TS union types (`'video'|'short'`, `'response'|'duet'`) are client-side only.

**Indexes:** `video_responses_pkey (id)`, `video_responses_source_idx (source_video_id)`, `video_responses_response_idx (response_video_id)`, `video_responses_source_video_id_response_video_id_key`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Responses viewable by everyone" ON public.video_responses
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
CREATE POLICY "Users can link own response video" ON public.video_responses
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can remove own response link" ON public.video_responses
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Links are publicly readable; only the linker can create or remove one. No UPDATE policy.

**Triggers:** none.

---

## public.tapins

Canonical TS shape: `TapIn` (`lib/supabase.ts:355`). LukuLuku's "follow".

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| channel_id | uuid | NOT NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE` · UNIQUE `(user_id, channel_id)`
**Indexes:** `tapins_pkey (id)`, `tapins_user_id_channel_id_key (user_id, channel_id)`, `unique_tapin_per_user_channel (user_id, channel_id)` — the last two are duplicates.

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view their own tapins" ON public.tapins
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
```
→ **You can only read your own tapins.** This is the specific reason `fetchLeaderboard` ranks by `channels.tapiners` instead of counting this table (`lib/supabase.ts:86-88`).

```sql
CREATE POLICY "Users can tapin" ON public.tapins
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can untapin" ON public.tapins
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = user_id));
```
→ Tap in / out as yourself only.

**Triggers:**
- `trg_tapins_sync_count` AFTER INSERT OR DELETE → `tapins_sync_channel_count()`:
  ```sql
  cid := COALESCE(NEW.channel_id, OLD.channel_id);
  IF cid IS NOT NULL THEN
    UPDATE public.channels SET tapiners = (SELECT count(*) FROM public.tapins WHERE channel_id = cid) WHERE id = cid;
  END IF;
  ```
  → Full recount into `channels.tapiners` on every change. This is the authoritative public follower count.
- `trg_notify_on_tapin` AFTER INSERT → `notify_on_tapin()` — inserts a `'tapin'` notification for the channel owner (skipped when tapping your own channel).

---

## public.notifications

Canonical TS shape: `Notification` (`lib/supabase.ts:344`) — **see drift note below.** Read by `NotificationsScreen`, written by `insertNotification` (`lib/supabase.ts:371`) and by three triggers.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NULL | — |
| actor_id | uuid | NULL | — |
| type | text | NULL | — |
| video_id | uuid | NULL | — |
| read | boolean | NULL | `false` |
| created_at | timestamptz | NULL | `timezone('utc', now())` |
| title | text | NULL | — |
| body | text | NULL | — |
| link | text | NULL | — |
| sent_telegram | boolean | NOT NULL | `false` |
| sent_push | boolean | NOT NULL | `false` |

**CHECK:** `type IS NULL OR type IN ('like','comment','system','new_video','tapin','mention','reply','post_like','follow')`
**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` · FK `actor_id → auth.users(id)` (no cascade) · FK `video_id → videos(id) ON DELETE CASCADE`
**Indexes:** `notifications_pkey (id)` only — no index on `user_id`, though every read filters on it.

> **Drift:** there is **no `post_id` column.** The `Notification` interface declares `post_id` and
> `insertNotification` sends it on every insert (`lib/supabase.ts:377`). PostgREST rejects unknown
> columns, so those inserts fail — and the failure is swallowed by `console.warn` (line 382). Post-like
> and reply notifications from the app therefore never persist; only the trigger-generated ones do.

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Users can see own notifications" ON public.notifications
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
```
→ You read only notifications addressed to you.

```sql
CREATE POLICY "Users can insert notifications as themselves" ON public.notifications
    AS PERMISSIVE FOR INSERT TO {authenticated} WITH CHECK ((auth.uid() = actor_id));
```
→ A signed-in user may create a notification for anyone, provided they name themselves as `actor_id`.

```sql
CREATE POLICY "Users can update own notifications" ON public.notifications
    AS PERMISSIVE FOR UPDATE TO {authenticated}
    USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete own notifications" ON public.notifications
    AS PERMISSIVE FOR DELETE TO {authenticated} USING ((auth.uid() = user_id));
```
→ Mark-as-read and delete are limited to the recipient.

**Triggers:** none on this table. Rows are inserted by `notify_on_comment()`, `notify_on_tapin()` and `notify_tapiners_on_new_video()` (all SECURITY DEFINER, so they bypass the INSERT policy above). Trigger-written `title`/`body` text is **Dutch**, not passed through `lib/i18n.ts`.

---

## public.wallets

Canonical TS shape: `WalletRow` (`lib/supabase.ts:32`). Read via `fetchWalletRow`; also touched by `ProfileScreen`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NULL | — |
| balance | numeric | NULL | `0` |
| created_at | timestamptz | NULL | `now()` |
| `"walletType"` | text | NULL | — |
| `"walletNumber"` | text | NULL | — |
| `"walletAddress"` | text | NULL | — |
| `"accountHolder"` | text | NULL | — |

> The last four are **quoted camelCase identifiers** — they must be double-quoted in raw SQL. No CHECK constrains `"walletType"`.

**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE`
**Indexes:** `wallets_pkey (id)`, `wallets_user_id_idx (user_id)` — UNIQUE, so one wallet per user (enforced by index, not by a table constraint).

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view own wallet" ON public.wallets
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own wallet" ON public.wallets
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own wallet" ON public.wallets
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
```
→ Fully private per user. **Note the UPDATE policy has no `WITH CHECK`** — a user can update their own `balance` directly; nothing at the RLS layer stops self-crediting. Balance debits are supposed to flow through `create_withdrawal()`.

**Triggers:** none. Balance is changed by `create_withdrawal()` (debit), `refund_failed_withdrawal()` (credit back) and `nowpayments_on_confirm()`.

---

## public.wallet_withdrawals

Canonical TS shape: `WithdrawalRow` (`lib/supabase.ts:42`). Read via `fetchWalletWithdrawals`; created **only** through the `create_withdrawal` RPC.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| amount_srd | numeric | NOT NULL | — |
| method | text | NOT NULL | — |
| destination | text | NOT NULL | — |
| status | text | NOT NULL | `'pending'` |
| receipt_number | text | NOT NULL | `'LL-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))` |
| paid_at | timestamptz | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| np_batch_id | text | NULL | — |
| np_payout_status | text | NULL | — |
| amount | numeric | NOT NULL | `0` |
| invoice_number | text | NULL | — |
| net_amount | numeric | NULL | — |

**CHECK:** `method IN ('uni5pay','usdt_bep20')`
**Keys:** PK `(id)` · UNIQUE `(receipt_number)` — **no FK on `user_id`.**
**Indexes:** `wallet_withdrawals_pkey (id)`, `wallet_withdrawals_receipt_number_key (receipt_number)`

> **Two amount columns.** `create_withdrawal()` writes only `amount_srd`; `amount` stays at its
> default `0`. But the app selects `amount` (`lib/supabase.ts:193`) and types it as the withdrawal
> value — so app-created withdrawals display as `0`. `status` has no CHECK, while the TS union
> expects `'pending'|'paid'|'failed'` and the RPC can also write `'processing'`.

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Users view own withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR SELECT TO {authenticated} USING ((auth.uid() = user_id));
CREATE POLICY "Users create own withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR INSERT TO {authenticated} WITH CHECK ((auth.uid() = user_id));
```
→ Own rows only. The INSERT policy would permit a direct client insert that skips the balance check — the app deliberately goes through the RPC instead.

```sql
CREATE POLICY "Admins view all withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR SELECT TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins update withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR UPDATE TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
```
→ Admins see and settle every withdrawal. **Only admins can UPDATE** — a user cannot cancel their own.

**Triggers:** none.
**RPC (app-called), `create_withdrawal(p_amount numeric, p_method text, p_destination text)` → `wallet_withdrawals`** — SECURITY DEFINER; requires auth, rejects non-positive amounts and unknown methods, `SELECT … FOR UPDATE` locks the wallet row, refuses on insufficient balance, debits `wallets.balance`, then inserts with `status='processing'`/`np_payout_status='queued'` for `usdt_bep20` or `status='pending'` for `uni5pay`.

---

## public.channel_tips

Read/written by `ChannelScreen`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| channel_id | uuid | NOT NULL | — |
| from_user_id | uuid | NULL | — |
| from_name | text | NULL | — |
| amount_srd | numeric(10,2) | NOT NULL | — |
| message | text | NULL | — |
| uni5pay_reference | text | NULL | — |
| status | text | NOT NULL | `'pending'` |
| created_at | timestamptz | NOT NULL | `now()` |
| confirmed_at | timestamptz | NULL | — |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE`. No FK on `from_user_id`; no CHECK on `status`.
**Indexes:** `channel_tips_pkey (id)`, `idx_channel_tips_channel (channel_id)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Confirmed tips viewable by everyone" ON public.channel_tips
    AS PERMISSIVE FOR SELECT TO {public}
    USING (((status = 'confirmed'::text) OR (auth.uid() = from_user_id) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_tips.channel_id) AND (c.user_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
```
→ Confirmed tips are public; pending ones are visible only to the sender, the channel owner, or an admin.

```sql
CREATE POLICY "Anyone can send a tip" ON public.channel_tips
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK (true);
```
→ **Unrestricted insert** — even anonymous callers, and `from_user_id` is not validated against `auth.uid()`.

```sql
CREATE POLICY "Admins or channel owner confirm tips" ON public.channel_tips
    AS PERMISSIVE FOR UPDATE TO {public}
    USING ((has_role(auth.uid(), 'admin'::app_role) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_tips.channel_id) AND (c.user_id = auth.uid()))))));
```
→ Only the channel owner or an admin can move a tip to `confirmed`. No `WITH CHECK`, so they may edit any column.

**Triggers:** none.

---

## public.channel_memberships

Membership **tiers** offered by a channel (the product definition). Read by `ChannelScreen`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| channel_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| tier_name | text | NOT NULL | `'Supporter'` |
| monthly_amount_srd | numeric(10,2) | NOT NULL | `0` |
| perks | text | NULL | — |
| enabled | boolean | NOT NULL | `true` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE`. No FK on `user_id`.
**Referenced by:** `channel_members.membership_id`
**Indexes:** `channel_memberships_pkey (id)`, `idx_channel_memberships_channel (channel_id)`

**RLS: ENABLED** (2 policies)

```sql
CREATE POLICY "Memberships viewable by everyone" ON public.channel_memberships
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
```
→ Tier definitions are public (needed to render the offer).

```sql
CREATE POLICY "Channel owner manages memberships" ON public.channel_memberships
    AS PERMISSIVE FOR ALL TO {public}
    USING ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_memberships.channel_id) AND (c.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_memberships.channel_id) AND (c.user_id = auth.uid())))));
```
→ Only the owner of the channel may create, edit or delete its tiers.

**Triggers:** `memberships_updated` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.channel_members

A user's **purchased** membership in a channel. Read by `ChannelScreen`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| membership_id | uuid | NOT NULL | — |
| channel_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| uni5pay_reference | text | NULL | — |
| status | text | NOT NULL | `'pending'` |
| amount_srd | numeric(10,2) | NOT NULL | — |
| starts_at | timestamptz | NOT NULL | `now()` |
| expires_at | timestamptz | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `membership_id → channel_memberships(id) ON DELETE CASCADE` · UNIQUE `(channel_id, user_id)` — one membership per user per channel. No CHECK on `status`.
**Indexes:** `channel_members_pkey (id)`, `channel_members_channel_id_user_id_key (channel_id, user_id)`, `idx_channel_members_user (user_id)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users see own membership records" ON public.channel_members
    AS PERMISSIVE FOR SELECT TO {public}
    USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_members.channel_id) AND (c.user_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
```
→ Visible to the member, the channel owner, or an admin — never publicly. A public "N members" count is therefore not readable from this table.

```sql
CREATE POLICY "Users create own membership requests" ON public.channel_members
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
```
→ You may only enroll yourself. Note `status` and `amount_srd` are client-supplied here.

```sql
CREATE POLICY "Admins update memberships" ON public.channel_members
    AS PERMISSIVE FOR UPDATE TO {public}
    USING ((has_role(auth.uid(), 'admin'::app_role) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_members.channel_id) AND (c.user_id = auth.uid()))))));
```
→ Only an admin or the channel owner can activate/expire a membership. There is **no DELETE policy** — rows cannot be removed by anyone.

**Triggers:** none.

---

## public.content_claims

Copyright/content claims shown on the watch screen. Canonical TS shape: `ContentClaim` (`lib/supabase.ts:220`). Read by `VideoPlayerScreen`, `BangiPostScreen`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| video_id | uuid | NOT NULL | — |
| claimant_name | text | NOT NULL | — |
| claimant_user_id | uuid | NULL | — |
| claim_type | text | NOT NULL | `'music'` |
| claim_status | text | NOT NULL | `'allow'` |
| revenue_redirect | boolean | NOT NULL | `true` |
| credit_text | text | NOT NULL | `''` |
| matched_content | text | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `video_id → videos(id) ON DELETE CASCADE`. No FK on `claimant_user_id`; no CHECK on `claim_type`/`claim_status`.
**Indexes:** `content_claims_pkey (id)`, `idx_content_claims_video_id (video_id)`, `idx_content_claims_claimant_user (claimant_user_id) WHERE claimant_user_id IS NOT NULL`

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Claims are viewable by everyone" ON public.content_claims
    AS PERMISSIVE FOR SELECT TO {public} USING (true);
```
→ Claims are public — the app can render the claim banner for any viewer.

```sql
CREATE POLICY "Admins can insert claims" ON public.content_claims
    AS PERMISSIVE FOR INSERT TO {authenticated} WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update claims" ON public.content_claims
    AS PERMISSIVE FOR UPDATE TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can delete claims" ON public.content_claims
    AS PERMISSIVE FOR DELETE TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
```
→ Admin-only writes; the mobile app is read-only against this table (correctly — it only selects).

**Triggers:** `update_content_claims_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.verification_requests

⚠️ **Listed for exclusion in the task brief, but the RN app references it directly** — kept here on the
evidence of `screens/ProfileScreen.tsx:422` and `:768` (reads own request, submits a new one) and
`screens/ChannelScreen.tsx:112` (reads request state). See *Needs Confirmation*.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| message | text | NULL | — |
| status | text | NOT NULL | `'pending'` |
| created_at | timestamptz | NOT NULL | `now()` |
| tiktok_url | text | NULL | — |
| youtube_url | text | NULL | — |
| facebook_url | text | NULL | — |
| instagram_url | text | NULL | — |
| press_links | text | NULL | — |
| about | text | NULL | — |

**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE`. No UNIQUE on `user_id` — a user may file unlimited requests. No CHECK on `status`.
**Indexes:** `verification_requests_pkey (id)` only.

**RLS: ENABLED** (4 policies)

```sql
CREATE POLICY "Users can view own verification requests" ON public.verification_requests
    AS PERMISSIVE FOR SELECT TO {authenticated} USING ((auth.uid() = user_id));
CREATE POLICY "Users can create verification requests" ON public.verification_requests
    AS PERMISSIVE FOR INSERT TO {authenticated} WITH CHECK ((auth.uid() = user_id));
```
→ Signed-in users see and file only their own requests. Both are `TO {authenticated}`, so an anonymous session reads nothing.

```sql
CREATE POLICY "Admins can view all verification requests" ON public.verification_requests
    AS PERMISSIVE FOR SELECT TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update verification requests" ON public.verification_requests
    AS PERMISSIVE FOR UPDATE TO {authenticated} USING (has_role(auth.uid(), 'admin'::app_role));
```
→ Admins review and decide. Approval does not write back here — it flips `profiles.is_verified` / `verification_type`. There is **no DELETE policy.**

**Triggers:** none.

---

## VIEW public.public_ads_active

Read by `hooks/useActiveAds.ts:53` — the app's only ad source.

```sql
CREATE OR REPLACE VIEW public.public_ads_active AS
 SELECT id, company_name, campaign_title, campaign_description, ad_type,
    creative_url, cta_url, website, status, payment_status, created_at,
    preferred_start_date, duration_days, target_impressions, impressions_count, reviewed_at
   FROM ad_requests
  WHERE status = 'live'::text AND payment_status = 'paid'::text;
```

Exposes only paid+live campaigns, and deliberately omits the applicant's contact columns
(`contact_name`, `email`, `phone`, `admin_notes`, `reviewed_by`). `hooks/useActiveAds.ts` re-checks the
ad window (`duration_days`, `target_impressions`) in JS because the view itself does not filter on time
or impression cap. Impressions are counted through the **`increment_ad_impression(p_ad_id uuid)` RPC**
(`VideoPlayerScreen.tsx:295`) — SECURITY DEFINER, returns `boolean`, and increments only while the ad is
paid, live, under its `target_impressions`, and inside `COALESCE(reviewed_at, created_at) + duration_days`.

---

# SHARED TABLES (App + Web)

No direct RN `.from()` reference, but the app depends on them through RLS or an app-called RPC.

---

## public.user_roles

**Why shared:** `has_role(auth.uid(), 'admin')` reads this table, and that function gates policies on
`content_claims`, `verification_requests`, `wallet_withdrawals`, `channel_tips`, `channel_members` —
all app-used. `profiles`' admin-update policy queries it directly. Since the live-streaming migrations it
also gates every staff policy and staff RPC check in the *LIVE STREAMING* section (`'admin'`, and
`'moderator'` for `live_streams` / `stream_mod_is_moderator()`). Whether an app user can do anything
privileged is decided here.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| role | **`app_role`** | NOT NULL | — |

**ENUM `public.app_role`:** `'admin' | 'moderator' | 'user'` — the only custom enum in the dump; the live-streaming migrations added 17 more (listed per migration in the *LIVE STREAMING* section), so `public` now has 18.
**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` · UNIQUE `(user_id, role)`
**Indexes:** `user_roles_pkey (id)`, `user_roles_user_id_role_key (user_id, role)`

**RLS: ENABLED** (2 policies)

```sql
CREATE POLICY "Users can view own roles" ON public.user_roles
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Admins can view all roles" ON public.user_roles
    AS PERMISSIVE FOR SELECT TO {public} USING (has_role(auth.uid(), 'admin'::app_role));
```
→ Read-only for clients: you see your own roles, admins see everyone's. **There is no INSERT, UPDATE or DELETE policy at all** — roles cannot be granted through the API, only via the service key or SQL editor.

**Triggers:** none.

**`has_role(_user_id uuid, _role app_role) → boolean`** — `STABLE SECURITY DEFINER`, `search_path = public`:
```sql
SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
```
SECURITY DEFINER is what lets it work inside policies despite the restrictive SELECT rules above.

> `profiles.is_admin` is a **separate, unrelated** flag. `has_role()` never reads it, so the two can disagree.

---

## public.video_views

**Why shared:** the app-called `get_top3_rank_badges()` RPC counts this table for its `'views'`
category, so the rank badges rendered by `hooks/useRankBadges.ts` depend on it. No RN code writes it —
the write path is the `register_video_view` RPC, which the mobile app does not call.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| video_id | uuid | NOT NULL | — |
| user_id | uuid | NULL | — |
| session_id | text | NOT NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · FK `video_id → videos(id) ON DELETE CASCADE` · UNIQUE `(video_id, session_id)` — dedupes per session, allowing anonymous views (`user_id` nullable).
**Indexes:** `video_views_pkey (id)`, `video_views_video_id_session_id_key (video_id, session_id)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Anyone can insert views" ON public.video_views
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK (true);
```
→ Unrestricted insert, including anonymous — `session_id` is client-chosen, so the UNIQUE is the only abuse guard.

```sql
CREATE POLICY "Users see own view rows" ON public.video_views
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Channel owners see views on own videos" ON public.video_views
    AS PERMISSIVE FOR SELECT TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_views.video_id) AND (v.user_id = auth.uid())))));
```
→ You read your own view rows; creators read all views on their own videos. **Nobody can read a global view count** — hence `videos.views` as the public counter, and hence `get_top3_rank_badges()` being SECURITY DEFINER.

**Triggers:** none. Related RPCs (not called from RN): `register_video_view(p_video_id, p_session_id, p_user_id)`, `increment_video_views(video_id)`, `increment_views(video_id)`.

---

## public.user_category_interests

**Why shared:** the app-called `get_personalized_feed()` RPC reads this table to pick a user's top 3
categories; when it is empty the RPC silently falls back to a chronological feed. `HomeScreen.tsx:285`
therefore behaves differently depending on rows here. No RN code writes it — the writer is
`track_user_interest()`, which the app never calls, so **in practice the mobile feed is always the
chronological fallback.**

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| category | text | NOT NULL | — |
| score | numeric | NOT NULL | `0` |
| updated_at | timestamptz | NOT NULL | `now()` |

**Keys:** PK `(id)` · UNIQUE `(user_id, category)`. **No FK on `user_id`.**
**Indexes:** `user_category_interests_pkey (id)`, `user_category_interests_user_id_category_key (user_id, category)`, `idx_user_interests_user_score (user_id, score DESC)`

**RLS: ENABLED** (3 policies)

```sql
CREATE POLICY "Users can view own interests" ON public.user_category_interests
    AS PERMISSIVE FOR SELECT TO {public} USING ((auth.uid() = user_id));
CREATE POLICY "Users can upsert own interests" ON public.user_category_interests
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own interests" ON public.user_category_interests
    AS PERMISSIVE FOR UPDATE TO {public} USING ((auth.uid() = user_id));
```
→ Private per user, read/insert/update only. No DELETE policy.

**Triggers:** none.

**`get_personalized_feed(p_user_id uuid, p_limit int = 20, p_offset int = 0)`** — `STABLE SECURITY DEFINER`, returns
`(id, title, thumbnail_url, duration, views, created_at, channel_id, channel_name, channel_avatar, feed_score, feed_type)`.
Splits `p_limit` 70/30 into an "interest" branch (`videos.tags && top_cats`, scored on tag match +
recency + `views/10` capped at 20) and a "discovery" branch (recency + a `channels.tapiners < 100`
boost). Both branches filter `status='published' AND is_short=false`. `feed_type` is
`'interest'`/`'discovery'`/`'chronological'`.
> Note: both branches `ORDER BY 10 DESC` — an ordinal that exceeds the select list, so ordering falls to `created_at DESC` and `feed_score` never actually sorts the feed.

---

## public.live_streams

**Status:** pre-existing table (in the dump), **extended add-only** by live-streaming migration 01
(6 columns, 5 constraints, 5 indexes, 2 staff policies — user permission 2026-09-10) and migration 05
(1 trigger — user permission 2026-09-10). Nothing original was dropped, renamed, retyped or edited.
One row per broadcast; it is the parent of the whole *LIVE STREAMING* section (19 inbound FKs). The
**mobile app is now the user of this table** for live streaming (through the `live_*` RPCs — no RN code
calls them yet); per migrations 02/05/06 the website does not run live streaming. Migration 01 still
keeps the table website-compatible (free-text `category` untouched, no CHECK on `status`, the
abandoned-stream sweeper only touches streams that sent a mobile heartbeat).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| host_user_id | uuid | NULL | — |
| channel_id | uuid | NULL | — |
| title | text | NULL | — |
| category | text | NULL | — |
| status | text | NULL | `'live'` |
| zego_room_id | text | NOT NULL | — |
| started_at | timestamptz | NULL | `now()` |
| ended_at | timestamptz | NULL | — |
| category_id *(01)* | uuid | NULL | — |
| end_reason *(01)* | `live_stream_end_reason` | NULL | — |
| duration_seconds *(01)* | integer | NULL | — |
| total_views *(01)* | bigint | NOT NULL | `0` |
| unique_viewers *(01)* | bigint | NOT NULL | `0` |
| peak_concurrent_viewers *(01)* | bigint | NOT NULL | `0` |

> `category` (free text, website) and `category_id` (normalised FK, mobile) coexist. `end_reason`,
> `duration_seconds`, `total_views` (= all watch sessions, repeat joins counted), `unique_viewers`
> (distinct uid, or guest key for guests) are written **once at end** by `live_stream_end_internal()`;
> `peak_concurrent_viewers` is raised incrementally by `live_stream_join()` (it cannot be derived later).
> While live, the running numbers live in `live_stream_runtime`, not here — deliberately, so the discovery
> table does not churn.

**CHECK (all added by 01):** `live_streams_duration_seconds_check` `(duration_seconds IS NULL OR duration_seconds >= 0)` · `live_streams_total_views_check` `(total_views >= 0)` · `live_streams_unique_viewers_check` `(unique_viewers >= 0)` · `live_streams_peak_viewers_check` `(peak_concurrent_viewers >= 0)`
> **Still no CHECK on `status`** — deliberately left free text (migration 01: the website writes it and not every value was audited). All live-streaming code treats anything other than `'live'` as ended. `zego_room_id NOT NULL` confirms the **ZEGOCLOUD** basis; there is still no UNIQUE on it.

**Keys:** PK `(id)` · FK `channel_id → channels(id)` (**no** `ON DELETE` action) · FK `host_user_id → auth.users(id)` (**no** `ON DELETE` action) · FK `live_streams_category_id_fkey`: `category_id → stream_categories(id) ON DELETE SET NULL` *(01)*
> The two original FKs are unchanged: nullable and non-cascading, so deleting a channel or user is still *blocked* while a stream row references it.

**Referenced by (19 FKs, all from the live-streaming tables):**
- `ON DELETE CASCADE` (15): `live_stream_runtime`, `live_stream_viewer_sessions`, `live_stream_reaction_counts`, `live_stream_chat_counts`, `lk_battles.initiator_stream_id` / `.opponent_stream_id` / `.winner_stream_id`, `lk_battle_scores.stream_id`, `live_cohost_sessions.host_stream_id` / `.cohost_stream_id`, `stream_moderators.live_stream_id`, `user_punishments.live_stream_id`, `stream_chat_rate_state`, `live_engagement_counters`, `live_shares`
- `ON DELETE SET NULL` (3): `stream_moderation_actions.live_stream_id`, `user_punishments.origin_live_stream_id`, `stream_reports.live_stream_id`
- `ON DELETE RESTRICT` (1): `gift_transactions.live_stream_id`
> Consequence: deleting a stream that ever received a gift **fails**; any other delete cascades away its
> runtime, sessions, counters, battles, co-host sessions and mute/kick rows, while the moderation audit
> log and reports survive with `live_stream_id = NULL`. The migrations' rule is: **end a stream, never delete it.**

**Indexes:** `live_streams_pkey (id)` · *(01)* `idx_live_streams_status_started (status, started_at DESC)` — "what is live now" feed · `idx_live_streams_host_started (host_user_id, started_at DESC)` — host history, stream-ban window count, host's current live stream · `idx_live_streams_channel (channel_id)` — FK support · `idx_live_streams_live_by_category (category_id, started_at DESC) WHERE status = 'live'` · `idx_live_streams_zego_room (zego_room_id)` — ZegoCloud callback lookup (non-unique)

**RLS: ENABLED** (6 policies — the 4 original host-scoped ones, unchanged, plus 2 staff policies from 01)

```sql
CREATE POLICY "Anyone can view live streams" ON public.live_streams
    AS PERMISSIVE FOR SELECT TO {public}
    USING (((status = 'live'::text) OR (host_user_id = auth.uid())));
```
→ Anyone may read streams whose `status = 'live'`; ended/other-status rows are visible only to the host. A viewer cannot list a host's past streams.

```sql
CREATE POLICY "Hosts can create their own live stream" ON public.live_streams
    AS PERMISSIVE FOR INSERT TO {public} WITH CHECK ((auth.uid() = host_user_id));
CREATE POLICY "Hosts can update their own live stream" ON public.live_streams
    AS PERMISSIVE FOR UPDATE TO {public}
    USING ((auth.uid() = host_user_id)) WITH CHECK ((auth.uid() = host_user_id));
CREATE POLICY "Hosts can delete their own live stream" ON public.live_streams
    AS PERMISSIVE FOR DELETE TO {public} USING ((auth.uid() = host_user_id));
```
→ Host-only writes; `channel_id` is not checked against channel ownership. The host still inserts the row directly under this INSERT policy (then calls `live_stream_init`). **The host UPDATE policy also still lets a host set `status` directly**, which bypasses the end-of-stream work — see *Needs Confirmation*. The host DELETE policy remains, but see the RESTRICT consequence above.

Policies added by migration 01 (quoted as written in the migration file):

```sql
create policy "Admins and moderators can view all live streams"
    on public.live_streams
    as permissive for select
    to authenticated
    using (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        or public.has_role(auth.uid(), 'moderator'::public.app_role)
    );
```
→ Platform admins and moderators (`app_role`) can read every stream, including ended/abandoned ones, for moderation review. Ordinary users keep exactly the access the original policy gave them (permissive policies are OR'd).

```sql
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
```
→ Staff can update any stream (e.g. force-end an abusive broadcast). There is deliberately **no staff DELETE policy** — streams are ended, never erased, so the gift ledger and audit trail keep their references. (The proper end path is `live_stream_end()`, which is SECURITY DEFINER and does not depend on these policies.)

**Triggers:**
- `trg_stream_mod_block_banned_host` BEFORE INSERT OR UPDATE OF `status` → `stream_mod_block_banned_host()` *(05, SECURITY DEFINER)* — if the row is **becoming live** (a new row with `status = 'live'`, or an update flipping a non-live row to `'live'`) and its host has an active, unexpired, unrevoked `platform_ban`, the statement is rejected with SQLSTATE `42501` ("Your account is banned from the platform, so you cannot start a live stream."). Never modifies the row; stream bans / kicks / mutes are ignored (they restrict watching/chatting, not broadcasting). BEFORE triggers see defaults, so an INSERT that omits `status` (default `'live'`) is still checked.
- No `updated_at` trigger (the table has no `updated_at`).

**Maintained by RPCs, not triggers:** `live_stream_init()` sets `category_id`; `live_stream_join()` raises `peak_concurrent_viewers`; `live_stream_end_internal()` (reached via `live_stream_end()`, the pg_cron sweeper and `stream_mod_ban()`) writes `status = 'ended'`, `ended_at`, `end_reason`, `duration_seconds`, `total_views`, `unique_viewers` in one UPDATE.

---

## auth.users (referenced only)

Not reproduced here. It is the identity root: 39 `public` foreign keys point at `auth.users(id)` —
the 13 from the dump (`profiles`, `channels`, `videos`, `shorts`, `community_posts`, `tapins`, `comment_likes`,
`notifications.user_id`, `notifications.actor_id`, `user_roles`, `verification_requests`, `wallets`,
`live_streams.host_user_id`) plus 26 from the live-streaming tables (listed per table in the *LIVE
STREAMING* section: 7 are `ON DELETE CASCADE` — the user's own state rows in `viewer_wallets`,
`broadcaster_earnings`, `live_stream_viewer_sessions`, `stream_moderators.user_id`, `user_punishments.user_id` /
`.broadcaster_user_id`, `stream_chat_rate_state`; the other 19 are `ON DELETE SET NULL`, so ledger, audit,
report and battle/co-host rows survive account deletion). `auth.uid()` in every policy above is this table's `id`.

**Trigger on it:** `on_auth_user_created` AFTER INSERT → `handle_new_user()` (SECURITY DEFINER) — inserts
the `profiles` row, taking `display_name` from `raw_user_meta_data->>'full_name'` / `'name'` /
`split_part(email,'@',1)` and `avatar_url` from `'avatar_url'` / `'picture'`. It does **not** set
`username` and does **not** create a `channels` row — `lib/auth.ts` (`ensureSupabaseProfile`,
`ensureChannelExists`) fills both gaps on first sign-in.

---

# LIVE STREAMING (App) — migrations 01–06, applied 2026-09-11

Mobile app only (the website does not run live streaming). 23 new tables, 17 new enums, 1 new view,
3 pg_cron jobs, 1 Vault secret, plus the add-only extension of `public.live_streams` documented above.
Source: `supabase/migrations/20260910_01_…` → `20260910_06_…`, run in that order. **No RN code calls any
of this yet** (implementation phase pending). Specs: `specs/*.md`.

**Conventions that hold for every table and function below**
- **Writes are RPC-only.** Client-facing writes go through `SECURITY DEFINER` functions with
  `SET search_path = public, pg_temp` that take the caller from `auth.uid()` (never from a parameter).
  Most tables have SELECT policies only — no client INSERT/UPDATE/DELETE policy — and RLS is enabled but
  **not FORCEd**, so the owner-run RPCs can write.
- **Function grant pattern.** Every function is `REVOKE ALL … FROM public, anon, authenticated`, then
  `GRANT EXECUTE` only to the roles meant to call it. Reason (stated in each file): Supabase's default
  privileges grant EXECUTE on new functions **directly** to `anon`, `authenticated` and `service_role`,
  which `REVOKE … FROM public` alone does not remove. "private" below = granted to no client role;
  reachable only from other SECURITY DEFINER functions owned by the same role, and from pg_cron jobs
  (they run as `postgres`, the owner). `service_role` is never named in the revokes (except on the two
  chat-signing internals), so it keeps its default EXECUTE elsewhere. Exceptions in file 05 are marked †.
- **Table grants.** Explicit `GRANT SELECT` (and admin-gated I/U/D where noted). Some tables first
  `REVOKE ALL` from `public, anon, authenticated` (noted per table); the rest rely on RLS having no
  write policy.
- **Policies** are quoted as written in the migration files (lower-case source SQL, not the pg_dump
  normalisation used in the sections above), with inline `--` comments removed (Postgres does not store them).
- **Streams are ended, never deleted** (see the FK consequence under `live_streams`).

---

## Migration 01 — core broadcaster & viewer engine (`20260910_01_live_streaming_core.sql`)

Creates `stream_categories`, `live_stream_runtime`, `live_stream_viewer_sessions`; extends
`live_streams` (above); schedules the pg_cron job `lk_live_force_end_abandoned`.
Hot/durable split: durable per-stream metrics are columns on `live_streams` (written once at end);
counters written on every join/leave/heartbeat live in `live_stream_runtime` (1:1), because every UPDATE
rewrites a whole row and would bloat the discovery table.

**Enums**
- `live_stream_end_reason`: `'broadcaster_ended'`, `'disconnected'`, `'moderation_ban'`
- `live_viewer_leave_reason`: `'swiped_away'`, `'manual_exit'`, `'stream_ended'`, `'kicked'`, `'connection_lost'`

**Functions** (all `SECURITY DEFINER`, plpgsql)

| function | security | callable by | purpose |
|---|---|---|---|
| `live_stream_init(p_live_stream_id uuid, p_category_id uuid DEFAULT NULL) → live_streams` | DEFINER | authenticated | Host only, right after inserting the stream row: validates the category, sets `category_id`, creates/refreshes the `live_stream_runtime` row (`host_last_seen_at = now()`). Idempotent; returns the row. |
| `live_stream_heartbeat(p_live_stream_id uuid) → void` | DEFINER | authenticated | Host liveness ping, **every 30 s** while publishing; writes only `live_stream_runtime.host_last_seen_at`. Silently no-ops if the stream is not live or the caller is not the host. |
| `live_stream_join(p_live_stream_id uuid, p_guest_key text DEFAULT NULL) → uuid` | DEFINER | anon, authenticated | Opens a watch session (guests allowed; a guest without a key gets a random one). Refuses non-live streams. Closes a stale open session of the same identity (`connection_lost`), bumps `current_concurrent_viewers` and `total_views_live` in one runtime upsert, then raises `live_streams.peak_concurrent_viewers`. `FOR KEY SHARE` on the stream closes the join-vs-end race. Returns the session id. |
| `live_stream_leave(p_session_id uuid, p_leave_reason live_viewer_leave_reason DEFAULT 'manual_exit') → boolean` | DEFINER | anon, authenticated | Closes one session (`left_at`, `duration_seconds`, `leave_reason`) and decrements the live counter. Signed-in sessions only by their owner or an admin; a guest session is bearer-authenticated by its uuid. `false` if unknown/already closed. |
| `live_stream_end(p_live_stream_id uuid, p_end_reason live_stream_end_reason DEFAULT 'broadcaster_ended') → live_streams` | DEFINER | authenticated | Host, admin or moderator. Wrapper over `live_stream_end_internal`; returns the finished row for the summary screen. Idempotent. |
| `live_stream_end_internal(p_live_stream_id uuid, p_end_reason live_stream_end_reason) → live_streams` | DEFINER | private | The one end path (no auth check): force-closes open sessions (`stream_ended`), computes `total_views` / `unique_viewers` / `duration_seconds` and writes them with `status='ended'`, `ended_at`, `end_reason` in one UPDATE, zeroes the live counter and reconciles `total_views_live`. If the stream was live, then calls — dynamically, only if they exist — `lk_battle_on_stream_ended()` and afterwards `live_cohost_on_stream_ended()`. Re-ending keeps the original `end_reason`. |
| `live_stream_force_end_abandoned(p_timeout_minutes integer DEFAULT 2) → integer` | DEFINER | service_role | Sweeper (pg_cron every minute): ends every `'live'` stream whose `live_stream_runtime.host_last_seen_at` is set and older than the timeout (NULL/<1 → 2 min = 4 missed heartbeats), `end_reason='disconnected'`. Streams that never sent a heartbeat (no `host_last_seen_at`) are never swept. Allowed when `auth.uid()` is NULL (cron/service) or the caller is admin. Returns the count. |

**Seed:** 15 `stream_categories` (idempotent on `slug`): `just-chatting`, `music`, `dance`, `comedy`,
`gaming`, `sports`, `food`, `beauty-fashion`, `news-talk`, `faith`, `education`, `business`, `events`,
`travel` (sort 10…140) and `other` (sort 999). A fresh starter set — the app had no category constants.

---

## public.stream_categories

Reference list of live-stream categories for the "Go Live" picker and the discovery feed. Client-read-only, admin-managed. `slug` is the stable i18n key for `lib/i18n.ts` (nl / en / srn); `is_active = false` hides a category from the picker but keeps historical `live_streams.category_id` values resolvable.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| name | text | NOT NULL | — |
| slug | text | NOT NULL | — |
| is_active | boolean | NOT NULL | `true` |
| sort_order | integer | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `stream_categories_name_check` `(length(btrim(name)) between 1 and 60)` · `stream_categories_slug_check` `(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')`
**Keys:** PK `(id)` · UNIQUE `stream_categories_slug_key (slug)`
**Referenced by:** `live_streams.category_id` (`ON DELETE SET NULL`)
**Indexes:** `stream_categories_pkey (id)`, `stream_categories_slug_key (slug)`, `idx_stream_categories_active_order (sort_order, name) WHERE is_active`
**Grants:** SELECT → anon, authenticated; INSERT/UPDATE/DELETE → authenticated (narrowed to admins by RLS).

**RLS: ENABLED** (2 policies)

```sql
create policy "Anyone can view active stream categories"
    on public.stream_categories
    as permissive for select
    to public
    using (is_active);
```
→ Anyone, signed in or not, can read the active categories.

```sql
create policy "Admins can manage stream categories"
    on public.stream_categories
    as permissive for all
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role))
    with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Only admins create, edit, delete (and see inactive) categories.

**Triggers:** none (no `updated_at` column).

---

## public.live_stream_runtime

1:1 hot-path side table of `live_streams`: the values written on every join/leave/heartbeat. Created lazily by `live_stream_init()` or by the first `live_stream_join()`. Never written by clients — only by the `live_*` SECURITY DEFINER RPCs (and `stream_mod_close_sessions()`), so counters cannot be forged.

| column | type | null | default |
|---|---|---|---|
| live_stream_id | uuid | NOT NULL | — |
| current_concurrent_viewers | bigint | NOT NULL | `0` |
| total_views_live | bigint | NOT NULL | `0` |
| host_last_seen_at | timestamptz | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `current_concurrent_viewers`: +1 per join, −1 per leave/kick; its high-water mark is pushed to `live_streams.peak_concurrent_viewers`; zeroed at end. The on-screen count should come from realtime presence, not polling.
> `total_views_live`: running "total views" while live (+1 per new session row, same definition as the final `live_streams.total_views`); set to the exact final count at end.
> `host_last_seen_at`: broadcaster heartbeat (only `live_stream_init` / `live_stream_heartbeat` set it) — the sweeper's opt-in signal.

**CHECK:** `live_stream_runtime_current_check` `(current_concurrent_viewers >= 0)` · `live_stream_runtime_total_views_live_check` `(total_views_live >= 0)`
**Keys:** PK `(live_stream_id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE`
**Indexes:** `live_stream_runtime_pkey (live_stream_id)`, `idx_live_stream_runtime_open (host_last_seen_at)`
**Grants:** SELECT → anon, authenticated. No write grant, no write policy.

**RLS: ENABLED** (2 policies)

```sql
create policy "Anyone can view runtime of visible streams"
    on public.live_stream_runtime
    as permissive for select
    to public
    using (exists (
        select 1
        from public.live_streams ls
        where ls.id = live_stream_runtime.live_stream_id
    ));
```
→ Readable wherever the parent stream is readable under `live_streams`' own RLS (live streams for everyone; own streams for the host; all streams for staff).

```sql
create policy "Admins can view all live stream runtime"
    on public.live_stream_runtime
    as permissive for select
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admins read every runtime row (explicit, so it does not depend on another table's policy).

**Triggers:** `set_live_stream_runtime_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.live_stream_viewer_sessions

One row per watch session. Opened by `live_stream_join()`, closed by `live_stream_leave()`, force-closed at stream end (`stream_ended`) or by moderation (`kicked`). Repeat joins create new rows — that is how `total_views` (all rows) and `unique_viewers` (distinct identity) differ. Swiping to the next stream = leave + join; a silent auto-reconnect must not create a new row. Guests allowed (`viewer_user_id` NULL + a device-scoped `guest_key` that is never exposed).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NOT NULL | — |
| viewer_user_id | uuid | NULL | — |
| guest_key | text | NULL | — |
| joined_at | timestamptz | NOT NULL | `now()` |
| left_at | timestamptz | NULL | — |
| duration_seconds | integer | NULL | — |
| leave_reason | `live_viewer_leave_reason` | NULL | — |

**CHECK:** `live_viewer_sessions_identity_check` `(viewer_user_id is not null or guest_key is not null)` · `live_viewer_sessions_guest_key_check` `(guest_key is null or length(guest_key) between 8 and 64)` · `live_viewer_sessions_duration_check` `(duration_seconds is null or duration_seconds >= 0)` · `live_viewer_sessions_closed_check` — open rows have `left_at`, `duration_seconds`, `leave_reason` all NULL; closed rows have `left_at` and `leave_reason` set.
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `viewer_user_id → auth.users(id) ON DELETE CASCADE`
**Indexes:** `live_stream_viewer_sessions_pkey (id)` · `idx_live_viewer_sessions_open_by_stream (live_stream_id) WHERE left_at IS NULL` · `idx_live_viewer_sessions_stream_joined (live_stream_id, joined_at DESC)` · `idx_live_viewer_sessions_viewer_joined (viewer_user_id, joined_at DESC) WHERE viewer_user_id IS NOT NULL` · UNIQUE `uq_live_viewer_sessions_open_user (live_stream_id, viewer_user_id) WHERE left_at IS NULL AND viewer_user_id IS NOT NULL` · UNIQUE `uq_live_viewer_sessions_open_guest (live_stream_id, guest_key) WHERE left_at IS NULL AND viewer_user_id IS NULL AND guest_key IS NOT NULL`
> The two partial UNIQUEs guarantee **at most one open session per identity per stream**.

**Grants:** SELECT → authenticated only (guests have no SELECT; the session id from `live_stream_join()` is all they need). No write grant, no write policy.

**RLS: ENABLED** (3 policies)

```sql
create policy "Viewers can read their own watch sessions"
    on public.live_stream_viewer_sessions
    as permissive for select
    to authenticated
    using (viewer_user_id = auth.uid());
```
→ A signed-in viewer reads their own watch history — even after the stream ends.

```sql
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
```
→ The broadcaster reads every session on their own streams (analytics, kick lists).

```sql
create policy "Admins can read all viewer sessions"
    on public.live_stream_viewer_sessions
    as permissive for select
    to authenticated
    using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admins read everything.

**Triggers:** `trg_stream_mod_block_banned_join` BEFORE INSERT → `stream_mod_block_banned_join()` *(added by migration 05)* — refuses (`42501`) a signed-in viewer who is platform-banned, whose broadcaster-scoped stream ban covers this stream ("You are banned and cannot join this stream."), or who is inside a 15-minute kick lockout on this stream ("You can rejoin in N minutes", DETAIL `reason=kicked; retry_after_seconds=…`). Guest rows are not checked.

---

## Migration 02 — reactions + chat COUNT (`20260910_02_live_chat_reactions.sql`)

**Product decision (2026-09-10): live chat messages are never stored** — not for streams, battles or
co-hosting. A message exists only on screen, delivered over the realtime channel. What the DB holds:
the per-stream chat **count** (this file), mute/ban records and the message gate (file 05), the slow-mode
state without text (file 05, UNLOGGED), and the text of a single *reported* message inside its report
(file 05). The pinned message lives in the ZegoCloud room extra info; a moderator "remove message" is a
realtime-only signal. The relay (an Edge Function, implementation phase) must broadcast from the Edge
Function / ZegoCloud signalling — never with `realtime.send()` from Postgres, which would insert every
message into `realtime.messages`. Individual reaction taps are never stored either.

**Enums:** none.

**Functions**

| function | security | callable by | purpose |
|---|---|---|---|
| `live_chat_stream_status(p_live_stream_id uuid) → text` | DEFINER, STABLE (sql) | anon, authenticated | RLS-safe read of `live_streams.status` (policies and the chat gate must see ended streams, which `live_streams` RLS hides from non-hosts). |
| `live_chat_stream_host_id(p_live_stream_id uuid) → uuid` | DEFINER, STABLE (sql) | anon, authenticated | RLS-safe read of `live_streams.host_user_id`, used by the counter read policies. |
| `live_reactions_increment(p_live_stream_id uuid, p_delta int) → bigint` | DEFINER | authenticated | Batched tap-to-like flush (client buffers ~1–2 s). Requires auth, `p_delta >= 1`, stream `'live'`; clamps to **100 per call**; upserts the counter and returns the new total. |

The two helpers are granted to `anon` because they are evaluated inside anon-facing SELECT policies.

---

## public.live_stream_reaction_counts

One row per stream: the running tap-to-like ("hearts") total, eventually consistent, shown live and on the end-of-stream summary.

| column | type | null | default |
|---|---|---|---|
| live_stream_id | uuid | NOT NULL | — |
| total_reactions | bigint | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `(total_reactions >= 0)` — monotonically increasing.
**Keys:** PK `(live_stream_id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE`
**Indexes:** `live_stream_reaction_counts_pkey (live_stream_id)` only.
**Grants:** SELECT → anon, authenticated. No write grant.
**Written by:** `live_reactions_increment()` only.

**RLS: ENABLED** (2 policies)

```sql
create policy "Anyone can read reaction counts of visible streams"
  on public.live_stream_reaction_counts
  as permissive for select
  to anon, authenticated
  using (
    public.live_chat_stream_status(live_stream_id) = 'live'
    or public.live_chat_stream_host_id(live_stream_id) = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
```
→ Everyone sees the total while the stream is live; afterwards only the host and admins.

```sql
create policy "Admins can manage live stream reaction counts"
  on public.live_stream_reaction_counts
  as permissive for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admin-only correction path. (The migration itself grants only SELECT on this table.)

**Triggers:** `update_live_stream_reaction_counts_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.live_stream_chat_counts

The **only** chat data stored per stream: a number, never text. +1 for every message allowed by `stream_mod_chat_gate()` (file 05); a moderator "remove message" does not decrement it. Kept on its own row, separate from reactions, so per-message chat increments and per-viewer reaction batches never wait on each other's row lock.

| column | type | null | default |
|---|---|---|---|
| live_stream_id | uuid | NOT NULL | — |
| total_chat_messages | bigint | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `(total_chat_messages >= 0)`
**Keys:** PK `(live_stream_id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE`
**Indexes:** `live_stream_chat_counts_pkey (live_stream_id)` only.
**Grants:** `REVOKE ALL` from public, anon, authenticated, then SELECT → anon, authenticated.
**Written by:** `stream_mod_chat_gate()` only — no write policy, not even for admins.

**RLS: ENABLED** (1 policy)

```sql
create policy "Anyone can read chat counts of visible streams"
  on public.live_stream_chat_counts
  as permissive for select
  to anon, authenticated
  using (
    public.live_chat_stream_status(live_stream_id) = 'live'
    or public.live_chat_stream_host_id(live_stream_id) = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
```
→ Same visibility as the reaction total: everyone while live; host and admins after it ends.

**Triggers:** `update_live_stream_chat_counts_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## Migration 03 — LK battles + co-hosting (`20260910_03_lk_battles.sql`)

**LK (Luku Knockout) battle:** two already-live streams of two different broadcasters, scored by gift
points for a timer (1–3600 s; product presets 180/300). **Host** = broadcaster of `initiator_stream_id`
(sent the invite); **co-host** = broadcaster of `opponent_stream_id` (accepted). No new ZegoCloud room —
the client mixes the two existing `zego_room_id`s. **Co-hosting** (approved 2026-09-11, no spec file):
two live streams linked 50/50 with no timer, score, winner or penalty.

- **How a battle ends** (`lk_battles.end_method`, all through `lk_battle_finish_internal()`): `timer`
  and `host_ended` / `end_request_accepted` / `host_left` are decided by the **current score** (equal =
  draw); `cohost_surrendered` / `cohost_left` make the **host win regardless of score**. A live battle can
  never be cancelled — `lk_battle_cancel` only withdraws an unaccepted invite.
- **Invites** (battle and co-host alike): 60-second TTL; anti-spam keyed on people — the same inviter may
  not re-invite the same person within **2 minutes** of a declined/expired/cancelled invite, and at most
  **20 invites per inviter per rolling hour**, battle + co-host counted together (both raise SQLSTATE
  `PT429` = HTTP 429). One shared helper, so the two invite kinds cannot be alternated to spam.
- **End requests:** the co-host may ask the host to end; the request lapses after **30 s**, one pending per
  battle, **60 s** re-ask cooldown after a declined/expired one.
- **One active pairing per stream:** an active (invited/live) battle or co-host session never overlaps
  another on either stream — except a battle whose `cohost_session_id` points at the LIVE co-host session
  between the same two streams (while co-hosting, a stream may only battle its partner). Enforced by the
  partial unique indexes plus the shared trigger `lk_battles_assert_single_active()` (sorted advisory locks).
- **Stream ending** (any way) closes its battle and then its co-host session via the two hooks called by
  `live_stream_end_internal()`. Declined/expired/cancelled rows are kept (anti-spam history).
- Fixed lock order (co-host session row → inviter advisory lock → battle rows → invited session rows →
  stream advisory locks); session rows use `FOR NO KEY UPDATE` so gift FK checks never wait on them.

**Enums**
- `lk_battle_status`: `'invited'`, `'live'`, `'ended'`, `'declined'`, `'expired'`, `'cancelled'`
- `lk_penalty_status`: `'assigned'`, `'skipped'`
- `lk_battle_end_method`: `'timer'`, `'host_ended'`, `'end_request_accepted'`, `'cohost_surrendered'`, `'cohost_left'`, `'host_left'`
- `lk_battle_end_request_status`: `'pending'`, `'accepted'`, `'declined'`, `'expired'`
- `live_cohost_status`: `'invited'`, `'live'`, `'ended'`, `'declined'`, `'expired'`, `'cancelled'`
- `live_cohost_end_method`: `'host_ended'`, `'cohost_ended'`, `'host_left'`, `'cohost_left'`

**Functions** (all `SECURITY DEFINER`)

| function | security | callable by | purpose |
|---|---|---|---|
| `lk_battles_assert_single_active() → trigger` | DEFINER | — (trigger) | Shared trigger guard on `lk_battles` and `live_cohost_sessions` (branches on `TG_TABLE_NAME`): one active pairing per stream across both tables; the only allowed overlap is a battle linked to its live co-host session. |
| `lk_pairing_invite_guard_internal(p_kind text, p_inviter_user_id uuid, p_invitee_user_id uuid, p_stream_a uuid, p_stream_b uuid) → timestamptz` | DEFINER | private | Shared invite rules: serialises the inviter's invites (advisory lock), lazily expires stale invites on both streams, 2-min pair cooldown, 20/hour cap (combined). Returns `now() + 60 s`. |
| `lk_battle_invite(p_initiator_stream_id uuid, p_opponent_stream_id uuid, p_duration_seconds integer) → uuid` | DEFINER | authenticated | Host of the initiating stream invites another live broadcaster's stream; records both people; inside a live co-hosting only the partner may be invited (sets `cohost_session_id`). Returns the battle id. |
| `lk_battle_accept(p_battle_id uuid) → uuid` | DEFINER | authenticated | Invited broadcaster only: flips an unexpired invite to `live`, stamps `started_at` / `ends_at`, creates the two score rows at 0. Idempotent. |
| `lk_battle_decline(p_battle_id uuid) → uuid` | DEFINER | authenticated | Invited broadcaster declines an open invite (row kept). |
| `lk_battle_cancel(p_battle_id uuid) → uuid` | DEFINER | authenticated | Host withdraws an **unaccepted** invite; a live battle cannot be cancelled. |
| `lk_battle_finish_internal(p_battle_id uuid, p_end_method lk_battle_end_method, p_forced_winner text DEFAULT NULL) → uuid` | DEFINER | private | The single outcome rule: locks battle + both score rows, decides by current score (equal = draw) or forced host win (co-host exits only), writes `status/ended_at/result/winner_stream_id/end_method`, expires any pending end request. Idempotent; NULL if not live or timer not yet due. |
| `lk_battle_settle_internal(p_battle_id uuid) → uuid` | DEFINER | private | `lk_battle_finish_internal(id, 'timer')`. |
| `lk_battle_settle(p_battle_id uuid) → uuid` | DEFINER | authenticated | Timer settlement any signed-in client may trigger once `ends_at` has passed (deterministic); the cron sweep is the backstop. |
| `lk_battle_end_early(p_battle_id uuid) → uuid` | DEFINER | authenticated | Host only: ends a live battle now by current score (`host_ended`; a timer end if `ends_at` already passed). |
| `lk_battle_surrender(p_battle_id uuid) → uuid` | DEFINER | authenticated | Co-host only: ends now, host wins (`cohost_surrendered`). |
| `lk_battle_request_end(p_battle_id uuid) → uuid` | DEFINER | authenticated | Co-host only: creates a 30-s end request (repeat returns the open one; 60-s re-ask cooldown, `PT429`). NULL if the timer already ran out (settled instead). |
| `lk_battle_respond_end_request(p_request_id uuid, p_accept boolean) → uuid` | DEFINER | authenticated | Host only: accept → ends by current score (`end_request_accepted`); decline → battle continues. |
| `lk_battle_set_penalty(p_battle_id uuid, p_penalty_text text, p_status lk_penalty_status) → uuid` | DEFINER | authenticated | Winner's host only, on an ended, decided battle: cosmetic penalty text (≤ 280) or `skipped`. |
| `lk_battle_add_points(p_live_stream_id uuid, p_points bigint) → uuid` | DEFINER | service_role | Contract for `gift_send()`: if the stream is in a live battle window, adds points to its side (`FOR SHARE` on the battle, single-statement increment) and returns the battle id; otherwise NULL. Never raises. Not client-granted (would allow score inflation). |
| `lk_battles_expire_stale() → integer` | DEFINER | service_role | pg_cron sweep: expires battle invites and co-host invites past `invite_expires_at` (`ended_at = invite_expires_at`) and pending end requests past `expires_at`. Returns rows lapsed. |
| `lk_battles_settle_due() → integer` | DEFINER | service_role | pg_cron backstop: timer-settles up to 500 live battles whose `ends_at` passed. |
| `lk_battle_on_stream_ended(p_live_stream_id uuid) → integer` | DEFINER | private | Hook from `live_stream_end_internal()`: live battle → `cohost_left` (host wins) or `host_left` (current score), or a timer end if due; open invite → `cancelled` (host's stream ended) / `expired` (opponent's). |
| `live_cohost_invite(p_host_stream_id uuid, p_cohost_stream_id uuid) → uuid` | DEFINER | authenticated | Host of the inviting stream invites another live broadcaster to co-host; refused (`23505`) if either stream is in any active pairing; shared anti-spam. |
| `live_cohost_accept(p_session_id uuid) → uuid` | DEFINER | authenticated | Invitee only: unexpired invite → `live` while both streams are live. Idempotent. |
| `live_cohost_decline(p_session_id uuid) → uuid` | DEFINER | authenticated | Invitee declines an open invite. |
| `live_cohost_cancel(p_session_id uuid) → uuid` | DEFINER | authenticated | Host withdraws an unaccepted invite. |
| `live_cohost_end(p_session_id uuid) → uuid` | DEFINER | authenticated | Either participant ends a live co-hosting (`host_ended` / `cohost_ended`); both streams keep running solo. Refused while a battle inside it is live (a timed-out one is settled first); a pending battle invite inside it is cancelled. |
| `live_cohost_on_stream_ended(p_live_stream_id uuid) → integer` | DEFINER | private | Hook called after the battle hook: live session → `ended` (`host_left` / `cohost_left`); open invite → `cancelled` / `expired`. |
| `live_cohost_active_session(p_live_stream_id uuid) → uuid` | DEFINER, STABLE (sql) | private | Id of the LIVE co-host session the stream is in, else NULL. Used by `gift_send()` and file 06. |

---

## public.lk_battles

One row per battle **attempt**, from invite onward. All writes via the `lk_battle_*` RPCs (and the stream-ended hook / sweeps).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| initiator_stream_id | uuid | NOT NULL | — |
| opponent_stream_id | uuid | NULL | — |
| winner_stream_id | uuid | NULL | — |
| initiator_host_user_id | uuid | NULL | — |
| opponent_host_user_id | uuid | NULL | — |
| status | `lk_battle_status` | NOT NULL | `'invited'` |
| result | text | NULL | — |
| end_method | `lk_battle_end_method` | NULL | — |
| duration_seconds | integer | NOT NULL | — |
| invited_at | timestamptz | NOT NULL | `now()` |
| invite_expires_at | timestamptz | NOT NULL | `now() + '60 seconds'` |
| started_at | timestamptz | NULL | — |
| ends_at | timestamptz | NULL | — |
| ended_at | timestamptz | NULL | — |
| penalty_text | text | NULL | — |
| penalty_status | `lk_penalty_status` | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |
| cohost_session_id | uuid | NULL | — |

> `initiator_host_user_id` / `opponent_host_user_id` are copied from `live_streams.host_user_id` at invite time — a broadcaster gets a new stream id every time they go live, so anti-spam and history key on **people**. `ends_at` is a stored `started_at + duration_seconds` (not a generated column: `timestamptz + interval` is only STABLE). `result` is constrained text, not an enum. `ended_at` = when the row left the active states (`ends_at` for a timer end). `cohost_session_id` is set once by `lk_battle_invite()` when fought inside a live co-hosting.

**CHECK:** `result in ('initiator_win','opponent_win','draw')` · `duration_seconds > 0 and duration_seconds <= 3600` · `penalty_text is null or length(btrim(penalty_text)) between 1 and 280` ·
`lk_battles_distinct_sides_chk` (a stream never fights itself) · `lk_battles_live_shape_chk` (live ⇒ opponent, `started_at`, `ends_at` set) · `lk_battles_ends_at_shape_chk` (`started_at` and `ends_at` both NULL or both set) · `lk_battles_result_status_chk` (`result` set exactly when `status='ended'`) · `lk_battles_end_method_status_chk` (`end_method` set exactly when ended) · `lk_battles_end_method_result_chk` (`cohost_surrendered`/`cohost_left` ⇒ `initiator_win`) · `lk_battles_winner_matches_result_chk` (`winner_stream_id` agrees with `result`; NULL on draw) · `lk_battles_ended_at_shape_chk` (`ended_at` NULL exactly while invited/live) · `lk_battles_penalty_shape_chk` (penalty only on an ended battle with a winner; `assigned` needs text) · `lk_battles_penalty_text_requires_status_chk`
**Keys:** PK `(id)` · FK `initiator_stream_id`, `opponent_stream_id`, `winner_stream_id` → `live_streams(id) ON DELETE CASCADE` · FK `initiator_host_user_id`, `opponent_host_user_id` → `auth.users(id) ON DELETE SET NULL` · FK `lk_battles_cohost_session_id_fkey`: `cohost_session_id → live_cohost_sessions(id) ON DELETE SET NULL`
**Referenced by:** `lk_battle_scores.battle_id` (CASCADE), `lk_battle_end_requests.battle_id` (CASCADE), `gift_transactions.battle_id` (SET NULL), `live_engagement_counters.lk_battle_id` (CASCADE), `live_shares.lk_battle_id` (CASCADE)
**Indexes:** `lk_battles_pkey (id)` · UNIQUE `lk_battles_active_initiator_uniq (initiator_stream_id) WHERE status IN ('invited','live')` · UNIQUE `lk_battles_active_opponent_uniq (opponent_stream_id) WHERE status IN ('invited','live')` · `lk_battles_initiator_history_idx (initiator_stream_id, invited_at DESC)` · `lk_battles_opponent_history_idx (opponent_stream_id, invited_at DESC) WHERE opponent_stream_id IS NOT NULL` · `lk_battles_expiry_sweep_idx (invite_expires_at) WHERE status = 'invited'` · `lk_battles_settle_sweep_idx (ends_at) WHERE status = 'live'` · `lk_battles_initiator_host_history_idx (initiator_host_user_id, invited_at DESC) WHERE initiator_host_user_id IS NOT NULL` · `lk_battles_opponent_host_history_idx (opponent_host_user_id, invited_at DESC) WHERE opponent_host_user_id IS NOT NULL` · `lk_battles_pair_cooldown_idx (initiator_host_user_id, opponent_host_user_id, ended_at DESC) WHERE status IN ('declined','expired','cancelled')` · `lk_battles_cohost_session_idx (cohost_session_id) WHERE cohost_session_id IS NOT NULL`
> The two active-state partial UNIQUEs enforce one active battle per stream per side and double as the per-gift "active battle for this stream" lookup.

**Grants:** SELECT → anon, authenticated. No write grant, no write policy.

**RLS: ENABLED** (3 policies)

```sql
create policy "Viewers can read battles of visible streams"
  on public.lk_battles
  as permissive for select
  to anon, authenticated
  using (
    lk_battles.started_at is not null
    and exists (
      select 1
        from public.live_streams ls
       where ls.id in (lk_battles.initiator_stream_id, lk_battles.opponent_stream_id)
         and (ls.status = 'live' or ls.host_user_id = auth.uid())
    )
  );
```
→ Viewers see only battles that actually **started**, and only while either side's stream is visible to them (live, or their own). Declined/expired/withdrawn invites stay private (privacy decision 2026-09-11).

```sql
create policy "Participants can read their battles"
  on public.lk_battles
  as permissive for select
  to authenticated
  using ((select auth.uid()) in (lk_battles.initiator_host_user_id, lk_battles.opponent_host_user_id));
```
→ The two broadcasters always see their own battles, including pending invites.

```sql
create policy "Admins can read all battles"
  on public.lk_battles
  as permissive for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admins see everything.

**Triggers:** `update_lk_battles_updated_at` BEFORE UPDATE → `update_updated_at_column()` · `lk_battles_single_active_trg` BEFORE INSERT OR UPDATE OF `status, initiator_stream_id, opponent_stream_id, cohost_session_id` → `lk_battles_assert_single_active()`.

---

## public.lk_battle_scores

Running point total per side — exactly two rows per battle, created by `lk_battle_accept()`. A total, not a ledger (the ledger is `gift_transactions`). Mirrors real money, so never client-writable.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| battle_id | uuid | NOT NULL | — |
| stream_id | uuid | NOT NULL | — |
| points | bigint | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `(points >= 0)`
**Keys:** PK `(id)` · FK `battle_id → lk_battles(id) ON DELETE CASCADE` · FK `stream_id → live_streams(id) ON DELETE CASCADE` · UNIQUE `lk_battle_scores_battle_stream_uniq (battle_id, stream_id)`
**Indexes:** `lk_battle_scores_pkey (id)`, `lk_battle_scores_battle_stream_uniq (battle_id, stream_id)`, `lk_battle_scores_stream_idx (stream_id)`
**Grants:** SELECT → anon, authenticated. **Written by:** `lk_battle_add_points()` only (called by `gift_send()`).

**RLS: ENABLED** (2 policies)

```sql
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
```
→ Scores are visible wherever the battle is visible to the caller and one of its streams is live or their own — viewers of either side get the progress bar.

```sql
create policy "Admins can read all battle scores"
  on public.lk_battle_scores
  as permissive for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admins see all scores.

**Triggers:** `update_lk_battle_scores_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.lk_battle_end_requests

A co-host's "please end the battle" request to the host (Accept/Decline popup via realtime). A row still `'pending'` after `expires_at` is treated as expired everywhere and flipped by the next request or the cron sweep.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| battle_id | uuid | NOT NULL | — |
| requested_by_user_id | uuid | NULL | — |
| status | `lk_battle_end_request_status` | NOT NULL | `'pending'` |
| created_at | timestamptz | NOT NULL | `now()` |
| expires_at | timestamptz | NOT NULL | `now() + '30 seconds'` |
| responded_at | timestamptz | NULL | — |

**CHECK:** `lk_battle_end_requests_expiry_chk` `(expires_at > created_at)` · `lk_battle_end_requests_responded_chk` `((status in ('accepted','declined')) = (responded_at is not null))`
**Keys:** PK `(id)` · FK `battle_id → lk_battles(id) ON DELETE CASCADE` · FK `requested_by_user_id → auth.users(id) ON DELETE SET NULL`
**Indexes:** `lk_battle_end_requests_pkey (id)` · UNIQUE `lk_battle_end_requests_one_pending_uidx (battle_id) WHERE status = 'pending'` · `lk_battle_end_requests_battle_created_idx (battle_id, created_at DESC)` · `lk_battle_end_requests_expiry_sweep_idx (expires_at) WHERE status = 'pending'` · `lk_battle_end_requests_requested_by_idx (requested_by_user_id) WHERE requested_by_user_id IS NOT NULL`
**Grants:** `REVOKE ALL` from public, anon, authenticated, then SELECT → authenticated. anon has no access.

**RLS: ENABLED** (2 policies)

```sql
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
```
→ Only the two broadcasters of the battle see its end requests — viewers never do.

```sql
create policy "Admins can read all battle end requests"
  on public.lk_battle_end_requests
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));
```
→ Admins see all.

**Triggers:** none (no `updated_at` column).

---

## public.live_cohost_sessions

**Co-hosting:** one row per co-host attempt between two already-live streams of two different broadcasters, linked 50/50. Host = broadcaster of `host_stream_id` (sent the invite); co-host = broadcaster of `cohost_stream_id`. Chat, hearts, shares, viewers and moderation stay per stream; gifts carry `gift_transactions.cohost_session_id`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| host_stream_id | uuid | NOT NULL | — |
| cohost_stream_id | uuid | NOT NULL | — |
| host_user_id | uuid | NULL | — |
| cohost_user_id | uuid | NULL | — |
| status | `live_cohost_status` | NOT NULL | `'invited'` |
| invited_at | timestamptz | NOT NULL | `now()` |
| invite_expires_at | timestamptz | NOT NULL | `now() + '60 seconds'` |
| started_at | timestamptz | NULL | — |
| ended_at | timestamptz | NULL | — |
| ended_by_user_id | uuid | NULL | — |
| end_method | `live_cohost_end_method` | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `live_cohost_sessions_distinct_streams_chk` `(host_stream_id <> cohost_stream_id)` · `live_cohost_sessions_distinct_users_chk` (two different people when both known) · `live_cohost_sessions_invite_window_chk` `(invite_expires_at > invited_at)` · `live_cohost_sessions_started_shape_chk` (`started_at` set exactly for live/ended) · `live_cohost_sessions_ended_at_shape_chk` (`ended_at` NULL exactly while invited/live) · `live_cohost_sessions_ended_after_start_chk` · `live_cohost_sessions_end_method_status_chk` (`end_method` set exactly when ended) · `live_cohost_sessions_ended_by_shape_chk` (`ended_by_user_id` only for declined/cancelled or a button-press end `host_ended`/`cohost_ended`)
**Keys:** PK `(id)` · FK `host_stream_id`, `cohost_stream_id` → `live_streams(id) ON DELETE CASCADE` · FK `host_user_id`, `cohost_user_id`, `ended_by_user_id` → `auth.users(id) ON DELETE SET NULL`
**Referenced by:** `lk_battles.cohost_session_id` (SET NULL), `gift_transactions.cohost_session_id` (SET NULL)
**Indexes:** `live_cohost_sessions_pkey (id)` · UNIQUE `live_cohost_sessions_active_host_uniq (host_stream_id) WHERE status IN ('invited','live')` · UNIQUE `live_cohost_sessions_active_cohost_uniq (cohost_stream_id) WHERE status IN ('invited','live')` · `live_cohost_sessions_host_stream_history_idx (host_stream_id, invited_at DESC)` · `live_cohost_sessions_cohost_stream_history_idx (cohost_stream_id, invited_at DESC)` · `live_cohost_sessions_host_user_history_idx (host_user_id, invited_at DESC) WHERE host_user_id IS NOT NULL` · `live_cohost_sessions_cohost_user_history_idx (cohost_user_id, invited_at DESC) WHERE cohost_user_id IS NOT NULL` · `live_cohost_sessions_pair_cooldown_idx (host_user_id, cohost_user_id, ended_at DESC) WHERE status IN ('declined','expired','cancelled')` · `live_cohost_sessions_expiry_sweep_idx (invite_expires_at) WHERE status = 'invited'` · `live_cohost_sessions_ended_by_idx (ended_by_user_id) WHERE ended_by_user_id IS NOT NULL`
**Grants:** `REVOKE ALL` from public, anon, authenticated, then SELECT → anon, authenticated. No write policy.

**RLS: ENABLED** (3 policies)

```sql
create policy "Viewers can read co-host sessions of visible streams"
  on public.live_cohost_sessions
  as permissive for select
  to anon, authenticated
  using (
    live_cohost_sessions.started_at is not null
    and exists (
      select 1
        from public.live_streams ls
       where ls.id in (live_cohost_sessions.host_stream_id, live_cohost_sessions.cohost_stream_id)
         and (ls.status = 'live' or ls.host_user_id = (select auth.uid()))
    )
  );
```
→ Viewers see only co-hosting that actually started, while either stream is visible to them — so viewers of both rooms see the 50/50 link. Unaccepted invites stay private.

```sql
create policy "Participants can read their co-host sessions"
  on public.live_cohost_sessions
  as permissive for select
  to authenticated
  using ((select auth.uid()) in (live_cohost_sessions.host_user_id, live_cohost_sessions.cohost_user_id));
```
→ The two broadcasters always see their sessions, even after both streams end.

```sql
create policy "Admins can read all co-host sessions"
  on public.live_cohost_sessions
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));
```
→ Admins see all.

**Triggers:** `update_live_cohost_sessions_updated_at` BEFORE UPDATE → `update_updated_at_column()` · `live_cohost_sessions_single_active_trg` BEFORE INSERT OR UPDATE OF `status, host_stream_id, cohost_stream_id` → `lk_battles_assert_single_active()`.

---

## Migration 04 — coins, gifting & earnings (`20260910_04_economy_gifting.sql`)

**Two separate money systems — do not confuse them.** `public.wallets` (pre-existing) is the SRD **cash**
wallet paid out by `create_withdrawal()`; this migration never touches it. `viewer_wallets` holds
spendable **coins** bought via Google Play / Apple IAP; `broadcaster_earnings` holds **points** earned from
gifts plus a `cash_balance` staged for a future payout. The bridge `cash_balance → wallets.balance` is
intentionally **not built** (needs an FX/margin policy and an admin approval flow). Coins enter only via a
verified `coin_purchases` row and leave only via `gift_send()`. Rows in `viewer_wallets` /
`broadcaster_earnings` are provisioned lazily inside the RPCs (no trigger on `auth.users`/`profiles`).
Pricing rule (user, 2026-09-10): the broadcaster earns **60 %** of a gift's coin cost as points, LukuLuku
keeps 40 % — stored per gift as `point_value`, not enforced by a CHECK.

**Enums**
- `gift_tier`: `'low'`, `'medium_low'`, `'medium_high'`, `'high'`, `'super'` (ascending price order; bands 1–50 / 51–300 / 301–1,000 / 1,001–5,000 / 5,001–20,000 coins)
- `gift_animation_style`: `'banner'`, `'large'`, `'fullscreen'` (render size, deliberately independent of tier)
- `coin_purchase_platform`: `'google_play'`, `'apple_iap'`
- `coin_purchase_status`: `'pending'`, `'verified'`, `'failed'`, `'refunded'` (`refunded` reserved for store revocations; no clawback logic exists yet)

**Functions** (all `SECURITY DEFINER`)

| function | security | callable by | purpose |
|---|---|---|---|
| `coin_wallet_ensure() → viewer_wallets` | DEFINER | authenticated | Lazily creates and returns the caller's own coin wallet. |
| `coin_wallet_balance() → bigint` | DEFINER, STABLE (sql) | authenticated | Caller's coin balance, 0 if no wallet row yet. |
| `coin_purchase_record(p_platform coin_purchase_platform, p_product_id text, p_receipt_token text, p_price_paid numeric DEFAULT NULL, p_currency text DEFAULT NULL) → uuid` | DEFINER | authenticated | Buyer records a **pending** receipt; package resolved from `coin_packages` by (platform, product id) and base/bonus snapshotted — the client never supplies a coin amount. Credits nothing. Idempotent on (platform, receipt_token). Errors `LKG05`, `LKC01`, `LKC02`, `LKC06` unknown product, `LKC07` inactive package. |
| `coin_purchase_mark_verified(p_platform coin_purchase_platform, p_receipt_token text, p_product_id text, p_user_id uuid DEFAULT NULL, p_price_paid numeric DEFAULT NULL, p_currency text DEFAULT NULL) → jsonb` | DEFINER | service_role | Verifying Edge Function only. Flips pending → verified and credits exactly the snapshotted base + bonus **once** (row lock + UNIQUE receipt). The store-confirmed product id wins over the client's (`product_mismatch` flag); retired packages still honoured; creates the row if the store notification came first (needs `p_user_id`). |
| `coin_purchase_mark_failed(p_platform coin_purchase_platform, p_receipt_token text, p_reason text DEFAULT NULL) → boolean` | DEFINER | service_role | Marks a **pending** receipt failed (never downgrades a verified one). |
| `gift_send(p_live_stream_id uuid, p_gift_id uuid, p_quantity int DEFAULT 1, p_client_tx_id uuid DEFAULT NULL) → jsonb` | DEFINER | authenticated | The atomic gift: receiver resolved server-side from the stream host; stream must be live, gift active, quantity 1–999, no self-gift; locks and debits the coin wallet, credits `broadcaster_earnings` points, calls `lk_battle_add_points()` and `live_cohost_active_session()`, writes the ledger row with snapshotted prices. Optional `p_client_tx_id` makes retries return the original. Errors `LKG01`–`LKG08` (`LKG03` insufficient coins = recharge popup). |
| `gift_live_stream_points(p_live_stream_id uuid) → jsonb` | DEFINER, STABLE | anon, authenticated | Public hype counter: host's `points_balance` and this stream's total gift points. Points only, never cash. Only for streams the caller can see (live or own; else `LKG09`). |
| `gift_live_stream_top_senders(p_live_stream_id uuid, p_limit int DEFAULT 10) → TABLE(sender_user_id uuid, display_name text, avatar_url text, total_coins bigint, total_points bigint, gift_count bigint)` | DEFINER, STABLE | anon, authenticated | Top-gifter leaderboard for one visible stream (limit clamped 1–100), joined to `profiles`. |

**Seed data** (fixed UUIDs, `ON CONFLICT (id) DO NOTHING`)
- **50 gifts** — `a1000000-0000-4000-8000-0000000000NN`, NN = `sort_order` 01–50: `low` 15 (1–50 coins,
  `banner`), `medium_low` 15 (60–300, `banner`), `medium_high` 10 (350–1,000, `large`), `high` 6
  (1,500–5,000, `fullscreen`), `super` 4 (7,500–20,000, `fullscreen`). Cheapest Rose / Heart / Thumbs Up at
  1 coin; most expensive Universe at 20,000. `point_value = greatest(1, round(coin_cost × 0.60))` on every
  gift (so the three 1-coin gifts earn 1 point, 0 margin); `animation_asset_ref = 'gift_' + slug with '-' → '_'`.
- **10 coin packages** — `c1000000-0000-4000-8000-0000000000NN`; the same product id on both stores,
  `online.lukuluku.app.coins_<base_coins>` (must exist as consumables in Play Console and App Store Connect).
  Prices are reference/display values only; the charged price comes from the store SDK.

| slug | base | bonus | total | USD | SRD | badge |
|---|---|---|---|---|---|---|
| mini-tryout | 100 | 0 | 100 | 0.99 | 38.00 | — |
| starter | 300 | 15 | 315 | 2.99 | 115.00 | — |
| popular | 500 | 30 | 530 | 4.99 | 190.00 | popular |
| standard | 1,000 | 100 | 1,100 | 9.99 | 385.00 | — |
| pro | 2,000 | 250 | 2,250 | 19.99 | 770.00 | — |
| advanced | 3,000 | 450 | 3,450 | 29.99 | 1,155.00 | — |
| vip | 5,000 | 800 | 5,800 | 49.99 | 1,925.00 | best_value |
| high-roller | 10,000 | 2,000 | 12,000 | 99.99 | 3,850.00 | — |
| super-vip | 20,000 | 5,000 | 25,000 | 199.99 | 7,700.00 | — |
| whale-tier | 50,000 | 15,000 | 65,000 | 499.99 | 19,250.00 | — |

---

## public.gift_catalog

Reference table of purchasable live-stream gifts. Retire a gift with `is_active = false` — never delete (the ledger references it with RESTRICT). `slug` is the i18n key; `name` is the English fallback.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| slug | text | NOT NULL | — |
| name | text | NOT NULL | — |
| emoji | text | NULL | — |
| tier | `gift_tier` | NOT NULL | — |
| animation_style | `gift_animation_style` | NOT NULL | — |
| coin_cost | bigint | NOT NULL | — |
| point_value | bigint | NOT NULL | — |
| animation_asset_ref | text | NULL | — |
| sort_order | int | NOT NULL | `0` |
| is_active | boolean | NOT NULL | `true` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `gift_catalog_slug_check` (lowercase kebab) · `gift_catalog_name_check` `(length(btrim(name)) between 1 and 60)` · `gift_catalog_emoji_check` `(emoji is null or length(emoji) between 1 and 16)` · `gift_catalog_coin_cost_check` `(coin_cost between 1 and 20000)` · `gift_catalog_point_value_check` `(point_value >= 1)` · `gift_catalog_tier_band_check` (`tier` must equal the price band `coin_cost` falls in)
**Keys:** PK `(id)` · UNIQUE `gift_catalog_name_key (name)` · UNIQUE `gift_catalog_slug_key (slug)`
**Referenced by:** `gift_transactions.gift_id` (`ON DELETE RESTRICT`)
**Indexes:** `gift_catalog_pkey (id)`, `gift_catalog_name_key`, `gift_catalog_slug_key`, `gift_catalog_active_tier_cost_idx (tier, coin_cost, sort_order) WHERE is_active`
**Grants:** SELECT → anon, authenticated; INSERT/UPDATE/DELETE → authenticated (admin-gated by RLS).

**RLS: ENABLED** (2 policies)

```sql
create policy "Anyone can read active gifts"
  on public.gift_catalog for select to anon, authenticated
  using (is_active or public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Everyone reads active gifts; admins also see retired ones.

```sql
create policy "Admins manage the gift catalog"
  on public.gift_catalog for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Only admins edit the catalog.

**Triggers:** `gift_catalog_set_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.coin_packages

Coin top-up packages sold as consumable IAP products — **the single source of truth** for how many coins a store product credits. Retire with `is_active = false`; never delete a package that has purchases.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| slug | text | NOT NULL | — |
| name | text | NOT NULL | — |
| sort_order | int | NOT NULL | `0` |
| base_coins | bigint | NOT NULL | — |
| bonus_coins | bigint | NOT NULL | `0` |
| total_coins | bigint | — | GENERATED ALWAYS AS `(base_coins + bonus_coins)` STORED |
| price_usd | numeric(10,2) | NOT NULL | — |
| price_srd | numeric(12,2) | NOT NULL | — |
| google_play_product_id | text | NULL | — |
| apple_product_id | text | NULL | — |
| badge | text | NULL | — |
| is_active | boolean | NOT NULL | `true` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `price_usd` / `price_srd` are display references only — never used for crediting or accounting. Apple product ids can never be reused once created.

**CHECK:** `coin_packages_slug_check` · `coin_packages_name_check` · `coin_packages_base_coins_check` `(base_coins > 0)` · `coin_packages_bonus_coins_check` `(bonus_coins >= 0)` · `coin_packages_price_usd_check` `(price_usd > 0)` · `coin_packages_price_srd_check` `(price_srd > 0)` · `coin_packages_google_play_product_id_check` (`^[a-z0-9][a-z0-9._]{0,149}$`) · `coin_packages_apple_product_id_check` (`^[A-Za-z0-9][A-Za-z0-9._]{0,149}$`) · `coin_packages_has_product_id_check` (at least one store id) · `coin_packages_badge_check` (1–32 chars)
**Keys:** PK `(id)` · UNIQUE `coin_packages_slug_key (slug)` · UNIQUE `coin_packages_google_play_product_id_key (google_play_product_id)` · UNIQUE `coin_packages_apple_product_id_key (apple_product_id)`
**Referenced by:** `coin_purchases.coin_package_id` (`ON DELETE RESTRICT`)
**Indexes:** `coin_packages_pkey (id)`, the three UNIQUE indexes above, `coin_packages_active_sort_idx (sort_order) WHERE is_active`
**Grants:** SELECT → anon, authenticated (store screen renders before sign-in); INSERT/UPDATE/DELETE → authenticated (admin-gated by RLS).

**RLS: ENABLED** (2 policies)

```sql
create policy "Anyone can read active coin packages"
  on public.coin_packages for select to anon, authenticated
  using (is_active or public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Everyone reads active packages; admins also see retired ones.

```sql
create policy "Admins manage coin packages"
  on public.coin_packages for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Only admins edit packages.

**Triggers:** `coin_packages_set_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.viewer_wallets

Spendable **coin** balance, one row per user. **Not** `public.wallets` (the SRD cash wallet).

| column | type | null | default |
|---|---|---|---|
| user_id | uuid | NOT NULL | — |
| coin_balance | bigint | NOT NULL | `0` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `(coin_balance >= 0)` — last line of defence: a race that would overdraw aborts the whole gift instead.
**Keys:** PK `(user_id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` (state, not a ledger — the durable record is `coin_purchases` + `gift_transactions`; keeps `delete-account` working)
**Indexes:** `viewer_wallets_pkey (user_id)` only.
**Grants:** SELECT → authenticated. **Written by:** `coin_wallet_ensure()`, `coin_purchase_mark_verified()` (credit), `gift_send()` (debit).

**RLS: ENABLED** (1 policy)

```sql
create policy "Users read own coin wallet"
  on public.viewer_wallets for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ You read only your own coin balance; admins read all. No client write policy — the self-credit hole of `wallets` does not exist here.

**Triggers:** `viewer_wallets_set_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.broadcaster_earnings

Per-broadcaster gift earnings. `points_balance` / `lifetime_points_earned` are public-safe (exposed via the view `broadcaster_public_points`); `cash_balance` is **private** (owner + admin) staged value awaiting a payout RPC that does not exist yet.

| column | type | null | default |
|---|---|---|---|
| user_id | uuid | NOT NULL | — |
| points_balance | bigint | NOT NULL | `0` |
| lifetime_points_earned | bigint | NOT NULL | `0` |
| cash_balance | numeric(18,2) | NOT NULL | `0` |
| cash_currency | text | NOT NULL | `'SRD'` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `lifetime_points_earned` only ever increases (leaderboards read it). No function in these migrations converts points or writes `cash_balance`.

**CHECK:** `(points_balance >= 0)` · `(lifetime_points_earned >= 0)` · `(cash_balance >= 0)`
**Keys:** PK `(user_id)` · FK `user_id → auth.users(id) ON DELETE CASCADE`
**Indexes:** `broadcaster_earnings_pkey (user_id)`, `broadcaster_earnings_lifetime_points_idx (lifetime_points_earned DESC) WHERE lifetime_points_earned > 0`
**Grants:** SELECT → authenticated. **Written by:** `gift_send()` (upsert + credit points).

**RLS: ENABLED** (1 policy)

```sql
create policy "Broadcasters read own earnings"
  on public.broadcaster_earnings for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Only the broadcaster and admins read this row (it contains `cash_balance`). Everyone else uses the view.

**Triggers:** `broadcaster_earnings_set_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.coin_purchases

IAP top-up ledger, replay-protected. Created `pending` by the buyer (`coin_purchase_record`); only the service role flips it to `verified` and credits coins.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NULL | — |
| platform | `coin_purchase_platform` | NOT NULL | — |
| product_id | text | NOT NULL | — |
| receipt_token | text | NOT NULL | — |
| coin_package_id | uuid | NOT NULL | — |
| base_coins | bigint | NOT NULL | — |
| bonus_coins | bigint | NOT NULL | — |
| coins_expected | bigint | — | GENERATED ALWAYS AS `(base_coins + bonus_coins)` STORED |
| coins_credited | bigint | NOT NULL | `0` |
| price_paid | numeric(18,2) | NULL | — |
| currency | text | NULL | — |
| status | `coin_purchase_status` | NOT NULL | `'pending'` |
| failure_reason | text | NULL | — |
| verified_at | timestamptz | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `base_coins` / `bonus_coins` are snapshots of the package; `product_id` is overwritten on verify with the store-confirmed id.

**CHECK:** `(base_coins > 0)` · `(bonus_coins >= 0)` · `(coins_credited >= 0)` · `(price_paid >= 0)` · `coin_purchases_credit_matches_snapshot_check` — `verified` ⇒ `coins_credited = base_coins + bonus_coins`; `refunded` ⇒ unconstrained; `pending` / `failed` ⇒ `coins_credited = 0`.
**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE SET NULL` (record survives account deletion) · FK `coin_package_id → coin_packages(id) ON DELETE RESTRICT`
**Indexes:** `coin_purchases_pkey (id)` · UNIQUE `coin_purchases_platform_receipt_key (platform, receipt_token)` — **replay protection** · `coin_purchases_user_created_idx (user_id, created_at DESC)` · `coin_purchases_pending_idx (created_at) WHERE status = 'pending'` · `coin_purchases_package_idx (coin_package_id)`
**Grants:** SELECT → authenticated. No write grant/policy.

**RLS: ENABLED** (1 policy)

```sql
create policy "Users read own coin purchases"
  on public.coin_purchases for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Own purchase history only; admins see all.

**Triggers:** `coin_purchases_set_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.gift_transactions

Permanent, append-only gift ledger. Written only by `gift_send()`. FKs deliberately never cascade.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NOT NULL | — |
| sender_user_id | uuid | NULL | — |
| receiver_user_id | uuid | NULL | — |
| gift_id | uuid | NOT NULL | — |
| quantity | int | NOT NULL | `1` |
| coin_cost | bigint | NOT NULL | — |
| point_value | bigint | NOT NULL | — |
| total_coin_cost | bigint | — | GENERATED ALWAYS AS `(coin_cost * quantity)` STORED |
| total_point_value | bigint | — | GENERATED ALWAYS AS `(point_value * quantity)` STORED |
| gift_tier | `gift_tier` | NOT NULL | — |
| battle_id | uuid | NULL | — |
| cohost_session_id | uuid | NULL | — |
| client_tx_id | uuid | NULL | — |
| sent_at | timestamptz | NOT NULL | `now()` |
| created_at | timestamptz | NOT NULL | `now()` |

> `coin_cost` / `point_value` / `gift_tier` are **per-unit snapshots** from the catalog at send time (price edits never rewrite history). A combo of N taps is one row with `quantity = N`. `battle_id` is set when `lk_battle_add_points()` reported an active battle; `cohost_session_id` when the receiving stream was in a live co-host session. Gifting a co-host partner = `gift_send()` with the partner's stream id.

**CHECK:** `(quantity > 0 and quantity <= 999)` · `(coin_cost >= 0)` · `(point_value >= 0)`
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE RESTRICT` · FK `sender_user_id`, `receiver_user_id` → `auth.users(id) ON DELETE SET NULL` · FK `gift_id → gift_catalog(id) ON DELETE RESTRICT` · FK `battle_id → lk_battles(id) ON DELETE SET NULL` · FK `gift_transactions_cohost_session_id_fkey`: `cohost_session_id → live_cohost_sessions(id) ON DELETE SET NULL`
**Indexes:** `gift_transactions_pkey (id)` · UNIQUE `gift_transactions_sender_client_tx_key (sender_user_id, client_tx_id) WHERE client_tx_id IS NOT NULL AND sender_user_id IS NOT NULL` — idempotency · `gift_transactions_sender_sent_idx (sender_user_id, sent_at DESC)` · `gift_transactions_receiver_sent_idx (receiver_user_id, sent_at DESC)` · `gift_transactions_stream_sent_idx (live_stream_id, sent_at DESC)` · `gift_transactions_stream_sender_idx (live_stream_id, sender_user_id)` · `gift_transactions_battle_idx (battle_id, sent_at DESC) WHERE battle_id IS NOT NULL` · `gift_transactions_cohost_session_idx (cohost_session_id, live_stream_id) WHERE cohost_session_id IS NOT NULL` · `gift_transactions_gift_idx (gift_id)`
**Grants:** SELECT → authenticated. No write grant/policy.

**RLS: ENABLED** (1 policy)

```sql
create policy "Users read own gift transactions"
  on public.gift_transactions for select to authenticated
  using (
    auth.uid() = sender_user_id
    or auth.uid() = receiver_user_id
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
```
→ You see gifts you sent or received; admins see all. Room-wide feeds/leaderboards come from the SECURITY DEFINER helpers, which control which columns leave the server.

**Triggers:** none.

---

## VIEW public.broadcaster_public_points

Public-safe projection of `broadcaster_earnings` for on-stream hype counters and leaderboards.

```sql
create or replace view public.broadcaster_public_points as
  select
    be.user_id,
    be.points_balance,
    be.lifetime_points_earned,
    be.updated_at
  from public.broadcaster_earnings be;
```

Set to `security_invoker = false` (the PostgreSQL default; set explicitly), so it runs as its owner and
reads past the owner-only RLS on the base table — **the column list is the security boundary**.
`cash_balance` and `cash_currency` are deliberately omitted (column-level grants were considered
unverified in this project); **never add a cash column here**. `GRANT SELECT` → anon, authenticated —
every broadcaster's points are publicly readable.

---

## Migration 05 — moderation, safety & reporting (`20260910_05_moderation_safety.sql`)

**Punishment rules (user, 2026-09-10)**
- **Mute** — per stream; `p_duration_seconds` default 600, NULL = until lifted; re-mute extends.
- **Kick** — removes the viewer (sessions closed as `kicked`) **and** locks them out of that stream for
  **15 minutes**; a re-kick restarts the 15 minutes; `stream_mod_unban` (stream scope) lifts it early.
- **Stream ban** (host/moderator) — scoped to the **broadcaster**, covering the stream it was issued on
  plus that broadcaster's **next 2 streams** (3 total, counted by `started_at`), then lapses by itself —
  no duration, no cron. A stream ban never stops the banned user from broadcasting.
- **Platform ban** — admin only, exactly **7 days** (re-ban extends); ends every stream the user is
  hosting (`end_reason = 'moderation_ban'`) and blocks going live (`trg_stream_mod_block_banned_host`).
- Moderators cannot act on themselves, on the broadcaster, or (unless they are the host) on another
  moderator; admins can act on anyone.

**Chat gate** `stream_mod_chat_gate()` — called once per message by the relay with the **sender's** JWT.
Check order: `not_authenticated` → `empty` / `too_long` (500 chars) → `stream_not_live` → `banned` /
`kicked` / `muted` → `profanity` (**blocked, never masked**) → `slow_mode` (more than 3 messages in 5 s
puts the user in slow mode for 60 s at 1 message per 10 s; host + moderators exempt) → allow. On allow
it increments `live_stream_chat_counts` and returns `{allowed, message_id, sent_at (ms), sender_user_id,
signature}`; on deny `{allowed:false, reason, retry_after_seconds}`. It never stores text. The
**signature** is HMAC-SHA256 (hex) over `message_id`, `live_stream_id`, `sender_user_id`, `sent_at` in
epoch ms and the body, joined by pipe characters, keyed by the Vault secret `live_chat_signing_key` — so a
reported message can later be proven to be exactly what the gate let through.

**Enums**
- `stream_moderation_action_type`: `'mute'`, `'kick'`, `'ban'`, `'unmute'`, `'unban'` (reversals are appended, never edits)
- `user_punishment_type`: `'mute'`, `'kick'`, `'stream_ban'`, `'platform_ban'`
- `profanity_category`: `'profanity'`, `'hate_speech'`, `'spam_link'`, `'sexual_content'`
- `stream_report_reason`: `'inappropriate_content'`, `'harassment'`, `'spam'`, `'violence'`, `'copyright'`, `'other'`
- `stream_report_status`: `'pending'`, `'reviewed'`, `'resolved'`, `'dismissed'`

**Vault:** secret `live_chat_signing_key` (32 random bytes, hex) created once only if absent — re-running
never rotates it (rotation would make pending signed reports unverifiable).

**Functions** († = the migration grants EXECUTE but issues no `REVOKE` for this function — see *Needs Confirmation*)

| function | security | callable by | purpose |
|---|---|---|---|
| `stream_mod_reject_audit_update() → trigger` | **INVOKER** (no `search_path`) | — (trigger; revoked from public, anon, authenticated) | Raises `42501` on any UPDATE of `stream_moderation_actions` (append-only). |
| `stream_mod_is_moderator(p_live_stream_id uuid, p_user_id uuid) → boolean` | DEFINER, STABLE | anon, authenticated † | TRUE for app_role admin/moderator, the stream's host, or an active stream/channel/global `stream_moderators` assignee. |
| `stream_mod_is_punished(p_user_id uuid, p_live_stream_id uuid, p_types user_punishment_type[]) → boolean` | DEFINER, STABLE | anon, authenticated | The hot enforcement check: platform ban anywhere, mute/kick on this stream, or a stream ban whose 3-stream window covers this stream. Side-effect free; spent stream bans simply stop matching. |
| `stream_mod_assert_can_act(p_live_stream_id uuid, p_actor_user_id uuid, p_target_user_id uuid) → void` | DEFINER, STABLE | private | Shared guard: blocks self-moderation, mod-on-host and mod-on-mod escalation. |
| `stream_mod_close_sessions(p_live_stream_id uuid, p_target_user_id uuid) → integer` | DEFINER | private | Closes the target's open viewer sessions (`kicked`) on one stream, or on every stream when `p_live_stream_id` is NULL (platform ban), and decrements each stream's live counter. |
| `stream_mod_mute(p_live_stream_id uuid, p_target_user_id uuid, p_duration_seconds integer DEFAULT 600, p_reason text DEFAULT NULL) → uuid` | DEFINER | authenticated † | Host/mod mutes on one stream: audit row + punishment upsert (extends). |
| `stream_mod_unmute(p_live_stream_id uuid, p_target_user_id uuid, p_reason text DEFAULT NULL) → uuid` | DEFINER | authenticated † | Revokes the mute (never deletes) + `unmute` audit row. |
| `stream_mod_kick(p_live_stream_id uuid, p_target_user_id uuid, p_reason text DEFAULT NULL) → uuid` | DEFINER | authenticated | Audit row (900 s), 15-min `kick` punishment (restarts), closes sessions. |
| `stream_mod_ban(p_live_stream_id uuid, p_target_user_id uuid, p_platform_wide boolean DEFAULT false, p_reason text DEFAULT NULL) → uuid` | DEFINER | authenticated | Stream ban (host/mod; broadcaster-scoped, 3 streams) or platform ban (admin; 7 days). Closes sessions; ends the target's running broadcast(s) via `live_stream_end_internal(…, 'moderation_ban')`. |
| `stream_mod_unban(p_live_stream_id uuid, p_target_user_id uuid, p_platform_wide boolean DEFAULT false, p_reason text DEFAULT NULL) → uuid` | DEFINER | authenticated | Platform scope (admin): revokes the platform ban. Stream scope (host/mod): revokes the stream host's stream ban on the user **and** any active kick on this stream. One `unban` audit row. |
| `stream_mod_assign_moderator(p_user_id uuid, p_live_stream_id uuid DEFAULT NULL, p_channel_id uuid DEFAULT NULL) → uuid` | DEFINER | authenticated † | Stream scope = host or admin; channel scope = channel owner or admin; global (both NULL) = admin. Idempotent. |
| `stream_mod_revoke_moderator(p_moderator_row_id uuid) → boolean` | DEFINER | authenticated † | Soft-revokes an assignment; host/channel owner, admin, or the moderator themselves. |
| `stream_mod_report_submit(p_live_stream_id uuid, p_reason_category stream_report_reason, p_reported_user_id uuid DEFAULT NULL, p_details text DEFAULT NULL, p_message_id uuid DEFAULT NULL, p_message_text text DEFAULT NULL, p_message_sent_at timestamptz DEFAULT NULL, p_message_signature text DEFAULT NULL) → uuid` | DEFINER | authenticated | Files a report, optionally carrying ONE chat message (all three message fields together; sender = reported user; ≤ 500 chars; HMAC checked → `message_verified`, unverified still accepted). Max 10 per reporter per hour; a duplicate pending report returns the existing id. |
| `stream_mod_report_set_status(p_report_id uuid, p_status stream_report_status, p_resolution_notes text DEFAULT NULL) → boolean` | DEFINER | authenticated † | Admin only: moves a report through the queue and stamps the reviewer. |
| `stream_mod_profanity_pattern() → text` | DEFINER, STABLE (sql) | private | Aggregates all active dictionary rows into one alternation regex (deterministic order, so the per-connection compiled-regex cache hits). Not client-callable (would publish the blocklist). |
| `stream_mod_contains_profanity(p_text text) → boolean` | DEFINER, STABLE | authenticated † | Case-insensitive match against the compiled blocklist; used by the gate, also available for a pre-send UI hint. |
| `stream_mod_chat_signing_key() → text` | DEFINER, STABLE | private — also revoked from **service_role** | The only reader of the Vault key; never returned to any caller. |
| `stream_mod_chat_signature(p_message_id uuid, p_live_stream_id uuid, p_sender_user_id uuid, p_sent_at timestamptz, p_body text) → text` | DEFINER, STABLE | private — also revoked from **service_role** | Single definition of the canonical string + HMAC (sign in the gate, verify in reports); not callable, as it would be a signing oracle. |
| `stream_mod_chat_gate(p_live_stream_id uuid, p_body text) → jsonb` | DEFINER, VOLATILE | authenticated | The per-message chat gate described above. Raises only on a NULL stream id or a missing Vault key. |
| `stream_mod_block_banned_join() → trigger` | DEFINER | — (trigger) | BEFORE INSERT guard on `live_stream_viewer_sessions` (banned / kick-locked users cannot join). |
| `stream_mod_block_banned_host() → trigger` | DEFINER | — (trigger; revoked from public, anon, authenticated) | BEFORE INSERT / UPDATE OF status guard on `live_streams` (platform-banned host cannot go live). |

**Seed data — `profanity_dictionaries`** (`ON CONFLICT DO NOTHING`): 599 rows, **589 active**.
- 592 from **LDNOOBW** ("List of Dirty, Naughty, Obscene, and Otherwise Bad Words", © Shutterstock,
  **CC BY 4.0** — attribution required; files `en` and `nl` fetched 2026-09-10): `en` 403 (incl. one emoji
  entry seeded with `match_whole_word = false`) + `nl` 189; trimmed, lower-cased, de-duplicated,
  regex-escaped; `source = 'ldnoobw'`, category `profanity`, whole-word match.
- 10 of those are reviewed false positives (3 en, 7 nl — ordinary words / first names) seeded
  **inactive** (kept so admins can see they were reviewed).
- 7 `custom` additions (4 nl, 3 en; 5 `profanity`, 2 `hate_speech`) for common curses LDNOOBW lacks.
- No Sranantongo list exists; admins can add rows (`source` defaults to `'custom'`). No leetspeak or
  inflection matching. More candidate false positives are listed in the migration for admin review.

---

## public.stream_moderators

Moderator assignments, three scopes: stream (`live_stream_id` set), channel (`channel_id` set — every stream of that channel), or global (both NULL). Soft-revoked via `revoked_at`, so history survives.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NULL | — |
| channel_id | uuid | NULL | — |
| user_id | uuid | NOT NULL | — |
| assigned_by_user_id | uuid | NULL | — |
| revoked_at | timestamptz | NULL | — |
| revoked_by_user_id | uuid | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `stream_moderators_single_scope_chk` `(live_stream_id is null or channel_id is null)`
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `channel_id → channels(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE` · FK `assigned_by_user_id`, `revoked_by_user_id` → `auth.users(id) ON DELETE SET NULL`
**Indexes:** `stream_moderators_pkey (id)` · UNIQUE `uq_stream_moderators_stream_active (live_stream_id, user_id) WHERE revoked_at IS NULL AND live_stream_id IS NOT NULL` · UNIQUE `uq_stream_moderators_channel_active (channel_id, user_id) WHERE revoked_at IS NULL AND channel_id IS NOT NULL` · UNIQUE `uq_stream_moderators_global_active (user_id) WHERE revoked_at IS NULL AND live_stream_id IS NULL AND channel_id IS NULL` · `idx_stream_moderators_user_active (user_id) INCLUDE (live_stream_id, channel_id) WHERE revoked_at IS NULL` · `idx_stream_moderators_stream_active (live_stream_id) WHERE revoked_at IS NULL AND live_stream_id IS NOT NULL` · `idx_stream_moderators_channel_active (channel_id) WHERE revoked_at IS NULL AND channel_id IS NOT NULL`
**Grants:** SELECT → anon, authenticated; INSERT/UPDATE/DELETE revoked from anon, authenticated. **Written by:** `stream_mod_assign_moderator()` / `stream_mod_revoke_moderator()`.

**RLS: ENABLED** (1 policy)

```sql
create policy "Anyone can read active stream moderators"
  on public.stream_moderators for select to anon, authenticated
  using (
    revoked_at is null
    or user_id = auth.uid()
    or assigned_by_user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
```
→ Active assignments are public (every viewer's chat must paint "MOD" badges); revoked rows are visible only to the moderator, the assigner and admins.

**Triggers:** none.

---

## public.stream_moderation_actions

Immutable, append-only audit log of every manual moderation action. FKs are `SET NULL` (a deliberate deviation) so a host cannot erase the record by deleting the stream, and it outlives account deletion.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NULL | — |
| moderator_user_id | uuid | NULL | — |
| target_user_id | uuid | NULL | — |
| action_type | `stream_moderation_action_type` | NOT NULL | — |
| duration_seconds | integer | NULL | — |
| reason | text | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

> `duration_seconds`: mute as given, kick 900, platform ban 604800; NULL for an untimed mute, a stream ban (counted in streams) and all reversals.

**CHECK:** `(duration_seconds is null or duration_seconds > 0)`
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE SET NULL` · FK `moderator_user_id`, `target_user_id` → `auth.users(id) ON DELETE SET NULL`
**Indexes:** `stream_moderation_actions_pkey (id)`, `idx_stream_moderation_actions_stream_created (live_stream_id, created_at DESC)`, `idx_stream_moderation_actions_target_created (target_user_id, created_at DESC)`, `idx_stream_moderation_actions_moderator_created (moderator_user_id, created_at DESC)`
**Grants:** SELECT → authenticated; INSERT, UPDATE, DELETE revoked from anon, authenticated. **Written by:** the `stream_mod_*` action RPCs only.

**RLS: ENABLED** (1 policy)

```sql
create policy "Moderators and the target can read moderation actions"
  on public.stream_moderation_actions for select to authenticated
  using (
    target_user_id = auth.uid()
    or moderator_user_id = auth.uid()
    or public.stream_mod_is_moderator(live_stream_id, auth.uid())
  );
```
→ The target ("you were muted by X"), the acting moderator and the stream's moderators can read an action; it is never world-readable. No INSERT/UPDATE/DELETE policy.

**Triggers:** `trg_stream_moderation_actions_immutable` BEFORE UPDATE → `stream_mod_reject_audit_update()` (blocks every UPDATE, including service_role). DELETE is deliberately not trigger-blocked so FK cascades and account-erasure keep working.

---

## public.user_punishments

**Current** enforcement state (history is in `stream_moderation_actions`). One non-revoked row per (user, scope, type) — re-punishing updates that row. Scope: stream for mute/kick, broadcaster for stream_ban, platform for platform_ban. Read on every chat message and every stream join via `stream_mod_is_punished()`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| live_stream_id | uuid | NULL | — |
| punishment_type | `user_punishment_type` | NOT NULL | — |
| reason | text | NULL | — |
| issued_by_user_id | uuid | NULL | — |
| expires_at | timestamptz | NULL | — |
| revoked_at | timestamptz | NULL | — |
| revoked_by_user_id | uuid | NULL | — |
| broadcaster_user_id | uuid | NULL | — |
| origin_live_stream_id | uuid | NULL | — |
| origin_started_at | timestamptz | NULL | — |
| streams_covered | smallint | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `expires_at` is evaluated at read time (no cron): mute NULL = until lifted; kick always set (+15 min); platform_ban +7 days; stream_ban always NULL. The four `broadcaster_user_id … streams_covered` columns are stream_ban-only: the ban covers the origin stream plus the broadcaster's first `streams_covered − 1` streams started after `origin_started_at` (a snapshot, so deleting the origin stream — `origin_live_stream_id` becomes NULL — does not break the window). A spent stream ban stays unrevoked; clients must ask `stream_mod_is_punished()`, not "does a row exist".

**CHECK:** `user_punishments_scope_chk` — `platform_ban`: no stream/broadcaster columns; `mute`/`kick`: `live_stream_id` set, no stream-ban columns; `stream_ban`: `live_stream_id` NULL, `broadcaster_user_id`, `origin_started_at`, `streams_covered >= 1` set, `expires_at` NULL · `user_punishments_kick_expiry_chk` `(punishment_type <> 'kick' or expires_at is not null)`
**Keys:** PK `(id)` · FK `user_id → auth.users(id) ON DELETE CASCADE` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `issued_by_user_id`, `revoked_by_user_id` → `auth.users(id) ON DELETE SET NULL` · FK `broadcaster_user_id → auth.users(id) ON DELETE CASCADE` · FK `origin_live_stream_id → live_streams(id) ON DELETE SET NULL`
**Indexes:** `user_punishments_pkey (id)` · UNIQUE `uq_user_punishments_stream_scope_active (user_id, live_stream_id, punishment_type) WHERE revoked_at IS NULL AND live_stream_id IS NOT NULL` · UNIQUE `uq_user_punishments_platform_scope_active (user_id, punishment_type) WHERE revoked_at IS NULL AND punishment_type = 'platform_ban'` · UNIQUE `uq_user_punishments_stream_ban_active (user_id, broadcaster_user_id) WHERE punishment_type = 'stream_ban' AND revoked_at IS NULL` · `idx_user_punishments_active_lookup (user_id) INCLUDE (punishment_type, live_stream_id, expires_at, broadcaster_user_id, origin_live_stream_id, origin_started_at, streams_covered) WHERE revoked_at IS NULL` — **the hot index** (common case = one empty index-only probe) · `idx_user_punishments_stream_active (live_stream_id) WHERE revoked_at IS NULL AND live_stream_id IS NOT NULL` · `idx_user_punishments_broadcaster (broadcaster_user_id) WHERE broadcaster_user_id IS NOT NULL` · `idx_user_punishments_origin_stream (origin_live_stream_id) WHERE origin_live_stream_id IS NOT NULL`
**Grants:** SELECT → authenticated; INSERT/UPDATE/DELETE revoked from anon, authenticated. **Written by:** the `stream_mod_*` RPCs only.

**RLS: ENABLED** (1 policy)

```sql
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
```
→ You see your own punishments (so the app can explain why chat is disabled); admins see all; moderators see mute/kick rows of streams they moderate; a broadcaster sees every stream ban held in their name, and moderators of the ban's origin stream see it too.

**Triggers:** `update_user_punishments_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.profanity_dictionaries

Managed blocklist for the automated chat filter. Admin-only read — publishing it would hand spammers the bypass list; clients get the behaviour through the gate.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| word_or_pattern | text | NOT NULL | — |
| category | `profanity_category` | NOT NULL | `'profanity'` |
| language | text | NULL | — |
| match_whole_word | boolean | NOT NULL | `true` |
| is_active | boolean | NOT NULL | `true` |
| source | text | NOT NULL | `'custom'` |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `word_or_pattern` is a POSIX regex fragment (literal words must have metacharacters escaped); `match_whole_word = true` wraps it in `\m…\M`. `language` (`en` / `nl` / `srn`) is a curation hint only — every active row is always applied. `source`: `'ldnoobw'` (seed) or `'custom'`.

**CHECK:** `(length(btrim(word_or_pattern)) > 0)` · `(length(btrim(source)) > 0)`
**Keys:** PK `(id)`
**Indexes:** `profanity_dictionaries_pkey (id)`, UNIQUE `uq_profanity_dictionaries_pattern (lower(word_or_pattern))`, `idx_profanity_dictionaries_active (category) WHERE is_active`
**Grants:** SELECT, INSERT, UPDATE, DELETE → authenticated (all narrowed to admins by RLS).

**RLS: ENABLED** (4 policies)

```sql
create policy "Admins manage the profanity dictionary"
  on public.profanity_dictionaries for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
```sql
create policy "Admins can insert profanity rules"
  on public.profanity_dictionaries for insert to authenticated
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
```sql
create policy "Admins can update profanity rules"
  on public.profanity_dictionaries for update to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
```sql
create policy "Admins can delete profanity rules"
  on public.profanity_dictionaries for delete to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admin-only read, insert, update and delete (note the SELECT policy is the one named "manage").

**Triggers:** `update_profanity_dictionaries_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.stream_reports

Viewer-submitted reports for the admin queue. Inserted only through `stream_mod_report_submit()`. `message_text` is the **only chat text stored anywhere** in the schema (one reported message, kept inside its report).

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| reporter_user_id | uuid | NULL | — |
| live_stream_id | uuid | NULL | — |
| reported_user_id | uuid | NULL | — |
| message_id | uuid | NULL | — |
| message_text | text | NULL | — |
| message_sent_at | timestamptz | NULL | — |
| message_verified | boolean | NOT NULL | `false` |
| reason_category | `stream_report_reason` | NOT NULL | — |
| details | text | NULL | — |
| status | `stream_report_status` | NOT NULL | `'pending'` |
| reviewed_by_user_id | uuid | NULL | — |
| reviewed_at | timestamptz | NULL | — |
| resolution_notes | text | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

> `message_id` is the gate's id — no FK (there is no chat table). `message_verified = true` only when the supplied signature matches the gate's HMAC; an admin must never punish on unverified text alone. "A message report must name its sender" is enforced in the RPC, not a CHECK (a CHECK would make the `SET NULL` on account deletion fail).

**CHECK:** `stream_reports_message_fields_chk` — the three message fields are all NULL (with `message_verified = false`) or all set · `stream_reports_message_text_len_chk` `(message_text is null or char_length(message_text) <= 500)`
**Keys:** PK `(id)` · FK `reporter_user_id`, `reported_user_id`, `reviewed_by_user_id` → `auth.users(id) ON DELETE SET NULL` · FK `live_stream_id → live_streams(id) ON DELETE SET NULL`
**Indexes:** `stream_reports_pkey (id)` · UNIQUE `uq_stream_reports_pending_dedupe (reporter_user_id, COALESCE(live_stream_id, zero-uuid), COALESCE(reported_user_id, zero-uuid), COALESCE(message_id, zero-uuid)) WHERE status = 'pending'` (zero-uuid = `'00000000-0000-0000-0000-000000000000'`) · `idx_stream_reports_status_created (status, created_at DESC)` · `idx_stream_reports_reporter_created (reporter_user_id, created_at DESC)` · `idx_stream_reports_stream_created (live_stream_id, created_at DESC)` · `idx_stream_reports_reported_user (reported_user_id, created_at DESC) WHERE reported_user_id IS NOT NULL`
**Grants:** SELECT, UPDATE → authenticated; INSERT, DELETE revoked from anon, authenticated.

**RLS: ENABLED** (2 policies)

```sql
create policy "Reporters and admins can read stream reports"
  on public.stream_reports for select to authenticated
  using (
    reporter_user_id = auth.uid()
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );
```
→ Only the reporter and admins see a report — never the reported user (no retaliation trigger).

```sql
create policy "Admins can process stream reports"
  on public.stream_reports for update to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
```
→ Admins work the queue. No INSERT policy: submission must go through the RPC (rate limit, self-report check, server-side `message_verified`).

**Triggers:** `update_stream_reports_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.stream_chat_rate_state — **UNLOGGED**

Slow-mode bookkeeping for the chat gate: one row per (stream, user who chatted), counters and timestamps only — **no message text**. **UNLOGGED on purpose**: rewritten on every message and disposable, so it skips the WAL; after a crash Postgres empties it (only cooldowns reset), and it is not replicated or included in backups / point-in-time restore. An unlogged table may reference permanent tables (done here), but **no permanent table may ever FK to it**.

| column | type | null | default |
|---|---|---|---|
| live_stream_id | uuid | NOT NULL | — |
| user_id | uuid | NOT NULL | — |
| window_started_at | timestamptz | NOT NULL | — |
| messages_in_window | integer | NOT NULL | `0` |
| slow_until | timestamptz | NULL | — |
| last_attempt_allowed | boolean | NOT NULL | `true` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `(messages_in_window >= 0)`
**Keys:** PK `stream_chat_rate_state_pkey (live_stream_id, user_id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `user_id → auth.users(id) ON DELETE CASCADE`
**Indexes:** `stream_chat_rate_state_pkey` only.
**Grants:** `REVOKE ALL` from public, anon, authenticated — no client access at all.

**RLS: ENABLED** (0 policies) — clients can neither read nor write it; only `stream_mod_chat_gate()` (SECURITY DEFINER) touches it, in one atomic `INSERT … ON CONFLICT DO UPDATE` per message.

**Triggers:** none (`updated_at` is set by the gate itself).

---

## Migration 06 — the five live numbers, shares & deep links (`20260910_06_engagement_shares_deeplinks.sql`)

**The five live numbers** — live viewers · total views · hearts · chats · shares — are seen by everyone in
a stream, battle or co-hosting. They move **instantly via realtime room events** (presence join/leave or
the ZegoCloud user-count callback, reaction events, chat messages, and a share event sent only when
`live_share_record()` returns `counted = true`). Phones **re-sync** from `live_engagement_counts_*()` once
on open (and on the summary / ended-stream page) and then every few minutes — **never poll per second**.
Sources: live viewers = `live_stream_runtime.current_concurrent_viewers` (0 when not live); total views =
`total_views_live` while live, `live_streams.total_views` once ended (a stream ended outside
`live_stream_end_internal`, i.e. `end_reason` NULL, falls back to the larger of the two); hearts =
`live_stream_reaction_counts`; chats = `live_stream_chat_counts`; shares = snapshot + delta (below).

**Deep links** (app routing and the website fallback page are implementation work):
`https://lukuluku.online/live/<live_stream_id>` → `live_deeplink_resolve('live', id)` and
`https://lukuluku.online/battle/<battle_id>` → `live_deeplink_resolve('battle', id)`. Co-hosting has no link
of its own (the stream link is shared; the resolver adds the live partner). The resolver exists because
`live_streams` RLS hides ended streams from non-hosts; access needs the exact random UUID, so nothing can be
listed or guessed, and `zego_room_id` is never returned.

**Enums:** none by design (`share_channel` is checked text so new share targets need no migration).

**Functions** (all `SECURITY DEFINER`)

| function | security | callable by | purpose |
|---|---|---|---|
| `live_engagement_snapshot_internal(p_kind text, p_id uuid, OUT o_chat_count bigint, OUT o_share_count bigint, OUT o_as_of timestamptz)` | DEFINER, VOLATILE | private | Chat total (exact counter; 0 for battles) and share total = snapshot + rows after `snapshot_at`. If the snapshot is missing or older than 5 min and `pg_try_advisory_xact_lock` succeeds, recomputes it (cut 5 s in the past) — never blocks, never writes in a read-only transaction. Kinds `'stream'` / `'battle'`. |
| `live_engagement_viewers_internal(p_live_stream_id uuid, OUT o_live_viewers bigint, OUT o_total_views bigint)` | DEFINER, STABLE | private | The single live-viewers / total-views rule described above (two PK reads). |
| `live_engagement_counts_stream(p_live_stream_id uuid) → jsonb` | DEFINER, VOLATILE | anon, authenticated | `{chat_count, share_count, reaction_count, live_viewers, total_views, as_of}` for any existing stream, live or ended. |
| `live_engagement_counts_battle(p_battle_id uuid) → jsonb` | DEFINER, VOLATILE | anon, authenticated | `{battle_id, status, share_count (battle link), as_of, initiator:{…}, opponent:{…} or null}` — each side's whole-stream totals. |
| `live_engagement_counts_cohost(p_session_id uuid) → jsonb` | DEFINER, VOLATILE | anon, authenticated | `{session_id, status, started_at, ended_at, as_of, host:{…}, cohost:{…}}` — each side = its own stream's five numbers (reuses `live_engagement_counts_stream`) plus `points_in_session` from `gift_transactions.cohost_session_id`. |
| `live_share_record(p_live_stream_id uuid DEFAULT NULL, p_lk_battle_id uuid DEFAULT NULL, p_guest_key text DEFAULT NULL, p_share_channel text DEFAULT NULL) → jsonb` | DEFINER, VOLATILE | anon, authenticated | Counts a share of exactly one target. Identity = `auth.uid()`, else a guest key (8–64 chars; none ⇒ not recorded). At most one counted share per identity per target per **10 minutes** (advisory-locked). Never errors for "not counted"; returns `{counted, share_count, reason, as_of}` (`counted` / `cooldown` / `no_identity` / `not_shareable` — a never-started battle). Ended targets can still be shared. |
| `live_deeplink_stream_card_internal(p_live_stream_id uuid) → jsonb` | DEFINER, STABLE | private | Public-safe stream card: status (`live`/`ended`), title, times, category, host profile + channel (falls back to the host's channel), the host's other currently-live stream id. Never `zego_room_id`. |
| `live_deeplink_resolve(p_kind text, p_id uuid) → jsonb` | DEFINER, STABLE | anon, authenticated | Resolves a `'live'` or `'battle'` link (unknown kind raises). Unknown id ⇒ `{found:false}`. `live` adds `cohost` (session, role, partner card) while live in a co-hosting; `battle` returns status/result/end_method/winner/times/`cohost_session_id` and both stream cards; a never-started battle is reported as not found; penalty and invite timings are never returned. |

---

## public.live_engagement_counters

Lazy **share** snapshot cache — one row per target (a stream **or** a battle). Derived data only: every row may be dropped and is rebuilt on the next read. Chat and reaction totals are not here.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NULL | — |
| lk_battle_id | uuid | NULL | — |
| share_count_snapshot | bigint | NOT NULL | `0` |
| snapshot_at | timestamptz | NOT NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |
| updated_at | timestamptz | NOT NULL | `now()` |

**CHECK:** `live_engagement_counters_exactly_one_target_check` `(num_nonnulls(live_stream_id, lk_battle_id) = 1)` · `live_engagement_counters_share_check` `(share_count_snapshot >= 0)`
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `lk_battle_id → lk_battles(id) ON DELETE CASCADE`
**Indexes:** `live_engagement_counters_pkey (id)`, UNIQUE `live_engagement_counters_stream_uidx (live_stream_id) WHERE live_stream_id IS NOT NULL`, UNIQUE `live_engagement_counters_battle_uidx (lk_battle_id) WHERE lk_battle_id IS NOT NULL`
**Grants:** `REVOKE ALL` from public, anon, authenticated, then SELECT → authenticated (RLS narrows to admins). **Written by:** `live_engagement_snapshot_internal()` only.

**RLS: ENABLED** (1 policy)

```sql
create policy "Admins can read engagement counters"
  on public.live_engagement_counters
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));
```
→ Admins only; everyone else gets the numbers through the counts RPCs.

**Triggers:** `update_live_engagement_counters_updated_at` BEFORE UPDATE → `update_updated_at_column()`.

---

## public.live_shares

One row per **counted** share of a live stream or an LK battle. Written only by `live_share_record()`.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| live_stream_id | uuid | NULL | — |
| lk_battle_id | uuid | NULL | — |
| sharer_user_id | uuid | NULL | — |
| guest_key | text | NULL | — |
| share_channel | text | NULL | — |
| created_at | timestamptz | NOT NULL | `now()` |

> A row with both `sharer_user_id` and `guest_key` NULL = shared by an account since deleted (still counts). `share_channel` is an analytics hint (`whatsapp`, `copy_link`, …), lower-cased; anything not matching the pattern is stored as `'other'`. "At least one identity" is enforced in the RPC, not a CHECK (it would break the `SET NULL`).

**CHECK:** `live_shares_exactly_one_target_check` `(num_nonnulls(live_stream_id, lk_battle_id) = 1)` · `live_shares_identity_exclusive_check` `(sharer_user_id is null or guest_key is null)` · `live_shares_guest_key_check` `(guest_key is null or length(guest_key) between 8 and 64)` · `live_shares_share_channel_check` `(share_channel is null or share_channel ~ '^[a-z0-9_]{1,32}$')`
**Keys:** PK `(id)` · FK `live_stream_id → live_streams(id) ON DELETE CASCADE` · FK `lk_battle_id → lk_battles(id) ON DELETE CASCADE` · FK `sharer_user_id → auth.users(id) ON DELETE SET NULL`
**Indexes:** `live_shares_pkey (id)` · `live_shares_stream_created_idx (live_stream_id, created_at) WHERE live_stream_id IS NOT NULL` · `live_shares_battle_created_idx (lk_battle_id, created_at) WHERE lk_battle_id IS NOT NULL` · `live_shares_user_created_idx (sharer_user_id, created_at DESC) WHERE sharer_user_id IS NOT NULL` · `live_shares_guest_created_idx (guest_key, created_at DESC) WHERE guest_key IS NOT NULL`
**Grants:** `REVOKE ALL` from public, anon, authenticated, then SELECT → authenticated. anon has no table access.

**RLS: ENABLED** (2 policies)

```sql
create policy "Users can read their own live shares"
  on public.live_shares
  as permissive for select
  to authenticated
  using (sharer_user_id = (select auth.uid()));
```
→ A signed-in user sees only their own shares (rows reveal who shared what).

```sql
create policy "Admins can read all live shares"
  on public.live_shares
  as permissive for select
  to authenticated
  using (public.has_role((select auth.uid()), 'admin'::public.app_role));
```
→ Admins see all. Public totals come from the counts RPCs.

**Triggers:** none.

---

# Shared infrastructure

## Extensions enabled

`pg_cron` 1.6.4 (`pg_catalog`) · `pg_net` 0.20.0 (`public`) · `pg_stat_statements` 1.11 (`extensions`) ·
`pgcrypto` 1.3 (`extensions`) · `plpgsql` 1.0 · `supabase_vault` 0.3.1 (`vault`) · `uuid-ossp` 1.1 (`extensions`)

> `gen_random_uuid()` (from `pgcrypto`) is the default for every PK above. `pg_cron` and `pg_net` are present, so scheduled/HTTP-calling jobs are possible server-side.
> **Live-streaming use (migration 05):** the `pgcrypto` functions are called **schema-qualified** —
> `extensions.hmac(text, text, text)` (chat message signatures) and `extensions.gen_random_bytes(integer)`
> (key generation); the migration's preflight refuses to run without them. `supabase_vault` now holds the
> secret **`live_chat_signing_key`** (32 random bytes, hex; created once, never rotated by a re-run). It is
> read only by the private `stream_mod_chat_signing_key()` (EXECUTE revoked even from `service_role`) and is
> **never returned to any client**. `pg_trgm` is *not* enabled (the profanity filter uses one aggregated regex instead).

## pg_cron jobs

Scheduled by the live-streaming migrations (each file unschedules any job of the same name — and the old
hand-run draft names `live-stream-force-end-abandoned`, `lk-battles-expire-stale`, `lk-battles-settle-due` —
before scheduling, so none runs twice). Jobs run as the scheduling role (`postgres`, which owns the
functions), carry no JWT, so `auth.uid()` is NULL inside them; the functions allow that by design.

| job | schedule | command | what it does |
|---|---|---|---|
| `lk_live_force_end_abandoned` | `* * * * *` (every minute) | `select public.live_stream_force_end_abandoned(2);` | Ends every stream still `'live'` whose broadcaster heartbeat (`live_stream_runtime.host_last_seen_at`) is older than 2 minutes (= 4 missed 30-s heartbeats), with `end_reason = 'disconnected'` — so a dead stream closes within ~2–3 minutes. Streams that never sent a heartbeat are left alone. |
| `lk_battles_expire_stale` | `* * * * *` (every minute) | `select public.lk_battles_expire_stale();` | Lapses LK battle invites and co-host invites past `invite_expires_at` (→ `expired`, `ended_at = invite_expires_at`) and pending battle end requests past `expires_at`. |
| `lk_battles_settle_due` | `* * * * *` (every minute) | `select public.lk_battles_settle_due();` | Timer-settles live battles whose `ends_at` has passed and that no client settled (up to 500 per run). |

**Not scheduled** (suggestions in SQL comments only): `stream_chat_rate_state_prune` (daily delete of
rate-state rows older than a day — stale rows are harmless). No cron is needed for punishment expiry
(evaluated at read time), for the share snapshot cache (refreshed lazily), or for chat retention (no chat is stored).

## Storage buckets

All six buckets are **public: true** with **no file size limit and no MIME allowlist**.

| bucket | app usage |
|---|---|
| `videos` | video uploads |
| `thumbnails` | thumbnails |
| `avatars` | profile/channel images |
| `community-images` | Bangi post images |
| `media` | generic; `CreatePostScreen.tsx:184` resolves public URLs, `VideoPlayerScreen.tsx:935` removes objects |
| `ad-creatives` | ad creatives (admin/web) |

`storage.objects` RLS is **ENABLED**. The pattern across all buckets: public SELECT, and write access
gated on the **first path segment being the caller's UID** — `(auth.uid())::text = (storage.foldername(name))[1]`.
So every upload must be at `<uid>/…`.

```sql
CREATE POLICY "Public read for videos" ON storage.objects
    AS PERMISSIVE FOR SELECT TO {public}
    USING ((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])));
CREATE POLICY "Auth users can upload videos" ON storage.objects
    AS PERMISSIVE FOR INSERT TO {authenticated}
    WITH CHECK (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update their uploads" ON storage.objects
    AS PERMISSIVE FOR UPDATE TO {public}
    USING (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete their uploads" ON storage.objects
    AS PERMISSIVE FOR DELETE TO {public}
    USING (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));
```
→ The four content buckets: world-readable, owner-folder-scoped writes.

```sql
CREATE POLICY "Allow public view" ON storage.objects
    AS PERMISSIVE FOR SELECT TO {public} USING ((bucket_id = 'media'::text));
CREATE POLICY "Media uploads must be in own user folder" ON storage.objects
    AS PERMISSIVE FOR INSERT TO {authenticated}
    WITH CHECK (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update own media files" ON storage.objects
    AS PERMISSIVE FOR UPDATE TO {authenticated}
    USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete own media files" ON storage.objects
    AS PERMISSIVE FOR DELETE TO {authenticated}
    USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
```
→ Same rules for `media`. This is why `VideoPlayerScreen`'s delete only succeeds on objects under the user's own folder.

```sql
CREATE POLICY "Ad creatives are publicly viewable" ON storage.objects
    AS PERMISSIVE FOR SELECT TO {public} USING ((bucket_id = 'ad-creatives'::text));
CREATE POLICY "Authenticated users can upload ad creatives" ON storage.objects
    AS PERMISSIVE FOR INSERT TO {public}
    WITH CHECK (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update their own ad creatives" ON storage.objects
    AS PERMISSIVE FOR UPDATE TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete their own ad creatives" ON storage.objects
    AS PERMISSIVE FOR DELETE TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Admins can manage ad creatives" ON storage.objects
    AS PERMISSIVE FOR ALL TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND has_role(auth.uid(), 'admin'::app_role)));
```
→ `ad-creatives`: public read, owner-folder writes, plus full admin control.

## Trigger functions used by documented tables

| function | purpose |
|---|---|
| `update_updated_at_column()` | Sets `NEW.updated_at = now()`. Attached to `profiles`, `channels`, `videos`, `community_posts`, `content_claims`, `channel_memberships`, and (live-streaming migrations) `live_stream_runtime`, `live_stream_reaction_counts`, `live_stream_chat_counts`, `lk_battles`, `lk_battle_scores`, `live_cohost_sessions`, `gift_catalog`, `coin_packages`, `viewer_wallets`, `broadcaster_earnings`, `coin_purchases`, `user_punishments`, `profanity_dictionaries`, `stream_reports`, `live_engagement_counters`. **Not** `SECURITY DEFINER`. |
| `has_role(_user_id, _role)` | `SECURITY DEFINER` role check against `user_roles`; the gate in most admin policies. Body above. |
| `handle_new_user()` | On `auth.users` INSERT, creates the `profiles` row. |
| `tapins_sync_channel_count()` | Recounts `channels.tapiners` after any `tapins` insert/delete. Body above. |
| `notify_on_tapin()` | Inserts a `'tapin'` notification for the channel owner; self-tapins skipped. |
| `notify_on_comment()` | Inserts a `'comment'` notification for the video owner; post comments and self-comments skipped. |
| `notify_tapiners_on_new_video()` | On publish of a non-short video, inserts a `'new_video'` notification per opted-in tapiner. |
| `auto_promote_video()` | On video insert with `status='published' AND is_short=false`, creates the mirroring `community_posts` row (`auto_generated=true`). |
| `sync_short_to_video()` | Upserts each `shorts` row into `videos` with the same `id` and `is_short=true`; counters via `GREATEST`. Body above. |
| `delete_synced_short_video()` | Deletes the mirrored `videos` row when a `shorts` row is deleted. Body above. |
| `ad_requests_auto_live_on_paid()` | Flips `ad_requests.status` to `'live'` once `payment_status='paid'`; sets `reviewed_at`. Feeds `public_ads_active`. |
| `lk_battles_assert_single_active()` | *(03, SECURITY DEFINER)* BEFORE INSERT/UPDATE on `lk_battles` (`lk_battles_single_active_trg`) and `live_cohost_sessions` (`live_cohost_sessions_single_active_trg`): one active battle/co-host pairing per stream, except a battle linked to its own live co-host session; sorted advisory locks on the stream ids. |
| `stream_mod_reject_audit_update()` | *(05, not SECURITY DEFINER)* BEFORE UPDATE on `stream_moderation_actions` (`trg_stream_moderation_actions_immutable`): always raises — the audit log is append-only. |
| `stream_mod_block_banned_join()` | *(05, SECURITY DEFINER)* BEFORE INSERT on `live_stream_viewer_sessions` (`trg_stream_mod_block_banned_join`): refuses platform-banned, stream-ban-covered and kick-locked-out viewers. |
| `stream_mod_block_banned_host()` | *(05, SECURITY DEFINER)* BEFORE INSERT OR UPDATE OF status on `live_streams` (`trg_stream_mod_block_banned_host`): a platform-banned host cannot make a stream live. |

## RPCs the RN app calls

| RPC | called from | notes |
|---|---|---|
| `get_top3_rank_badges()` | `hooks/useRankBadges.ts:34`, `lib/supabase.ts:159` | `STABLE SECURITY DEFINER`. Returns `(user_id, channel_id, category, rank)` for the top 3 in each of `tapiners` / `views` / `posts` over a **7-day** window, counting `tapins`, `video_views` and non-auto-generated `community_posts`. SECURITY DEFINER is required — a client cannot count those tables itself. |
| `get_personalized_feed(p_user_id, p_limit, p_offset)` | `screens/HomeScreen.tsx:285` | See `user_category_interests` above. |
| `create_withdrawal(p_amount, p_method, p_destination)` | `lib/supabase.ts:169` | See `wallet_withdrawals` above. |
| `increment_ad_impression(p_ad_id)` | `screens/VideoPlayerScreen.tsx:295` | See `public_ads_active` above. |

Other public RPCs exist but are **not** called by the app: `admin_list_creator_finance`,
`can_enable_creator_monetization`, `evaluate_thumbnail_winner`, `get_channel_tapin_count`,
`get_my_creator_finance`, `get_poll_results`, `increment_post_likes`, `increment_thumbnail_click`,
`increment_thumbnail_impression`, `increment_video_views`, `increment_views`, `list_video_reactions`,
`nowpayments_on_confirm`, `post_like_counts`, `refund_failed_withdrawal`, `register_video_view`,
`track_user_interest`, `update_channel_tapiners`, `video_like_counts`, `weekly_top_posters`,
`weekly_top_tapiners`, `weekly_top_views`.

**Live-streaming RPCs** (`live_*`, `lk_battle_*`, `live_cohost_*`, `coin_*`, `gift_*`, `stream_mod_*`,
`live_engagement_*`, `live_share_record`, `live_deeplink_resolve`) exist in the database since
2026-09-11 but are **not yet called by any RN code** — the implementation phase is pending. Their
signatures, security mode and grants are listed per migration in the *LIVE STREAMING* section.

---

# Excluded as WEB/ADMIN-ONLY

Zero RN references and no dependency path from app code. Listed for completeness only.

`channel_social_links`, `fx_rates`, `mentions`, `nowpayments_payments`, `playlists`, `playlist_videos`,
`post_polls`, `post_poll_options`, `post_poll_votes`, `push_subscriptions`, `telegram_bot_state`,
`telegram_broadcasts`, `telegram_links`, `telegram_settings`, `uni5pay_ipn_logs`, `video_end_screens`,
`video_subtitles`, `video_thumbnail_variants`, `watch_history`, `watch_later`
— plus `ad_requests`, `comment_likes`, `video_engagements`, `moderation_violations` (flagged below)
and VIEW `creator_stats`.

Two notes worth carrying, since app-side TS types imply otherwise:
- **Polls** live in `post_polls` / `post_poll_options` / `post_poll_votes`, *not* in `community_posts`.
  The `CommunityPost` interface (`lib/supabase.ts:301-303`) declares `poll_question`, `poll_options`,
  `poll_ends_at` — none of these columns exist on `community_posts`.
- **`watch_history` / `watch_later`** have a `video_id` column but **no FK** to `videos`, so rows there
  outlive deleted videos.

---

## Needs Confirmation

Flagged rather than silently included or excluded.

1. **`verification_requests` — brief says exclude, evidence says APP-USED.** The task listed it among
   tables to drop, but the exclusion condition was "zero RN-code references", and it has three:
   `ProfileScreen.tsx:422` (reads own request), `ProfileScreen.tsx:768` (inserts one),
   `ChannelScreen.tsx:112` (reads request state). Documented in full above. **Confirm whether to keep it.**

2. **`ad_requests` — excluded per brief, but the app depends on it.** No direct `.from('ad_requests')`
   call, yet the app reads VIEW `public_ads_active` (which selects from it) and calls
   `increment_ad_impression()` (which UPDATEs it). Its columns are therefore not documented, but the
   view and the RPC are. **Confirm whether the underlying table should be documented too.**

3. **`user_blocks` and `content_reports` do not exist in the database.** `lib/communitySafety.ts:30`
   inserts into `user_blocks` and `:48` into `content_reports`. Neither table appears anywhere in the
   3072-line dump. Both calls are wrapped in `try {} catch {}` with comments saying "best-effort only",
   so **every block and every content report the app files is silently discarded server-side** and only
   the local queue survives. Nothing to document — but this looks like an unshipped migration rather
   than an intentional design. **Needs a decision, not just confirmation.**

4. **`notifications.post_id` does not exist.** `Notification` (`lib/supabase.ts:350`) declares it and
   `insertNotification` sends it on every insert (`:377`), which PostgREST will reject; the error is
   only `console.warn`-ed (`:382`). Post-like and reply notifications from the app never persist.
   **Confirm whether the column should be added or the client field dropped.**

5. **`comment_likes` — FK-linked to `comments` but no app path.** Zero RN references, and no trigger
   syncs it into `comments.likes`, so the counter the app reads is maintained elsewhere. Classified
   web-only; it would become SHARED if comment liking is meant to ship on mobile.

6. **`video_engagements` — FK-linked to `videos`, explicitly unreliable.** Zero RN references, and
   `lib/supabase.ts:74-75` states the app does not reliably populate it (the reason `fetchLeaderboard`
   avoids the `weekly_top_*` RPCs that read it). Excluded, but it is the table a real analytics/watch-time
   feature would use.

7. **`moderation_violations` — no references, no FKs, but the feature exists in-app.**
   `components/CommunitySafetyTools.tsx` and `lib/communitySafety.ts` implement moderation UI that never
   touches this table. Related to item 3; likely the same missing wiring.

8. **Type drift in `lib/supabase.ts` beyond the above** (documented at each table, listed here so it is
   not missed): `Video.duration` is `number | null` in TS but `text` in the DB; `Profile.email` has no
   backing column; `wallet_withdrawals.amount` is what the app reads while `create_withdrawal()` only
   writes `amount_srd` (so app-created withdrawals read as `0`); `WalletRow.walletType` uses
   `'bep20_usdt'` while the DB CHECK on `wallet_withdrawals.method` uses `'usdt_bep20'`.
