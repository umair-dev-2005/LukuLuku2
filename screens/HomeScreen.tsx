import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
  Dimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { supabase, Video, Channel, CommunityPost } from '../lib/supabase';
import { getCurrentSupabaseUserId } from '../lib/auth';
import { loadBlockedUserIds, subscribeCommunitySafetyChanges } from '../lib/communitySafety';
import { t } from '../lib/i18n';
import { formatViews, formatTimeAgo, extractRankingTerms, sortByFeedScore, formatDuration, isMomentiDuration, rankGameFeed } from '../lib/utils';
import VideoCard from '../components/VideoCard';
import VerifiedBadge from '../components/VerifiedBadge';
import { useActiveAds, SponsoredAd } from '../hooks/useActiveAds';
import SponsoredAdCard from '../components/SponsoredAdCard';

declare const require: any;

const { width } = Dimensions.get('window');
const WATCH_HISTORY_KEY = 'lukuluku_watch_history_v1';

const getBangiTextCardStyle = (post: CommunityPost & { background_color?: string | null; text_color?: string | null; background_style?: string | null }) => ({
  backgroundColor: post.background_color || colors.surface,
  color: post.text_color || colors.text,
});

interface WatchHistoryItem {
  videoId: string;
  currentTime: number;
  duration: number | null;
  title: string;
  thumbnail_url: string | null;
  updatedAt: number;
}

interface HomeScreenProps {
  onVideoPress: (video: Video) => void;
  onMomentiPress: (video: Video) => void;
  onChannelPress: (channelId: string) => void;
  onPostPress: (postId: string) => void;
  onNotificationsPress: () => void;
  onGamesPress?: () => void;
  onLeaderboardsPress?: () => void;
  onPlayGame?: (gameId: string, gameType: string, gameName: string) => void;
  refreshToken?: number;
  isActive?: boolean;
}

interface CreatorWithVerified extends Channel {
  isVerified?: boolean;
  verificationType?: string | null;
}

interface GamePixGame {
  id: string;
  title: string;
  description: string;
  url: string;
  banner_image?: string;
  image?: string;
  namespace?: string;
}

type HomeVideoFeedItem =
  | { type: 'video'; video: Video }
  | { type: 'ad'; ad: SponsoredAd };

type BangiFeedItem =
  | { type: 'post'; post: CommunityPost & { channelName?: string; channelAvatar?: string; channelId?: string; isVerified?: boolean; verificationType?: string | null; commentCount?: number; likeCount?: number } }
  | { type: 'ad'; ad: SponsoredAd };

type FeedMode = 'for-you' | 'trending' | 'new';

const AD_IMPRESSION_KEY = 'home_screen_ad_impressions_v1';
const AD_COOLDOWN_MS = 30 * 60 * 1000;
const HOME_CACHE_KEY = 'home_feed_cache_v1';

function HomeScreen({
  onVideoPress,
  onMomentiPress,
  onChannelPress,
  onPostPress,
  onNotificationsPress,
  onGamesPress,
  onLeaderboardsPress,
  onPlayGame,
  refreshToken = 0,
  isActive = true,
}: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const { ads } = useActiveAds('sponsored');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [feedMode, setFeedMode] = useState<FeedMode>('for-you');
  const adHistoryRef = useRef<Record<string, number>>({});
  const sessionAdIdsRef = useRef<Set<string>>(new Set());
  const adCursorRef = useRef(0);
  const [videos, setVideos] = useState<Video[]>([]);
  const [momenti, setMomenti] = useState<Video[]>([]);
  const [spotlightCreators, setSpotlightCreators] = useState<CreatorWithVerified[]>([]);
  const [leaderboardCreators, setLeaderboardCreators] = useState<CreatorWithVerified[]>([]);
  const [bangiPosts, setBangiPosts] = useState<(CommunityPost & { channelName?: string; channelAvatar?: string; channelId?: string; isVerified?: boolean; verificationType?: string | null; commentCount?: number; likeCount?: number })[]>([]);
  const [gamePixGames, setGamePixGames] = useState<GamePixGame[]>([]);
  const [watchHistory, setWatchHistory] = useState<WatchHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const freshFeedLoadedRef = useRef(false);
  const isInitialFetchRef = useRef(true);
  const listRef = useRef<FlatList>(null);

  // Auto-scroll to top when user returns to this tab
  useEffect(() => {
    if (isActive) {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [isActive]);

  // Paint the last known feed instantly while fresh data loads; the network
  // fetch overwrites it as soon as it lands.
  useEffect(() => {
    AsyncStorage.getItem(HOME_CACHE_KEY)
      .then((raw: string | null) => {
        if (!raw || freshFeedLoadedRef.current) return;
        const snap = JSON.parse(raw);
        if (snap.videos?.length) setVideos(snap.videos);
        if (snap.momenti?.length) setMomenti(snap.momenti);
        if (snap.spotlightCreators?.length) {
          setSpotlightCreators(snap.spotlightCreators);
          setLeaderboardCreators(snap.spotlightCreators.slice(0, 5));
        }
        if (snap.bangiPosts?.length) setBangiPosts(snap.bangiPosts);

        // If we have cached data, we can hide the initial full-screen loader
        // immediately for a faster perceived load.
        if (snap.videos?.length) setLoading(false);
      })
      .catch(() => {});
  }, []);

  const fetchGamePixGames = useCallback(async () => {
    try {
      const response = await globalThis.fetch('https://feeds.gamepix.com/v2/json/?order=quality&page=1&pagination=12&sid=U274U');
      const data = await response.json();
      const items = (data.items || []) as GamePixGame[];
      const preferredTerms = extractRankingTerms(items as any[]);
      const rankedItems = rankGameFeed(
        items.slice(0, 8),
        (game: GamePixGame) => ({
          id: game.id,
          title: game.title,
          description: game.description,
          tags: [game.namespace || 'game'],
          namespace: game.namespace,
          url: game.url,
          banner_image: game.banner_image || null,
          image: game.image || null,
        }),
        preferredTerms
      );
      setGamePixGames(rankedItems);
    } catch {
      setGamePixGames([]);
    }
  }, []);

  useEffect(() => {
    // We only load initial blocked IDs here. fetchData will also fetch them
    // to ensure consistency during the feed load.
    void loadBlockedUserIds().then(setBlockedUserIds);

    return subscribeCommunitySafetyChanges(() => {
      void loadBlockedUserIds().then((ids) => {
        setBlockedUserIds(ids);
        void fetchData(); // Trigger a fresh fetch if safety settings change
      });
    });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(AD_IMPRESSION_KEY)
      .then((value: string | null) => {
        if (!value) return;
        const parsed = JSON.parse(value) as Record<string, number>;
        adHistoryRef.current = parsed || {};
      })
      .catch(() => {
        adHistoryRef.current = {};
      });
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(WATCH_HISTORY_KEY)
      .then((value: string | null) => {
        if (!value) {
          setWatchHistory([]);
          return;
        }
        const parsed = JSON.parse(value) as WatchHistoryItem[];
        setWatchHistory(Array.isArray(parsed) ? parsed : []);
      })
      .catch(() => setWatchHistory([]));
  }, []);

  const registerAdImpression = useCallback((adId: string) => {
    const now = Date.now();
    adHistoryRef.current[adId] = now;
    sessionAdIdsRef.current.add(adId);
    void AsyncStorage.setItem(AD_IMPRESSION_KEY, JSON.stringify(adHistoryRef.current));
  }, []);

  const takeNextAd = useCallback((): SponsoredAd | null => {
    if (ads.length === 0) return null;

    const now = Date.now();
    const eligible = ads.filter((ad: SponsoredAd) => {
      if (sessionAdIdsRef.current.has(ad.id)) return false;
      const lastShown = adHistoryRef.current[ad.id] || 0;
      return now - lastShown >= AD_COOLDOWN_MS;
    });

    const fallback = ads.filter((ad: SponsoredAd) => !sessionAdIdsRef.current.has(ad.id));
    const pool = eligible.length > 0 ? eligible : fallback;
    if (pool.length === 0) return null;

    const ad = pool[adCursorRef.current % pool.length];
    adCursorRef.current += 1;
    registerAdImpression(ad.id);
    return ad;
  }, [ads, registerAdImpression]);

  const fetchData = useCallback(async () => {
    // Only show full-screen loader if we have absolutely no data to show (no cache)
    if (isInitialFetchRef.current && videos.length === 0) {
      setLoading(true);
    }

    try {
      // Fetch user ID and blocked IDs directly to avoid multiple triggers on mount.
      // We do this inside fetchData so the feed load always uses the latest state.
      const [userId, blockedIds] = await Promise.all([
        getCurrentSupabaseUserId().catch(() => null),
        loadBlockedUserIds().catch(() => []),
      ]);

      // Update state for other components/hooks that might use them.
      setCurrentUserId(userId);
      setBlockedUserIds(blockedIds);

      const loadVideos = async (): Promise<Video[]> => {
        if (feedMode === 'trending') {
          const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
          const { data } = await supabase
            .from('videos')
            .select('*, channels(name, avatar_url)')
            .eq('status', 'published')
            .eq('is_short', false)
            .gte('created_at', since)
            .order('views', { ascending: false })
            .limit(20);
          return (data || []) as Video[];
        }

        if (feedMode === 'new') {
          const { data } = await supabase
            .from('videos')
            .select('*, channels(name, avatar_url)')
            .eq('status', 'published')
            .eq('is_short', false)
            .order('created_at', { ascending: false })
            .limit(20);
          return (data || []) as Video[];
        }

        const { data: personalizedFeed, error } = await supabase.rpc('get_personalized_feed', {
          p_user_id: userId,
          p_limit: 20,
          p_offset: 0,
        });

        if (!error && personalizedFeed?.length) {
          return personalizedFeed as Video[];
        }

        const { data: fallback } = await supabase
          .from('videos')
          .select('*, channels(name, avatar_url)')
          .eq('status', 'published')
          .eq('is_short', false)
          .order('created_at', { ascending: false })
          .limit(20);
        return (fallback || []) as Video[];
      };

      // GamePix is an external API with no dependency on our data — let it
      // load alongside the feed instead of after it.
      const gamePixPromise = fetchGamePixGames();

      const [videosData, creatorsRes, bangiRes, momentsVideosRes, legacyShortsRes] = await Promise.all([
        loadVideos(),
        supabase
          .from('channels')
          .select('*')
          .order('tapiners', { ascending: false })
          .limit(10),
        supabase
          .from('community_posts')
          .select('*, channels(id, name, avatar_url, user_id), videos(id, title, thumbnail_url, views, channel_id)')
          .order('created_at', { ascending: false })
          .limit(15),
        supabase
          .from('videos')
          .select('*, channels(id, name, avatar_url)')
          .eq('status', 'published')
          .eq('is_short', true)
          .order('created_at', { ascending: false })
          .limit(15),
        supabase
          .from('shorts')
          .select('*, channels(id, name, avatar_url)')
          .eq('status', 'published')
          .order('created_at', { ascending: false })
          .limit(15),
      ]);

      const allLongVideos = (videosData || []).filter((video: Video) => !isMomentiDuration(video.duration, video.is_short));
      const visibleLongVideos = allLongVideos.filter((video: Video) => !blockedIds.includes(video.user_id));

      const preferredTerms = extractRankingTerms([
        ...(videosData || []),
        ...((momentsVideosRes.data || []) as Video[]),
        ...((legacyShortsRes.data || []) as Video[]),
      ]);

      const sortedVideos = feedMode === 'for-you'
        ? sortByFeedScore(
            visibleLongVideos,
            (item: Video) => ({
              title: item.title,
              description: item.description,
              tags: (item as any).tags,
              created_at: item.created_at,
              views: item.views,
              likes: item.likes,
              namespace: 'video',
            }),
            preferredTerms
          )
        : visibleLongVideos;
      setVideos(sortedVideos);

      const creators = (creatorsRes.data || []) as Channel[];
      const allBangiPosts = (bangiRes.data || []) as any[];
      const bangiData = allBangiPosts
        .filter((post) => !blockedIds.includes(post.user_id)) as any[];

      const profileIds = [...new Set([...creators.map((c) => c.user_id), ...bangiData.map((p) => p.user_id)])];
      const postIds = bangiData.map((p) => p.id);

      // Fetch verified badges, comments and likes in parallel.
      // We do this in one batch to keep the "First Load" fast.
      const [profilesRes, commentCountsRes, likeCountsRes] = await Promise.all([
        profileIds.length > 0
          ? supabase.from('profiles').select('user_id, is_verified, verification_type').in('user_id', profileIds)
          : Promise.resolve({ data: [] as { user_id: string; is_verified: boolean; verification_type: string | null }[] }),
        postIds.length > 0
          ? supabase.from('comments').select('post_id').in('post_id', postIds)
          : Promise.resolve({ data: [] as { post_id: string }[] }),
        postIds.length > 0
          ? supabase.from('post_likes').select('post_id').in('post_id', postIds)
          : Promise.resolve({ data: [] as { post_id: string }[] }),
      ]);

      const verifiedMap = new Map<string, { isVerified: boolean; verificationType: string | null }>();
      (profilesRes.data || []).forEach((p: { user_id: string; is_verified: boolean; verification_type: string | null }) => {
        if (p.is_verified) verifiedMap.set(p.user_id, { isVerified: true, verificationType: p.verification_type });
      });

      const creatorsWithVerified = creators.map((c: Channel) => ({
        ...c,
        tapiners: c.tapiners ?? 0,
        isVerified: verifiedMap.get(c.user_id)?.isVerified || false,
        verificationType: verifiedMap.get(c.user_id)?.verificationType || null,
      }));

      setSpotlightCreators(creatorsWithVerified);
      setLeaderboardCreators(creatorsWithVerified.slice(0, 5));

      const shortVideoMomenti = (momentsVideosRes.data || [])
        .filter((item: Video) => isMomentiDuration(item.duration, item.is_short))
        .map((item: Video) => ({
          ...item,
          is_short: true,
        })) as Video[];

      const legacyMomenti = (legacyShortsRes.data || []) as Video[];
      const seenMomenti = new Set<string>();
      const momentiVideos = [...shortVideoMomenti, ...legacyMomenti]
        .filter((item: any) => {
          const signature = `${item.user_id || ''}|${item.channel_id || ''}|${(item.video_url || '').trim().toLowerCase()}|${(item.title || '').trim().toLowerCase()}|${(item.thumbnail_url || '').trim().toLowerCase()}`;
          if (seenMomenti.has(signature)) return false;
          seenMomenti.add(signature);
          return true;
        })
        .filter((item: any) => !blockedIds.includes(item.user_id))
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setMomenti(momentiVideos);

      const commentCountMap = new Map<string, number>();
      ((commentCountsRes.data || []) as { post_id: string }[]).forEach((comment) => {
        commentCountMap.set(comment.post_id, (commentCountMap.get(comment.post_id) || 0) + 1);
      });

      const likeCountMap = new Map<string, number>();
      ((likeCountsRes.data || []) as { post_id: string }[]).forEach((like) => {
        likeCountMap.set(like.post_id, (likeCountMap.get(like.post_id) || 0) + 1);
      });

      const postsWithChannel = bangiData.map((p) => {
        const ch = p.channels as { id: string; name: string | null; avatar_url: string | null } | null;
        const imageUrl = p.image_url || p.videos?.thumbnail_url || null;
        return {
          ...p,
          image_url: imageUrl,
          channelName: ch?.name,
          channelAvatar: ch?.avatar_url || undefined,
          channelId: ch?.id,
          isVerified: verifiedMap.get(p.user_id)?.isVerified || false,
          verificationType: verifiedMap.get(p.user_id)?.verificationType || null,
          commentCount: commentCountMap.get(p.id) || 0,
          likeCount: likeCountMap.get(p.id) || p.likes || 0,
        };
      });
      if (bangiData.length > 0) {
        setBangiPosts(postsWithChannel);
      }

      freshFeedLoadedRef.current = true;
      AsyncStorage.setItem(
        HOME_CACHE_KEY,
        JSON.stringify({
          videos: sortedVideos,
          momenti: momentiVideos,
          spotlightCreators: creatorsWithVerified,
          bangiPosts: bangiData.length > 0 ? postsWithChannel : undefined,
        })
      ).catch(() => {});

      await gamePixPromise;
      isInitialFetchRef.current = false;
    } catch (error) {
      console.warn('Home feed failed to load:', error);
      if (isInitialFetchRef.current && videos.length === 0) {
        setVideos([]);
        setMomenti([]);
        setSpotlightCreators([]);
        setLeaderboardCreators([]);
        setBangiPosts([]);
        setGamePixGames([]);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchGamePixGames, feedMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshToken]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  const continueWatchingVideos = useMemo(() => {
    const historyMap = new Map<string, WatchHistoryItem>(watchHistory.map((item: WatchHistoryItem) => [item.videoId, item]));

    return videos
      .filter((video: Video) => {
        const item = historyMap.get(video.id);
        if (!item) return false;
        if (item.currentTime < 5) return false;
        if (item.duration && item.currentTime >= item.duration * 0.95) return false;
        return true;
      })
      .sort((a: Video, b: Video) => {
        const aTime = historyMap.get(a.id)?.updatedAt || 0;
        const bTime = historyMap.get(b.id)?.updatedAt || 0;
        return bTime - aTime;
      })
      .slice(0, 6);
  }, [videos, watchHistory]);

  const feedModeLabel = feedMode === 'for-you' ? t('home.forYou') : feedMode === 'trending' ? t('home.trending' as any) : t('home.new' as any);

  const homeVideoItems = useMemo<HomeVideoFeedItem[]>(() => {
    const items: HomeVideoFeedItem[] = [];

    videos.forEach((video: Video, index: number) => {
      items.push({ type: 'video', video });
      const shouldInsertAd = index > 0 && (index + 1) % 4 === 0 && ads.length > 0;
      if (shouldInsertAd) {
        const nextAd = takeNextAd();
        if (nextAd) items.push({ type: 'ad', ad: nextAd });
      }
    });

    return items;
  }, [videos, ads, takeNextAd]);

  const bangiFeedItems = useMemo<BangiFeedItem[]>(() => {
    const items: BangiFeedItem[] = [];

    bangiPosts.forEach((post: CommunityPost & { channelName?: string; channelAvatar?: string; channelId?: string; isVerified?: boolean; verificationType?: string | null; commentCount?: number; likeCount?: number }, index: number) => {
      items.push({ type: 'post', post });
      const shouldInsertAd = (index + 1) % 3 === 0 && ads.length > 0;
      if (shouldInsertAd) {
        const nextAd = takeNextAd();
        if (nextAd) items.push({ type: 'ad', ad: nextAd });
      }
    });

    return items;
  }, [bangiPosts, ads, takeNextAd]);

  const memoizedHeader = useMemo(() => (
    <View>
      {onLeaderboardsPress && (
        <View style={styles.sectionCtaWrap}>
          <TouchableOpacity style={styles.sectionCtaButton} onPress={onLeaderboardsPress} activeOpacity={0.85}>
            <Ionicons name="trophy" size={16} color={colors.tapIn} />
            <Text style={styles.sectionCtaText}>{t('leaderboards.title' as any)}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Leaderboard */}
      {leaderboardCreators.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="trophy" size={18} color="#FFD700" />
              <Text style={styles.sectionTitle}>{t('home.leaderboard')}</Text>
            </View>
          </View>
          <View style={styles.leaderboardContainer}>
            {leaderboardCreators.map((creator: CreatorWithVerified, index: number) => (
              <TouchableOpacity
                key={creator.id}
                style={styles.leaderboardRow}
                onPress={() => onChannelPress(creator.id)}
                activeOpacity={0.7}
              >
                <View style={[
                  styles.rankBadge,
                  index === 0 && styles.rankGold,
                  index === 1 && styles.rankSilver,
                  index === 2 && styles.rankBronze,
                ]}>
                  <Text style={[
                    styles.rankText,
                    index < 3 && styles.rankTextTop,
                  ]}>
                    {index + 1}
                  </Text>
                </View>
                {creator.avatar_url ? (
                  <Image
                    source={{ uri: creator.avatar_url }}
                    style={styles.leaderboardAvatar}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    transition={0}
                  />
                ) : (
                  <View style={[styles.leaderboardAvatar, styles.avatarPlaceholder]}>
                    <Ionicons name="person" size={16} color={colors.textTertiary} />
                  </View>
                )}
                <View style={styles.leaderboardInfo}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={styles.leaderboardName} numberOfLines={1}>
                      {creator.name}
                    </Text>
                    {creator.isVerified && (
                      <VerifiedBadge isVerified={true} verificationType={creator.verificationType} size={14} />
                    )}
                  </View>
                  <Text style={styles.leaderboardHandle}>@{creator.handle}</Text>
                </View>
                <Text style={styles.leaderboardCount}>
                  {formatViews(creator.tapiners)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <View style={styles.feedModeSection}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.feedModeScroll}>
          {([
            { key: 'for-you' as const, label: t('home.forYou') },
            { key: 'trending' as const, label: t('home.trending' as any) },
            { key: 'new' as const, label: t('home.new' as any) },
          ] as const).map((item) => {
            const active = feedMode === item.key;
            return (
              <TouchableOpacity
                key={item.key}
                onPress={() => setFeedMode(item.key)}
                style={[styles.feedModePill, active && styles.feedModePillActive]}
                activeOpacity={0.85}
              >
                <Text style={[styles.feedModePillText, active && styles.feedModePillTextActive]}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {ads.length > 0 && (
        <View style={styles.inlineAdBanner}>
          <SponsoredAdCard ad={ads[0]} />
        </View>
      )}

      {/* Creator Spotlight */}
      {spotlightCreators.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="star" size={18} color={colors.primary} />
              <Text style={styles.sectionTitle}>{t('home.spotlight')}</Text>
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.spotlightScroll}
          >
            {spotlightCreators.map((creator: CreatorWithVerified) => (
              <TouchableOpacity
                key={creator.id}
                style={styles.spotlightCard}
                onPress={() => onChannelPress(creator.id)}
                activeOpacity={0.8}
              >
                <View style={styles.spotlightAvatarWrap}>
                  {creator.avatar_url ? (
                    <Image
                      source={{ uri: creator.avatar_url }}
                      style={styles.spotlightAvatar}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.spotlightAvatar, styles.avatarPlaceholder]}>
                      <Ionicons name="person" size={24} color={colors.textTertiary} />
                    </View>
                  )}
                  {creator.isVerified && (
                    <View style={styles.spotlightVerified}>
                      <VerifiedBadge isVerified={true} verificationType={creator.verificationType} size={16} />
                    </View>
                  )}
                </View>
                <Text style={styles.spotlightName} numberOfLines={1}>
                  {creator.name}
                </Text>
                <Text style={styles.spotlightSubs}>
                  {formatViews(creator.tapiners)} tapins
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Bangi Feed */}
      {bangiPosts.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="chatbubbles" size={18} color="#5856D6" />
              <Text style={styles.sectionTitle}>{t('home.bangi')}</Text>
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.bangiScroll}
          >
            {bangiFeedItems.map((item: BangiFeedItem, index: number) => (
              item.type === 'ad' ? (
                <View key={`bangi-ad-${item.ad.id}-${index}`} style={styles.bangiAdWrap}>
                  <SponsoredAdCard ad={item.ad} variant="thumbnail" />
                </View>
              ) : (
                <TouchableOpacity
                  key={item.post.id}
                  style={[
                    styles.bangiCard,
                    !item.post.image_url && { backgroundColor: item.post.background_color || colors.surface },
                  ]}
                  onPress={() => onPostPress(item.post.id)}
                  activeOpacity={0.8}
                >
                  {item.post.image_url ? (
                    <Image
                      source={{ uri: item.post.image_url }}
                      style={styles.bangiImage}
                      contentFit="cover"
                      transition={0}
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={[styles.textOnlyBangiCard, { backgroundColor: item.post.background_color || colors.surface }]}>
                      <Text style={[styles.textOnlyBangiText, { color: item.post.text_color || colors.text }]} numberOfLines={5}>
                        {item.post.content}
                      </Text>
                    </View>
                  )}
                  <View style={styles.bangiCardContent}>
                    <View style={styles.bangiAuthorRow}>
                      {item.post.channelAvatar ? (
                        <Image source={{ uri: item.post.channelAvatar }} style={styles.bangiAuthorAvatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
                      ) : (
                        <View style={[styles.bangiAuthorAvatar, styles.avatarPlaceholder]}>
                          <Ionicons name="person" size={10} color={colors.textTertiary} />
                        </View>
                      )}
                      <Text style={styles.bangiAuthorName} numberOfLines={1}>{item.post.channelName || ''}</Text>
                      {item.post.isVerified && (
                        <VerifiedBadge isVerified={true} verificationType={item.post.verificationType} size={12} />
                      )}
                    </View>
                    {item.post.image_url ? (
                      <Text style={styles.bangiText} numberOfLines={2}>{item.post.content}</Text>
                    ) : null}
                    <View style={styles.bangiMeta}>
                      <Ionicons name="heart-outline" size={12} color={colors.textTertiary} />
                      <Text style={styles.bangiMetaText}>{item.post.likeCount ?? item.post.likes}</Text>
                      <Ionicons name="chatbubble-outline" size={12} color={colors.textTertiary} />
                      <Text style={styles.bangiMetaText}>{item.post.commentCount ?? 0}</Text>
                      <Text style={styles.bangiMetaText}>| {formatTimeAgo(item.post.created_at)}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              )
            ))}
          </ScrollView>
        </View>
      )}

      {/* Games Section */}
      {gamePixGames.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="game-controller" size={18} color={colors.tapIn} />
              <Text style={styles.sectionTitle}>{t('home.games' as any)}</Text>
            </View>
            {onGamesPress && (
              <TouchableOpacity onPress={onGamesPress}>
                <Text style={styles.seeAllText}>{t('home.seeAll')}</Text>
              </TouchableOpacity>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.gamesScroll}
          >
            {gamePixGames.map((game: GamePixGame) => {
              const thumbnail = game.banner_image || game.image;
              return (
                <TouchableOpacity
                  key={game.id}
                  style={styles.gameCard}
                  onPress={() => onPlayGame?.(game.url, 'gamepix', game.title)}
                  activeOpacity={0.85}
                >
                  {thumbnail ? (
                    <Image
                      source={{ uri: thumbnail }}
                      style={styles.gameCardImage}
                      contentFit="cover"
                      transition={0}
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={[styles.gameCardImage, styles.gameCardPlaceholder]}>
                      <Ionicons name="game-controller-outline" size={24} color={colors.textTertiary} />
                    </View>
                  )}
                  <View style={styles.gameCardOverlay}>
                    <Ionicons name="game-controller" size={20} color="#FFF" />
                  </View>
                  <View style={styles.gameCardInfo}>
                    <Text style={styles.gameCardName} numberOfLines={1}>{game.title}</Text>
                    <Text style={styles.gameCardDesc} numberOfLines={1}>{game.description}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Videos section title */}
      {videos.length > 0 && (
        <View style={styles.videosSectionHeader}>
          <Text style={styles.sectionTitle}>{feedModeLabel}</Text>
        </View>
      )}

      {momenti.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Ionicons name="play-circle" size={18} color={colors.tapIn} />
              <Text style={styles.sectionTitle}>{t('tab.momenti' as any)}</Text>
            </View>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.momentiScroll}
          >
            {momenti.slice(0, 8).map((item: Video) => {
              const durationText = formatDuration(item.duration);
              return (
                <TouchableOpacity
                  key={item.id}
                  style={styles.momentiCard}
                  onPress={() => onMomentiPress(item)}
                  activeOpacity={0.8}
                >
                  {item.thumbnail_url ? (
                    <Image
                      source={{ uri: item.thumbnail_url }}
                      style={styles.momentiThumb}
                      contentFit="cover"
                      transition={0}
                      cachePolicy="memory-disk"
                    />
                  ) : (
                    <View style={[styles.momentiThumb, styles.gameCardPlaceholder]}>
                      <Ionicons name="videocam-outline" size={24} color={colors.textTertiary} />
                    </View>
                  )}
                  {durationText ? (
                    <View style={styles.momentiDurationBadge}>
                      <Text style={styles.momentiDurationText}>{durationText}</Text>
                    </View>
                  ) : null}
                  <Text style={styles.momentiTitle} numberOfLines={2}>{item.title}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  ), [
    onLeaderboardsPress, leaderboardCreators, onChannelPress, feedMode, ads, spotlightCreators,
    bangiFeedItems, gamePixGames, onGamesPress, onPlayGame, videos, feedModeLabel, momenti, onMomentiPress, onPostPress
  ]);

  const mainContent = useMemo(() => {
    if (loading && videos.length === 0) {
      return (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>LukuLuku...</Text>
        </View>
      );
    }

    return (
      <FlatList
        ref={listRef}
        data={homeVideoItems}
        keyExtractor={(item: HomeVideoFeedItem, index: number) => (item.type === 'ad' ? `home-ad-${item.ad.id}-${index}` : item.video.id)}
        ListHeaderComponent={memoizedHeader}
        renderItem={({ item }: { item: HomeVideoFeedItem }) =>
          item.type === 'ad' ? (
            <View style={styles.videoAdWrap}>
              <SponsoredAdCard ad={item.ad} variant="thumbnail" />
            </View>
          ) : (
            <VideoCard
              video={item.video}
              onPress={onVideoPress}
              onChannelPress={onChannelPress}
            />
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        initialNumToRender={1}
        maxToRenderPerBatch={1}
        windowSize={2}
        removeClippedSubviews={false}
        updateCellsBatchingPeriod={120}
      />
    );
  }, [loading, videos.length, homeVideoItems, memoizedHeader, onVideoPress, onChannelPress, refreshing, onRefresh]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.logoRow}>
          <View style={styles.logoIconWrap}>
            <Image source={require('../assets/luku_luku_512.png')} style={styles.logoImage} contentFit="cover" />
          </View>
          <Text style={styles.logoText}>LukuLuku</Text>
        </View>
        <View style={styles.headerActions}>
          {onLeaderboardsPress && (
            <TouchableOpacity style={styles.top100Btn} onPress={onLeaderboardsPress}>
              <Ionicons name="trophy-outline" size={16} color={colors.tapIn} />
              <Text style={styles.top100BtnText}>{t('leaderboards.title' as any)}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.notificationBtn} onPress={onNotificationsPress}>
            <Ionicons name="notifications-outline" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      {mainContent}
    </View>
  );
}

const BANGI_CARD_WIDTH = width * 0.7;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  logoIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  logoImage: {
    width: '100%',
    height: '100%',
  },
  logoText: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  top100Btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  top100BtnText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  notificationBtn: {
    padding: spacing.sm,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  loadingText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  list: {
    paddingBottom: 100,
  },
  section: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionCtaWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  sectionCtaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sectionCtaText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  spotlightScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  spotlightCard: {
    alignItems: 'center',
    width: 80,
  },
  spotlightAvatarWrap: {
    padding: 2,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: colors.primary,
    position: 'relative',
  },
  spotlightAvatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  spotlightVerified: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: colors.background,
    borderRadius: 10,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  spotlightName: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '600',
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  spotlightSubs: {
    color: colors.textTertiary,
    fontSize: 10,
    marginTop: 1,
  },
  leaderboardContainer: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  leaderboardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    gap: spacing.md,
  },
  rankBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rankGold: {
    backgroundColor: '#FFD700',
  },
  rankSilver: {
    backgroundColor: '#C0C0C0',
  },
  rankBronze: {
    backgroundColor: '#CD7F32',
  },
  rankText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.text,
  },
  rankTextTop: {
    color: '#FFFFFF',
  },
  leaderboardAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  leaderboardInfo: {
    flex: 1,
  },
  leaderboardName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  leaderboardHandle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 1,
  },
  leaderboardCount: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  bangiScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  bangiCard: {
    width: BANGI_CARD_WIDTH,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
  },
  textOnlyBangiCard: {
    width: BANGI_CARD_WIDTH,
    aspectRatio: 4 / 5,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  textOnlyBangiText: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    lineHeight: 26,
  },
  bangiAdWrap: {
    width: BANGI_CARD_WIDTH,
  },
  bangiImage: {
    width: BANGI_CARD_WIDTH,
    aspectRatio: 4 / 5,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    backgroundColor: colors.surfaceLight,
  },
  bangiImagePlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bangiCardContent: {
    padding: spacing.md,
  },
  bangiAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  bangiAuthorAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  bangiAuthorName: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '600',
    flexShrink: 1,
  },
  bangiText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  bangiMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.xs,
  },
  bangiMetaText: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  gamesScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  gameCard: {
    width: 140,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  gameCardImage: {
    width: 140,
    height: 80,
  },
  gameCardPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gameCardOverlay: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  gameCardInfo: {
    padding: spacing.sm,
  },
  gameCardName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  gameCardDesc: {
    color: colors.textTertiary,
    fontSize: 10,
    marginTop: 1,
  },
  seeAllText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  videoAdWrap: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  videosSectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  momentiScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  momentiCard: {
    width: 132,
    position: 'relative',
  },
  momentiThumb: {
    width: 132,
    height: 176,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surfaceLight,
  },
  momentiDurationBadge: {
    position: 'absolute',
    right: 8,
    bottom: 38,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  momentiDurationText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  momentiTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginTop: 6,
    lineHeight: 18,
  },
  feedModeSection: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  feedModeScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  continueScroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  continueCard: {
    width: 220,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  continueThumb: {
    width: '100%',
    height: 124,
  },
  continueInfo: {
    padding: spacing.sm,
  },
  continueTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
    lineHeight: 18,
    minHeight: 36,
  },
  continueProgressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden',
    marginTop: spacing.xs,
  },
  continueProgressFill: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.tapIn,
  },
  continueMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 4,
  },
  feedModePill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  feedModePillActive: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  feedModePillText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  feedModePillTextActive: {
    color: '#FFFFFF',
  },
  inlineAdBanner: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
});

export default React.memo(HomeScreen);
