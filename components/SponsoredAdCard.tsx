import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import * as Linking from 'expo-linking';
import { Image } from './AppImage';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import type { SponsoredAd } from '../hooks/useActiveAds';

interface Props {
  ad: SponsoredAd;
  variant?: 'feed' | 'thumbnail';
}

export default function SponsoredAdCard({ ad, variant = 'feed' }: Props) {
  const target = ad.cta_url || ad.website || null;
  const open = () => {
    if (target) Linking.openURL(target).catch(() => {});
  };

  if (variant === 'thumbnail') {
    return (
      <Pressable onPress={open} style={styles.thumbCard}>
        {ad.creative_url ? (
          <Image source={{ uri: ad.creative_url }} style={styles.thumbImg} contentFit="cover" cachePolicy="memory-disk" transition={0} />
        ) : (
          <View style={[styles.thumbImg, styles.placeholder]} />
        )}
        <View style={styles.badge}>
          <Text style={styles.badgeText}>SPONSORED</Text>
        </View>
        <View style={styles.thumbBody}>
          <Text numberOfLines={2} style={styles.title}>{ad.campaign_title}</Text>
          <Text numberOfLines={1} style={styles.subtitle}>{ad.company_name}</Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={styles.feedCard}>
      <View style={styles.feedHeader}>
        <View style={styles.feedTag}>
          <Text style={styles.feedTagText}>SPONSORED</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.company}>{ad.company_name}</Text>
          <Text style={styles.title}>{ad.campaign_title}</Text>
        </View>
      </View>

      {!!ad.campaign_description && (
        <Text style={styles.body}>{ad.campaign_description}</Text>
      )}

      {ad.creative_url ? (
        <Pressable onPress={open}>
          <Image source={{ uri: ad.creative_url }} style={styles.feedImg} cachePolicy="memory-disk" transition={0} />
        </Pressable>
      ) : null}

      {target ? (
        <Pressable onPress={open} style={styles.cta}>
          <Text style={styles.ctaText}>Bekijk meer</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  feedCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.md,
  },
  feedHeader: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
  },
  feedTag: {
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    alignSelf: 'flex-start',
  },
  feedTagText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  company: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    marginBottom: 2,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  body: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  feedImg: {
    width: '100%',
    height: 220,
    marginTop: spacing.md,
    borderRadius: borderRadius.md,
  },
  cta: {
    backgroundColor: colors.tapIn,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  ctaText: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  thumbCard: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    marginBottom: spacing.md,
  },
  thumbImg: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  placeholder: {
    backgroundColor: colors.surfaceLight,
  },
  badge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  thumbBody: {
    padding: spacing.sm,
  },
  subtitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
});