import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';

const GAME_DURATION = 10; // seconds

interface TapSpeedGameProps {
  onGameEnd: (score: number) => void;
}

export default function TapSpeedGame({ onGameEnd }: TapSpeedGameProps) {
  const [phase, setPhase] = useState<'ready' | 'playing' | 'done'>('ready');
  const [taps, setTaps] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startGame = useCallback(() => {
    setPhase('playing');
    setTaps(0);
    setTimeLeft(GAME_DURATION);

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          setPhase('done');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => {
    if (phase === 'done') {
      onGameEnd(taps);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [phase]);

  const handleTap = () => {
    if (phase !== 'playing') return;
    setTaps((t) => t + 1);
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.9, duration: 50, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const resetGame = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setPhase('ready');
    setTaps(0);
    setTimeLeft(GAME_DURATION);
  };

  return (
    <View style={styles.container}>
      {/* Timer */}
      <View style={styles.timerContainer}>
        <Text style={styles.timerLabel}>Tijd</Text>
        <Text style={[styles.timerValue, timeLeft <= 3 && { color: colors.primary }]}>
          {timeLeft}s
        </Text>
      </View>

      {/* Tap count */}
      <Text style={styles.tapCount}>{taps}</Text>
      <Text style={styles.tapLabel}>taps</Text>

      {/* Tap button */}
      {phase === 'ready' ? (
        <TouchableOpacity style={styles.startBtn} onPress={startGame}>
          <Text style={styles.startBtnText}>START</Text>
        </TouchableOpacity>
      ) : phase === 'playing' ? (
        <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
          <TouchableOpacity
            style={styles.tapBtn}
            onPress={handleTap}
            activeOpacity={0.8}
          >
            <Ionicons name="finger-print" size={48} color="#FFF" />
            <Text style={styles.tapBtnText}>TAP!</Text>
          </TouchableOpacity>
        </Animated.View>
      ) : (
        <View style={styles.resultContainer}>
          <Text style={styles.resultText}>
            {taps >= 80 ? 'Ongelooflijk!' : taps >= 60 ? 'Super snel!' : taps >= 40 ? 'Goed gedaan!' : 'Blijf oefenen!'}
          </Text>
          <Text style={styles.resultScore}>{taps} taps in {GAME_DURATION}s</Text>
          <TouchableOpacity style={styles.resetBtn} onPress={resetGame}>
            <Ionicons name="refresh" size={20} color={colors.tapIn} />
            <Text style={styles.resetBtnText}>Opnieuw</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  timerContainer: { alignItems: 'center', marginBottom: spacing.xl },
  timerLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  timerValue: { color: colors.text, fontSize: 48, fontWeight: '700' },
  tapCount: { color: colors.tapIn, fontSize: 72, fontWeight: '800' },
  tapLabel: { color: colors.textSecondary, fontSize: fontSize.lg, marginBottom: spacing.xxl },
  startBtn: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: colors.tapIn,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.tapIn,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  startBtnText: { color: '#FFF', fontSize: fontSize.xxl, fontWeight: '800' },
  tapBtn: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  tapBtnText: { color: '#FFF', fontSize: fontSize.lg, fontWeight: '800', marginTop: 4 },
  resultContainer: { alignItems: 'center', gap: spacing.md },
  resultText: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  resultScore: { color: colors.textSecondary, fontSize: fontSize.md },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceLight,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.full,
    marginTop: spacing.md,
  },
  resetBtnText: { color: colors.tapIn, fontSize: fontSize.md, fontWeight: '600' },
});
