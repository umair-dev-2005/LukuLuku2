import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { Image } from '../../AppImage';
import { colors, spacing, fontSize, borderRadius } from '../../../lib/theme';
import { t } from '../../../lib/i18n';
import { formatViews, formatLiveDuration } from '../../../lib/utils';

interface LiveEndedOverlayProps {
  hostAvatarUrl: string | null;
  hostName: string;
  durationSeconds: number;
  likes: number;
  chats: number;
  shares: number;
  onExploreMore: () => void;
  onGoHome: () => void;
}

// The "Final Frame": since there's no captured last video frame yet (no ZegoCloud snapshot
// wired up in this UI phase), the host's own profile picture — the same stand-in used as
// this screen's whole-stream background — is blurred heavily (BlurView intensity 100 ≈ a
// strong Gaussian blur) to approximate it.
export default function LiveEndedOverlay({
  hostAvatarUrl,
  hostName,
  durationSeconds,
  likes,
  chats,
  shares,
  onExploreMore,
  onGoHome,
}: LiveEndedOverlayProps) {
  return (
    <View style={StyleSheet.absoluteFill}>
      {hostAvatarUrl ? (
        <Image source={{ uri: hostAvatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallbackBg]} />
      )}
      <BlurView intensity={100} tint="dark" style={StyleSheet.absoluteFill} />

      <View style={styles.centerWrap}>
        <View style={styles.card}>
          <View style={styles.endedIconWrap}>
            <Ionicons name="radio-outline" size={28} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>{t('liveViewer.streamEnded' as any)}</Text>
          <Text style={styles.hostName} numberOfLines={1}>{hostName}</Text>
          <Text style={styles.duration}>{formatLiveDuration(durationSeconds)}</Text>

          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Ionicons name="heart" size={16} color={colors.error} />
              <Text style={styles.statText}>{formatViews(likes)}</Text>
            </View>
            <View style={styles.statItem}>
              <Ionicons name="chatbubble-ellipses" size={16} color="#FFFFFF" />
              <Text style={styles.statText}>{formatViews(chats)}</Text>
            </View>
            <View style={styles.statItem}>
              <Ionicons name="share-social" size={16} color="#FFFFFF" />
              <Text style={styles.statText}>{formatViews(shares)}</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={onExploreMore} activeOpacity={0.85}>
            <Text style={styles.primaryBtnText}>{t('liveViewer.exploreMore' as any)}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.outlineBtn} onPress={onGoHome} activeOpacity={0.85}>
            <Text style={styles.outlineBtnText}>{t('liveViewer.goHome' as any)}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fallbackBg: {
    backgroundColor: '#1A1A1A',
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    backgroundColor: 'rgba(20,20,20,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
    gap: spacing.xs,
  },
  endedIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    color: '#FFFFFF',
    fontSize: fontSize.xl,
    fontWeight: '800',
  },
  hostName: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  duration: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginBottom: spacing.lg,
  },
  statItem: {
    alignItems: 'center',
    gap: 2,
  },
  statText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: colors.tapIn,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  outlineBtn: {
    width: '100%',
    borderRadius: borderRadius.full,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  outlineBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
});
