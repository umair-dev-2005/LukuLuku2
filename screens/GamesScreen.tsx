import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { useActiveAds, SponsoredAd } from '../hooks/useActiveAds';
import SponsoredAdCard from '../components/SponsoredAdCard';
import { extractRankingTerms, rankGameFeed } from '../lib/utils';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - spacing.lg * 3) / 2;

interface GamePixGame {
  id: string;
  title: string;
  description: string;
  url: string;
  banner_image?: string;
  image?: string;
  namespace?: string;
}

type GameFeedItem =
  | { type: 'game'; game: GamePixGame }
  | { type: 'ad'; ad: SponsoredAd };

interface GamesScreenProps {
  onBack: () => void;
  onPlayGame: (gameUrl: string, gameType: string, gameName: string) => void;
}

export default function GamesScreen({ onBack, onPlayGame }: GamesScreenProps) {
  const insets = useSafeAreaInsets();
  const { ads } = useActiveAds('sponsored');
  const [games, setGames] = useState<GamePixGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchGames = useCallback(async (pageToLoad: number, append: boolean) => {
    try {
      const response = await globalThis.fetch(
        `https://feeds.gamepix.com/v2/json/?order=quality&page=${pageToLoad}&pagination=12&sid=1`
      );
      const data = await response.json();
      const items = (data.items || []) as GamePixGame[];
      const preferredTerms = extractRankingTerms(items as any[]);

      const rankedItems = rankGameFeed(
        items,
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

      setGames((prev: GamePixGame[]) => (append ? [...prev, ...rankedItems] : rankedItems));
      setHasMore(Boolean(data.next_url) && items.length > 0);
    } catch {
      if (!append) setGames([]);
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchGames(1, false);
  }, [fetchGames]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    setLoadingMore(true);
    fetchGames(nextPage, true);
  }, [fetchGames, hasMore, loadingMore, page]);

  const feedItems = React.useMemo<GameFeedItem[]>(() => {
    const items: GameFeedItem[] = [];
    games.forEach((game, index) => {
      items.push({ type: 'game', game });
      if (ads.length > 0 && (index + 1) % 4 === 0) {
        const ad = ads[(index / 4) % ads.length];
        if (ad) items.push({ type: 'ad', ad });
      }
    });
    return items;
  }, [ads, games]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('games.title' as any)}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.grid}
          showsVerticalScrollIndicator={false}
        >
          {feedItems.map((item) => {
            if (item.type === 'game') {
              const game = item.game;
              const thumbnail = game.banner_image || game.image;
              return (
                <TouchableOpacity
                  key={game.id}
                  style={styles.gameCard}
                  onPress={() => onPlayGame(game.url, 'gamepix', game.title)}
                  activeOpacity={0.85}
                >
                  {thumbnail ? (
                    <Image
                      source={{ uri: thumbnail }}
                      style={styles.gameThumbnail}
                      contentFit="cover"
                      transition={200}
                    />
                  ) : (
                    <View style={[styles.gameThumbnail, styles.placeholderThumb]}>
                      <Ionicons name="game-controller-outline" size={28} color={colors.textTertiary} />
                    </View>
                  )}
                  <View style={styles.gameInfo}>
                    <Text style={styles.gameName} numberOfLines={1}>{game.title}</Text>
                    <Text style={styles.gameDesc} numberOfLines={2}>{game.description}</Text>
                    <View style={styles.gameStats}>
                      <Ionicons name="play-outline" size={12} color={colors.textTertiary} />
                      <Text style={styles.gameStatText}>{game.namespace || 'GamePix'}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            } else if (item.type === 'ad') {
              return <SponsoredAdCard key={item.ad.id} ad={item.ad} />;
            }
            return null;
          })}

          {hasMore && (
            <TouchableOpacity
              style={styles.loadMoreBtn}
              onPress={handleLoadMore}
              activeOpacity={0.85}
            >
              {loadingMore ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Text style={styles.loadMoreText}>{t('games.loadMore' as any)}</Text>
              )}
            </TouchableOpacity>
          )}

          <View style={{ height: 100 }} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: { padding: spacing.sm },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: spacing.lg,
    gap: spacing.lg,
  },
  gameCard: {
    width: CARD_WIDTH,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  gameThumbnail: {
    width: CARD_WIDTH,
    height: CARD_WIDTH * 0.6,
  },
  placeholderThumb: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  gameInfo: {
    padding: spacing.md,
  },
  gameName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  gameDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
    lineHeight: 16,
  },
  gameStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.sm,
  },
  gameStatText: {
    color: colors.textTertiary,
    fontSize: 10,
  },
  loadMoreBtn: {
    width: '100%',
    borderRadius: borderRadius.lg,
    backgroundColor: colors.tapIn,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  loadMoreText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});