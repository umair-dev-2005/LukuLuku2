-- FEATURE 1: ad_requests auto-live trigger + public ad creatives bucket + policies
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

CREATE POLICY "Public read ad creatives" ON storage.objects
  FOR SELECT USING (bucket_id = 'ad-creatives');

CREATE POLICY "Admins upload ad creatives" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'ad-creatives' AND public.has_role(auth.uid(), 'admin'));

-- FEATURE 2: weekly leaderboard RPCs
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

-- FEATURE 3: Bangi text post styling columns
ALTER TABLE public.community_posts
  ADD COLUMN IF NOT EXISTS background_color text,
  ADD COLUMN IF NOT EXISTS text_color text,
  ADD COLUMN IF NOT EXISTS background_style text;

UPDATE public.community_posts
SET background_color = COALESCE(background_color, '#FFFFFF')
WHERE background_color IS NULL;

UPDATE public.community_posts
SET text_color = COALESCE(text_color, '#111111')
WHERE text_color IS NULL;

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