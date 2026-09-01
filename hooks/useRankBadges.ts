import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

export type RankCategory = 'tapiners' | 'views' | 'posts';

export type RankBadge = {
  user_id: string;
  channel_id: string;
  category: RankCategory;
  rank: number;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function toRankBadgeMap(badges: RankBadge[]) {
  const byUserId: Record<string, RankBadge> = {};
  const byChannelId: Record<string, RankBadge> = {};

  for (const badge of badges) {
    byUserId[badge.user_id] = badge;
    byChannelId[badge.channel_id] = badge;
  }

  return { byUserId, byChannelId };
}

export function useRankBadges() {
  const [badges, setBadges] = useState<RankBadge[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('get_top3_rank_badges');
      if (error) throw error;
      setBadges((Array.isArray(data) ? data : []).filter(Boolean) as RankBadge[]);
    } catch (error) {
      console.warn('Failed to load rank badges:', error);
      setBadges([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [refresh]);

  const maps = useMemo(() => toRankBadgeMap(badges), [badges]);

  return {
    badges,
    loading,
    refresh,
    badgeByUserId: maps.byUserId,
    badgeByChannelId: maps.byChannelId,
  };
}

export function getAvatarBadge(
  badgeByUserId: Record<string, RankBadge>,
  badgeByChannelId: Record<string, RankBadge>,
  userId?: string | null,
  channelId?: string | null
) {
  if (channelId && badgeByChannelId[channelId]) {
    return badgeByChannelId[channelId];
  }

  if (userId && badgeByUserId[userId]) {
    return badgeByUserId[userId];
  }

  return null;
}