import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from './AppImage';
import { colors } from '../lib/theme';
import type { RankBadge } from '../hooks/useRankBadges';

interface RankAuraAvatarProps {
  uri?: string | null;
  size: number;
  badge?: RankBadge | null;
  fallbackLabel?: string;
}

const CATEGORY_STYLES = {
  tapiners: {
    ringColor: colors.tapIn,
    accentColor: colors.tapIn,
  },
  views: {
    ringColor: colors.primaryLight,
    accentColor: colors.verified,
  },
  posts: {
    ringColor: colors.primary,
    accentColor: colors.primary,
  },
} as const;

function getRankStyle(rank: RankBadge['rank']) {
  if (rank === 1) {
    return { backgroundColor: colors.gold, textColor: colors.text };
  }
  if (rank === 2) {
    return { backgroundColor: colors.silver, textColor: colors.text };
  }
  return { backgroundColor: colors.bronze, textColor: colors.textInverse };
}

export default function RankAuraAvatar({ uri, size, badge, fallbackLabel }: RankAuraAvatarProps) {
  const categoryStyle = badge ? CATEGORY_STYLES[badge.category] : null;
  const rankStyle = badge ? getRankStyle(badge.rank) : null;
  const haloSize = size + 12;
  const avatarRadius = size / 2;

  return (
    <View style={[styles.wrap, { width: haloSize + 20, height: haloSize + 20 }]}>
      {badge?.category === 'tapiners' && (
        <>
          <View
            style={[
              styles.wing,
              styles.wingLeft,
              {
                width: size * 0.38,
                height: size * 0.72,
                borderColor: colors.textInverse,
                transform: [{ rotate: '-20deg' }],
              },
            ]}
          />
          <View
            style={[
              styles.wing,
              styles.wingRight,
              {
                width: size * 0.38,
                height: size * 0.72,
                borderColor: colors.textInverse,
                transform: [{ rotate: '20deg' }],
              },
            ]}
          />
          <View
            style={[
              styles.halo,
              {
                width: haloSize * 0.62,
                height: haloSize * 0.22,
                borderColor: colors.verified,
                top: 0,
              },
            ]}
          />
        </>
      )}

      {badge?.category === 'views' && (
        <>
          {Array.from({ length: 5 }).map((_, index) => (
            <View
              key={index}
              style={[
                styles.eyeBubble,
                {
                  left: [6, haloSize - 18, haloSize - 2, 8, haloSize / 2 - 7][index],
                  top: [6, 10, haloSize / 2 - 10, haloSize - 16, haloSize / 2 - 16][index],
                  backgroundColor: colors.background,
                  borderColor: categoryStyle?.accentColor || colors.primary,
                },
              ]}
            >
              <Ionicons name="eye" size={9} color={categoryStyle?.accentColor || colors.primary} />
            </View>
          ))}
        </>
      )}

      {badge?.category === 'posts' && (
        <>
          {Array.from({ length: 3 }).map((_, index) => (
            <View
              key={index}
              style={[
                styles.chatBubble,
                {
                  left: [2, haloSize - 18, haloSize / 2 - 5][index],
                  top: [4, 10, haloSize - 16][index],
                  backgroundColor: colors.background,
                  borderColor: categoryStyle?.accentColor || colors.primary,
                },
              ]}
            >
              <Ionicons name="chatbubble" size={8} color={categoryStyle?.accentColor || colors.primary} />
            </View>
          ))}
        </>
      )}

      <View
        style={[
          styles.avatarFrame,
          {
            width: size,
            height: size,
            borderRadius: avatarRadius,
            borderColor: categoryStyle?.ringColor || colors.borderLight,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={{ width: size, height: size, borderRadius: avatarRadius }} contentFit="cover" />
        ) : (
          <View
            style={[
              styles.fallback,
              {
                width: size,
                height: size,
                borderRadius: avatarRadius,
              },
            ]}
          >
            <Text style={styles.fallbackText}>{(fallbackLabel || 'U').slice(0, 1).toUpperCase()}</Text>
          </View>
        )}
      </View>

      {rankStyle ? (
        <View style={[styles.rankBadge, { backgroundColor: rankStyle.backgroundColor }]}>
          <Ionicons name="star" size={9} color={rankStyle.textColor} />
          <Text style={[styles.rankText, { color: rankStyle.textColor }]}>{badge?.rank}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFrame: {
    overflow: 'hidden',
    borderWidth: 2,
    backgroundColor: colors.surfaceLight,
  },
  halo: {
    position: 'absolute',
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
    borderWidth: 2,
    borderBottomWidth: 0,
    opacity: 0.95,
  },
  wing: {
    position: 'absolute',
    top: '42%',
    borderWidth: 2,
    borderRadius: 999,
    backgroundColor: 'transparent',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: 'transparent',
    borderTopColor: 'transparent',
    opacity: 0.95,
  },
  wingLeft: {
    left: -4,
  },
  wingRight: {
    right: -4,
  },
  eyeBubble: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatBubble: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceLight,
  },
  fallbackText: {
    color: colors.textSecondary,
    fontSize: 16,
    fontWeight: '700',
  },
  rankBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: 1,
    borderColor: colors.background,
  },
  rankText: {
    fontSize: 9,
    fontWeight: '800',
    lineHeight: 10,
  },
});