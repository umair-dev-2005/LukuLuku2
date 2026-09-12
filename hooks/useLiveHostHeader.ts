import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getCurrentSupabaseUserId } from '../lib/auth';

export interface LiveHostHeader {
  name: string;
  avatarUrl: string | null;
  tapins: number;
  liveViewers: number;
  totalViews: number;
  earnedCoins: number;
  loading: boolean;
}

// Everything the streamer's live-screen header shows, in one place — so the ZegoCloud /
// live_streams integration only has to change this hook, not LiveBroadcastScreen.tsx.
//
// Real today: name + avatar (own channel, falling back to profile) and total tapins
// (channels.tapiners — the trigger-maintained column; counting the tapins table directly
// returns 0 under RLS, see ChannelScreen.tsx).
// UI phase: liveViewers / totalViews / earnedCoins are 0, which is what a freshly started
// stream really has. Integration wires them to live_stream_runtime.current_concurrent_viewers,
// live_stream_runtime.total_views_live and SUM(gift_transactions.total_point_value).
export function useLiveHostHeader(): LiveHostHeader {
  const [name, setName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [tapins, setTapins] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const userId = await getCurrentSupabaseUserId();
        if (!userId) return;

        const [profileRes, channelRes] = await Promise.all([
          supabase.from('profiles').select('display_name, avatar_url').eq('user_id', userId).maybeSingle(),
          supabase.from('channels').select('name, avatar_url, tapiners').eq('user_id', userId).maybeSingle(),
        ]);
        if (cancelled) return;

        const profile = profileRes.data as { display_name: string | null; avatar_url: string | null } | null;
        const channel = channelRes.data as { name: string | null; avatar_url: string | null; tapiners: number | null } | null;

        setName(channel?.name || profile?.display_name || '');
        setAvatarUrl(profile?.avatar_url || channel?.avatar_url || null);
        setTapins(channel?.tapiners ?? 0);
      } catch (err) {
        console.warn('useLiveHostHeader: failed to load host header', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { name, avatarUrl, tapins, liveViewers: 0, totalViews: 0, earnedCoins: 0, loading };
}
