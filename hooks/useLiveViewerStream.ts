import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getCurrentSupabaseUserId } from '../lib/auth';

export interface LiveViewerStreamData {
  hostUserId: string | null;
  channelId: string | null;
  hostName: string;
  hostAvatarUrl: string | null;
  title: string;
  startedAt: string | null;
  tapins: number;
  liveViewers: number;
  earnedCoins: number;
  hasEnded: boolean;
  isModerator: boolean;
  hasTapped: boolean;
  tapInBusy: boolean;
  tapIn: () => Promise<void>;
  loading: boolean;
  error: boolean;
}

// Re-checking "did the stream end" / "how many are watching" every ~20s, not per second —
// matches the schema's own guidance (APP_SCHEMA_OVERVIEW.md: viewer counts "re-sync ... every
// few minutes — never poll per second"; 20s is on the fast/safe side of that for a screen
// that's actively open). Real-time push (Realtime subscription / ZegoCloud room event) comes
// in this feature's integration plan.
const POLL_INTERVAL_MS = 20000;

function normalizeName(channel: { name?: string | null } | undefined, profile: { display_name?: string | null } | undefined): string {
  return channel?.name || profile?.display_name || '…';
}

function normalizeAvatar(channel: { avatar_url?: string | null } | undefined, profile: { avatar_url?: string | null } | undefined): string | null {
  return profile?.avatar_url || channel?.avatar_url || null;
}

// Everything LiveViewerScreen needs about the ONE stream it's watching. Real reads only
// (live_streams, channels, profiles, live_stream_runtime, stream_moderators, tapins) — no
// live_* RPCs and no ZegoCloud room join here yet; that's this feature's integration plan.
export function useLiveViewerStream(streamId: string) {
  const [hostUserId, setHostUserId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [hostName, setHostName] = useState('');
  const [hostAvatarUrl, setHostAvatarUrl] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [tapins, setTapins] = useState(0);
  const [liveViewers, setLiveViewers] = useState(0);
  const [hasEnded, setHasEnded] = useState(false);
  const [isModerator, setIsModerator] = useState(false);
  const [hasTapped, setHasTapped] = useState(false);
  const [tapInBusy, setTapInBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const currentUserIdRef = useRef<string | null>(null);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      // Round-trip 1: everything that only needs streamId (not the stream row's own
      // columns) fires in parallel with the live_streams fetch itself, instead of waiting
      // for it first — this is what was making the screen feel slow to open (3 sequential
      // round-trips before anything rendered; now 2).
      const [userId, streamRes, runtimeRes] = await Promise.all([
        getCurrentSupabaseUserId(),
        supabase.from('live_streams').select('host_user_id, channel_id, title, status, started_at').eq('id', streamId).maybeSingle(),
        supabase.from('live_stream_runtime').select('current_concurrent_viewers').eq('live_stream_id', streamId).maybeSingle(),
      ]);
      if (streamRes.error) throw streamRes.error;
      const stream = streamRes.data;
      currentUserIdRef.current = userId;

      if (!stream) {
        setHasEnded(true);
        return;
      }

      setHostUserId(stream.host_user_id);
      setChannelId(stream.channel_id);
      setTitle(stream.title || '');
      setStartedAt(stream.started_at);
      setHasEnded(stream.status !== 'live');
      setLiveViewers((runtimeRes.data as { current_concurrent_viewers: number } | null)?.current_concurrent_viewers ?? 0);

      // Round-trip 2: everything that needed stream.channel_id/host_user_id, all together.
      const [channelRes, profileRes, modRes, tapinRes] = await Promise.all([
        stream.channel_id
          ? supabase.from('channels').select('name, avatar_url, tapiners').eq('id', stream.channel_id).maybeSingle()
          : Promise.resolve({ data: null }),
        stream.host_user_id
          ? supabase.from('profiles').select('display_name, avatar_url').eq('user_id', stream.host_user_id).maybeSingle()
          : Promise.resolve({ data: null }),
        userId
          ? supabase
              .from('stream_moderators')
              .select('id')
              .is('revoked_at', null)
              .eq('user_id', userId)
              .or(`live_stream_id.eq.${streamId},channel_id.eq.${stream.channel_id},and(live_stream_id.is.null,channel_id.is.null)`)
              .limit(1)
          : Promise.resolve({ data: null }),
        userId && stream.channel_id
          ? supabase.from('tapins').select('id').eq('user_id', userId).eq('channel_id', stream.channel_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      const channel = channelRes.data as { name: string | null; avatar_url: string | null; tapiners: number | null } | null;
      const profile = profileRes.data as { display_name: string | null; avatar_url: string | null } | null;

      setHostName(normalizeName(channel || undefined, profile || undefined));
      setHostAvatarUrl(normalizeAvatar(channel || undefined, profile || undefined));
      setTapins(channel?.tapiners ?? 0);
      setIsModerator(!!(modRes.data && (modRes.data as any[]).length > 0));
      setHasTapped(!!tapinRes.data);
    } catch (err) {
      console.warn('useLiveViewerStream: failed to load stream', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [streamId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Lightweight periodic re-sync: viewer count + "did the host end the stream".
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [statusRes, runtimeRes] = await Promise.all([
          supabase.from('live_streams').select('status').eq('id', streamId).maybeSingle(),
          supabase.from('live_stream_runtime').select('current_concurrent_viewers').eq('live_stream_id', streamId).maybeSingle(),
        ]);
        if (statusRes.data) setHasEnded(statusRes.data.status !== 'live');
        else setHasEnded(true); // row gone (shouldn't happen — streams are ended, never deleted)
        if (runtimeRes.data) setLiveViewers(runtimeRes.data.current_concurrent_viewers ?? 0);
      } catch (err) {
        console.warn('useLiveViewerStream: poll failed', err);
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [streamId]);

  const tapIn = useCallback(async () => {
    if (hasTapped || tapInBusy || !channelId) return;
    const currentUserId = currentUserIdRef.current;
    if (!currentUserId) return;

    setTapInBusy(true);
    try {
      const { data: existing } = await supabase
        .from('tapins')
        .select('id')
        .eq('user_id', currentUserId)
        .eq('channel_id', channelId)
        .maybeSingle();
      if (existing) {
        setHasTapped(true);
        return;
      }
      const { error: insertErr } = await supabase.from('tapins').insert({ user_id: currentUserId, channel_id: channelId });
      if (insertErr) throw insertErr;

      // The DB trigger bumps channels.tapiners; reflect it optimistically here (same
      // reasoning as ChannelScreen.tsx — re-counting the tapins table returns 0 under RLS).
      setTapins((prev) => prev + 1);
      setHasTapped(true);
    } catch (err) {
      console.warn('useLiveViewerStream: tap in failed', err);
    } finally {
      setTapInBusy(false);
    }
  }, [hasTapped, tapInBusy, channelId]);

  return {
    hostUserId,
    channelId,
    hostName,
    hostAvatarUrl,
    title,
    startedAt,
    tapins,
    liveViewers,
    earnedCoins: 0, // real value needs gift_live_stream_points() — integration phase
    hasEnded,
    isModerator,
    hasTapped,
    tapInBusy,
    tapIn,
    loading,
    error,
  };
}
