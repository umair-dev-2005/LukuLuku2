import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export interface HeartBurstInstance {
  id: string;
  x: number;
  y: number;
}

interface HeartBurstProps {
  bursts: HeartBurstInstance[];
  onDone: (id: string) => void;
}

const HEARTS_PER_BURST = 6;
const HEART_COLORS = ['#FF4D6D', '#FF8FA3', '#FFD166', '#5AC8FA', '#B983FF', '#FF758F'];

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

// One heart rising along an approximated Bezier curve — RN's Animated has no native path
// API, so the curve is built from a 3-keyframe X interpolation (start → random midpoint →
// random end) driven by the same 0..1 progress as the Y rise, which reads as a soft arc
// rather than a straight line.
function SingleHeart({ index }: { index: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  const color = useMemo(() => HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)], []);
  const size = useMemo(() => randomBetween(16, 26), []);
  const riseHeight = useMemo(() => randomBetween(160, 260), []);
  const midX = useMemo(() => randomBetween(-40, 40), []);
  const endX = useMemo(() => midX + randomBetween(-30, 30), []);
  const rotate = useMemo(() => `${randomBetween(-25, 25)}deg`, []);
  const delay = index * 70;

  useEffect(() => {
    const timeout = setTimeout(() => {
      Animated.timing(anim, { toValue: 1, duration: 1300 + randomBetween(0, 300), useNativeDriver: true }).start();
    }, delay);
    return () => clearTimeout(timeout);
  }, [anim, delay]);

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [0, -riseHeight] });
  const translateX = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, midX, endX] });
  const opacity = anim.interpolate({ inputRange: [0, 0.15, 0.75, 1], outputRange: [0, 1, 1, 0] });
  const scale = anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.4, 1.1, 0.8] });

  return (
    <Animated.View
      style={[
        styles.heart,
        { opacity, transform: [{ translateY }, { translateX }, { scale }, { rotate }] },
      ]}
      pointerEvents="none"
    >
      <Ionicons name="heart" size={size} color={color} />
    </Animated.View>
  );
}

function Burst({ burst, onDone }: { burst: HeartBurstInstance; onDone: (id: string) => void }) {
  useEffect(() => {
    const timeout = setTimeout(() => onDone(burst.id), 1900);
    return () => clearTimeout(timeout);
  }, [burst.id, onDone]);

  return (
    <View style={[styles.burstOrigin, { left: burst.x, top: burst.y }]} pointerEvents="none">
      {Array.from({ length: HEARTS_PER_BURST }).map((_, i) => (
        <SingleHeart key={i} index={i} />
      ))}
    </View>
  );
}

// Double-tap anywhere on the video spawns one of these from the exact tap point — purely a
// visual reaction; it does not itself send a like (LiveViewerScreen also bumps the real
// like counter on the same double-tap so the two stay in sync).
export default function HeartBurst({ bursts, onDone }: HeartBurstProps) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {bursts.map((burst) => (
        <Burst key={burst.id} burst={burst} onDone={onDone} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  burstOrigin: {
    position: 'absolute',
    width: 1,
    height: 1,
  },
  heart: {
    position: 'absolute',
  },
});
