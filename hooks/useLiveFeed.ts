import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type LiveFeedKind = 'solo' | 'cohost' | 'battle';

export interface LiveFeedSide {
  streamId: string;
  hostUserId: string | null;
  name: string;
  avatarUrl: string | null;
  title: string;
  liveViewers: number;
  points?: number; // battle only
}

export interface LiveFeedItem {
  id: string; // stream id for solo, cohost_session/battle id for pairs
  kind: LiveFeedKind;
  categoryId: string | null;
  sides: LiveFeedSide[]; // length 1 (solo) or 2 (cohost/battle)
}

// Small, fixed placeholders shown ONLY when nobody on the platform is actually live —
// purely so the three card layouts (solo/co-host/battle) can be reviewed before any real
// stream exists. The instant one real live_streams row appears, this list is never used.
const DEMO_ITEMS: LiveFeedItem[] = [
  {
    id: 'demo-solo',
    kind: 'solo',
    categoryId: null,
    sides: [{ streamId: 'demo-solo-1', hostUserId: null, name: 'Demo Streamer', avatarUrl: null, title: 'Chit-chat with viewers ✨ (demo)', liveViewers: 128 }],
  },
  {
    id: 'demo-cohost',
    kind: 'cohost',
    categoryId: null,
    sides: [
      { streamId: 'demo-cohost-1', hostUserId: null, name: 'Host Demo', avatarUrl: null, title: 'Co-hosting jam session (demo)', liveViewers: 342 },
      { streamId: 'demo-cohost-2', hostUserId: null, name: 'Guest Demo', avatarUrl: null, title: 'Co-hosting jam session (demo)', liveViewers: 210 },
    ],
  },
  {
    id: 'demo-battle',
    kind: 'battle',
    categoryId: null,
    sides: [
      { streamId: 'demo-battle-1', hostUserId: null, name: 'Fighter A', avatarUrl: null, title: 'LK Battle round 1 (demo)', liveViewers: 512, points: 320 },
      { streamId: 'demo-battle-2', hostUserId: null, name: 'Fighter B', avatarUrl: null, title: 'LK Battle round 1 (demo)', liveViewers: 480, points: 260 },
    ],
  },
];

function normalizeName(channel: { name?: string | null } | undefined, profile: { display_name?: string | null } | undefined): string {
  return channel?.name || profile?.display_name || '…';
}

function normalizeAvatar(channel: { avatar_url?: string | null } | undefined, profile: { avatar_url?: string | null } | undefined): string | null {
  return profile?.avatar_url || channel?.avatar_url || null;
}

// Fetches every currently-live stream plus which of them are linked in an active co-host
// session or LK battle, and folds each linked pair into ONE feed item (a stream that's
// paired never also shows as its own solo card). All plain table reads — no live_* RPCs,
// no ZegoCloud — matching the rest of this feature's UI phase.
export function useLiveFeed() {
  const [items, setItems] = useState<LiveFeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [usingDemo, setUsingDemo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data: streams, error: streamsErr } = await supabase
        .from('live_streams')
        .select('id, host_user_id, channel_id, title, category_id')
        .eq('status', 'live');
      if (streamsErr) throw streamsErr;

      const liveStreams = streams || [];
      if (liveStreams.length === 0) {
        setItems(DEMO_ITEMS);
        setUsingDemo(true);
        return;
      }

      const streamIds = liveStreams.map((s: any) => s.id);

      const [cohostRes, battleRes, runtimeRes] = await Promise.all([
        supabase.from('live_cohost_sessions').select('id, host_stream_id, cohost_stream_id').eq('status', 'live'),
        supabase.from('lk_battles').select('id, initiator_stream_id, opponent_stream_id').eq('status', 'live'),
        supabase.from('live_stream_runtime').select('live_stream_id, current_concurrent_viewers').in('live_stream_id', streamIds),
      ]);

      const cohostSessions = (cohostRes.data || []).filter(
        (c: any) => streamIds.includes(c.host_stream_id) && streamIds.includes(c.cohost_stream_id)
      );
      const battles = (battleRes.data || []).filter(
        (b: any) => streamIds.includes(b.initiator_stream_id) && streamIds.includes(b.opponent_stream_id)
      );

      const battleIds = battles.map((b: any) => b.id);
      const scoresRes = battleIds.length
        ? await supabase.from('lk_battle_scores').select('battle_id, stream_id, points').in('battle_id', battleIds)
        : { data: [] as any[] };
      const scoreByStream = new Map<string, number>();
      for (const row of scoresRes.data || []) scoreByStream.set(`${row.battle_id}:${row.stream_id}`, row.points);

      const viewersByStream = new Map<string, number>();
      for (const row of runtimeRes.data || []) viewersByStream.set(row.live_stream_id, row.current_concurrent_viewers ?? 0);

      const channelIds = [...new Set(liveStreams.map((s: any) => s.channel_id).filter(Boolean))];
      const hostUserIds = [...new Set(liveStreams.map((s: any) => s.host_user_id).filter(Boolean))];
      const [channelsRes, profilesRes] = await Promise.all([
        channelIds.length ? supabase.from('channels').select('id, name, avatar_url').in('id', channelIds) : Promise.resolve({ data: [] as any[] }),
        hostUserIds.length ? supabase.from('profiles').select('user_id, display_name, avatar_url').in('user_id', hostUserIds) : Promise.resolve({ data: [] as any[] }),
      ]);
      const channelById = new Map((channelsRes.data || []).map((c: any) => [c.id, c]));
      const profileByUserId = new Map((profilesRes.data || []).map((p: any) => [p.user_id, p]));

      const streamById = new Map(liveStreams.map((s: any) => [s.id, s]));
      const pairedStreamIds = new Set<string>();
      for (const c of cohostSessions) {
        pairedStreamIds.add(c.host_stream_id);
        pairedStreamIds.add(c.cohost_stream_id);
      }
      for (const b of battles) {
        pairedStreamIds.add(b.initiator_stream_id);
        pairedStreamIds.add(b.opponent_stream_id);
      }

      const buildSide = (streamId: string, battleId?: string): LiveFeedSide => {
        const stream = streamById.get(streamId);
        const channel = stream?.channel_id ? channelById.get(stream.channel_id) : undefined;
        const profile = stream?.host_user_id ? profileByUserId.get(stream.host_user_id) : undefined;
        return {
          streamId,
          hostUserId: stream?.host_user_id ?? null,
          name: normalizeName(channel, profile),
          avatarUrl: normalizeAvatar(channel, profile),
          title: stream?.title || '…',
          liveViewers: viewersByStream.get(streamId) ?? 0,
          points: battleId ? scoreByStream.get(`${battleId}:${streamId}`) ?? 0 : undefined,
        };
      };

      const result: LiveFeedItem[] = [];

      for (const c of cohostSessions) {
        result.push({
          id: c.id,
          kind: 'cohost',
          categoryId: streamById.get(c.host_stream_id)?.category_id ?? null,
          sides: [buildSide(c.host_stream_id), buildSide(c.cohost_stream_id)],
        });
      }
      for (const b of battles) {
        result.push({
          id: b.id,
          kind: 'battle',
          categoryId: streamById.get(b.initiator_stream_id)?.category_id ?? null,
          sides: [buildSide(b.initiator_stream_id, b.id), buildSide(b.opponent_stream_id, b.id)],
        });
      }
      for (const s of liveStreams) {
        if (pairedStreamIds.has(s.id)) continue;
        result.push({ id: s.id, kind: 'solo', categoryId: s.category_id ?? null, sides: [buildSide(s.id)] });
      }

      setItems(result);
      setUsingDemo(false);
    } catch (err) {
      console.warn('useLiveFeed: failed to load live feed', err);
      setError(true);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { items, loading, error, usingDemo, retry: load };
}
