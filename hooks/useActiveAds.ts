import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface SponsoredAd {
  id: string;
  company_name: string;
  campaign_title: string;
  campaign_description: string;
  ad_type: 'banner' | 'preroll' | 'sponsored' | 'video_preroll';
  creative_url: string | null;
  cta_url: string | null;
  website: string | null;
  // Campaign scheduling / pacing (used to mirror the web's active-ad filter).
  reviewed_at?: string | null;
  created_at?: string | null;
  duration_days?: number | null;
  target_impressions?: number | null;
  impressions_count?: number | null;
}

// Mirror of the web platform's active-window check: an ad is "running" from its
// reviewed_at (or created_at) for duration_days (default 30).
export function isAdWithinCampaignWindow(ad: SponsoredAd, now: Date = new Date()): boolean {
  const startStr = ad.reviewed_at || ad.created_at;
  if (!startStr) return true;
  const start = new Date(startStr);
  if (isNaN(start.getTime())) return true;
  if (now < start) return false;
  const days = ad.duration_days && ad.duration_days > 0 ? ad.duration_days : 30;
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return now < end;
}

// True if the ad still has impressions left against its target (or no target).
export function adHasImpressionsLeft(ad: SponsoredAd): boolean {
  return ad.target_impressions == null || (ad.impressions_count ?? 0) < ad.target_impressions;
}

// NOTE: ads are read from the `public_ads_active` Supabase VIEW — the same source the
// web platform uses. That view already exposes only live + paid + in-flight campaigns
// (the raw `ad_requests` table is RLS-protected and returns nothing to the app), so we
// don't re-apply status/payment filters here. Real ad_type values in the data are
// 'banner' and 'preroll'.
export function useActiveAds(adType?: 'banner' | 'preroll' | 'sponsored' | 'video_preroll') {
  const [ads, setAds] = useState<SponsoredAd[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let query = supabase
        .from('public_ads_active')
        .select('id, company_name, campaign_title, campaign_description, ad_type, creative_url, cta_url, website, created_at, reviewed_at, duration_days, target_impressions, impressions_count')
        .order('created_at', { ascending: false });

      if (adType) {
        query = query.eq('ad_type', adType);
      }

      const { data, error } = await query;
      if (!cancelled) {
        if (!error && data) {
          setAds(data as SponsoredAd[]);
        } else {
          setAds([]);
        }
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adType]);

  return { ads, loading };
}