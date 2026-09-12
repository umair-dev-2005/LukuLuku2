import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { useLiveFeed, type LiveFeedItem } from '../hooks/useLiveFeed';
import { useStreamCategories } from '../hooks/useStreamCategories';
import LiveFeedCard from '../components/live/LiveFeedCard';

interface LiveHubScreenProps {
  onBack: () => void;
  onOpenStream: (streamId: string) => void;
}

export default function LiveHubScreen({ onBack, onOpenStream }: LiveHubScreenProps) {
  const insets = useSafeAreaInsets();
  const { items, loading, error, retry } = useLiveFeed();
  const { categories } = useStreamCategories();

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');

  const filteredItems = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return items.filter((item) => {
      if (selectedCategoryId && item.categoryId !== selectedCategoryId) return false;
      if (!query) return true;
      return item.sides.some(
        (side) => side.name.toLowerCase().includes(query) || side.title.toLowerCase().includes(query)
      );
    });
  }, [items, selectedCategoryId, searchText]);

  const handleCardPress = (item: LiveFeedItem, sideIndex: number) => {
    const streamId = item.sides[sideIndex]?.streamId;
    if (!streamId || streamId.startsWith('demo-')) {
      // The 3 placeholder cards shown when nobody's actually live yet have no real
      // live_streams row behind them — nothing to open.
      Alert.alert(t('liveFeed.openingSoon' as any));
      return;
    }
    onOpenStream(streamId);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </TouchableOpacity>

        {searchOpen ? (
          <TextInput
            style={styles.searchInput}
            placeholder={t('liveFeed.searchPlaceholder' as any)}
            placeholderTextColor={colors.textTertiary}
            value={searchText}
            onChangeText={setSearchText}
            autoFocus
          />
        ) : (
          <Text style={styles.headerTitle}>{t('liveFeed.title' as any)}</Text>
        )}

        <TouchableOpacity
          onPress={() => {
            if (searchOpen) setSearchText('');
            setSearchOpen((prev) => !prev);
          }}
          style={styles.iconBtn}
        >
          <Ionicons name={searchOpen ? 'close' : 'search'} size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.categoryRow}>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[{ id: null as string | null, label: t('liveFeed.categoryAll' as any) }, ...categories.map((c) => ({ id: c.id, label: c.label }))]}
          keyExtractor={(c) => c.id ?? 'all'}
          contentContainerStyle={styles.categoryList}
          renderItem={({ item: cat }) => {
            const selected = cat.id === selectedCategoryId;
            return (
              <TouchableOpacity
                style={[styles.categoryChip, selected && styles.categoryChipSelected]}
                onPress={() => setSelectedCategoryId(cat.id)}
                activeOpacity={0.8}
              >
                <Text style={[styles.categoryChipText, selected && styles.categoryChipTextSelected]}>{cat.label}</Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      {loading ? (
        <View style={styles.centerState}>
          <ActivityIndicator size="large" color={colors.tapIn} />
        </View>
      ) : error ? (
        <View style={styles.centerState}>
          <Text style={styles.emptyText}>{t('liveFeed.loadError' as any)}</Text>
          <TouchableOpacity onPress={retry} style={styles.retryBtn}>
            <Text style={styles.retryText}>{t('liveFeed.retry' as any)}</Text>
          </TouchableOpacity>
        </View>
      ) : filteredItems.length === 0 ? (
        <View style={styles.centerState}>
          <Ionicons name="radio-outline" size={40} color={colors.textTertiary} />
          <Text style={styles.emptyText}>
            {items.length === 0 ? t('liveFeed.empty' as any) : t('liveFeed.noResults' as any)}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <LiveFeedCard item={item} onPress={handleCardPress} />}
          contentContainerStyle={styles.feedList}
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '800',
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.sm,
  },
  categoryRow: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  categoryList: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  categoryChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    marginRight: spacing.sm,
  },
  categoryChipSelected: {
    backgroundColor: colors.tapIn,
  },
  categoryChipText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  categoryChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  feedList: {
    padding: spacing.md,
  },
  centerState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});
