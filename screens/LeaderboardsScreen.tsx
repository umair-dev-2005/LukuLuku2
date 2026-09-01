import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews } from '../lib/utils';
import { Crown, Eye, MessageSquare, Medal, Trophy, Users, ChevronLeft } from 'lucide-react-native';
import { t } from '../lib/i18n';
import RankAuraAvatar from '../components/RankAuraAvatar';
import { useRankBadges, getAvatarBadge } from '../hooks/useRankBadges';
import { fetchLeaderboard } from '../lib/supabase';

interface LeaderboardRow {
  channel_id: string;
  name: string;
  avatar_url: string | null;
  score: number | string | bigint;
}

type LeaderboardTabKey = 'tapiners' | 'views' | 'posts';

interface LeaderboardsScreenProps {
  onBack: () => void;
  onChannelPress: (channelId: string) => void;
}

const TABS: Array<{ key: LeaderboardTabKey; labelKey: 'leaderboards.tapiners' | 'leaderboards.views' | 'leaderboards.posts'; icon: any }> = [
  { key: 'tapiners', labelKey: 'leaderboards.tapiners', icon: Users },
  { key: 'views', labelKey: 'leaderboards.views', icon: Eye },
  { key: 'posts', labelKey: 'leaderboards.posts', icon: MessageSquare },
];

export default function LeaderboardsScreen({ onBack, onChannelPress }: LeaderboardsScreenProps) {
  const insets = useSafeAreaInsets();
  const [selectedTab, setSelectedTab] = useState<LeaderboardTabKey>('tapiners');
  const [tapiners, setTapiners] = useState<LeaderboardRow[]>([]);
  const [views, setViews] = useState<LeaderboardRow[]>([]);
  const [posts, setPosts] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const { badgeByUserId, badgeByChannelId } = useRankBadges();

  const loadLeaderboard = useCallback(async () => {
    setLoading(true);

    try {
      const [tapinRows, viewRows, postRows] = await Promise.all([
        fetchLeaderboard('tapiners', 100),
        fetchLeaderboard('views', 100),
        fetchLeaderboard('posts', 100),
      ]);

      setTapiners(tapinRows as LeaderboardRow[]);
      setViews(viewRows as LeaderboardRow[]);
      setPosts(postRows as LeaderboardRow[]);
    } catch (error) {
      console.warn('Leaderboard failed to load:', error);
      setTapiners([]);
      setViews([]);
      setPosts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLeaderboard();
    const interval = setInterval(() => void loadLeaderboard(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadLeaderboard]);

  const activeRows = useMemo(() => {
    const source = selectedTab === 'views' ? views : selectedTab === 'posts' ? posts : tapiners;
    const sorted = [...source].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    const deduped = new Map<string, LeaderboardRow>();
    sorted.forEach((row) => {
      if (!deduped.has(row.channel_id)) {
        deduped.set(row.channel_id, row);
      }
    });
    return [...deduped.values()];
  }, [posts, selectedTab, tapiners, views]);

  const tabTotals = useMemo(() => {
    const sum = (rows: LeaderboardRow[]) => rows.reduce((acc, row) => acc + Number(row.score || 0), 0);
    return {
      tapiners: sum(tapiners),
      views: sum(views),
      posts: sum(posts),
    } as Record<LeaderboardTabKey, number>;
  }, [posts, tapiners, views]);

  const renderRankIcon = (index: number) => {
    if (index === 0) return <Crown size={16} color={colors.gold} />;
    if (index === 1) return <Medal size={16} color={colors.silver} />;
    if (index === 2) return <Medal size={16} color={colors.bronze} />;
    return <Text style={styles.rankText}>#{index + 1}</Text>;
  };

  const formatScore = (score: number | string | bigint) => formatViews(Number(score || 0));
  const rowLabel = t('leaderboards.allTime' as any);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerTitleWrap}>
          <Trophy size={18} color={colors.tapIn} />
          <Text style={styles.headerTitle}>{t('leaderboards.title' as any)}</Text>
        </View>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.tabRow}>
        {TABS.map((tab) => {
          const active = selectedTab === tab.key;
          const Icon = tab.icon;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tabPill, active && styles.tabPillActive]}
              onPress={() => setSelectedTab(tab.key)}
              activeOpacity={0.85}
            >
              <Icon size={16} color={active ? colors.textInverse : colors.textSecondary} />
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{t(tab.labelKey as any)}</Text>
              {!loading && (
                <View style={[styles.tabCountBadge, active && styles.tabCountBadgeActive]}>
                  <Text style={[styles.tabCountText, active && styles.tabCountTextActive]}>
                    {formatViews(tabTotals[tab.key])}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={colors.tapIn} />
          <Text style={styles.stateText}>{t('leaderboards.loading' as any)}</Text>
        </View>
      ) : activeRows.length === 0 ? (
        <View style={styles.centerState}>
          <Text style={styles.stateText}>{t('leaderboards.empty' as any)}</Text>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}>
          {activeRows.slice(0, 100).map((row: LeaderboardRow, index: number) => {
            const badge = getAvatarBadge(badgeByUserId, badgeByChannelId, null, row.channel_id);
            return (
              <TouchableOpacity
                key={`${selectedTab}-${row.channel_id}`}
                style={styles.row}
                onPress={() => onChannelPress(row.channel_id)}
                activeOpacity={0.85}
              >
                <View style={styles.rankBadge}>{renderRankIcon(index)}</View>

                <RankAuraAvatar
                  uri={row.avatar_url}
                  size={42}
                  badge={badge}
                  fallbackLabel={row.name}
                />

                <View style={styles.rowInfo}>
                  <Text style={styles.channelName} numberOfLines={1}>{row.name}</Text>
                  <Text style={styles.rankMeta}>#{index + 1} {rowLabel}</Text>
                </View>

                <Text style={styles.scoreText}>{formatScore(row.score)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  tabRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  tabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
  },
  tabPillActive: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  tabLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  tabLabelActive: {
    color: colors.textInverse,
  },
  tabCountBadge: {
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 22,
    alignItems: 'center',
  },
  tabCountBadgeActive: {
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  tabCountText: {
    color: colors.textSecondary,
    fontSize: 10,
    fontWeight: '800',
  },
  tabCountTextActive: {
    color: colors.textInverse,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  stateText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 80,
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
  },
  rankBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
  },
  rankText: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: {
    flex: 1,
    gap: 2,
  },
  channelName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  rankMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  scoreText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '800',
  },
});