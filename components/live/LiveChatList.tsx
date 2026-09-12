import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Animated, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import RankAuraAvatar from '../RankAuraAvatar';
import EdgeGradient from './EdgeGradient';
import type { ChatMessage, SenderRole } from '../../hooks/useLiveChat';

interface LiveChatListProps {
  messages: ChatMessage[];
  pinnedMessage: ChatMessage | null;
  mutedSenderIds: Set<string>;
  getRole: (senderId: string) => SenderRole;
  onMessagePress: (message: ChatMessage) => void;
}

// How close to the bottom (px) still counts as "at the bottom" — new messages keep
// auto-scrolling into view there. Past that, the streamer has scrolled up on purpose to
// read older messages, so new arrivals must NOT yank the list back down.
const STICKY_BOTTOM_THRESHOLD = 48;

// Soft diagonal highlight that sweeps across the pinned banner in a loop — a lightweight
// shimmer built from the same react-native-svg gradient technique already used elsewhere in
// this feature (EdgeGradient, the send button), so it needs no new native dependency/rebuild.
function PinnedShimmer() {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 1600, useNativeDriver: true }),
        Animated.delay(900),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-160, 260] });

  return (
    <Animated.View style={[styles.shimmerBand, { transform: [{ translateX }] }]} pointerEvents="none">
      <Svg width={80} height="100%">
        <Defs>
          <SvgLinearGradient id="pin-shimmer" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.25} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#pin-shimmer)" />
      </Svg>
    </Animated.View>
  );
}

function SystemRow({ message }: { message: ChatMessage }) {
  return (
    <View style={styles.systemRow}>
      <Text style={styles.systemText}>
        <Text style={styles.systemName}>{message.name}</Text> {message.text}
      </Text>
    </View>
  );
}

function MessageBubble({
  message,
  role,
  muted,
  onPress,
}: {
  message: ChatMessage;
  role: SenderRole;
  muted: boolean;
  onPress: () => void;
}) {
  const roleBubbleStyle = role === 'host' ? styles.bubbleHost : role === 'moderator' ? styles.bubbleModerator : null;
  const badge = role === 'host' ? t('liveMod.badgeHost' as any) : role === 'moderator' ? t('liveMod.badgeModerator' as any) : null;
  const badgeStyle = role === 'host' ? styles.badgeHost : styles.badgeModerator;

  // Tapping anywhere on the message (photo, name or text) opens the same options menu —
  // pin/unpin plus, for anyone else's message, mute/kick/ban/report/moderator.
  return (
    <TouchableOpacity style={[styles.bubble, roleBubbleStyle]} onPress={onPress} activeOpacity={0.75}>
      <RankAuraAvatar size={28} uri={message.avatarUrl} fallbackLabel={message.name} />
      <View style={styles.bubbleTextCol}>
        <View style={styles.nameRow}>
          <Text style={styles.bubbleName} numberOfLines={1}>{message.name}</Text>
          {badge && (
            <View style={[styles.badge, badgeStyle]}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.bubbleText, muted && styles.bubbleTextMuted]} numberOfLines={3}>
          {message.text}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

export default function LiveChatList({ messages, pinnedMessage, mutedSenderIds, getRole, onMessagePress }: LiveChatListProps) {
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const isAtBottomRef = useRef(true);

  const scrollToEndIfStuck = useCallback(() => {
    if (isAtBottomRef.current) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    isAtBottomRef.current = distanceFromBottom < STICKY_BOTTOM_THRESHOLD;
  }, []);

  return (
    <View style={styles.container}>
      {pinnedMessage && (
        <View style={styles.pinnedBanner}>
          <PinnedShimmer />
          <View style={styles.pinnedLabelRow}>
            <Ionicons name="pin" size={11} color={colors.tapIn} />
            <Text style={styles.pinnedLabel}>{t('liveChat.pinned' as any)}</Text>
          </View>
          <Text style={styles.pinnedText} numberOfLines={2}>{pinnedMessage.text}</Text>
        </View>
      )}

      {/* Transparent-to-solid fade at the top of the chat area, so scrolling messages look
          like they emerge out of thin air rather than getting cut off by a hard edge. */}
      <EdgeGradient position="top" height={28} />

      {/* Newest message at the bottom, list auto-scrolls down as messages arrive — like
          every live-stream chat — but only while the streamer is already at the bottom.
          It's a normal scrollable list otherwise: they can freely scroll up to read
          history and back down again. */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) =>
          item.type === 'system' ? (
            <SystemRow message={item} />
          ) : (
            <MessageBubble
              message={item}
              role={getRole(item.senderId)}
              muted={mutedSenderIds.has(item.senderId)}
              onPress={() => onMessagePress(item)}
            />
          )
        }
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={100}
        onContentSizeChange={scrollToEndIfStuck}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  pinnedBanner: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    padding: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  shimmerBand: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 80,
  },
  pinnedLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  pinnedLabel: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  pinnedText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    maxWidth: '86%',
    marginBottom: spacing.xs,
  },
  bubbleHost: {
    backgroundColor: 'rgba(255,215,0,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.55)',
  },
  bubbleModerator: {
    backgroundColor: 'rgba(90,200,250,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(90,200,250,0.6)',
  },
  bubbleTextCol: {
    flexShrink: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  bubbleName: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.xs,
    fontWeight: '700',
    flexShrink: 1,
  },
  badge: {
    paddingHorizontal: 5,
    borderRadius: borderRadius.sm,
  },
  badgeHost: {
    backgroundColor: colors.gold,
  },
  badgeModerator: {
    backgroundColor: colors.tapIn,
  },
  badgeText: {
    color: '#101010',
    fontSize: 9,
    fontWeight: '800',
  },
  bubbleText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '400',
    marginTop: 1,
  },
  bubbleTextMuted: {
    color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic',
  },
  systemRow: {
    marginBottom: spacing.xs,
    paddingLeft: spacing.sm,
  },
  systemText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: fontSize.xs,
    fontStyle: 'italic',
  },
  systemName: {
    fontWeight: '700',
    fontStyle: 'normal',
  },
});
