-- ============================================================
-- LUKULUKU — COMPLETE public SCHEMA DUMP
-- Generated: Wed Sep  9 15:25:43 UTC 2026 (UTC)
-- Source: live database (PostgreSQL 17.6)
-- ============================================================

-- ############ SECTION 7: EXTENSIONS ############
-- extension: pg_cron v1.6.4 in schema pg_catalog
-- extension: pg_net v0.20.0 in schema public
-- extension: pg_stat_statements v1.11 in schema extensions
-- extension: pgcrypto v1.3 in schema extensions
-- extension: plpgsql v1.0 in schema pg_catalog
-- extension: supabase_vault v0.3.1 in schema vault
-- extension: uuid-ossp v1.1 in schema extensions

-- ############ SECTION 4: CUSTOM TYPES / ENUMS ############
CREATE TYPE auth.aal_level AS ENUM ('aal1', 'aal2', 'aal3');
CREATE TYPE auth.code_challenge_method AS ENUM ('s256', 'plain');
CREATE TYPE auth.factor_status AS ENUM ('unverified', 'verified');
CREATE TYPE auth.factor_type AS ENUM ('totp', 'webauthn', 'phone');
CREATE TYPE auth.oauth_authorization_status AS ENUM ('pending', 'approved', 'denied', 'expired');
CREATE TYPE auth.oauth_client_type AS ENUM ('public', 'confidential');
CREATE TYPE auth.oauth_registration_type AS ENUM ('dynamic', 'manual');
CREATE TYPE auth.oauth_response_type AS ENUM ('code');
CREATE TYPE auth.one_time_token_type AS ENUM ('confirmation_token', 'reauthentication_token', 'recovery_token', 'email_change_token_new', 'email_change_token_current', 'phone_change_token');
CREATE TYPE net.request_status AS ENUM ('PENDING', 'SUCCESS', 'ERROR');
CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
CREATE TYPE realtime.action AS ENUM ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'ERROR');
CREATE TYPE realtime.equality_op AS ENUM ('eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'like', 'ilike', 'is', 'match', 'imatch', 'isdistinct');
CREATE TYPE storage.buckettype AS ENUM ('STANDARD', 'ANALYTICS', 'VECTOR');

-- ############ SECTIONS 1-3, 5: TABLES (columns, checks, keys, indexes, RLS) ############

-- ============================================================
-- TABLE: public.ad_requests
-- ============================================================
CREATE TABLE public.ad_requests (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NULL,
    company_name text NOT NULL,
    contact_name text NOT NULL,
    email text NOT NULL,
    phone text NULL,
    website text NULL,
    campaign_title text NOT NULL,
    campaign_description text NOT NULL,
    ad_type text NOT NULL,
    creative_url text NULL,
    cta_url text NULL,
    target_categories text[] NOT NULL DEFAULT '{}'::text[],
    target_language text NOT NULL DEFAULT 'both'::text,
    target_device text NOT NULL DEFAULT 'both'::text,
    preferred_start_date date NULL,
    duration_days integer NULL,
    budget_note text NULL,
    status text NOT NULL DEFAULT 'pending'::text,
    admin_notes text NULL,
    reviewed_by uuid NULL,
    reviewed_at timestamp with time zone NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    payment_method text NOT NULL DEFAULT 'invoice'::text,
    uni5pay_reference text NULL,
    payment_status text NOT NULL DEFAULT 'unpaid'::text,
    target_impressions integer NULL,
    impressions_count integer NOT NULL DEFAULT 0
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.ad_requests ADD CONSTRAINT ad_requests_ad_type_check CHECK ((ad_type = ANY (ARRAY['banner'::text, 'preroll'::text, 'sponsored'::text])));
ALTER TABLE public.ad_requests ADD CONSTRAINT ad_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'live'::text, 'ended'::text])));
ALTER TABLE public.ad_requests ADD CONSTRAINT ad_requests_target_device_check CHECK ((target_device = ANY (ARRAY['desktop'::text, 'mobile'::text, 'both'::text])));
ALTER TABLE public.ad_requests ADD CONSTRAINT ad_requests_target_language_check CHECK ((target_language = ANY (ARRAY['nl'::text, 'en'::text, 'both'::text])));
ALTER TABLE public.ad_requests ADD CONSTRAINT ad_requests_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX ad_requests_pkey ON public.ad_requests USING btree (id);
CREATE INDEX idx_ad_requests_created_at ON public.ad_requests USING btree (created_at DESC);
CREATE INDEX idx_ad_requests_status ON public.ad_requests USING btree (status);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can delete ad requests" ON public.ad_requests
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update ad requests" ON public.ad_requests
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can view all ad requests" ON public.ad_requests
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Anyone can submit an ad request" ON public.ad_requests
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK (((auth.uid() = user_id) OR (user_id IS NULL)));
CREATE POLICY "Users can view their own ad requests" ON public.ad_requests
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER trg_ad_requests_auto_live BEFORE UPDATE ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION ad_requests_auto_live_on_paid();
CREATE TRIGGER trg_ad_requests_auto_live_ins BEFORE INSERT ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION ad_requests_auto_live_on_paid();
CREATE TRIGGER update_ad_requests_updated_at BEFORE UPDATE ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.channel_members
-- ============================================================
CREATE TABLE public.channel_members (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    membership_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    uni5pay_reference text NULL,
    status text NOT NULL DEFAULT 'pending'::text,
    amount_srd numeric(10,2) NOT NULL,
    starts_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.channel_members ADD CONSTRAINT channel_members_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.channel_members ADD CONSTRAINT channel_members_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES channel_memberships(id) ON DELETE CASCADE;
ALTER TABLE public.channel_members ADD CONSTRAINT channel_members_pkey PRIMARY KEY (id);
ALTER TABLE public.channel_members ADD CONSTRAINT channel_members_channel_id_user_id_key UNIQUE (channel_id, user_id);
-- indexes:
CREATE UNIQUE INDEX channel_members_channel_id_user_id_key ON public.channel_members USING btree (channel_id, user_id);
CREATE UNIQUE INDEX channel_members_pkey ON public.channel_members USING btree (id);
CREATE INDEX idx_channel_members_user ON public.channel_members USING btree (user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins update memberships" ON public.channel_members
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((has_role(auth.uid(), 'admin'::app_role) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_members.channel_id) AND (c.user_id = auth.uid()))))));
CREATE POLICY "Users create own membership requests" ON public.channel_members
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users see own membership records" ON public.channel_members
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((auth.uid() = user_id) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_members.channel_id) AND (c.user_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
-- triggers:

-- ============================================================
-- TABLE: public.channel_memberships
-- ============================================================
CREATE TABLE public.channel_memberships (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    tier_name text NOT NULL DEFAULT 'Supporter'::text,
    monthly_amount_srd numeric(10,2) NOT NULL DEFAULT 0,
    perks text NULL,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.channel_memberships ADD CONSTRAINT channel_memberships_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.channel_memberships ADD CONSTRAINT channel_memberships_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX channel_memberships_pkey ON public.channel_memberships USING btree (id);
CREATE INDEX idx_channel_memberships_channel ON public.channel_memberships USING btree (channel_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Channel owner manages memberships" ON public.channel_memberships
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_memberships.channel_id) AND (c.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_memberships.channel_id) AND (c.user_id = auth.uid())))));
CREATE POLICY "Memberships viewable by everyone" ON public.channel_memberships
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:
CREATE TRIGGER memberships_updated BEFORE UPDATE ON public.channel_memberships FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.channel_social_links
-- ============================================================
CREATE TABLE public.channel_social_links (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    website_url text NULL,
    youtube_url text NULL,
    instagram_url text NULL,
    tiktok_url text NULL,
    x_url text NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.channel_social_links ADD CONSTRAINT channel_social_links_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.channel_social_links ADD CONSTRAINT channel_social_links_pkey PRIMARY KEY (id);
ALTER TABLE public.channel_social_links ADD CONSTRAINT channel_social_links_channel_id_key UNIQUE (channel_id);
-- indexes:
CREATE UNIQUE INDEX channel_social_links_channel_id_key ON public.channel_social_links USING btree (channel_id);
CREATE UNIQUE INDEX channel_social_links_pkey ON public.channel_social_links USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Channel social links are viewable by everyone" ON public.channel_social_links
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can delete social links for own channel" ON public.channel_social_links
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_social_links.channel_id) AND (c.user_id = auth.uid())))));
CREATE POLICY "Users can insert social links for own channel" ON public.channel_social_links
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_social_links.channel_id) AND (c.user_id = auth.uid())))));
CREATE POLICY "Users can update social links for own channel" ON public.channel_social_links
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_social_links.channel_id) AND (c.user_id = auth.uid())))));
-- triggers:
CREATE TRIGGER update_channel_social_links_updated_at BEFORE UPDATE ON public.channel_social_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.channel_tips
-- ============================================================
CREATE TABLE public.channel_tips (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    from_user_id uuid NULL,
    from_name text NULL,
    amount_srd numeric(10,2) NOT NULL,
    message text NULL,
    uni5pay_reference text NULL,
    status text NOT NULL DEFAULT 'pending'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    confirmed_at timestamp with time zone NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.channel_tips ADD CONSTRAINT channel_tips_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.channel_tips ADD CONSTRAINT channel_tips_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX channel_tips_pkey ON public.channel_tips USING btree (id);
CREATE INDEX idx_channel_tips_channel ON public.channel_tips USING btree (channel_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins or channel owner confirm tips" ON public.channel_tips
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((has_role(auth.uid(), 'admin'::app_role) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_tips.channel_id) AND (c.user_id = auth.uid()))))));
CREATE POLICY "Anyone can send a tip" ON public.channel_tips
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK (true);
CREATE POLICY "Confirmed tips viewable by everyone" ON public.channel_tips
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((status = 'confirmed'::text) OR (auth.uid() = from_user_id) OR (EXISTS ( SELECT 1
   FROM channels c
  WHERE ((c.id = channel_tips.channel_id) AND (c.user_id = auth.uid())))) OR has_role(auth.uid(), 'admin'::app_role)));
-- triggers:

-- ============================================================
-- TABLE: public.channels
-- ============================================================
CREATE TABLE public.channels (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    name text NOT NULL,
    handle text NULL,
    description text NULL,
    avatar_url text NULL,
    banner_url text NULL,
    tapiners integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    creator_boost boolean NOT NULL DEFAULT true,
    creator_boost_until timestamp with time zone NULL DEFAULT (now() + '30 days'::interval),
    monetization_enabled boolean NOT NULL DEFAULT false
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.channels ADD CONSTRAINT channels_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.channels ADD CONSTRAINT channels_pkey PRIMARY KEY (id);
ALTER TABLE public.channels ADD CONSTRAINT channels_handle_key UNIQUE (handle);
ALTER TABLE public.channels ADD CONSTRAINT channels_user_id_unique UNIQUE (user_id);
-- indexes:
CREATE UNIQUE INDEX channels_handle_key ON public.channels USING btree (handle);
CREATE UNIQUE INDEX channels_pkey ON public.channels USING btree (id);
CREATE UNIQUE INDEX channels_user_id_unique ON public.channels USING btree (user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Channels are viewable by everyone" ON public.channels
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can create their own channel" ON public.channels
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own channel" ON public.channels
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update their own channel" ON public.channels
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.comment_likes
-- ============================================================
CREATE TABLE public.comment_likes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NULL,
    comment_id uuid NULL,
    created_at timestamp without time zone NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.comment_likes ADD CONSTRAINT comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE public.comment_likes ADD CONSTRAINT comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.comment_likes ADD CONSTRAINT comment_likes_pkey PRIMARY KEY (id);
ALTER TABLE public.comment_likes ADD CONSTRAINT comment_likes_user_id_comment_id_key UNIQUE (user_id, comment_id);
-- indexes:
CREATE UNIQUE INDEX comment_likes_pkey ON public.comment_likes USING btree (id);
CREATE UNIQUE INDEX comment_likes_user_id_comment_id_key ON public.comment_likes USING btree (user_id, comment_id);
CREATE UNIQUE INDEX unique_like ON public.comment_likes USING btree (user_id, comment_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can delete own comment likes" ON public.comment_likes
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own comment likes" ON public.comment_likes
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own comment likes" ON public.comment_likes
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.comments
-- ============================================================
CREATE TABLE public.comments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    likes integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    post_id uuid NULL,
    parent_id uuid NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.comments ADD CONSTRAINT comments_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.comments ADD CONSTRAINT comments_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX comments_pkey ON public.comments USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Authenticated users can post comments" ON public.comments
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Comments are viewable by everyone" ON public.comments
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can delete their own comments" ON public.comments
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update their own comments" ON public.comments
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER trg_notify_on_comment AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION notify_on_comment();

-- ============================================================
-- TABLE: public.community_posts
-- ============================================================
CREATE TABLE public.community_posts (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    image_url text NULL,
    likes integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    video_id uuid NULL,
    auto_generated boolean NOT NULL DEFAULT false,
    background_color text NULL,
    text_color text NULL,
    background_style text NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.community_posts ADD CONSTRAINT community_posts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.community_posts ADD CONSTRAINT community_posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.community_posts ADD CONSTRAINT community_posts_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL;
ALTER TABLE public.community_posts ADD CONSTRAINT community_posts_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX community_posts_pkey ON public.community_posts USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Allow insert posts" ON public.community_posts
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Allow read posts" ON public.community_posts
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Community posts are viewable by everyone" ON public.community_posts
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can create posts for their channels" ON public.community_posts
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can delete their own posts" ON public.community_posts
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update their own posts" ON public.community_posts
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER update_community_posts_updated_at BEFORE UPDATE ON public.community_posts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.content_claims
-- ============================================================
CREATE TABLE public.content_claims (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    claimant_name text NOT NULL,
    claimant_user_id uuid NULL,
    claim_type text NOT NULL DEFAULT 'music'::text,
    claim_status text NOT NULL DEFAULT 'allow'::text,
    revenue_redirect boolean NOT NULL DEFAULT true,
    credit_text text NOT NULL DEFAULT ''::text,
    matched_content text NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.content_claims ADD CONSTRAINT content_claims_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.content_claims ADD CONSTRAINT content_claims_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX content_claims_pkey ON public.content_claims USING btree (id);
CREATE INDEX idx_content_claims_claimant_user ON public.content_claims USING btree (claimant_user_id) WHERE (claimant_user_id IS NOT NULL);
CREATE INDEX idx_content_claims_video_id ON public.content_claims USING btree (video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can delete claims" ON public.content_claims
    AS PERMISSIVE FOR DELETE
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can insert claims" ON public.content_claims
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can update claims" ON public.content_claims
    AS PERMISSIVE FOR UPDATE
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Claims are viewable by everyone" ON public.content_claims
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:
CREATE TRIGGER update_content_claims_updated_at BEFORE UPDATE ON public.content_claims FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.fx_rates
-- ============================================================
CREATE TABLE public.fx_rates (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    base text NOT NULL,
    quote text NOT NULL,
    rate numeric NOT NULL,
    source text NOT NULL DEFAULT 'wise'::text,
    fetched_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.fx_rates ADD CONSTRAINT fx_rates_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX fx_rates_pkey ON public.fx_rates USING btree (id);
CREATE INDEX idx_fx_rates_pair_time ON public.fx_rates USING btree (base, quote, fetched_at DESC);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Anyone can read fx rates" ON public.fx_rates
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:

-- ============================================================
-- TABLE: public.live_streams
-- ============================================================
CREATE TABLE public.live_streams (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    host_user_id uuid NULL,
    channel_id uuid NULL,
    title text NULL,
    category text NULL,
    status text NULL DEFAULT 'live'::text,
    zego_room_id text NOT NULL,
    started_at timestamp with time zone NULL DEFAULT now(),
    ended_at timestamp with time zone NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.live_streams ADD CONSTRAINT live_streams_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id);
ALTER TABLE public.live_streams ADD CONSTRAINT live_streams_host_user_id_fkey FOREIGN KEY (host_user_id) REFERENCES auth.users(id);
ALTER TABLE public.live_streams ADD CONSTRAINT live_streams_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX live_streams_pkey ON public.live_streams USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Anyone can view live streams" ON public.live_streams
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((status = 'live'::text) OR (host_user_id = auth.uid())));
CREATE POLICY "Hosts can create their own live stream" ON public.live_streams
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = host_user_id));
CREATE POLICY "Hosts can delete their own live stream" ON public.live_streams
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = host_user_id));
CREATE POLICY "Hosts can update their own live stream" ON public.live_streams
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = host_user_id))
    WITH CHECK ((auth.uid() = host_user_id));
-- triggers:

-- ============================================================
-- TABLE: public.mentions
-- ============================================================
CREATE TABLE public.mentions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    mentioned_user_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.mentions ADD CONSTRAINT mentions_source_type_check CHECK ((source_type = ANY (ARRAY['comment'::text, 'post'::text])));
ALTER TABLE public.mentions ADD CONSTRAINT mentions_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_mentions_user ON public.mentions USING btree (mentioned_user_id, created_at DESC);
CREATE UNIQUE INDEX mentions_pkey ON public.mentions USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Mentions viewable by mentioned and actor" ON public.mentions
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((auth.uid() = mentioned_user_id) OR (auth.uid() = actor_id)));
CREATE POLICY "Users create mentions as themselves" ON public.mentions
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = actor_id));
-- triggers:

-- ============================================================
-- TABLE: public.moderation_violations
-- ============================================================
CREATE TABLE public.moderation_violations (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    content_type text NOT NULL,
    reason text NOT NULL,
    scores jsonb NULL,
    file_path text NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.moderation_violations ADD CONSTRAINT moderation_violations_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_moderation_violations_user ON public.moderation_violations USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX moderation_violations_pkey ON public.moderation_violations USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can view all violations" ON public.moderation_violations
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Anyone authenticated can insert own violations" ON public.moderation_violations
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own violations" ON public.moderation_violations
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.notifications
-- ============================================================
CREATE TABLE public.notifications (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NULL,
    actor_id uuid NULL,
    type text NULL,
    video_id uuid NULL,
    read boolean NULL DEFAULT false,
    created_at timestamp with time zone NULL DEFAULT timezone('utc'::text, now()),
    title text NULL,
    body text NULL,
    link text NULL,
    sent_telegram boolean NOT NULL DEFAULT false,
    sent_push boolean NOT NULL DEFAULT false
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (((type IS NULL) OR (type = ANY (ARRAY['like'::text, 'comment'::text, 'system'::text, 'new_video'::text, 'tapin'::text, 'mention'::text, 'reply'::text, 'post_like'::text, 'follow'::text]))));
ALTER TABLE public.notifications ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can delete own notifications" ON public.notifications
    AS PERMISSIVE FOR DELETE
    TO {authenticated}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert notifications as themselves" ON public.notifications
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK ((auth.uid() = actor_id));
CREATE POLICY "Users can see own notifications" ON public.notifications
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own notifications" ON public.notifications
    AS PERMISSIVE FOR UPDATE
    TO {authenticated}
    USING ((auth.uid() = user_id))
    WITH CHECK ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.nowpayments_payments
-- ============================================================
CREATE TABLE public.nowpayments_payments (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NULL,
    purpose text NOT NULL,
    reference_id uuid NULL,
    reference_table text NULL,
    channel_id uuid NULL,
    amount_usd numeric(10,2) NOT NULL,
    pay_currency text NULL,
    status text NOT NULL DEFAULT 'waiting'::text,
    np_order_id text NULL,
    np_payment_id text NULL,
    np_invoice_id text NULL,
    np_invoice_url text NULL,
    pay_address text NULL,
    pay_amount numeric NULL,
    actually_paid numeric NULL,
    message text NULL,
    from_name text NULL,
    email text NULL,
    raw_callback jsonb NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.nowpayments_payments ADD CONSTRAINT nowpayments_payments_amount_usd_check CHECK ((amount_usd > (0)::numeric));
ALTER TABLE public.nowpayments_payments ADD CONSTRAINT nowpayments_payments_purpose_check CHECK ((purpose = ANY (ARRAY['advertise'::text, 'tip'::text, 'membership'::text, 'support'::text])));
ALTER TABLE public.nowpayments_payments ADD CONSTRAINT nowpayments_payments_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'confirming'::text, 'confirmed'::text, 'sending'::text, 'partially_paid'::text, 'finished'::text, 'failed'::text, 'refunded'::text, 'expired'::text])));
ALTER TABLE public.nowpayments_payments ADD CONSTRAINT nowpayments_payments_pkey PRIMARY KEY (id);
ALTER TABLE public.nowpayments_payments ADD CONSTRAINT nowpayments_payments_np_order_id_key UNIQUE (np_order_id);
-- indexes:
CREATE INDEX idx_nowpayments_ref ON public.nowpayments_payments USING btree (reference_table, reference_id);
CREATE INDEX idx_nowpayments_status ON public.nowpayments_payments USING btree (status);
CREATE INDEX idx_nowpayments_user ON public.nowpayments_payments USING btree (user_id);
CREATE UNIQUE INDEX nowpayments_payments_np_order_id_key ON public.nowpayments_payments USING btree (np_order_id);
CREATE UNIQUE INDEX nowpayments_payments_pkey ON public.nowpayments_payments USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins update payments" ON public.nowpayments_payments
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "No client inserts on nowpayments_payments" ON public.nowpayments_payments
    AS PERMISSIVE FOR INSERT
    TO {anon,authenticated}
    WITH CHECK (false);
CREATE POLICY "Users view own payments" ON public.nowpayments_payments
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((auth.uid() = user_id) OR has_role(auth.uid(), 'admin'::app_role)));
-- triggers:
CREATE TRIGGER nowpayments_set_updated_at BEFORE UPDATE ON public.nowpayments_payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER nowpayments_status_change AFTER UPDATE ON public.nowpayments_payments FOR EACH ROW EXECUTE FUNCTION nowpayments_on_confirm();

-- ============================================================
-- TABLE: public.playlist_videos
-- ============================================================
CREATE TABLE public.playlist_videos (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    playlist_id uuid NOT NULL,
    video_id uuid NOT NULL,
    "position" integer NOT NULL DEFAULT 0,
    added_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.playlist_videos ADD CONSTRAINT playlist_videos_playlist_id_fkey FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE;
ALTER TABLE public.playlist_videos ADD CONSTRAINT playlist_videos_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.playlist_videos ADD CONSTRAINT playlist_videos_pkey PRIMARY KEY (id);
ALTER TABLE public.playlist_videos ADD CONSTRAINT playlist_videos_playlist_id_video_id_key UNIQUE (playlist_id, video_id);
-- indexes:
CREATE INDEX idx_playlist_videos_playlist ON public.playlist_videos USING btree (playlist_id, "position");
CREATE UNIQUE INDEX playlist_videos_pkey ON public.playlist_videos USING btree (id);
CREATE UNIQUE INDEX playlist_videos_playlist_id_video_id_key ON public.playlist_videos USING btree (playlist_id, video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Owner manages playlist videos" ON public.playlist_videos
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM playlists p
  WHERE ((p.id = playlist_videos.playlist_id) AND (p.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM playlists p
  WHERE ((p.id = playlist_videos.playlist_id) AND (p.user_id = auth.uid())))));
CREATE POLICY "Playlist videos viewable by everyone" ON public.playlist_videos
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:

-- ============================================================
-- TABLE: public.playlists
-- ============================================================
CREATE TABLE public.playlists (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    title text NOT NULL,
    description text NULL,
    thumbnail_url text NULL,
    visibility text NOT NULL DEFAULT 'public'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.playlists ADD CONSTRAINT playlists_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.playlists ADD CONSTRAINT playlists_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_playlists_channel ON public.playlists USING btree (channel_id);
CREATE UNIQUE INDEX playlists_pkey ON public.playlists USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Public playlists viewable by everyone" ON public.playlists
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR (auth.uid() = user_id)));
CREATE POLICY "Users create own playlists" ON public.playlists
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users delete own playlists" ON public.playlists
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users update own playlists" ON public.playlists
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER playlists_updated BEFORE UPDATE ON public.playlists FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.post_likes
-- ============================================================
CREATE TABLE public.post_likes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    post_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    reaction_type text NOT NULL DEFAULT 'like'::text
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE;
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_pkey PRIMARY KEY (id);
ALTER TABLE public.post_likes ADD CONSTRAINT post_likes_post_id_user_id_key UNIQUE (post_id, user_id);
-- indexes:
CREATE UNIQUE INDEX post_likes_pkey ON public.post_likes USING btree (id);
CREATE UNIQUE INDEX post_likes_post_id_user_id_key ON public.post_likes USING btree (post_id, user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can delete own post likes" ON public.post_likes
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own post likes" ON public.post_likes
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own post likes" ON public.post_likes
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.post_poll_options
-- ============================================================
CREATE TABLE public.post_poll_options (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    poll_id uuid NOT NULL,
    option_text text NOT NULL,
    "position" integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.post_poll_options ADD CONSTRAINT post_poll_options_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES post_polls(id) ON DELETE CASCADE;
ALTER TABLE public.post_poll_options ADD CONSTRAINT post_poll_options_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_poll_options_poll ON public.post_poll_options USING btree (poll_id);
CREATE UNIQUE INDEX post_poll_options_pkey ON public.post_poll_options USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Poll options viewable by everyone" ON public.post_poll_options
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Post owner manages options" ON public.post_poll_options
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM (post_polls pp
     JOIN community_posts p ON ((p.id = pp.post_id)))
  WHERE ((pp.id = post_poll_options.poll_id) AND (p.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM (post_polls pp
     JOIN community_posts p ON ((p.id = pp.post_id)))
  WHERE ((pp.id = post_poll_options.poll_id) AND (p.user_id = auth.uid())))));
-- triggers:

-- ============================================================
-- TABLE: public.post_poll_votes
-- ============================================================
CREATE TABLE public.post_poll_votes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    poll_id uuid NOT NULL,
    option_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.post_poll_votes ADD CONSTRAINT post_poll_votes_option_id_fkey FOREIGN KEY (option_id) REFERENCES post_poll_options(id) ON DELETE CASCADE;
ALTER TABLE public.post_poll_votes ADD CONSTRAINT post_poll_votes_poll_id_fkey FOREIGN KEY (poll_id) REFERENCES post_polls(id) ON DELETE CASCADE;
ALTER TABLE public.post_poll_votes ADD CONSTRAINT post_poll_votes_pkey PRIMARY KEY (id);
ALTER TABLE public.post_poll_votes ADD CONSTRAINT post_poll_votes_poll_id_user_id_key UNIQUE (poll_id, user_id);
-- indexes:
CREATE INDEX idx_poll_votes_poll ON public.post_poll_votes USING btree (poll_id);
CREATE UNIQUE INDEX post_poll_votes_pkey ON public.post_poll_votes USING btree (id);
CREATE UNIQUE INDEX post_poll_votes_poll_id_user_id_key ON public.post_poll_votes USING btree (poll_id, user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users remove own vote" ON public.post_poll_votes
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users see own poll votes" ON public.post_poll_votes
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users vote once" ON public.post_poll_votes
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.post_polls
-- ============================================================
CREATE TABLE public.post_polls (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    post_id uuid NOT NULL,
    question text NOT NULL,
    expires_at timestamp with time zone NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.post_polls ADD CONSTRAINT post_polls_pkey PRIMARY KEY (id);
ALTER TABLE public.post_polls ADD CONSTRAINT post_polls_post_id_key UNIQUE (post_id);
-- indexes:
CREATE UNIQUE INDEX post_polls_pkey ON public.post_polls USING btree (id);
CREATE UNIQUE INDEX post_polls_post_id_key ON public.post_polls USING btree (post_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Polls viewable by everyone" ON public.post_polls
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Post owner creates poll" ON public.post_polls
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((EXISTS ( SELECT 1
   FROM community_posts p
  WHERE ((p.id = post_polls.post_id) AND (p.user_id = auth.uid())))));
CREATE POLICY "Post owner deletes poll" ON public.post_polls
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM community_posts p
  WHERE ((p.id = post_polls.post_id) AND (p.user_id = auth.uid())))));
-- triggers:

-- ============================================================
-- TABLE: public.profiles
-- ============================================================
CREATE TABLE public.profiles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    display_name text NULL,
    username text NULL,
    avatar_url text NULL,
    bio text NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    verification_type text NULL DEFAULT 'none'::text,
    is_admin boolean NULL DEFAULT false,
    is_founder_team boolean NULL DEFAULT false,
    is_monetized boolean NULL DEFAULT false,
    standard_share_pct numeric NULL DEFAULT 70.00,
    bonus_share_pct numeric NULL DEFAULT 0.00,
    is_verified boolean NULL DEFAULT false,
    notify_telegram boolean NOT NULL DEFAULT true,
    notify_push boolean NOT NULL DEFAULT true,
    notify_new_video_from_tapins boolean NOT NULL DEFAULT true
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.profiles ADD CONSTRAINT profiles_verification_type_check CHECK ((verification_type = ANY (ARRAY['none'::text, 'default'::text, 'music'::text, 'business_politics'::text, 'film'::text])));
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_username_key UNIQUE (username);
-- indexes:
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE UNIQUE INDEX profiles_user_id_key ON public.profiles USING btree (user_id);
CREATE UNIQUE INDEX profiles_username_key ON public.profiles USING btree (username);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can update verification status" ON public.profiles
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING (((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::app_role)))) OR (auth.uid() = user_id)));
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can insert their own profile" ON public.profiles
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update their own profile safe" ON public.profiles
    AS PERMISSIVE FOR UPDATE
    TO {public}
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
-- triggers:
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.push_subscriptions
-- ============================================================
CREATE TABLE public.push_subscriptions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    user_agent text NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);
ALTER TABLE public.push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);
-- indexes:
CREATE UNIQUE INDEX push_subscriptions_endpoint_key ON public.push_subscriptions USING btree (endpoint);
CREATE UNIQUE INDEX push_subscriptions_pkey ON public.push_subscriptions USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users manage own push subs" ON public.push_subscriptions
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((auth.uid() = user_id))
    WITH CHECK ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.shorts
-- ============================================================
CREATE TABLE public.shorts (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    description text NULL,
    video_url text NULL,
    thumbnail_url text NULL,
    views integer NOT NULL DEFAULT 0,
    likes integer NOT NULL DEFAULT 0,
    dislikes integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'published'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.shorts ADD CONSTRAINT shorts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.shorts ADD CONSTRAINT shorts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.shorts ADD CONSTRAINT shorts_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX shorts_pkey ON public.shorts USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Published shorts viewable by everyone" ON public.shorts
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((status = 'published'::text) OR (auth.uid() = user_id)));
CREATE POLICY "Users can delete own shorts" ON public.shorts
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own shorts" ON public.shorts
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can upload shorts" ON public.shorts
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER delete_synced_short_video_trigger AFTER DELETE ON public.shorts FOR EACH ROW EXECUTE FUNCTION delete_synced_short_video();
CREATE TRIGGER sync_short_to_video_trigger AFTER INSERT OR UPDATE ON public.shorts FOR EACH ROW EXECUTE FUNCTION sync_short_to_video();

-- ============================================================
-- TABLE: public.tapins
-- ============================================================
CREATE TABLE public.tapins (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.tapins ADD CONSTRAINT tapins_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.tapins ADD CONSTRAINT tapins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.tapins ADD CONSTRAINT tapins_pkey PRIMARY KEY (id);
ALTER TABLE public.tapins ADD CONSTRAINT tapins_user_id_channel_id_key UNIQUE (user_id, channel_id);
-- indexes:
CREATE UNIQUE INDEX tapins_pkey ON public.tapins USING btree (id);
CREATE UNIQUE INDEX tapins_user_id_channel_id_key ON public.tapins USING btree (user_id, channel_id);
CREATE UNIQUE INDEX unique_tapin_per_user_channel ON public.tapins USING btree (user_id, channel_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can tapin" ON public.tapins
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can untapin" ON public.tapins
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can view their own tapins" ON public.tapins
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER trg_notify_on_tapin AFTER INSERT ON public.tapins FOR EACH ROW EXECUTE FUNCTION notify_on_tapin();
CREATE TRIGGER trg_tapins_sync_count AFTER INSERT OR DELETE ON public.tapins FOR EACH ROW EXECUTE FUNCTION tapins_sync_channel_count();

-- ============================================================
-- TABLE: public.telegram_bot_state
-- ============================================================
CREATE TABLE public.telegram_bot_state (
    id integer NOT NULL,
    update_offset bigint NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.telegram_bot_state ADD CONSTRAINT telegram_bot_state_id_check CHECK ((id = 1));
ALTER TABLE public.telegram_bot_state ADD CONSTRAINT telegram_bot_state_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX telegram_bot_state_pkey ON public.telegram_bot_state USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins view bot state" ON public.telegram_bot_state
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
-- triggers:

-- ============================================================
-- TABLE: public.telegram_broadcasts
-- ============================================================
CREATE TABLE public.telegram_broadcasts (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    telegram_message_id bigint NULL,
    sent_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.telegram_broadcasts ADD CONSTRAINT telegram_broadcasts_pkey PRIMARY KEY (id);
ALTER TABLE public.telegram_broadcasts ADD CONSTRAINT telegram_broadcasts_source_type_source_id_key UNIQUE (source_type, source_id);
-- indexes:
CREATE UNIQUE INDEX telegram_broadcasts_pkey ON public.telegram_broadcasts USING btree (id);
CREATE UNIQUE INDEX telegram_broadcasts_source_type_source_id_key ON public.telegram_broadcasts USING btree (source_type, source_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins view broadcasts" ON public.telegram_broadcasts
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
-- triggers:

-- ============================================================
-- TABLE: public.telegram_links
-- ============================================================
CREATE TABLE public.telegram_links (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    telegram_chat_id bigint NULL,
    telegram_username text NULL,
    link_code text NULL,
    link_code_expires_at timestamp with time zone NULL,
    linked_at timestamp with time zone NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.telegram_links ADD CONSTRAINT telegram_links_pkey PRIMARY KEY (id);
ALTER TABLE public.telegram_links ADD CONSTRAINT telegram_links_link_code_key UNIQUE (link_code);
ALTER TABLE public.telegram_links ADD CONSTRAINT telegram_links_telegram_chat_id_key UNIQUE (telegram_chat_id);
ALTER TABLE public.telegram_links ADD CONSTRAINT telegram_links_user_id_key UNIQUE (user_id);
-- indexes:
CREATE UNIQUE INDEX telegram_links_link_code_key ON public.telegram_links USING btree (link_code);
CREATE UNIQUE INDEX telegram_links_pkey ON public.telegram_links USING btree (id);
CREATE UNIQUE INDEX telegram_links_telegram_chat_id_key ON public.telegram_links USING btree (telegram_chat_id);
CREATE UNIQUE INDEX telegram_links_user_id_key ON public.telegram_links USING btree (user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users delete own telegram link" ON public.telegram_links
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users insert own telegram link" ON public.telegram_links
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users update own telegram link" ON public.telegram_links
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users view own telegram link" ON public.telegram_links
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER update_telegram_links_updated_at BEFORE UPDATE ON public.telegram_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.telegram_settings
-- ============================================================
CREATE TABLE public.telegram_settings (
    id integer NOT NULL,
    chat_id text NULL,
    broadcast_videos boolean NOT NULL DEFAULT true,
    broadcast_bangi boolean NOT NULL DEFAULT true,
    broadcast_momenti boolean NOT NULL DEFAULT true,
    site_url text NOT NULL DEFAULT 'https://lukuluku.online'::text,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.telegram_settings ADD CONSTRAINT telegram_settings_id_check CHECK ((id = 1));
ALTER TABLE public.telegram_settings ADD CONSTRAINT telegram_settings_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX telegram_settings_pkey ON public.telegram_settings USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins manage telegram settings" ON public.telegram_settings
    AS PERMISSIVE FOR ALL
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role))
    WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
-- triggers:

-- ============================================================
-- TABLE: public.uni5pay_ipn_logs
-- ============================================================
CREATE TABLE public.uni5pay_ipn_logs (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    mcht_order_no text NULL,
    status text NULL,
    order_no text NULL,
    ext_order_no text NULL,
    raw_payload jsonb NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.uni5pay_ipn_logs ADD CONSTRAINT uni5pay_ipn_logs_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_uni5pay_ipn_logs_created_at ON public.uni5pay_ipn_logs USING btree (created_at DESC);
CREATE UNIQUE INDEX uni5pay_ipn_logs_pkey ON public.uni5pay_ipn_logs USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can view uni5pay ipn logs" ON public.uni5pay_ipn_logs
    AS PERMISSIVE FOR SELECT
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
-- triggers:

-- ============================================================
-- TABLE: public.user_category_interests
-- ============================================================
CREATE TABLE public.user_category_interests (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    category text NOT NULL,
    score numeric NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.user_category_interests ADD CONSTRAINT user_category_interests_pkey PRIMARY KEY (id);
ALTER TABLE public.user_category_interests ADD CONSTRAINT user_category_interests_user_id_category_key UNIQUE (user_id, category);
-- indexes:
CREATE INDEX idx_user_interests_user_score ON public.user_category_interests USING btree (user_id, score DESC);
CREATE UNIQUE INDEX user_category_interests_pkey ON public.user_category_interests USING btree (id);
CREATE UNIQUE INDEX user_category_interests_user_id_category_key ON public.user_category_interests USING btree (user_id, category);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can update own interests" ON public.user_category_interests
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can upsert own interests" ON public.user_category_interests
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own interests" ON public.user_category_interests
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.user_roles
-- ============================================================
CREATE TABLE public.user_roles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    role app_role NOT NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);
-- indexes:
CREATE UNIQUE INDEX user_roles_pkey ON public.user_roles USING btree (id);
CREATE UNIQUE INDEX user_roles_user_id_role_key ON public.user_roles USING btree (user_id, role);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can view all roles" ON public.user_roles
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users can view own roles" ON public.user_roles
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.verification_requests
-- ============================================================
CREATE TABLE public.verification_requests (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    message text NULL,
    status text NOT NULL DEFAULT 'pending'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    tiktok_url text NULL,
    youtube_url text NULL,
    facebook_url text NULL,
    instagram_url text NULL,
    press_links text NULL,
    about text NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.verification_requests ADD CONSTRAINT verification_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.verification_requests ADD CONSTRAINT verification_requests_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX verification_requests_pkey ON public.verification_requests USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins can update verification requests" ON public.verification_requests
    AS PERMISSIVE FOR UPDATE
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins can view all verification requests" ON public.verification_requests
    AS PERMISSIVE FOR SELECT
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users can create verification requests" ON public.verification_requests
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own verification requests" ON public.verification_requests
    AS PERMISSIVE FOR SELECT
    TO {authenticated}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.video_end_screens
-- ============================================================
CREATE TABLE public.video_end_screens (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    show_seconds integer NOT NULL DEFAULT 20,
    cta_text text NULL DEFAULT 'Tapin voor meer'::text,
    suggested_video_ids uuid[] NULL DEFAULT '{}'::uuid[],
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_end_screens ADD CONSTRAINT video_end_screens_pkey PRIMARY KEY (id);
ALTER TABLE public.video_end_screens ADD CONSTRAINT video_end_screens_video_id_key UNIQUE (video_id);
-- indexes:
CREATE UNIQUE INDEX video_end_screens_pkey ON public.video_end_screens USING btree (id);
CREATE UNIQUE INDEX video_end_screens_video_id_key ON public.video_end_screens USING btree (video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "End screens viewable by everyone" ON public.video_end_screens
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Owner manages end screen" ON public.video_end_screens
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_end_screens.video_id) AND (v.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_end_screens.video_id) AND (v.user_id = auth.uid())))));
-- triggers:
CREATE TRIGGER update_video_end_screens_updated_at BEFORE UPDATE ON public.video_end_screens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.video_engagements
-- ============================================================
CREATE TABLE public.video_engagements (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    video_id uuid NOT NULL,
    engagement_type text NOT NULL,
    watch_seconds integer NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_engagements ADD CONSTRAINT video_engagements_engagement_type_check CHECK ((engagement_type = ANY (ARRAY['watch'::text, 'like'::text, 'comment'::text, 'share'::text])));
ALTER TABLE public.video_engagements ADD CONSTRAINT video_engagements_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.video_engagements ADD CONSTRAINT video_engagements_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_engagements_type ON public.video_engagements USING btree (user_id, engagement_type);
CREATE INDEX idx_engagements_user ON public.video_engagements USING btree (user_id);
CREATE INDEX idx_engagements_video ON public.video_engagements USING btree (video_id);
CREATE UNIQUE INDEX video_engagements_pkey ON public.video_engagements USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can insert own engagements" ON public.video_engagements
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view own engagements" ON public.video_engagements
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.video_likes
-- ============================================================
CREATE TABLE public.video_likes (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    user_id uuid NOT NULL,
    like_type text NOT NULL DEFAULT 'like'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_likes ADD CONSTRAINT video_likes_like_type_check CHECK ((like_type = ANY (ARRAY['like'::text, 'heart'::text])));
ALTER TABLE public.video_likes ADD CONSTRAINT video_likes_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.video_likes ADD CONSTRAINT video_likes_pkey PRIMARY KEY (id);
ALTER TABLE public.video_likes ADD CONSTRAINT video_likes_video_id_user_id_like_type_key UNIQUE (video_id, user_id, like_type);
-- indexes:
CREATE UNIQUE INDEX video_likes_pkey ON public.video_likes USING btree (id);
CREATE UNIQUE INDEX video_likes_video_id_user_id_like_type_key ON public.video_likes USING btree (video_id, user_id, like_type);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can delete their own likes" ON public.video_likes
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own likes" ON public.video_likes
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own video likes" ON public.video_likes
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.video_reactions
-- ============================================================
CREATE TABLE public.video_reactions (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    user_id uuid NOT NULL,
    emoji text NOT NULL,
    timestamp_seconds integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_reactions ADD CONSTRAINT video_reactions_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_video_reactions_video ON public.video_reactions USING btree (video_id, timestamp_seconds);
CREATE UNIQUE INDEX video_reactions_pkey ON public.video_reactions USING btree (id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users add own reactions" ON public.video_reactions
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can view their own reactions" ON public.video_reactions
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users delete own reactions" ON public.video_reactions
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.video_responses
-- ============================================================
CREATE TABLE public.video_responses (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_video_id uuid NOT NULL,
    source_kind text NOT NULL DEFAULT 'video'::text,
    response_video_id uuid NOT NULL,
    response_kind text NOT NULL DEFAULT 'video'::text,
    response_type text NOT NULL DEFAULT 'response'::text,
    user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_responses ADD CONSTRAINT video_responses_pkey PRIMARY KEY (id);
ALTER TABLE public.video_responses ADD CONSTRAINT video_responses_source_video_id_response_video_id_key UNIQUE (source_video_id, response_video_id);
-- indexes:
CREATE UNIQUE INDEX video_responses_pkey ON public.video_responses USING btree (id);
CREATE INDEX video_responses_response_idx ON public.video_responses USING btree (response_video_id);
CREATE INDEX video_responses_source_idx ON public.video_responses USING btree (source_video_id);
CREATE UNIQUE INDEX video_responses_source_video_id_response_video_id_key ON public.video_responses USING btree (source_video_id, response_video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Responses viewable by everyone" ON public.video_responses
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
CREATE POLICY "Users can link own response video" ON public.video_responses
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can remove own response link" ON public.video_responses
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.video_subtitles
-- ============================================================
CREATE TABLE public.video_subtitles (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    language text NOT NULL,
    label text NOT NULL,
    content text NOT NULL,
    source text NOT NULL DEFAULT 'auto'::text,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_subtitles ADD CONSTRAINT video_subtitles_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.video_subtitles ADD CONSTRAINT video_subtitles_pkey PRIMARY KEY (id);
ALTER TABLE public.video_subtitles ADD CONSTRAINT video_subtitles_video_id_language_key UNIQUE (video_id, language);
-- indexes:
CREATE INDEX idx_video_subtitles_video ON public.video_subtitles USING btree (video_id);
CREATE UNIQUE INDEX video_subtitles_pkey ON public.video_subtitles USING btree (id);
CREATE UNIQUE INDEX video_subtitles_video_id_language_key ON public.video_subtitles USING btree (video_id, language);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Owners can delete subtitles" ON public.video_subtitles
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_subtitles.video_id) AND (v.user_id = auth.uid())))));
CREATE POLICY "Owners can insert subtitles" ON public.video_subtitles
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_subtitles.video_id) AND (v.user_id = auth.uid())))));
CREATE POLICY "Owners can update subtitles" ON public.video_subtitles
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_subtitles.video_id) AND (v.user_id = auth.uid())))));
CREATE POLICY "Subtitles viewable by everyone" ON public.video_subtitles
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:
CREATE TRIGGER update_video_subtitles_updated_at BEFORE UPDATE ON public.video_subtitles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.video_thumbnail_variants
-- ============================================================
CREATE TABLE public.video_thumbnail_variants (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    thumbnail_url text NOT NULL,
    label text NULL,
    impressions integer NOT NULL DEFAULT 0,
    clicks integer NOT NULL DEFAULT 0,
    "position" integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_thumbnail_variants ADD CONSTRAINT video_thumbnail_variants_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.video_thumbnail_variants ADD CONSTRAINT video_thumbnail_variants_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX video_thumbnail_variants_pkey ON public.video_thumbnail_variants USING btree (id);
CREATE INDEX video_thumbnail_variants_video_id_idx ON public.video_thumbnail_variants USING btree (video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Owner manages variants" ON public.video_thumbnail_variants
    AS PERMISSIVE FOR ALL
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_thumbnail_variants.video_id) AND (v.user_id = auth.uid())))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_thumbnail_variants.video_id) AND (v.user_id = auth.uid())))));
CREATE POLICY "Variants viewable by everyone" ON public.video_thumbnail_variants
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (true);
-- triggers:

-- ============================================================
-- TABLE: public.video_views
-- ============================================================
CREATE TABLE public.video_views (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL,
    user_id uuid NULL,
    session_id text NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.video_views ADD CONSTRAINT video_views_video_id_fkey FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE;
ALTER TABLE public.video_views ADD CONSTRAINT video_views_pkey PRIMARY KEY (id);
ALTER TABLE public.video_views ADD CONSTRAINT video_views_video_id_session_id_key UNIQUE (video_id, session_id);
-- indexes:
CREATE UNIQUE INDEX video_views_pkey ON public.video_views USING btree (id);
CREATE UNIQUE INDEX video_views_video_id_session_id_key ON public.video_views USING btree (video_id, session_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Anyone can insert views" ON public.video_views
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK (true);
CREATE POLICY "Channel owners see views on own videos" ON public.video_views
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((EXISTS ( SELECT 1
   FROM videos v
  WHERE ((v.id = video_views.video_id) AND (v.user_id = auth.uid())))));
CREATE POLICY "Users see own view rows" ON public.video_views
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.videos
-- ============================================================
CREATE TABLE public.videos (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    description text NULL,
    thumbnail_url text NULL,
    video_url text NULL,
    duration text NULL,
    views integer NOT NULL DEFAULT 0,
    likes integer NOT NULL DEFAULT 0,
    dislikes integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'draft'::text,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    is_short boolean NOT NULL DEFAULT false,
    tags text[] NULL DEFAULT '{}'::text[],
    timestamps text NULL,
    premiere_at timestamp with time zone NULL,
    thumbnail_test_status text NOT NULL DEFAULT 'idle'::text,
    thumbnail_winner_variant_id uuid NULL,
    ai_insights jsonb NULL,
    ai_insights_generated_at timestamp with time zone NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.videos ADD CONSTRAINT videos_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'unlisted'::text, 'private'::text])));
ALTER TABLE public.videos ADD CONSTRAINT videos_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE public.videos ADD CONSTRAINT videos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.videos ADD CONSTRAINT videos_pkey PRIMARY KEY (id);
-- indexes:
CREATE INDEX idx_video_type_date ON public.videos USING btree (is_short, created_at);
CREATE INDEX idx_videos_status_short_created ON public.videos USING btree (status, is_short, created_at DESC) WHERE ((status = 'published'::text) AND (is_short = false));
CREATE INDEX idx_videos_tags ON public.videos USING gin (tags);
CREATE UNIQUE INDEX videos_pkey ON public.videos USING btree (id);
CREATE INDEX videos_premiere_at_idx ON public.videos USING btree (premiere_at) WHERE (premiere_at IS NOT NULL);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Creators can update own videos" ON public.videos
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id))
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Published videos are viewable by everyone" ON public.videos
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING (((status = 'published'::text) OR (auth.uid() = user_id)));
CREATE POLICY "Users can delete their own videos" ON public.videos
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can update their own videos" ON public.videos
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can upload videos" ON public.videos
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
-- triggers:
CREATE TRIGGER on_video_published AFTER INSERT ON public.videos FOR EACH ROW EXECUTE FUNCTION auto_promote_video();
CREATE TRIGGER trg_notify_tapiners_on_new_video AFTER INSERT OR UPDATE ON public.videos FOR EACH ROW EXECUTE FUNCTION notify_tapiners_on_new_video();
CREATE TRIGGER update_videos_updated_at BEFORE UPDATE ON public.videos FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- TABLE: public.wallet_withdrawals
-- ============================================================
CREATE TABLE public.wallet_withdrawals (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    amount_srd numeric NOT NULL,
    method text NOT NULL,
    destination text NOT NULL,
    status text NOT NULL DEFAULT 'pending'::text,
    receipt_number text NOT NULL DEFAULT ((('LL-'::text || to_char(now(), 'YYYYMMDD'::text)) || '-'::text) || upper(substr(replace((gen_random_uuid())::text, '-'::text, ''::text), 1, 8))),
    paid_at timestamp with time zone NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    np_batch_id text NULL,
    np_payout_status text NULL,
    amount numeric NOT NULL DEFAULT 0,
    invoice_number text NULL,
    net_amount numeric NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.wallet_withdrawals ADD CONSTRAINT wallet_withdrawals_method_check CHECK ((method = ANY (ARRAY['uni5pay'::text, 'usdt_bep20'::text])));
ALTER TABLE public.wallet_withdrawals ADD CONSTRAINT wallet_withdrawals_pkey PRIMARY KEY (id);
ALTER TABLE public.wallet_withdrawals ADD CONSTRAINT wallet_withdrawals_receipt_number_key UNIQUE (receipt_number);
-- indexes:
CREATE UNIQUE INDEX wallet_withdrawals_pkey ON public.wallet_withdrawals USING btree (id);
CREATE UNIQUE INDEX wallet_withdrawals_receipt_number_key ON public.wallet_withdrawals USING btree (receipt_number);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Admins update withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR UPDATE
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Admins view all withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR SELECT
    TO {authenticated}
    USING (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users create own withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users view own withdrawals" ON public.wallet_withdrawals
    AS PERMISSIVE FOR SELECT
    TO {authenticated}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.wallets
-- ============================================================
CREATE TABLE public.wallets (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NULL,
    balance numeric NULL DEFAULT 0,
    created_at timestamp with time zone NULL DEFAULT now(),
    "walletType" text NULL,
    "walletNumber" text NULL,
    "walletAddress" text NULL,
    "accountHolder" text NULL
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.wallets ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.wallets ADD CONSTRAINT wallets_pkey PRIMARY KEY (id);
-- indexes:
CREATE UNIQUE INDEX wallets_pkey ON public.wallets USING btree (id);
CREATE UNIQUE INDEX wallets_user_id_idx ON public.wallets USING btree (user_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users can insert own wallet" ON public.wallets
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own wallet" ON public.wallets
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users can view own wallet" ON public.wallets
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.watch_history
-- ============================================================
CREATE TABLE public.watch_history (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    video_id uuid NOT NULL,
    last_position_seconds integer NOT NULL DEFAULT 0,
    watched_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.watch_history ADD CONSTRAINT watch_history_pkey PRIMARY KEY (id);
ALTER TABLE public.watch_history ADD CONSTRAINT watch_history_user_id_video_id_key UNIQUE (user_id, video_id);
-- indexes:
CREATE INDEX idx_watch_history_user ON public.watch_history USING btree (user_id, watched_at DESC);
CREATE UNIQUE INDEX watch_history_pkey ON public.watch_history USING btree (id);
CREATE UNIQUE INDEX watch_history_user_id_video_id_key ON public.watch_history USING btree (user_id, video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users add own history" ON public.watch_history
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users delete own history" ON public.watch_history
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users update own history" ON public.watch_history
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users view own history" ON public.watch_history
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ============================================================
-- TABLE: public.watch_later
-- ============================================================
CREATE TABLE public.watch_later (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    video_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- constraints (PK / FK / UNIQUE / CHECK):
ALTER TABLE public.watch_later ADD CONSTRAINT watch_later_pkey PRIMARY KEY (id);
ALTER TABLE public.watch_later ADD CONSTRAINT watch_later_user_id_video_id_key UNIQUE (user_id, video_id);
-- indexes:
CREATE INDEX idx_watch_later_user ON public.watch_later USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX watch_later_pkey ON public.watch_later USING btree (id);
CREATE UNIQUE INDEX watch_later_user_id_video_id_key ON public.watch_later USING btree (user_id, video_id);
-- RLS status:
-- ROW LEVEL SECURITY: ENABLED (forced: f)
-- policies:
CREATE POLICY "Users add to own watch later" ON public.watch_later
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users remove from own watch later" ON public.watch_later
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING ((auth.uid() = user_id));
CREATE POLICY "Users view own watch later" ON public.watch_later
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((auth.uid() = user_id));
-- triggers:

-- ############ SECTION 9: VIEWS IN public ############

-- VIEW: public.creator_stats
CREATE OR REPLACE VIEW public.creator_stats AS
 SELECT user_id,
    count(id) AS total_videos,
    sum(COALESCE(views, 0)) AS total_views,
    sum(COALESCE(likes, 0)) AS total_likes
   FROM videos
  GROUP BY user_id;

-- VIEW: public.public_ads_active
CREATE OR REPLACE VIEW public.public_ads_active AS
 SELECT id,
    company_name,
    campaign_title,
    campaign_description,
    ad_type,
    creative_url,
    cta_url,
    website,
    status,
    payment_status,
    created_at,
    preferred_start_date,
    duration_days,
    target_impressions,
    impressions_count,
    reviewed_at
   FROM ad_requests
  WHERE status = 'live'::text AND payment_status = 'paid'::text;

-- ############ SECTION 6: FUNCTIONS / RPCs (full bodies) ############

-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ad_requests_auto_live_on_paid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.payment_status = 'paid'
     AND NEW.status NOT IN ('rejected', 'ended', 'live') THEN
    NEW.status := 'live';
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  ELSIF TG_OP = 'UPDATE'
     AND NEW.status = 'live'
     AND OLD.status IS DISTINCT FROM 'live' THEN
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_creator_finance()
 RETURNS TABLE(user_id uuid, is_monetized boolean, standard_share_pct numeric, bonus_share_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.user_id, p.is_monetized, p.standard_share_pct, p.bonus_share_pct
  FROM public.profiles p
  WHERE public.has_role(auth.uid(), 'admin');
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_promote_video()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'published' AND NEW.is_short = false THEN
    -- Avoid duplicates if a post already exists for this video
    IF NOT EXISTS (
      SELECT 1 FROM public.community_posts WHERE video_id = NEW.id
    ) THEN
      INSERT INTO public.community_posts (channel_id, user_id, content, video_id, auto_generated)
      VALUES (
        NEW.channel_id,
        NEW.user_id,
        '🎬 ' || NEW.title || COALESCE(E'\n' || LEFT(NEW.description, 200), ''),
        NEW.id,
        true
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_enable_creator_monetization(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = _user_id AND (p.is_founder_team = true OR p.is_admin = true)
  ) OR EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id AND ur.role = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM public.channels c
    WHERE c.user_id = _user_id AND c.tapiners >= 500
  );
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_withdrawal(p_amount numeric, p_method text, p_destination text)
 RETURNS wallet_withdrawals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_balance numeric;
  v_status text;
  v_np_status text;
  v_row public.wallet_withdrawals;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  IF p_method NOT IN ('uni5pay','usdt_bep20') THEN RAISE EXCEPTION 'Invalid method'; END IF;

  SELECT balance INTO v_balance FROM public.wallets WHERE user_id = v_user FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'No wallet'; END IF;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'Insufficient balance'; END IF;

  UPDATE public.wallets SET balance = balance - p_amount WHERE user_id = v_user;

  IF p_method = 'usdt_bep20' THEN
    v_status := 'processing';
    v_np_status := 'queued';
  ELSE
    v_status := 'pending';
    v_np_status := NULL;
  END IF;

  INSERT INTO public.wallet_withdrawals (user_id, amount_srd, method, destination, status, paid_at, np_payout_status)
  VALUES (v_user, p_amount, p_method, p_destination, v_status, NULL, v_np_status)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_synced_short_video()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.videos
  WHERE id = OLD.id
    AND is_short = true;

  RETURN OLD;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.evaluate_thumbnail_winner(p_video_id uuid, p_threshold integer DEFAULT 1000)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  total_imp integer;
  winner uuid;
BEGIN
  SELECT COALESCE(SUM(impressions), 0) INTO total_imp
    FROM public.video_thumbnail_variants WHERE video_id = p_video_id;

  IF total_imp < p_threshold THEN
    RETURN NULL;
  END IF;

  SELECT id INTO winner
    FROM public.video_thumbnail_variants
    WHERE video_id = p_video_id AND impressions > 0
    ORDER BY (clicks::numeric / impressions::numeric) DESC, clicks DESC
    LIMIT 1;

  IF winner IS NOT NULL THEN
    UPDATE public.videos
      SET thumbnail_test_status = 'completed',
          thumbnail_winner_variant_id = winner,
          thumbnail_url = (SELECT thumbnail_url FROM public.video_thumbnail_variants WHERE id = winner)
      WHERE id = p_video_id;
  END IF;

  RETURN winner;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_channel_tapin_count(p_channel_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::bigint FROM public.tapins WHERE channel_id = p_channel_id;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_creator_finance()
 RETURNS TABLE(is_monetized boolean, standard_share_pct numeric, bonus_share_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.is_monetized, p.standard_share_pct, p.bonus_share_pct
  FROM public.profiles p
  WHERE p.user_id = auth.uid();
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_personalized_feed(p_user_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, title text, thumbnail_url text, duration text, views integer, created_at timestamp with time zone, channel_id uuid, channel_name text, channel_avatar text, feed_score numeric, feed_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  interest_count integer;
  discovery_count integer;
  top_cats text[];
BEGIN
  interest_count := CEIL(p_limit * 0.7);
  discovery_count := p_limit - interest_count;

  -- Get user's top 3 categories
  IF p_user_id IS NOT NULL THEN
    SELECT array_agg(ci.category ORDER BY ci.score DESC)
    INTO top_cats
    FROM (
      SELECT category, score FROM public.user_category_interests
      WHERE user_id = p_user_id
      ORDER BY score DESC LIMIT 3
    ) ci;
  END IF;

  -- If no interests yet, return chronological
  IF top_cats IS NULL OR array_length(top_cats, 1) IS NULL THEN
    RETURN QUERY
    SELECT v.id, v.title, v.thumbnail_url, v.duration, v.views, v.created_at,
           v.channel_id, c.name, c.avatar_url,
           0::numeric, 'chronological'::text
    FROM public.videos v
    JOIN public.channels c ON c.id = v.channel_id
    WHERE v.status = 'published' AND v.is_short = false
    ORDER BY v.created_at DESC
    LIMIT p_limit OFFSET p_offset;
    RETURN;
  END IF;

  -- 70% interest-based + 30% discovery
  RETURN QUERY
  (
    SELECT v.id, v.title, v.thumbnail_url, v.duration, v.views, v.created_at,
           v.channel_id, c.name, c.avatar_url,
           (
             CASE WHEN v.tags IS NOT NULL AND v.tags && top_cats THEN 50 ELSE 0 END +
             CASE WHEN v.created_at > now() - interval '48 hours' THEN 30
                  WHEN v.created_at > now() - interval '7 days' THEN 10
                  ELSE 0 END +
             LEAST(v.views / 10.0, 20)
           )::numeric,
           'interest'::text
    FROM public.videos v
    JOIN public.channels c ON c.id = v.channel_id
    WHERE v.status = 'published' AND v.is_short = false
      AND v.tags IS NOT NULL AND v.tags && top_cats
    ORDER BY 10 DESC, v.created_at DESC
    LIMIT interest_count
  )
  UNION ALL
  (
    SELECT v.id, v.title, v.thumbnail_url, v.duration, v.views, v.created_at,
           v.channel_id, c.name, c.avatar_url,
           (
             CASE WHEN v.created_at > now() - interval '48 hours' THEN 30
                  WHEN v.created_at > now() - interval '7 days' THEN 15
                  ELSE 0 END +
             CASE WHEN c.tapiners < 100 THEN 20 ELSE 0 END
           )::numeric,
           'discovery'::text
    FROM public.videos v
    JOIN public.channels c ON c.id = v.channel_id
    WHERE v.status = 'published' AND v.is_short = false
      AND (v.tags IS NULL OR NOT (v.tags && top_cats))
    ORDER BY 10 DESC, v.created_at DESC
    LIMIT discovery_count
  )
  LIMIT p_limit;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_poll_results(p_poll_id uuid)
 RETURNS TABLE(option_id uuid, votes bigint, my_vote boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT option_id,
         count(*)::bigint AS votes,
         bool_or(user_id = auth.uid()) AS my_vote
  FROM public.post_poll_votes
  WHERE poll_id = p_poll_id
  GROUP BY option_id
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_top3_rank_badges()
 RETURNS TABLE(user_id uuid, channel_id uuid, category text, rank integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH tap AS (
    SELECT c.user_id, c.id AS channel_id, 'tapiners'::text AS category,
           ROW_NUMBER() OVER (ORDER BY COUNT(t.id) DESC) AS rnk
    FROM public.channels c
    JOIN public.tapins t ON t.channel_id = c.id
    WHERE t.created_at > now() - interval '7 days'
    GROUP BY c.user_id, c.id
  ),
  vws AS (
    SELECT c.user_id, c.id AS channel_id, 'views'::text AS category,
           ROW_NUMBER() OVER (ORDER BY COUNT(vv.id) DESC) AS rnk
    FROM public.channels c
    JOIN public.videos v ON v.channel_id = c.id
    JOIN public.video_views vv ON vv.video_id = v.id
    WHERE vv.created_at > now() - interval '7 days'
    GROUP BY c.user_id, c.id
  ),
  pst AS (
    SELECT c.user_id, c.id AS channel_id, 'posts'::text AS category,
           ROW_NUMBER() OVER (ORDER BY COUNT(p.id) DESC) AS rnk
    FROM public.channels c
    JOIN public.community_posts p ON p.channel_id = c.id
    WHERE p.created_at > now() - interval '7 days'
      AND COALESCE(p.auto_generated, false) = false
    GROUP BY c.user_id, c.id
  )
  SELECT user_id, channel_id, category, rnk::int AS rank FROM tap WHERE rnk <= 3
  UNION ALL
  SELECT user_id, channel_id, category, rnk::int AS rank FROM vws WHERE rnk <= 3
  UNION ALL
  SELECT user_id, channel_id, category, rnk::int AS rank FROM pst WHERE rnk <= 3;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture')
  );
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_ad_impression(p_ad_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  updated integer;
BEGIN
  IF p_ad_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.ad_requests
     SET impressions_count = COALESCE(impressions_count, 0) + 1
   WHERE id = p_ad_id
     AND payment_status = 'paid'
     AND status = 'live'
     AND (target_impressions IS NULL OR COALESCE(impressions_count, 0) < target_impressions)
     AND (
       duration_days IS NULL
       OR COALESCE(reviewed_at, created_at) + (duration_days || ' days')::interval > now()
     );
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_post_likes(post_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  update community_posts
  set likes = coalesce(likes, 0) + 1
  where id = post_id;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_thumbnail_click(p_variant_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.video_thumbnail_variants
    SET clicks = clicks + 1
    WHERE id = p_variant_id;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_thumbnail_impression(p_variant_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.video_thumbnail_variants
    SET impressions = impressions + 1
    WHERE id = p_variant_id;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_video_views(video_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Deprecated: counting is handled by register_video_view to enforce
  -- one-view-per-unique-session. Intentionally no-op.
  RETURN;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_views(video_id uuid)
 RETURNS void
 LANGUAGE sql
AS $function$
  update videos
  set views = coalesce(views, 0) + 1
  where id = video_id;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_video_reactions(p_video_id uuid)
 RETURNS TABLE(id uuid, emoji text, timestamp_seconds integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id, emoji, timestamp_seconds
  FROM public.video_reactions
  WHERE video_id = p_video_id
  ORDER BY timestamp_seconds ASC;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_comment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  video_owner UUID;
  video_title TEXT;
  actor_name TEXT;
BEGIN
  IF NEW.video_id IS NULL THEN RETURN NEW; END IF;
  SELECT user_id, title INTO video_owner, video_title FROM public.videos WHERE id = NEW.video_id;
  IF video_owner IS NULL OR video_owner = NEW.user_id THEN RETURN NEW; END IF;
  SELECT COALESCE(display_name, username, 'Iemand') INTO actor_name FROM public.profiles WHERE user_id = NEW.user_id;
  INSERT INTO public.notifications (user_id, actor_id, type, video_id, title, body, link)
  VALUES (video_owner, NEW.user_id, 'comment', NEW.video_id,
    'Nieuwe reactie',
    actor_name || ' op "' || COALESCE(video_title, 'je video') || '": ' || LEFT(NEW.content, 120),
    '/watch/' || NEW.video_id);
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_on_tapin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  owner_id UUID;
  actor_name TEXT;
BEGIN
  SELECT user_id INTO owner_id FROM public.channels WHERE id = NEW.channel_id;
  IF owner_id IS NULL OR owner_id = NEW.user_id THEN RETURN NEW; END IF;
  SELECT COALESCE(display_name, username, 'Iemand') INTO actor_name FROM public.profiles WHERE user_id = NEW.user_id;
  INSERT INTO public.notifications (user_id, actor_id, type, title, body, link)
  VALUES (owner_id, NEW.user_id, 'tapin',
    'Nieuwe tapiner!',
    actor_name || ' heeft op je kanaal getapt.',
    '/channel/' || NEW.channel_id);
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.notify_tapiners_on_new_video()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  channel_name TEXT;
BEGIN
  IF NEW.status <> 'published' OR NEW.is_short = true THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN RETURN NEW; END IF;
  SELECT name INTO channel_name FROM public.channels WHERE id = NEW.channel_id;
  INSERT INTO public.notifications (user_id, actor_id, type, video_id, title, body, link)
  SELECT t.user_id, NEW.user_id, 'new_video', NEW.id,
    'Nieuwe video van ' || COALESCE(channel_name, 'een creator'),
    NEW.title,
    '/watch/' || NEW.id
  FROM public.tapins t
  JOIN public.profiles p ON p.user_id = t.user_id
  WHERE t.channel_id = NEW.channel_id
    AND t.user_id <> NEW.user_id
    AND COALESCE(p.notify_new_video_from_tapins, true) = true;
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nowpayments_on_confirm()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only act when transitioning to a confirmed/finished state
  IF NEW.status IN ('confirmed', 'finished') AND
     (OLD.status IS NULL OR OLD.status NOT IN ('confirmed', 'finished')) THEN

    IF NEW.purpose = 'advertise' AND NEW.reference_id IS NOT NULL THEN
      UPDATE public.ad_requests
        SET payment_status = 'paid'
        WHERE id = NEW.reference_id;
    ELSIF NEW.purpose = 'tip' AND NEW.reference_id IS NOT NULL THEN
      UPDATE public.channel_tips
        SET status = 'confirmed', confirmed_at = now()
        WHERE id = NEW.reference_id;
    ELSIF NEW.purpose = 'membership' AND NEW.reference_id IS NOT NULL THEN
      UPDATE public.channel_members
        SET status = 'active'
        WHERE id = NEW.reference_id;
    ELSIF NEW.purpose = 'support' AND NEW.channel_id IS NOT NULL THEN
      -- Insert as a confirmed tip
      INSERT INTO public.channel_tips (channel_id, from_user_id, from_name, amount_srd, message, uni5pay_reference, status, confirmed_at)
      VALUES (NEW.channel_id, NEW.user_id, COALESCE(NEW.from_name, 'Crypto supporter'),
              NEW.amount_usd * 35, -- rough USD->SRD; admin can adjust
              NEW.message, 'NP:' || COALESCE(NEW.np_payment_id, NEW.np_order_id),
              'confirmed', now());
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_like_counts(p_post_ids uuid[])
 RETURNS TABLE(post_id uuid, reaction_type text, cnt bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT post_id, reaction_type, count(*)::bigint
  FROM public.post_likes
  WHERE post_id = ANY(p_post_ids)
  GROUP BY post_id, reaction_type;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_failed_withdrawal(p_withdrawal_id uuid, p_payout_status text DEFAULT 'provider_error'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_withdrawal public.wallet_withdrawals%ROWTYPE;
BEGIN
  SELECT * INTO v_withdrawal
  FROM public.wallet_withdrawals
  WHERE id = p_withdrawal_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_withdrawal.status NOT IN ('pending', 'processing') OR v_withdrawal.paid_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.wallets
     SET balance = balance + v_withdrawal.amount_srd
   WHERE user_id = v_withdrawal.user_id;

  UPDATE public.wallet_withdrawals
     SET status = 'rejected',
         np_payout_status = p_payout_status
   WHERE id = p_withdrawal_id;

  RETURN true;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_video_view(p_video_id uuid, p_session_id text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  inserted boolean := false;
BEGIN
  IF p_video_id IS NULL OR p_session_id IS NULL OR length(p_session_id) = 0 THEN
    RETURN false;
  END IF;

  BEGIN
    INSERT INTO public.video_views (video_id, user_id, session_id)
    VALUES (p_video_id, p_user_id, p_session_id);
    inserted := true;
  EXCEPTION WHEN unique_violation THEN
    inserted := false;
  END;

  IF inserted THEN
    UPDATE public.videos SET views = COALESCE(views, 0) + 1 WHERE id = p_video_id;
    UPDATE public.shorts SET views = COALESCE(views, 0) + 1 WHERE id = p_video_id;
  END IF;

  RETURN inserted;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_short_to_video()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.videos (
    id,
    channel_id,
    user_id,
    title,
    description,
    thumbnail_url,
    video_url,
    views,
    likes,
    dislikes,
    status,
    created_at,
    updated_at,
    is_short,
    tags
  ) VALUES (
    NEW.id,
    NEW.channel_id,
    NEW.user_id,
    NEW.title,
    NEW.description,
    NEW.thumbnail_url,
    NEW.video_url,
    COALESCE(NEW.views, 0),
    COALESCE(NEW.likes, 0),
    COALESCE(NEW.dislikes, 0),
    NEW.status,
    NEW.created_at,
    NEW.updated_at,
    true,
    ARRAY[]::text[]
  )
  ON CONFLICT (id) DO UPDATE SET
    channel_id = EXCLUDED.channel_id,
    user_id = EXCLUDED.user_id,
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    thumbnail_url = EXCLUDED.thumbnail_url,
    video_url = EXCLUDED.video_url,
    views = GREATEST(public.videos.views, EXCLUDED.views),
    likes = GREATEST(public.videos.likes, EXCLUDED.likes),
    dislikes = GREATEST(public.videos.dislikes, EXCLUDED.dislikes),
    status = EXCLUDED.status,
    updated_at = EXCLUDED.updated_at,
    is_short = true;

  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tapins_sync_channel_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cid uuid;
BEGIN
  cid := COALESCE(NEW.channel_id, OLD.channel_id);
  IF cid IS NOT NULL THEN
    UPDATE public.channels
       SET tapiners = (SELECT count(*) FROM public.tapins WHERE channel_id = cid)
     WHERE id = cid;
  END IF;
  RETURN NULL;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.track_user_interest(p_user_id uuid, p_category text, p_points numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.user_category_interests (user_id, category, score, updated_at)
  VALUES (p_user_id, p_category, p_points, now())
  ON CONFLICT (user_id, category)
  DO UPDATE SET score = user_category_interests.score + p_points, updated_at = now();
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_channel_tapiners(p_channel_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cnt integer;
BEGIN
  SELECT count(*) INTO cnt FROM public.tapins WHERE channel_id = p_channel_id;
  UPDATE public.channels SET tapiners = cnt WHERE id = p_channel_id;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.video_like_counts(p_video_ids uuid[])
 RETURNS TABLE(video_id uuid, like_type text, cnt bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT video_id, like_type, count(*)::bigint
  FROM public.video_likes
  WHERE video_id = ANY(p_video_ids)
  GROUP BY video_id, like_type;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_top_posters(p_limit integer DEFAULT 100)
 RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT c.id, c.name, c.avatar_url, COUNT(p.id)::bigint AS score
  FROM public.channels c
  JOIN public.community_posts p ON p.channel_id = c.id
  WHERE p.created_at > now() - interval '7 days'
    AND COALESCE(p.auto_generated, false) = false
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_top_tapiners(p_limit integer DEFAULT 100)
 RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT c.id, c.name, c.avatar_url, COUNT(t.id)::bigint AS score
  FROM public.channels c
  JOIN public.tapins t ON t.channel_id = c.id
  WHERE t.created_at > now() - interval '7 days'
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$function$
;


-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.weekly_top_views(p_limit integer DEFAULT 100)
 RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT c.id, c.name, c.avatar_url, COUNT(vv.id)::bigint AS score
  FROM public.channels c
  JOIN public.videos v ON v.channel_id = c.id
  JOIN public.video_views vv ON vv.video_id = v.id
  WHERE vv.created_at > now() - interval '7 days'
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$function$
;


-- ############ SECTION 6b: ALL TRIGGERS (public + auth on users) ############
-- table auth.users | timing/events: CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()
-- table public.ad_requests | timing/events: CREATE TRIGGER trg_ad_requests_auto_live BEFORE UPDATE ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION ad_requests_auto_live_on_paid()
-- table public.ad_requests | timing/events: CREATE TRIGGER trg_ad_requests_auto_live_ins BEFORE INSERT ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION ad_requests_auto_live_on_paid()
-- table public.ad_requests | timing/events: CREATE TRIGGER update_ad_requests_updated_at BEFORE UPDATE ON public.ad_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.channel_memberships | timing/events: CREATE TRIGGER memberships_updated BEFORE UPDATE ON public.channel_memberships FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.channel_social_links | timing/events: CREATE TRIGGER update_channel_social_links_updated_at BEFORE UPDATE ON public.channel_social_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.channels | timing/events: CREATE TRIGGER update_channels_updated_at BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.comments | timing/events: CREATE TRIGGER trg_notify_on_comment AFTER INSERT ON public.comments FOR EACH ROW EXECUTE FUNCTION notify_on_comment()
-- table public.community_posts | timing/events: CREATE TRIGGER update_community_posts_updated_at BEFORE UPDATE ON public.community_posts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.content_claims | timing/events: CREATE TRIGGER update_content_claims_updated_at BEFORE UPDATE ON public.content_claims FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.nowpayments_payments | timing/events: CREATE TRIGGER nowpayments_set_updated_at BEFORE UPDATE ON public.nowpayments_payments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.nowpayments_payments | timing/events: CREATE TRIGGER nowpayments_status_change AFTER UPDATE ON public.nowpayments_payments FOR EACH ROW EXECUTE FUNCTION nowpayments_on_confirm()
-- table public.playlists | timing/events: CREATE TRIGGER playlists_updated BEFORE UPDATE ON public.playlists FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.profiles | timing/events: CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.shorts | timing/events: CREATE TRIGGER delete_synced_short_video_trigger AFTER DELETE ON public.shorts FOR EACH ROW EXECUTE FUNCTION delete_synced_short_video()
-- table public.shorts | timing/events: CREATE TRIGGER sync_short_to_video_trigger AFTER INSERT OR UPDATE ON public.shorts FOR EACH ROW EXECUTE FUNCTION sync_short_to_video()
-- table public.tapins | timing/events: CREATE TRIGGER trg_notify_on_tapin AFTER INSERT ON public.tapins FOR EACH ROW EXECUTE FUNCTION notify_on_tapin()
-- table public.tapins | timing/events: CREATE TRIGGER trg_tapins_sync_count AFTER INSERT OR DELETE ON public.tapins FOR EACH ROW EXECUTE FUNCTION tapins_sync_channel_count()
-- table public.telegram_links | timing/events: CREATE TRIGGER update_telegram_links_updated_at BEFORE UPDATE ON public.telegram_links FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.video_end_screens | timing/events: CREATE TRIGGER update_video_end_screens_updated_at BEFORE UPDATE ON public.video_end_screens FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.video_subtitles | timing/events: CREATE TRIGGER update_video_subtitles_updated_at BEFORE UPDATE ON public.video_subtitles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table public.videos | timing/events: CREATE TRIGGER on_video_published AFTER INSERT ON public.videos FOR EACH ROW EXECUTE FUNCTION auto_promote_video()
-- table public.videos | timing/events: CREATE TRIGGER trg_notify_tapiners_on_new_video AFTER INSERT OR UPDATE ON public.videos FOR EACH ROW EXECUTE FUNCTION notify_tapiners_on_new_video()
-- table public.videos | timing/events: CREATE TRIGGER update_videos_updated_at BEFORE UPDATE ON public.videos FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
-- table storage.buckets | timing/events: CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length()
-- table storage.buckets | timing/events: CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()
-- table storage.objects | timing/events: CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()
-- table storage.objects | timing/events: CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column()

-- ############ SECTION 8: STORAGE BUCKETS & storage.objects POLICIES ############
-- bucket: ad-creatives | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-04-20 11:21:13.286957+00
-- bucket: avatars | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-03-14 20:41:17.444255+00
-- bucket: community-images | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-03-14 20:41:17.444255+00
-- bucket: media | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-03-22 13:44:12.978851+00
-- bucket: thumbnails | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-03-14 20:41:17.444255+00
-- bucket: videos | public: t | file_size_limit: none | allowed_mime_types: any | created: 2026-03-14 20:41:17.444255+00
-- RLS on storage tables:
-- storage.buckets: RLS ENABLED
-- storage.buckets_analytics: RLS ENABLED
-- storage.buckets_vectors: RLS ENABLED
-- storage.migrations: RLS ENABLED
-- storage.objects: RLS ENABLED
-- storage.s3_multipart_uploads: RLS ENABLED
-- storage.s3_multipart_uploads_parts: RLS ENABLED
-- storage.vector_indexes: RLS ENABLED
-- storage policies (full text):
CREATE POLICY "Ad creatives are publicly viewable" ON storage.objects
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((bucket_id = 'ad-creatives'::text));
CREATE POLICY "Admins can manage ad creatives" ON storage.objects
    AS PERMISSIVE FOR ALL
    TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND has_role(auth.uid(), 'admin'::app_role)));
CREATE POLICY "Allow public view" ON storage.objects
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((bucket_id = 'media'::text));
CREATE POLICY "Auth users can upload videos" ON storage.objects
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Authenticated users can upload ad creatives" ON storage.objects
    AS PERMISSIVE FOR INSERT
    TO {public}
    WITH CHECK (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Media uploads must be in own user folder" ON storage.objects
    AS PERMISSIVE FOR INSERT
    TO {authenticated}
    WITH CHECK (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Public read for videos" ON storage.objects
    AS PERMISSIVE FOR SELECT
    TO {public}
    USING ((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])));
CREATE POLICY "Users can delete own media files" ON storage.objects
    AS PERMISSIVE FOR DELETE
    TO {authenticated}
    USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete their own ad creatives" ON storage.objects
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can delete their uploads" ON storage.objects
    AS PERMISSIVE FOR DELETE
    TO {public}
    USING (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update own media files" ON storage.objects
    AS PERMISSIVE FOR UPDATE
    TO {authenticated}
    USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update their own ad creatives" ON storage.objects
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING (((bucket_id = 'ad-creatives'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));
CREATE POLICY "Users can update their uploads" ON storage.objects
    AS PERMISSIVE FOR UPDATE
    TO {public}
    USING (((bucket_id = ANY (ARRAY['videos'::text, 'thumbnails'::text, 'avatars'::text, 'community-images'::text])) AND ((auth.uid())::text = (storage.foldername(name))[1])));

-- ############ SECTION 10: RELATIONSHIP MAP ############
-- Every foreign key in public, as: child.column -> parent.column
--   channel_members.membership_id -> channel_memberships.id
--   channel_members.channel_id -> channels.id
--   channel_memberships.channel_id -> channels.id
--   channel_social_links.channel_id -> channels.id
--   channel_tips.channel_id -> channels.id
--   community_posts.channel_id -> channels.id
--   live_streams.channel_id -> channels.id
--   playlists.channel_id -> channels.id
--   shorts.channel_id -> channels.id
--   tapins.channel_id -> channels.id
--   videos.channel_id -> channels.id
--   comment_likes.comment_id -> comments.id
--   comments.parent_id -> comments.id
--   comments.post_id -> community_posts.id
--   post_likes.post_id -> community_posts.id
--   playlist_videos.playlist_id -> playlists.id
--   post_poll_votes.option_id -> post_poll_options.id
--   post_poll_options.poll_id -> post_polls.id
--   post_poll_votes.poll_id -> post_polls.id
--   comments.user_id -> profiles.user_id
--   channels.user_id -> users.id
--   comment_likes.user_id -> users.id
--   community_posts.user_id -> users.id
--   live_streams.host_user_id -> users.id
--   notifications.actor_id -> users.id
--   notifications.user_id -> users.id
--   profiles.user_id -> users.id
--   shorts.user_id -> users.id
--   tapins.user_id -> users.id
--   user_roles.user_id -> users.id
--   verification_requests.user_id -> users.id
--   videos.user_id -> users.id
--   wallets.user_id -> users.id
--   comments.video_id -> videos.id
--   community_posts.video_id -> videos.id
--   content_claims.video_id -> videos.id
--   notifications.video_id -> videos.id
--   playlist_videos.video_id -> videos.id
--   video_engagements.video_id -> videos.id
--   video_likes.video_id -> videos.id
--   video_subtitles.video_id -> videos.id
--   video_thumbnail_variants.video_id -> videos.id
--   video_views.video_id -> videos.id
-- Referenced-by counts (which parents are most central):
--   auth.users is referenced by 13 foreign key(s)
--   public.channels is referenced by 10 foreign key(s)
--   public.videos is referenced by 10 foreign key(s)
--   public.post_polls is referenced by 2 foreign key(s)
--   public.community_posts is referenced by 2 foreign key(s)
--   public.comments is referenced by 2 foreign key(s)
--   public.channel_memberships is referenced by 1 foreign key(s)
--   public.post_poll_options is referenced by 1 foreign key(s)
--   public.playlists is referenced by 1 foreign key(s)
--   public.profiles is referenced by 1 foreign key(s)

-- ############ SECTION 5b: RLS SUMMARY TABLE ############
--   public.ad_requests                  RLS=ENABLED  policies=5
--   public.channel_members              RLS=ENABLED  policies=3
--   public.channel_memberships          RLS=ENABLED  policies=2
--   public.channel_social_links         RLS=ENABLED  policies=4
--   public.channel_tips                 RLS=ENABLED  policies=3
--   public.channels                     RLS=ENABLED  policies=4
--   public.comment_likes                RLS=ENABLED  policies=3
--   public.comments                     RLS=ENABLED  policies=4
--   public.community_posts              RLS=ENABLED  policies=6
--   public.content_claims               RLS=ENABLED  policies=4
--   public.fx_rates                     RLS=ENABLED  policies=1
--   public.live_streams                 RLS=ENABLED  policies=4
--   public.mentions                     RLS=ENABLED  policies=2
--   public.moderation_violations        RLS=ENABLED  policies=3
--   public.notifications                RLS=ENABLED  policies=4
--   public.nowpayments_payments         RLS=ENABLED  policies=3
--   public.playlist_videos              RLS=ENABLED  policies=2
--   public.playlists                    RLS=ENABLED  policies=4
--   public.post_likes                   RLS=ENABLED  policies=3
--   public.post_poll_options            RLS=ENABLED  policies=2
--   public.post_poll_votes              RLS=ENABLED  policies=3
--   public.post_polls                   RLS=ENABLED  policies=3
--   public.profiles                     RLS=ENABLED  policies=4
--   public.push_subscriptions           RLS=ENABLED  policies=1
--   public.shorts                       RLS=ENABLED  policies=4
--   public.tapins                       RLS=ENABLED  policies=3
--   public.telegram_bot_state           RLS=ENABLED  policies=1
--   public.telegram_broadcasts          RLS=ENABLED  policies=1
--   public.telegram_links               RLS=ENABLED  policies=4
--   public.telegram_settings            RLS=ENABLED  policies=1
--   public.uni5pay_ipn_logs             RLS=ENABLED  policies=1
--   public.user_category_interests      RLS=ENABLED  policies=3
--   public.user_roles                   RLS=ENABLED  policies=2
--   public.verification_requests        RLS=ENABLED  policies=4
--   public.video_end_screens            RLS=ENABLED  policies=2
--   public.video_engagements            RLS=ENABLED  policies=2
--   public.video_likes                  RLS=ENABLED  policies=3
--   public.video_reactions              RLS=ENABLED  policies=3
--   public.video_responses              RLS=ENABLED  policies=3
--   public.video_subtitles              RLS=ENABLED  policies=4
--   public.video_thumbnail_variants     RLS=ENABLED  policies=2
--   public.video_views                  RLS=ENABLED  policies=3
--   public.videos                       RLS=ENABLED  policies=5
--   public.wallet_withdrawals           RLS=ENABLED  policies=4
--   public.wallets                      RLS=ENABLED  policies=3
--   public.watch_history                RLS=ENABLED  policies=4
--   public.watch_later                  RLS=ENABLED  policies=3

-- ############ END OF DUMP ############
