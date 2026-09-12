import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  TextInput,
  Alert,
  BackHandler,
  Keyboard,
  Platform,
  Animated,
  Modal,
  ActivityIndicator,
  GestureResponderEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { Image } from '../components/AppImage';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { formatLiveDuration } from '../lib/utils';
import { useLiveViewerStream } from '../hooks/useLiveViewerStream';
import { useLiveHostHeader } from '../hooks/useLiveHostHeader';
import { useLiveChat, type ChatMessage, type ModerationAction } from '../hooks/useLiveChat';
import EdgeGradient from '../components/live/EdgeGradient';
import LiveChatList from '../components/live/LiveChatList';
import LiveCounters from '../components/live/LiveCounters';
import LiveModerationMenu, { type ModerationTarget } from '../components/live/LiveModerationMenu';
import LiveJoinToastStack from '../components/live/LiveJoinToast';
import AeroHeader from '../components/live/viewer/AeroHeader';
import HeartBurst, { type HeartBurstInstance } from '../components/live/viewer/HeartBurst';
import GiftCelebration from '../components/live/viewer/GiftCelebration';
import LiveEndedOverlay from '../components/live/viewer/LiveEndedOverlay';

interface LiveViewerScreenProps {
  streamId: string;
  onBack: () => void;
  onExploreMore: () => void;
}

const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SLOP = 40;
const GIFT_BUTTON_SIZE = 44;

// Gift Box trigger with a persistent subtle "heartbeat" bounce — a plain Animated loop, no
// new dependency. Gift SENDING itself (the bottom sheet + catalog) is this feature's very
// next session; tapping it here just says so.
function GiftButton({ onPress }: { onPress: () => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 550, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 550, useNativeDriver: true }),
        Animated.delay(1400),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] });

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      <Animated.View style={[styles.giftBtn, { transform: [{ scale }] }]}>
        <Ionicons name="gift" size={22} color="#FFD700" />
      </Animated.View>
    </TouchableOpacity>
  );
}

export default function LiveViewerScreen({ streamId, onBack, onExploreMore }: LiveViewerScreenProps) {
  const insets = useSafeAreaInsets();
  const stream = useLiveViewerStream(streamId);
  // Same hook the broadcaster's own screen uses for "my own signed-in identity" — here it's
  // the VIEWER's own name/avatar (for the chat messages they send), not the streamer's.
  const me = useLiveHostHeader();
  const chat = useLiveChat({
    hostUserId: stream.hostUserId ?? undefined,
    currentUserName: me.name,
    currentUserAvatarUrl: me.avatarUrl,
  });

  const [uiVisible, setUiVisible] = useState(true);
  const uiAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(uiAnim, { toValue: uiVisible ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  }, [uiVisible, uiAnim]);

  const [hearts, setHearts] = useState<HeartBurstInstance[]>([]);
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartBurstId = useRef(0);

  const spawnHeartBurst = (x: number, y: number) => {
    heartBurstId.current += 1;
    setHearts((prev) => [...prev, { id: `hb-${heartBurstId.current}`, x, y }]);
    chat.likeStream();
  };

  const removeHeartBurst = (id: string) => {
    setHearts((prev) => prev.filter((h) => h.id !== id));
  };

  // Single-tap toggles Clean View; a second tap at ~the same spot within 280ms upgrades it
  // to a double-tap heart burst instead (and cancels the pending single-tap toggle).
  const handleScreenPress = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const now = Date.now();
    const last = lastTapRef.current;
    if (
      last &&
      now - last.time < DOUBLE_TAP_MS &&
      Math.abs(locationX - last.x) < DOUBLE_TAP_SLOP &&
      Math.abs(locationY - last.y) < DOUBLE_TAP_SLOP
    ) {
      if (singleTapTimeoutRef.current) clearTimeout(singleTapTimeoutRef.current);
      lastTapRef.current = null;
      spawnHeartBurst(locationX, locationY);
      return;
    }
    lastTapRef.current = { time: now, x: locationX, y: locationY };
    singleTapTimeoutRef.current = setTimeout(() => {
      setUiVisible((prev) => !prev);
      lastTapRef.current = null;
    }, DOUBLE_TAP_MS);
  };

  const [chatText, setChatText] = useState('');
  const [moderationTarget, setModerationTarget] = useState<ModerationTarget | null>(null);
  const [moderationMessage, setModerationMessage] = useState<ChatMessage | null>(null);
  const viewerRole = stream.isModerator ? 'moderator' : 'viewer';

  const handleModerationAction = (senderId: string, action: ModerationAction) => {
    if (action === 'pin') {
      if (moderationMessage) chat.pinMessage(moderationMessage);
      return;
    }
    if (action === 'unpin') {
      chat.unpinMessage();
      return;
    }
    chat.moderateViewer(senderId, action);
  };

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
    const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleSendChat = async () => {
    const sent = await chat.sendMessage(chatText);
    if (sent) setChatText('');
  };

  const handleShare = () => {
    // UI phase mock of a "copy link" share (matches live_shares.share_channel = 'copy_link')
    // — the real share sheet + live_share_record() call comes in this feature's ZegoCloud
    // integration plan.
    chat.shareStream();
  };

  const handleGiftPress = () => {
    Alert.alert(t('liveViewer.giftComingSoon' as any));
  };

  // The X button opens this small dropdown instead of exiting straight away — Report (the
  // stream/host, no specific message this time) or End the Stream (which, for a viewer,
  // only ever means leaving their own watch session — never the broadcaster's stream).
  const [exitMenuVisible, setExitMenuVisible] = useState(false);

  const handleReportStream = () => {
    setExitMenuVisible(false);
    Alert.alert(
      t('liveMod.reportConfirmTitle' as any),
      t('liveMod.reportConfirmDesc' as any),
      [
        { text: t('liveMod.cancel' as any), style: 'cancel' },
        {
          text: t('liveMod.reportSubmit' as any),
          style: 'destructive',
          onPress: () => Alert.alert(`${stream.hostName} ${t('liveMod.reportedDesc' as any)}`),
        },
      ]
    );
  };

  const handleLeaveStream = () => {
    setExitMenuVisible(false);
    onBack();
  };

  // Dev-only: long-press the X to preview the end-of-stream screen without waiting for a
  // real stream to end. Remove once ZegoCloud integration can actually detect stream end.
  const [devPreviewEnded, setDevPreviewEnded] = useState(false);

  // Hardware back leaves the stream like the X button.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  // How long the STREAM has actually been live (live_streams.started_at) — not how long
  // this viewer has been watching — ticking every second like TikTok/Bigo Live's timer.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!stream.startedAt) return;
    const startedAtMs = new Date(stream.startedAt).getTime();
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [stream.startedAt]);

  // Shown immediately on navigation, before the header/chat would otherwise flash with
  // blank name/0 stats while the network round-trips finish — makes opening the screen
  // feel instant even though the real data takes a moment to arrive.
  if (stream.loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.tapIn} />
      </View>
    );
  }

  const hasEnded = stream.hasEnded || devPreviewEnded;

  if (hasEnded) {
    return (
      <LiveEndedOverlay
        hostAvatarUrl={stream.hostAvatarUrl}
        hostName={stream.hostName}
        durationSeconds={elapsedSeconds}
        likes={chat.likes}
        chats={chat.chats}
        shares={chat.shares}
        onExploreMore={onExploreMore}
        onGoHome={onBack}
      />
    );
  }

  return (
    <Pressable style={styles.container} onPress={handleScreenPress}>
      {stream.hostAvatarUrl ? (
        <Image source={{ uri: stream.hostAvatarUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallbackBg]} />
      )}

      {/* Always visible regardless of Clean View — the celebration/heart layers are the
          "video content" reactions, not chrome. */}
      <HeartBurst bursts={hearts} onDone={removeHeartBurst} />
      <GiftCelebration />

      <Animated.View style={[StyleSheet.absoluteFill, { opacity: uiAnim }]} pointerEvents={uiVisible ? 'box-none' : 'none'}>
        <EdgeGradient position="top" />
        <EdgeGradient position="bottom" />

        <AeroHeader
          hostName={stream.hostName}
          hostAvatarUrl={stream.hostAvatarUrl}
          elapsedSeconds={elapsedSeconds}
          tapins={stream.tapins}
          liveViewers={stream.liveViewers}
          earnedCoins={stream.earnedCoins}
          hasTapped={stream.hasTapped}
          tapInBusy={stream.tapInBusy}
          onTapIn={stream.tapIn}
          onExitPress={() => setExitMenuVisible(true)}
          onExitLongPress={() => setDevPreviewEnded(true)}
          topInset={insets.top}
        />

        <View style={{ flex: 1 }} />

        <View style={styles.joinToastLayer} pointerEvents="none">
          <LiveJoinToastStack toasts={chat.joinToasts} onDone={chat.removeJoinToast} />
        </View>

        <View style={styles.chatSection}>
          <View style={styles.chatRow}>
            <View style={styles.chatColumn}>
              <LiveChatList
                messages={chat.messages}
                pinnedMessage={chat.pinnedMessage}
                mutedSenderIds={chat.mutedSenderIds}
                getRole={chat.getRole}
                onMessagePress={(message) => {
                  const isSelf = message.senderId === chat.currentUserId;
                  if (isSelf && viewerRole === 'viewer') return; // a plain viewer has nothing to do on their own message
                  setModerationMessage(message);
                  setModerationTarget({
                    messageId: message.id,
                    senderId: message.senderId,
                    name: message.name,
                    isModerator: chat.moderatorSenderIds.has(message.senderId),
                    isPinned: chat.pinnedMessage?.id === message.id,
                    isSelf,
                  });
                }}
              />
            </View>
          </View>
        </View>

        <View style={styles.countersOverlay} pointerEvents="box-none">
          <LiveCounters
            variant="viewer"
            likes={chat.likes}
            chats={chat.chats}
            shares={chat.shares}
            onLike={chat.likeStream}
            onShare={handleShare}
          />
        </View>

        <View style={[styles.inputBar, { marginBottom: keyboardHeight + insets.bottom + spacing.sm }]}>
          {chat.inputError && <Text style={styles.inputErrorText}>{chat.inputError}</Text>}
          <View style={styles.inputRow}>
            <BlurView intensity={40} tint="dark" style={styles.inputPill}>
              <TextInput
                style={styles.textInput}
                placeholder={t('liveChat.addComment' as any)}
                placeholderTextColor="rgba(255,255,255,0.6)"
                value={chatText}
                onChangeText={setChatText}
                maxLength={500}
                returnKeyType="send"
                onSubmitEditing={handleSendChat}
              />
              <TouchableOpacity onPress={handleSendChat} disabled={!chatText.trim()} style={{ opacity: chatText.trim() ? 1 : 0.5 }}>
                <Ionicons name="send" size={20} color={colors.tapIn} />
              </TouchableOpacity>
            </BlurView>
            <GiftButton onPress={handleGiftPress} />
          </View>
        </View>
      </Animated.View>

      <LiveModerationMenu
        target={moderationTarget}
        viewerRole={viewerRole}
        onClose={() => setModerationTarget(null)}
        onAction={handleModerationAction}
      />

      {/* X button dropdown: Report the stream, or leave it. */}
      <Modal visible={exitMenuVisible} transparent animationType="fade" onRequestClose={() => setExitMenuVisible(false)}>
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={() => setExitMenuVisible(false)}
        />
        <View style={[styles.exitMenuCard, { top: insets.top + spacing.sm + 64 }]}>
          <TouchableOpacity style={styles.exitMenuRow} onPress={handleReportStream} activeOpacity={0.7}>
            <Ionicons name="flag-outline" size={19} color="#FFFFFF" />
            <Text style={styles.exitMenuRowText}>{t('liveMod.report' as any)}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.exitMenuRow} onPress={handleLeaveStream} activeOpacity={0.7}>
            <Ionicons name="exit-outline" size={19} color={colors.error} />
            <Text style={[styles.exitMenuRowText, { color: colors.error }]}>{t('liveViewer.endStream' as any)}</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  fallbackBg: {
    backgroundColor: '#1A1A1A',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  joinToastLayer: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 260 + spacing.sm,
  },
  chatSection: {
    height: 260,
  },
  chatRow: {
    flex: 1,
    paddingHorizontal: spacing.md,
  },
  chatColumn: {
    flex: 1,
  },
  countersOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: spacing.md,
    justifyContent: 'center',
  },
  inputBar: {
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  inputErrorText: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: '700',
    paddingHorizontal: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  inputPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    gap: spacing.sm,
  },
  textInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    padding: 0,
  },
  giftBtn: {
    width: GIFT_BUTTON_SIZE,
    height: GIFT_BUTTON_SIZE,
    borderRadius: GIFT_BUTTON_SIZE / 2,
    backgroundColor: 'rgba(255,215,0,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  exitMenuCard: {
    position: 'absolute',
    right: spacing.md,
    width: 200,
    backgroundColor: 'rgba(20,20,20,0.95)',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  exitMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  exitMenuRowText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
