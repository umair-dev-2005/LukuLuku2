# LukuLuku — Mobile App Database Context

| | |
|---|---|
| **Generated** | 2026-09-09 |
| **Source dump** | `supabase/lukuluku_public_schema_dump.sql` (3072 lines, dumped 2026-09-09 15:25 UTC from live DB, PostgreSQL 17.6) |
| **Tables in `public`** | 47 total → **23 documented** (19 APP-USED + 4 SHARED), 24 excluded as web/admin-only |
| **Views in `public`** | 2 total → 1 documented (`public_ads_active`), 1 excluded (`creator_stats`) |
| **Classification signal** | `.from('…')` / `.rpc('…')` / `storage.from('…')` grep across all RN `.ts`/`.tsx`, then FK + RPC-dependency analysis |

Read-only reference. Contains no migration or `ALTER` statements. If the dump above is regenerated, this file is stale.

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
**Referenced by (10 FKs):** `videos`, `shorts`, `community_posts`, `tapins`, `channel_tips`, `channel_memberships`, `channel_members`, `channel_social_links`, `playlists`, `live_streams`
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
all app-used. `profiles`' admin-update policy queries it directly. Whether an app user can do anything
privileged is decided here.

| column | type | null | default |
|---|---|---|---|
| id | uuid | NOT NULL | `gen_random_uuid()` |
| user_id | uuid | NOT NULL | — |
| role | **`app_role`** | NOT NULL | — |

**ENUM `public.app_role`:** `'admin' | 'moderator' | 'user'` — the only custom enum in the `public` schema.
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

**Why shared:** FK-linked to `channels`, and it is the **already-existing live-streaming table** — the
direct starting point for the feature being built. Zero RN references today (grep finds no
`.from('live_streams')`), so it is currently web-only, but any new live-streaming design either extends
or replaces this table.

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

**Keys:** PK `(id)` · FK `channel_id → channels(id)` (**no** `ON DELETE` action) · FK `host_user_id → auth.users(id)` (**no** `ON DELETE` action)
> Both FKs are nullable and non-cascading, so deleting a channel or user is *blocked* while a stream row references it. No CHECK on `status`; no UNIQUE on `zego_room_id`; no index on `channel_id`, `host_user_id` or `status`.
> `zego_room_id NOT NULL` shows the existing implementation is built on **ZEGOCLOUD**.

**Indexes:** `live_streams_pkey (id)` only.

**RLS: ENABLED** (4 policies)

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
→ Host-only writes; `channel_id` is not checked against channel ownership. No admin/moderator policy exists, so **an admin cannot currently end someone else's stream** through the API.

**Triggers:** none — `ended_at` and `status` are not maintained automatically; a stream stays `'live'` until something explicitly updates it.

---

## auth.users (referenced only)

Not reproduced here. It is the identity root: 13 `public` foreign keys point at `auth.users(id)`
(`profiles`, `channels`, `videos`, `shorts`, `community_posts`, `tapins`, `comment_likes`,
`notifications.user_id`, `notifications.actor_id`, `user_roles`, `verification_requests`, `wallets`,
`live_streams.host_user_id`). `auth.uid()` in every policy above is this table's `id`.

**Trigger on it:** `on_auth_user_created` AFTER INSERT → `handle_new_user()` (SECURITY DEFINER) — inserts
the `profiles` row, taking `display_name` from `raw_user_meta_data->>'full_name'` / `'name'` /
`split_part(email,'@',1)` and `avatar_url` from `'avatar_url'` / `'picture'`. It does **not** set
`username` and does **not** create a `channels` row — `lib/auth.ts` (`ensureSupabaseProfile`,
`ensureChannelExists`) fills both gaps on first sign-in.

---

# Shared infrastructure

## Extensions enabled

`pg_cron` 1.6.4 (`pg_catalog`) · `pg_net` 0.20.0 (`public`) · `pg_stat_statements` 1.11 (`extensions`) ·
`pgcrypto` 1.3 (`extensions`) · `plpgsql` 1.0 · `supabase_vault` 0.3.1 (`vault`) · `uuid-ossp` 1.1 (`extensions`)

> `gen_random_uuid()` (from `pgcrypto`) is the default for every PK above. `pg_cron` and `pg_net` are present, so scheduled/HTTP-calling jobs are possible server-side.

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
| `update_updated_at_column()` | Sets `NEW.updated_at = now()`. Attached to `profiles`, `channels`, `videos`, `community_posts`, `content_claims`, `channel_memberships`. **Not** `SECURITY DEFINER`. |
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
