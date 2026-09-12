import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { spacing, fontSize, borderRadius } from '../../../lib/theme';
import { t } from '../../../lib/i18n';

interface CelebrationEvent {
  id: number;
  senderName: string;
}

let eventId = 0;

// Sparkle ring around the celebration card — small gold particles popping outward, purely
// decorative (same Animated-loop technique as HeartBurst/LiveCounters' particles).
function Sparkle({ angle }: { angle: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }).start();
  }, [anim]);

  const distance = 46;
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(angle) * distance] });
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(angle) * distance] });
  const opacity = anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] });

  return (
    <Animated.View style={[styles.sparkle, { opacity, transform: [{ translateX }, { translateY }] }]} pointerEvents="none">
      <Ionicons name="sparkles" size={14} color="#FFD700" />
    </Animated.View>
  );
}

function CelebrationCard({ event, onDone }: { event: CelebrationEvent; onDone: () => void }) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 5, tension: 80 }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]),
      Animated.delay(1800),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (finished) onDone();
    });
  }, [scale, opacity, onDone]);

  const sparkleAngles = [0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3];

  return (
    <Animated.View style={[styles.card, { opacity, transform: [{ scale }] }]} pointerEvents="none">
      {sparkleAngles.map((angle, i) => (
        <Sparkle key={i} angle={angle} />
      ))}
      <View style={styles.giftIconWrap}>
        <Ionicons name="gift" size={22} color="#FFD700" />
      </View>
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.senderName}>{event.senderName}</Text> {t('liveViewer.giftCelebration' as any)}
      </Text>
    </Animated.View>
  );
}

// Centralized high-tier gift celebration layer, positioned in the upper third so it never
// covers the streamer's face. UI-phase only: real gift sending (and the trigger that would
// feed events into this layer) is the bottom-sheet feature built right after this screen —
// until then this fires its own occasional demo event, purely so the animation is reviewable.
export default function GiftCelebration() {
  const [event, setEvent] = useState<CelebrationEvent | null>(null);

  const showDemo = useCallback(() => {
    eventId += 1;
    setEvent({ id: eventId, senderName: t('liveViewer.giftDemoSender' as any) });
  }, []);

  useEffect(() => {
    const first = setTimeout(showDemo, 12000);
    const interval = setInterval(() => {
      if (Math.random() < 0.5) showDemo();
    }, 20000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [showDemo]);

  return (
    <View style={styles.layer} pointerEvents="none">
      {event && <CelebrationCard key={event.id} event={event} onDone={() => setEvent(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    // Anchored just above the chat area (same bottom offset as the join-toast stack),
    // left-aligned rather than full-width-centered — so it reads as part of the chat/
    // engagement layer instead of sitting over the middle of the video.
    position: 'absolute',
    left: spacing.md,
    right: spacing.xxxl * 2,
    bottom: 260 + spacing.sm,
    alignItems: 'flex-start',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(20,20,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.5)',
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  giftIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,215,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  senderName: {
    fontWeight: '800',
    color: '#FFD700',
  },
  sparkle: {
    position: 'absolute',
    left: '50%',
    top: '50%',
  },
});
