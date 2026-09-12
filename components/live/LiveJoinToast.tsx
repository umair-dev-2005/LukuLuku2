import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { spacing, fontSize, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import RankAuraAvatar from '../RankAuraAvatar';
import type { JoinToast } from '../../hooks/useLiveChat';

const ENTER_MS = 260;
const HOLD_MS = 1900;
const EXIT_MS = 260;

function JoinToastItem({ toast, onDone }: { toast: JoinToast; onDone: (id: string) => void }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const sequence = Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: ENTER_MS, useNativeDriver: true }),
      Animated.delay(HOLD_MS),
      Animated.timing(anim, { toValue: 0, duration: EXIT_MS, useNativeDriver: true }),
    ]);
    sequence.start(({ finished }) => {
      if (finished) onDone(toast.id);
    });
    return () => sequence.stop();
  }, [anim, toast.id, onDone]);

  const opacity = anim;
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] });
  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });

  return (
    <Animated.View style={[styles.toast, { opacity, transform: [{ translateX }, { scale }] }]}>
      <RankAuraAvatar size={22} fallbackLabel={toast.name} />
      <Text style={styles.text} numberOfLines={1}>
        <Text style={styles.name}>{toast.name}</Text> {t('liveChat.joined' as any)} 👋
      </Text>
    </Animated.View>
  );
}

interface LiveJoinToastStackProps {
  toasts: JoinToast[];
  onDone: (id: string) => void;
}

// Floats above the chat — never inserted into the message list — so a burst of viewers
// joining can't push or disturb real chat content. New toasts stack above older ones and
// each auto-dismisses on its own after ~2.4s; see useLiveChat.ts's pushJoinToast/MAX cap
// for how the queue itself is kept short.
export default function LiveJoinToastStack({ toasts, onDone }: LiveJoinToastStackProps) {
  return (
    <View style={styles.stack}>
      {toasts.map((toast) => (
        <JoinToastItem key={toast.id} toast={toast} onDone={onDone} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing.xs,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: borderRadius.full,
    paddingVertical: 5,
    paddingRight: spacing.md,
    paddingLeft: 5,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  text: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: fontSize.xs,
    maxWidth: 200,
  },
  name: {
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
