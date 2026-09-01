import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const SUPABASE_URL = 'https://ymmgctotppvzuczrhdgc.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltbWdjdG90cHB2enVjenJoZGdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0ODQzMzksImV4cCI6MjA4OTA2MDMzOX0.L7n-Dp8Z1ArHC04NMYy6H1Vq7673NibCOM0aLOqfsio';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export type LeaderboardCategory = 'tapiners' | 'views' | 'posts';

export interface LeaderboardRow {
  channel_id: string;
  name: string;
  avatar_url: string | null;
  score: number | string | bigint;
}

export interface RankBadgeRow {
  user_id: string;
  channel_id: string;
  category: LeaderboardCategory;
  rank: number;
}

export interface WalletRow {
  id: string;
  user_id: string;
  balance?: number | null;
  walletType?: 'uni5pay' | 'bep20_usdt' | null;
  walletNumber?: string | null;
  walletAddress?: string | null;
  accountHolder?: string | null;
}

export interface WithdrawalRow {
  id: string;
  user_id: string;
  amount: number | null ;
  method: 'uni5pay' | 'usdt_bep20' | string;
  destination: string | null;
  status: 'pending' | 'paid' | 'failed' | string;
  invoice_number?: string | null;
  net_amount?: number | null;
  created_at?: string;
}

function rankLeaderboardRows(
  channels: { id: string; name: string; avatar_url: string | null }[],
  scores: Map<string, number>,
  limit: number
): LeaderboardRow[] {
  const channelById = new Map(channels.map((c) => [c.id, c]));
  return [...scores.entries()]
    .filter(([channelId, score]) => score > 0 && channelById.has(channelId))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([channelId, score]) => ({
      channel_id: channelId,
      name: channelById.get(channelId)!.name,
      avatar_url: channelById.get(channelId)!.avatar_url,
      score,
    }));
}

// Aggregated client-side from the source tables (tapins, videos/shorts views,
// community_posts) so the counts always match what the rest of the app shows.
// The weekly_top_* RPCs only count a 7-day window over tables the app does not
// reliably populate (e.g. video_engagements), which made this screen look empty.
export async function fetchLeaderboard(category: LeaderboardCategory, limit = 100): Promise<LeaderboardRow[]> {
  const scores = new Map<string, number>();
  const add = (channelId: string | null | undefined, amount: number) => {
    if (!channelId || amount <= 0) return;
    scores.set(channelId, (scores.get(channelId) || 0) + amount);
  };

  const channelsReq = supabase.from('channels').select('id, name, avatar_url').limit(1000);

  if (category === 'tapiners') {
    // Rank by the channel's trigger-maintained `tapiners` column. Counting the `tapins`
    // table directly returns 0 under RLS (a user can only read their own tapins), so the
    // column is the single source that stays consistent with the rest of the app.
    const channelsRes = await supabase
      .from('channels')
      .select('id, name, avatar_url, tapiners')
      .order('tapiners', { ascending: false })
      .limit(1000);
    if (channelsRes.error) throw channelsRes.error;
    (channelsRes.data || []).forEach((row: { id: string; tapiners: number | null }) =>
      add(row.id, Number(row.tapiners || 0))
    );
    return rankLeaderboardRows(channelsRes.data || [], scores, limit);
  }

  if (category === 'views') {
    const [channelsRes, videosRes, shortsRes] = await Promise.all([
      channelsReq,
      supabase
        .from('videos')
        .select('channel_id, user_id, views, is_short, video_url, title, thumbnail_url')
        .eq('status', 'published')
        .limit(10000),
      supabase
        .from('shorts')
        .select('channel_id, user_id, views, video_url, title, thumbnail_url')
        .eq('status', 'published')
        .limit(10000),
    ]);
    if (channelsRes.error) throw channelsRes.error;
    if (videosRes.error) throw videosRes.error;
    if (shortsRes.error) throw shortsRes.error;

    type ViewRow = {
      channel_id: string;
      user_id?: string | null;
      views: number | null;
      is_short?: boolean | null;
      video_url?: string | null;
      title?: string | null;
      thumbnail_url?: string | null;
    };
    const videoRows = (videosRes.data || []) as ViewRow[];
    const shortRows = (shortsRes.data || []) as ViewRow[];

    // Momenti live in BOTH the `videos` table (is_short = true) and the `shorts`
    // table, so summing the two raw tables double-counts their views. ChannelScreen
    // dedupes momenti by this composite key, so we mirror it here to keep the
    // per-channel score equal to what the channel page shows.
    videoRows.filter((row) => !row.is_short).forEach((row) => add(row.channel_id, Number(row.views || 0)));
    const seenMomenti = new Set<string>();
    [...videoRows.filter((row) => row.is_short), ...shortRows].forEach((row) => {
      const key = `${row.user_id || ''}|${row.channel_id || ''}|${(row.video_url || '').trim().toLowerCase()}|${(row.title || '').trim().toLowerCase()}|${(row.thumbnail_url || '').trim().toLowerCase()}`;
      if (seenMomenti.has(key)) return;
      seenMomenti.add(key);
      add(row.channel_id, Number(row.views || 0));
    });
    return rankLeaderboardRows(channelsRes.data || [], scores, limit);
  }

  // Bangi posts: count every community post for the channel (including auto-generated
  // ones) so the score matches the count shown on the channel page's Bangi tab.
  const [channelsRes, postsRes] = await Promise.all([
    channelsReq,
    supabase.from('community_posts').select('channel_id').limit(10000),
  ]);
  if (channelsRes.error) throw channelsRes.error;
  if (postsRes.error) throw postsRes.error;
  (postsRes.data || []).forEach((row: { channel_id: string }) => add(row.channel_id, 1));
  return rankLeaderboardRows(channelsRes.data || [], scores, limit);
}

export async function fetchTop3RankBadges() {
  const { data, error } = await supabase.rpc('get_top3_rank_badges');
  if (error) throw error;
  return (Array.isArray(data) ? data : []) as RankBadgeRow[];
}

export async function createWithdrawal(input: {
  amount: number;
  method: 'uni5pay' | 'usdt_bep20';
  destination: string;
}) {
  const { data, error } = await supabase.rpc('create_withdrawal', {
    p_amount: input.amount,
    p_method: input.method,
    p_destination: input.destination,
  });

  if (error) throw error;
  return data;
}

export async function fetchWalletRow(userId: string) {
  const { data, error } = await supabase
    .from('wallets')
    .select('id, user_id, balance, walletType, walletNumber, walletAddress, accountHolder')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data as WalletRow | null;
}

export async function fetchWalletWithdrawals(userId: string) {
  const { data, error } = await supabase
    .from('wallet_withdrawals')
    .select('id, user_id, amount, method, destination, status, invoice_number, net_amount, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as WithdrawalRow[];
}

// Types
export interface Profile {
  id: string;
  user_id: string;
  email?: string;
  display_name: string;
  username: string;
  avatar_url: string | null;
  bio: string | null;
  is_verified: boolean;
  verification_type: string;
  is_admin: boolean;
  is_monetized: boolean;
  standard_share_pct: number;
  bonus_share_pct: number;
  is_founder_team?: boolean;
  created_at: string;
}

export interface ContentClaim {
  id: string;
  claimant_user_id: string;
  video_id: string;
  claim_status: string;
  created_at: string;
  updated_at: string;
}

export interface PollOption {
  id: string;
  label: string;
  votes: number;
}

export interface Channel {
  id: string;
  user_id: string;
  name: string;
  handle: string;
  description: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  tapiners: number;
  monetization_enabled: boolean;
  created_at: string;
}

export interface Video {
  id: string;
  channel_id: string;
  user_id: string;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  video_url: string;
  duration: number | null;
  views: number;
  likes: number;
  dislikes: number;
  status: string;
  is_short: boolean;
  created_at: string;
}

export interface Short {
  id: string;
  channel_id: string;
  user_id: string;
  title: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  views: number;
  likes: number;
  dislikes: number;
  status: string;
  created_at: string;
}

export interface Comment {
  id: string;
  video_id: string | null;
  user_id: string;
  content: string;
  likes: number;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  post_id: string | null;
}

export interface CommunityPost {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  image_url: string | null;
  likes: number;
  created_at: string;
  video_id: string | null;
  poll_question: string | null;
  poll_options: PollOption[] | null;
  poll_ends_at: string | null;
  background_color?: string | null;
  text_color?: string | null;
  background_style?: string | null;
}

export interface PostLike {
  id: string;
  post_id: string;
  user_id: string;
  created_at: string;
}

export interface VideoLike {
  id: string;
  video_id: string;
  user_id: string;
  like_type: string;
  created_at: string;
}

export interface VideoResponse {
  id: string;
  source_video_id: string;
  source_kind: 'video' | 'short';
  response_video_id: string;
  response_kind: 'video' | 'short';
  response_type: 'response' | 'duet';
  user_id: string;
  created_at: string;
}

export interface VideoReaction {
  id: string;
  video_id: string;
  user_id: string;
  emoji: string;
  timestamp_seconds: number;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  actor_id: string;
  type: string;
  video_id: string | null;
  post_id: string | null;
  read: boolean;
  created_at: string;
}

export interface TapIn {
  id: string;
  user_id: string;
  channel_id: string;
  created_at: string;
}

export interface CreateNotificationInput {
  user_id: string;
  actor_id: string;
  type: string;
  video_id?: string | null;
  post_id?: string | null;
  read?: boolean;
}

export async function insertNotification(notification: CreateNotificationInput) {
  const { error } = await supabase.from('notifications').insert({
    user_id: notification.user_id,
    actor_id: notification.actor_id,
    type: notification.type,
    video_id: notification.video_id ?? null,
    post_id: notification.post_id ?? null,
    read: notification.read ?? false,
  });

  if (error) {
    console.warn('Notification insert failed:', error.message);
  }
}