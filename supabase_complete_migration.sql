-- ============================================================
-- LukuLuku — COMPLETE MIGRATION
-- Run this whole file in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to run multiple times (idempotent).
-- ============================================================

-- ============================================================
-- FIX A: profiles table read permission
-- The app queries profiles with select('*'), but SELECT was revoked on
-- is_monetized / standard_share_pct / bonus_share_pct, which makes the
-- WHOLE query fail with "permission denied" — this is why the Profile
-- screen shows no data (0 tapiners / 0 videos / 0 momenti, empty @).
-- ============================================================
GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT INSERT, UPDATE ON public.profiles TO authenticated;

-- Backfill missing usernames from the user's channel handle so "@" is not empty
UPDATE public.profiles p
SET username = c.handle
FROM public.channels c
WHERE c.user_id = p.user_id
  AND (p.username IS NULL OR p.username = '')
  AND c.handle IS NOT NULL
  AND c.handle <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles p2
    WHERE p2.username = c.handle
      AND p2.user_id <> p.user_id
  );

-- ============================================================
-- FIX B (FEATURE 3): Bangi text post styling columns
-- The app saves background_color / text_color / background_style when you
-- create a text post, but these columns do not exist in the live DB, so
-- the app silently retries the insert WITHOUT them — that is why your
-- selected background color never shows in the Bangi Feed.
-- ============================================================
ALTER TABLE public.community_posts
  ADD COLUMN IF NOT EXISTS background_color text,
  ADD COLUMN IF NOT EXISTS text_color text,
  ADD COLUMN IF NOT EXISTS background_style text;

UPDATE public.community_posts
SET background_color = '#FFFFFF'
WHERE background_color IS NULL;

UPDATE public.community_posts
SET text_color = '#111111'
WHERE text_color IS NULL;

-- ============================================================
-- FIX C: wallets / wallet_withdrawals missing columns
-- The app reads wallets ("walletType", "walletNumber", "walletAddress",
-- "accountHolder") and wallet_withdrawals (amount, invoice_number,
-- net_amount), but these columns do not exist in the live DB. The wallet
-- query throws, which aborted profile loading midway — Bangi posts were
-- counted but never rendered on the Profile screen.
-- ============================================================
ALTER TABLE public.wallets
  ADD COLUMN IF NOT EXISTS "walletType" text,
  ADD COLUMN IF NOT EXISTS "walletNumber" text,
  ADD COLUMN IF NOT EXISTS "walletAddress" text,
  ADD COLUMN IF NOT EXISTS "accountHolder" text;

ALTER TABLE public.wallet_withdrawals
  ADD COLUMN IF NOT EXISTS amount numeric,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS net_amount numeric;

-- ============================================================
-- FIX D: tapins public read policy
-- RLS on tapins only let users see their OWN tapin rows, so the app's
-- live follower count (SELECT count on tapins by channel_id) always
-- returned 0 for other people's taps — even though the trigger-synced
-- channels.tapiners column was correct. Tapin counts are public
-- (leaderboards already expose them), so allow public SELECT.
-- ============================================================
GRANT SELECT ON public.tapins TO anon, authenticated;

DROP POLICY IF EXISTS "Public read tapins" ON public.tapins;
CREATE POLICY "Public read tapins" ON public.tapins
  FOR SELECT TO anon, authenticated
  USING (true);

-- ============================================================
-- FEATURE 1: ad_requests auto-live trigger + public ad creatives bucket
-- ============================================================
CREATE OR REPLACE FUNCTION public.ad_requests_auto_live_on_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_status = 'paid'
     AND NEW.status IN ('pending', 'approved')
  THEN
    NEW.status := 'live';
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ad_requests_auto_live ON public.ad_requests;
CREATE TRIGGER trg_ad_requests_auto_live
  BEFORE INSERT OR UPDATE OF payment_status ON public.ad_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.ad_requests_auto_live_on_paid();

INSERT INTO storage.buckets (id, name, public) VALUES ('ad-creatives', 'ad-creatives', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read ad creatives" ON storage.objects;
CREATE POLICY "Public read ad creatives" ON storage.objects
  FOR SELECT USING (bucket_id = 'ad-creatives');

DROP POLICY IF EXISTS "Admins upload ad creatives" ON storage.objects;
CREATE POLICY "Admins upload ad creatives" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'ad-creatives' AND public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- FEATURE 2: live tapin counts (triggers keep channels.tapiners in sync)
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_channel_tapin_count(p_channel_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.channels c
  SET tapiners = COALESCE(t.cnt, 0)
  FROM (
    SELECT channel_id, COUNT(*)::int AS cnt
    FROM public.tapins
    WHERE channel_id = p_channel_id
    GROUP BY channel_id
  ) t
  WHERE c.id = p_channel_id;

  UPDATE public.channels
  SET tapiners = 0
  WHERE id = p_channel_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.tapins
      WHERE channel_id = p_channel_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.tapin_count_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.sync_channel_tapin_count(NEW.channel_id);
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.sync_channel_tapin_count(OLD.channel_id);
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_tapin_count_after_insert ON public.tapins;
DROP TRIGGER IF EXISTS trg_tapin_count_after_delete ON public.tapins;
CREATE TRIGGER trg_tapin_count_after_insert
  AFTER INSERT ON public.tapins
  FOR EACH ROW
  EXECUTE FUNCTION public.tapin_count_after_change();

CREATE TRIGGER trg_tapin_count_after_delete
  AFTER DELETE ON public.tapins
  FOR EACH ROW
  EXECUTE FUNCTION public.tapin_count_after_change();

-- One-time backfill of existing counts
UPDATE public.channels c
SET tapiners = COALESCE(t.cnt, 0)
FROM (
  SELECT channel_id, COUNT(*)::int AS cnt
  FROM public.tapins
  GROUP BY channel_id
) t
WHERE c.id = t.channel_id;

UPDATE public.channels
SET tapiners = 0
WHERE id NOT IN (SELECT DISTINCT channel_id FROM public.tapins);

-- ============================================================
-- FEATURE 2b: weekly leaderboard RPCs
-- ============================================================
CREATE OR REPLACE FUNCTION public.weekly_top_tapiners(p_limit int DEFAULT 100)
RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.avatar_url, COUNT(t.id)::bigint AS score
  FROM public.tapins t
  JOIN public.channels c ON c.id = t.channel_id
  WHERE t.created_at >= now() - interval '7 days'
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.weekly_top_views(p_limit int DEFAULT 100)
RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.avatar_url, COUNT(ve.id)::bigint AS score
  FROM public.video_engagements ve
  JOIN public.videos v ON v.id = ve.video_id
  JOIN public.channels c ON c.id = v.channel_id
  WHERE ve.engagement_type = 'view'
    AND ve.created_at >= now() - interval '7 days'
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION public.weekly_top_posters(p_limit int DEFAULT 100)
RETURNS TABLE(channel_id uuid, name text, avatar_url text, score bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.avatar_url, COUNT(p.id)::bigint AS score
  FROM public.community_posts p
  JOIN public.channels c ON c.id = p.channel_id
  WHERE p.created_at >= now() - interval '7 days'
    AND p.auto_generated = false
  GROUP BY c.id, c.name, c.avatar_url
  ORDER BY score DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.weekly_top_tapiners(int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_top_views(int) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.weekly_top_posters(int) TO anon, authenticated;
