import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews, formatTimeAgo, formatDuration } from '../lib/utils';
import { supabase, Video, Channel } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';

interface SearchScreenProps {
  onVideoPress: (video: Video) => void;
  onChannelPress: (channelId: string) => void;
  isActive?: boolean;
}

type SearchResult = { type: 'video'; data: Video } | { type: 'channel'; data: Channel & { isVerified?: boolean; verificationType?: string | null; liveTapinCount?: number } };

function SearchScreen({ onVideoPress, onChannelPress, isActive }: SearchScreenProps) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSearched(true);

    try {
      const [videosRes, channelsRes] = await Promise.all([
        supabase
          .from('videos')
          .select('*')
          .eq('status', 'published')
          .eq('is_short', false)
          .ilike('title', `%${query}%`)
          .limit(20),
        supabase
          .from('channels')
          .select('*')
          .ilike('name', `%${query}%`)
          .limit(10),
      ]);

      let channelsWithVerified: (Channel & { isVerified?: boolean; verificationType?: string | null; liveTapinCount?: number })[] = [];
      if (channelsRes.data && channelsRes.data.length > 0) {
        const userIds = channelsRes.data.map((c: Channel) => c.user_id);
        const [profilesRes] = await Promise.all([
          supabase
            .from('profiles')
            .select('user_id, is_verified, verification_type')
            .in('user_id', userIds),
        ]);

        const verifiedMap = new Map<string, { isVerified: boolean; verificationType: string | null }>();
        profilesRes.data?.forEach((p: any) => {
          if (p.is_verified) verifiedMap.set(p.user_id, { isVerified: true, verificationType: p.verification_type });
        });

        channelsWithVerified = channelsRes.data.map((c: Channel) => ({
          ...c,
          isVerified: verifiedMap.get(c.user_id)?.isVerified || false,
          verificationType: verifiedMap.get(c.user_id)?.verificationType || null,
          // Channel's trigger-maintained tapiners column (consistent everywhere; counting
          // the tapins table returns 0 under RLS).
          liveTapinCount: c.tapiners ?? 0,
        }));
      }

      const combined: SearchResult[] = [
        ...channelsWithVerified.map((c) => ({ type: 'channel' as const, data: c })),
        ...(videosRes.data?.map((v: Video) => ({ type: 'video' as const, data: v })) || []),
      ];

      setResults(combined);
    } catch (error) {
      console.warn('Search failed:', error);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  const renderItem = ({ item }: { item: SearchResult }) => {
    if (item.type === 'channel') {
      const channel = item.data;
      return (
        <TouchableOpacity
          style={styles.channelResult}
          onPress={() => onChannelPress(channel.id)}
        >
          {channel.avatar_url ? (
            <Image source={{ uri: channel.avatar_url }} style={styles.channelAvatar} contentFit="cover" />
          ) : (
            <View style={[styles.channelAvatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={24} color={colors.textTertiary} />
            </View>
          )}
          <View style={styles.channelInfo}>
            <View style={styles.channelNameRow}>
              <Text style={styles.channelName}>{channel.name}</Text>
              <VerifiedBadge
                isVerified={channel.isVerified || false}
                verificationType={channel.verificationType}
                size={16}
              />
            </View>
            <Text style={styles.channelHandle}>@{channel.handle} · {channel.liveTapinCount ?? channel.tapiners} tapiners</Text>
          </View>
        </TouchableOpacity>
      );
    }

    const video = item.data;
    const durationText = formatDuration(video.duration);
    return (
      <TouchableOpacity
        style={styles.videoResult}
        onPress={() => onVideoPress(video)}
      >
        <View style={styles.videoThumbWrap}>
          {video.thumbnail_url ? (
            <Image source={{ uri: video.thumbnail_url }} style={styles.videoThumb} contentFit="cover" />
          ) : (
            <View style={[styles.videoThumb, styles.thumbPlaceholder]}>
              <Ionicons name="play-circle" size={24} color={colors.textTertiary} />
            </View>
          )}
          {durationText ? (
            <View style={styles.durationBadge}>
              <Text style={styles.durationBadgeText}>{durationText}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.videoInfo}>
          <Text style={styles.videoTitle} numberOfLines={2}>{video.title}</Text>
          <Text style={styles.videoMeta}>
            {formatViews(video.views)} weergaven | {formatTimeAgo(video.created_at)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={20} color={colors.textTertiary} />
        <TextInput
          style={styles.input}
          placeholder={t('search.placeholder')}
          placeholderTextColor={colors.textTertiary}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={search}
          returnKeyType="search"
          autoCapitalize="none"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => { setQuery(''); setResults([]); setSearched(false); }}>
            <Ionicons name="close-circle" size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : results.length === 0 && searched ? (
        <View style={styles.centered}>
          <Ionicons name="search-outline" size={48} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{t('search.noResults')}</Text>
        </View>
      ) : results.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="search-outline" size={48} color={colors.textTertiary} />
          <Text style={styles.emptyText}>{t('search.prompt')}</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item: SearchResult, index: number) => `${item.type}-${item.data.id}-${index}`}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceLight,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    height: 44,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 100,
  },
  channelResult: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  channelAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  channelInfo: {
    flex: 1,
  },
  channelNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  channelName: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  channelHandle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  videoResult: {
    flexDirection: 'row',
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  videoThumbWrap: {
    position: 'relative',
  },
  videoThumb: {
    width: 160,
    height: 90,
    borderRadius: borderRadius.md,
  },
  thumbPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  durationBadgeText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  videoInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  videoTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '500',
    lineHeight: 20,
  },
  videoMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 4,
  },
});

export default React.memo(SearchScreen);
