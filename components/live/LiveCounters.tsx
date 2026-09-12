import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';
import { formatViews } from '../../lib/utils';

interface LiveCountersProps {
  likes: number;
  chats: number;
  shares: number;
  onLike: () => void;
  onShare: () => void;
  // 'host' = the broadcaster's own screen (LiveBroadcastScreen): simple dark circles,
  // counts printed below each icon. 'viewer' = the "Aero" quick-action stack spec: 48dp
  // frosted-glass circles, a red-to-pink gradient fill on the heart once liked, and
  // ultra-thin line icons with a small overlapping count badge instead of text below.
  variant?: 'host' | 'viewer';
}

interface Particle {
  id: number;
  icon: 'heart' | 'gift';
  startX: number;
  anim: Animated.Value;
}

let particleId = 0;

function FloatingParticle({ particle, onDone }: { particle: Particle; onDone: (id: number) => void }) {
  useEffect(() => {
    Animated.timing(particle.anim, {
      toValue: 1,
      duration: 1400,
      useNativeDriver: true,
    }).start(() => onDone(particle.id));
  }, [particle, onDone]);

  const translateY = particle.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -120] });
  const translateX = particle.anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, particle.startX, particle.startX * 1.6] });
  const opacity = particle.anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 1, 0] });
  const scale = particle.anim.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.3, 1.15, 0.8] });

  return (
    <Animated.View
      style={[styles.particle, { opacity, transform: [{ translateY }, { translateX }, { scale }] }]}
      pointerEvents="none"
    >
      <Ionicons
        name={particle.icon === 'heart' ? 'heart' : 'gift'}
        size={particle.icon === 'heart' ? 22 : 24}
        color={particle.icon === 'heart' ? colors.error : '#FFD700'}
      />
    </Animated.View>
  );
}

const VIEWER_CIRCLE_SIZE = 48;

export default function LiveCounters({ likes, chats, shares, onLike, onShare, variant = 'host' }: LiveCountersProps) {
  const [particles, setParticles] = useState<Particle[]>([]);
  const [liked, setLiked] = useState(false);

  const spawnParticle = useCallback((icon: Particle['icon']) => {
    const particle: Particle = {
      id: particleId++,
      icon,
      startX: Math.random() * 30 - 15,
      anim: new Animated.Value(0),
    };
    setParticles((prev) => [...prev, particle]);
  }, []);

  const removeParticle = useCallback((id: number) => {
    setParticles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleLike = () => {
    setLiked(true);
    onLike();
    spawnParticle('heart');
  };

  // Occasional decorative "gift" float so the stream feels alive — purely visual, not tied
  // to the real gifting/coins economy (that's a separate future feature).
  const spawnParticleRef = useRef(spawnParticle);
  spawnParticleRef.current = spawnParticle;
  useEffect(() => {
    const interval = setInterval(() => {
      if (Math.random() < 0.4) spawnParticleRef.current('gift');
    }, 9000);
    return () => clearInterval(interval);
  }, []);

  const particleLayer = (
    <View style={styles.particleLayer} pointerEvents="none">
      {particles.map((particle) => (
        <FloatingParticle key={particle.id} particle={particle} onDone={removeParticle} />
      ))}
    </View>
  );

  if (variant === 'viewer') {
    return (
      <View style={styles.viewerContainer}>
        <View style={styles.viewerItem}>
          {particleLayer}
          {/* A plain solid fill, not an SVG gradient: react-native-svg draws through its own
              native surface on Android, which kept compositing above the icon and hiding it
              — no combination of zIndex/elevation reliably fixed that stacking order. A
              single background color has no such risk and the icon is always visible. */}
          <TouchableOpacity
            style={[styles.viewerCircle, liked ? styles.viewerCircleLiked : styles.viewerCircleFrosted]}
            onPress={handleLike}
            activeOpacity={0.7}
          >
            <Ionicons name={liked ? 'heart' : 'heart-outline'} size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <View style={styles.viewerBadge}>
            <Text style={styles.viewerBadgeText}>{formatViews(likes)}</Text>
          </View>
        </View>

        <View style={styles.viewerItem}>
          <View style={[styles.viewerCircle, styles.viewerCircleFrosted]}>
            <Ionicons name="chatbubble-outline" size={20} color="#FFFFFF" />
          </View>
          <View style={styles.viewerBadge}>
            <Text style={styles.viewerBadgeText}>{formatViews(chats)}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.viewerItem} onPress={onShare} activeOpacity={0.7}>
          <View style={[styles.viewerCircle, styles.viewerCircleFrosted]}>
            <Ionicons name="share-social-outline" size={20} color="#FFFFFF" />
          </View>
          <View style={styles.viewerBadge}>
            <Text style={styles.viewerBadgeText}>{formatViews(shares)}</Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Heart button owns its own particle layer, positioned right over it, so the
          floating hearts visibly rise from where the streamer actually tapped. */}
      <View style={styles.counterItem}>
        {particleLayer}
        <TouchableOpacity style={styles.counterCircle} onPress={handleLike} activeOpacity={0.7}>
          <Ionicons name="heart" size={22} color={liked ? colors.error : '#FFFFFF'} />
        </TouchableOpacity>
        <Text style={styles.counterText}>{formatViews(likes)}</Text>
      </View>

      <View style={styles.counterItem}>
        <View style={styles.counterCircle}>
          <Ionicons name="chatbubble-ellipses" size={20} color="#FFFFFF" />
        </View>
        <Text style={styles.counterText}>{formatViews(chats)}</Text>
      </View>

      <TouchableOpacity style={styles.counterItem} onPress={onShare} activeOpacity={0.7}>
        <View style={styles.counterCircle}>
          <Ionicons name="arrow-redo" size={20} color="#FFFFFF" />
        </View>
        <Text style={styles.counterText}>{formatViews(shares)}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: spacing.lg,
  },
  particleLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  particle: {
    position: 'absolute',
  },
  counterCircle: {
    width: 44,
    height: 44,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  counterText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  counterItem: {
    alignItems: 'center',
    gap: 2,
  },
  // --- viewer ("Aero") variant ---
  viewerContainer: {
    alignItems: 'center',
    gap: spacing.lg,
  },
  viewerItem: {
    alignItems: 'center',
  },
  viewerCircle: {
    width: VIEWER_CIRCLE_SIZE,
    height: VIEWER_CIRCLE_SIZE,
    borderRadius: VIEWER_CIRCLE_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  viewerCircleFrosted: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  viewerCircleLiked: {
    backgroundColor: '#FF4D6D',
    borderWidth: 1,
    borderColor: '#FF8FA3',
    shadowColor: '#FF4D6D',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 8,
    elevation: 6,
  },
  viewerBadge: {
    position: 'absolute',
    bottom: -6,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: borderRadius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  viewerBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '700',
  },
});
