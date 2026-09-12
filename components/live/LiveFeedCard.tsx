import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Image } from '../AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import { formatViews } from '../../lib/utils';
import type { LiveFeedItem, LiveFeedSide } from '../../hooks/useLiveFeed';

interface LiveFeedCardProps {
  item: LiveFeedItem;
  // sideIndex tells the caller WHICH half was tapped for a cohost/battle card (0 or 1) —
  // only that side's room gets joined later, so the other side's viewer count is never
  // double-counted for one tap. Always 0 for a solo card.
  onPress: (item: LiveFeedItem, sideIndex: number) => void;
}

const CARD_HEIGHT = 220;

// Full-bleed background: the streamer's own profile picture (per the app's decision —
// there's no live-frame thumbnail column on live_streams yet, and no ZegoCloud snapshot
// wired up in this UI phase). Falls back to a plain tinted panel + initial when a
// streamer has no avatar_url, matching RankAuraAvatar's own fallback convention.
function SideBackground({ side }: { side: LiveFeedSide }) {
  if (side.avatarUrl) {
    return <Image source={{ uri: side.avatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />;
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.fallbackBg]}>
      <Text style={styles.fallbackLetter}>{(side.name || '?').slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

function SideInfo({ side, flexed }: { side: LiveFeedSide; flexed?: boolean }) {
  return (
    <View style={[styles.sideInfo, flexed && { flex: 1 }]}>
      <View style={styles.avatarWrap}>
        <SideBackground side={side} />
        <View style={styles.miniLiveBadge}>
          <Text style={styles.miniLiveBadgeText}>{t('liveHost.live' as any)}</Text>
        </View>
      </View>
      <View style={styles.sideTextCol}>
        <Text style={styles.sideName} numberOfLines={1}>{side.name}</Text>
        <View style={styles.viewersRow}>
          <Ionicons name="eye" size={11} color="rgba(255,255,255,0.85)" />
          <Text style={styles.viewersText}>{formatViews(side.liveViewers)}</Text>
        </View>
        <Text style={styles.sideTitle} numberOfLines={1}>{side.title}</Text>
      </View>
    </View>
  );
}

function BattleScoreBar({ sides }: { sides: LiveFeedSide[] }) {
  const a = sides[0]?.points ?? 0;
  const b = sides[1]?.points ?? 0;
  const total = a + b;
  const leftPct = total > 0 ? (a / total) * 100 : 50;
  return (
    <View style={styles.scoreBarTrack} pointerEvents="none">
      <View style={[styles.scoreBarSeg, { width: `${leftPct}%`, backgroundColor: colors.tapIn }]} />
      <View style={[styles.scoreBarSeg, { width: `${100 - leftPct}%`, backgroundColor: colors.primary }]} />
    </View>
  );
}

export default function LiveFeedCard({ item, onPress }: LiveFeedCardProps) {
  const isPaired = item.kind !== 'solo';

  return (
    <View style={styles.card}>
      {isPaired ? (
        <View style={styles.splitRow}>
          {[0, 1].map((sideIndex) => (
            <TouchableOpacity
              key={sideIndex}
              style={styles.splitHalf}
              onPress={() => onPress(item, sideIndex)}
              activeOpacity={0.85}
            >
              <SideBackground side={item.sides[sideIndex]} />
              <View style={styles.bottomOverlayHalf}>
                <SideInfo side={item.sides[sideIndex]} flexed />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      ) : (
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={() => onPress(item, 0)} activeOpacity={0.85}>
          <SideBackground side={item.sides[0]} />
          <View style={styles.bottomOverlay}>
            <SideInfo side={item.sides[0]} />
          </View>
        </TouchableOpacity>
      )}

      {item.kind === 'battle' && <BattleScoreBar sides={item.sides} />}

      {isPaired && (
        <View style={styles.topPill} pointerEvents="none">
          <Text style={styles.topPillText}>
            {item.kind === 'battle' ? t('liveFeed.battlePill' as any) : t('liveFeed.cohostPill' as any)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    height: CARD_HEIGHT,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    backgroundColor: colors.surfaceLight,
    marginBottom: spacing.lg,
  },
  splitRow: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
  },
  splitHalf: {
    flex: 1,
    overflow: 'hidden',
  },
  fallbackBg: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallbackLetter: {
    color: colors.textSecondary,
    fontSize: fontSize.xxxl,
    fontWeight: '700',
  },
  topPill: {
    position: 'absolute',
    top: spacing.sm,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  topPillText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  scoreBarTrack: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    height: 5,
    marginTop: -2.5,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  scoreBarSeg: {
    height: '100%',
  },
  bottomOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bottomOverlayHalf: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  sideInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  avatarWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  miniLiveBadge: {
    position: 'absolute',
    bottom: -3,
    alignSelf: 'center',
    backgroundColor: colors.error,
    borderRadius: borderRadius.sm,
    paddingHorizontal: 3,
  },
  miniLiveBadgeText: {
    color: '#FFFFFF',
    fontSize: 7,
    fontWeight: '800',
  },
  sideTextCol: {
    flex: 1,
  },
  sideName: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  viewersRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 1,
  },
  viewersText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  sideTitle: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.xs,
    marginTop: 2,
  },
});
