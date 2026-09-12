import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../../lib/theme';
import { t } from '../../../lib/i18n';
import { formatViews, formatLiveDuration } from '../../../lib/utils';
import RankAuraAvatar from '../../RankAuraAvatar';

interface AeroHeaderProps {
  hostName: string;
  hostAvatarUrl: string | null;
  // Real elapsed time since live_streams.started_at, ticking every second — how long the
  // stream has actually been running, not how long this viewer has been watching.
  elapsedSeconds: number;
  tapins: number;
  liveViewers: number;
  earnedCoins: number;
  hasTapped: boolean;
  tapInBusy: boolean;
  onTapIn: () => void;
  // Short tap opens the Report / End-the-Stream dropdown (LiveViewerScreen owns it);
  // long-press is a dev-only shortcut to preview the end-of-stream screen.
  onExitPress: () => void;
  onExitLongPress?: () => void;
  topInset: number;
}

const AVATAR_SIZE = 40;

// Pulsating cyan/theme-colored ring behind the avatar — a plain Animated opacity loop, no
// new native dependency needed.
function PulsingRing() {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const opacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });

  return (
    <Animated.View
      style={[styles.pulsingRing, { opacity, transform: [{ scale }] }]}
      pointerEvents="none"
    />
  );
}

// The "Aero" top header — a single frosted pill floating over the video. Real data:
// hostName/hostAvatarUrl/tapins (channels/profiles), liveViewers (live_stream_runtime).
// earnedCoins is 0 until gift_live_stream_points() is wired in this feature's integration
// plan. Mic status has no real source yet either (it's a ZegoCloud room extra-info value
// that doesn't exist until that integration) — shown as a static "on" placeholder.
export default function AeroHeader({
  hostName,
  hostAvatarUrl,
  elapsedSeconds,
  tapins,
  liveViewers,
  earnedCoins,
  hasTapped,
  tapInBusy,
  onTapIn,
  onExitPress,
  onExitLongPress,
  topInset,
}: AeroHeaderProps) {
  return (
    <View style={[styles.wrap, { marginTop: topInset + spacing.sm }]}>
      <BlurView intensity={40} tint="dark" style={styles.pill}>
        <View style={styles.topRow}>
          <View style={styles.avatarWrap}>
            <PulsingRing />
            <RankAuraAvatar size={AVATAR_SIZE} uri={hostAvatarUrl} fallbackLabel={hostName} />
          </View>

          <View style={styles.nameCol}>
            <View style={styles.nameLiveRow}>
              <Text style={styles.hostName} numberOfLines={1}>{hostName || '…'}</Text>
              <View style={styles.liveDot} />
              <Text style={styles.liveTimer}>{formatLiveDuration(elapsedSeconds)}</Text>
            </View>
            <View style={styles.statsRow}>
              <Ionicons name="hand-left" size={11} color="rgba(255,255,255,0.75)" />
              <Text style={styles.statText}>{formatViews(tapins)}</Text>
              <Ionicons name="eye" size={11} color="rgba(255,255,255,0.75)" style={styles.statIconSpaced} />
              <Text style={styles.statText}>{formatViews(liveViewers)}</Text>
              <Ionicons name="diamond" size={11} color="#FFD700" style={styles.statIconSpaced} />
              <Text style={[styles.statText, styles.coinText]}>{formatViews(earnedCoins)}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={[styles.tapinBtn, hasTapped && styles.tapinBtnDone]}
            onPress={onTapIn}
            disabled={hasTapped || tapInBusy}
            activeOpacity={0.8}
          >
            <Text style={styles.tapinBtnText}>
              {hasTapped ? t('liveViewer.tappedIn' as any) : t('liveViewer.tapIn' as any)}
            </Text>
          </TouchableOpacity>

          <View style={styles.micIcon}>
            <Ionicons name="mic" size={16} color="rgba(255,255,255,0.85)" />
          </View>

          <TouchableOpacity style={styles.exitBtn} onPress={onExitPress} onLongPress={onExitLongPress} activeOpacity={0.75}>
            <Ionicons name="close" size={18} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: spacing.md,
  },
  pill: {
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  avatarWrap: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulsingRing: {
    position: 'absolute',
    width: AVATAR_SIZE + 8,
    height: AVATAR_SIZE + 8,
    borderRadius: (AVATAR_SIZE + 8) / 2,
    borderWidth: 2,
    borderColor: colors.tapIn,
  },
  nameCol: {
    flex: 1,
  },
  hostName: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
    flexShrink: 1,
  },
  nameLiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  liveDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.error,
  },
  liveTimer: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 1,
  },
  statIconSpaced: {
    marginLeft: 6,
  },
  statText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.xs,
    fontWeight: '600',
    marginLeft: 2,
  },
  coinText: {
    color: '#FFD700',
  },
  tapinBtn: {
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: borderRadius.full,
    shadowColor: colors.tapIn,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 8,
    elevation: 6,
  },
  tapinBtnDone: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    shadowOpacity: 0,
    elevation: 0,
  },
  tapinBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  micIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
