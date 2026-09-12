import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Modal,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, CameraType } from 'expo-camera';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Circle } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { formatViews, formatLiveDuration } from '../lib/utils';
import { useMicLevel } from '../hooks/useMicLevel';
import { useLiveHostHeader } from '../hooks/useLiveHostHeader';
import { useLiveChat, type ChatMessage, type ModerationAction } from '../hooks/useLiveChat';
import RankAuraAvatar from '../components/RankAuraAvatar';
import LiveChatList from '../components/live/LiveChatList';
import LiveCounters from '../components/live/LiveCounters';
import LiveModerationMenu, { type ModerationTarget } from '../components/live/LiveModerationMenu';
import LiveJoinToastStack from '../components/live/LiveJoinToast';
import EdgeGradient from '../components/live/EdgeGradient';

interface LiveBroadcastScreenProps {
  initialFacing: CameraType;
  initialMuted: boolean;
  onEndStream: () => void;
}

const SEND_BUTTON_SIZE = 40;

// Purple → pink circular send button, matching the reference design.
function SendButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.8} style={{ opacity: disabled ? 0.5 : 1 }}>
      <View style={styles.sendButton}>
        <Svg width={SEND_BUTTON_SIZE} height={SEND_BUTTON_SIZE} style={StyleSheet.absoluteFill}>
          <Defs>
            <SvgLinearGradient id="send-grad" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#8B5CF6" />
              <Stop offset="1" stopColor="#EC4899" />
            </SvgLinearGradient>
          </Defs>
          <Circle cx={SEND_BUTTON_SIZE / 2} cy={SEND_BUTTON_SIZE / 2} r={SEND_BUTTON_SIZE / 2} fill="url(#send-grad)" />
        </Svg>
        <Ionicons name="send" size={17} color="#FFFFFF" style={{ marginLeft: -2 }} />
      </View>
    </TouchableOpacity>
  );
}

export default function LiveBroadcastScreen({ initialFacing, initialMuted, onEndStream }: LiveBroadcastScreenProps) {
  const insets = useSafeAreaInsets();
  const [facing, setFacing] = useState<CameraType>(initialFacing);
  const [menuVisible, setMenuVisible] = useState(false);
  const mic = useMicLevel(initialMuted);
  const host = useLiveHostHeader();
  const chat = useLiveChat({ currentUserName: host.name, currentUserAvatarUrl: host.avatarUrl });

  const startedAtRef = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Tap the camera anywhere (not on a control) to hide the chat/header/counters overlay
  // and see the clean frame, like TikTok/Bigo Live — tap again to bring it back. Controls
  // are their own Touchables, so tapping one of them never reaches this toggle.
  const [uiVisible, setUiVisible] = useState(true);
  const toggleUi = () => setUiVisible((prev) => !prev);

  const [chatText, setChatText] = useState('');
  const [moderationTarget, setModerationTarget] = useState<ModerationTarget | null>(null);
  // The full tapped message, kept alongside moderationTarget purely so pin/unpin (which
  // acts on a message, not a sender) has something to hand to chat.pinMessage().
  const [moderationMessage, setModerationMessage] = useState<ChatMessage | null>(null);

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

  // Same manual keyboard tracking as LivePreviewScreen.tsx — KeyboardAvoidingView's
  // padding/height math double-counts against this app's Android adjustResize setup.
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
    // UI phase mock of a "copy link" share (matches live_shares.share_channel = 'copy_link'
    // in the schema) — the real share sheet + live_share_record() call comes in this
    // feature's ZegoCloud integration plan.
    chat.shareStream();
  };

  const confirmEndStream = () => {
    setMenuVisible(false);
    Alert.alert(
      t('liveHost.endConfirmTitle' as any),
      t('liveHost.endConfirmDesc' as any),
      [
        { text: t('liveHost.cancel' as any), style: 'cancel' },
        { text: t('liveHost.end' as any), style: 'destructive', onPress: onEndStream },
      ]
    );
  };

  // Hardware back must never silently drop the streamer out of their own live stream.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      confirmEndStream();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const handleFlipCamera = () => {
    setMenuVisible(false);
    setFacing((prev) => (prev === 'front' ? 'back' : 'front'));
  };

  const handleToggleMute = () => {
    setMenuVisible(false);
    mic.toggleMute();
  };

  const handleComingSoon = () => {
    setMenuVisible(false);
    Alert.alert(t('create.comingSoon' as any));
  };

  const menuItems = useMemo(
    () => [
      {
        key: 'end',
        icon: 'exit-outline' as const,
        label: t('liveHost.endStream' as any),
        onPress: confirmEndStream,
        danger: true,
      },
      {
        key: 'flip',
        icon: 'camera-reverse-outline' as const,
        label: t('liveHost.flipCamera' as any),
        onPress: handleFlipCamera,
        danger: false,
      },
      {
        key: 'mic',
        icon: (mic.isMuted ? 'mic-off-outline' : 'mic-outline') as 'mic-off-outline' | 'mic-outline',
        label: mic.isMuted ? t('liveHost.unmuteMic' as any) : t('liveHost.muteMic' as any),
        onPress: handleToggleMute,
        danger: false,
      },
      {
        key: 'cohost',
        icon: 'people-outline' as const,
        label: t('liveHost.coHosting' as any),
        onPress: handleComingSoon,
        danger: false,
      },
      {
        key: 'battle',
        icon: 'flash-outline' as const,
        label: t('liveHost.battle' as any),
        onPress: handleComingSoon,
        danger: false,
      },
    ],
    [mic.isMuted]
  );

  return (
    <Pressable style={styles.container} onPress={toggleUi}>
      <CameraView style={StyleSheet.absoluteFill} facing={facing} />

      {uiVisible && (
        <>
          <EdgeGradient position="top" />
          <EdgeGradient position="bottom" />

          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
            <View style={styles.headerRow}>
              <RankAuraAvatar uri={host.avatarUrl} size={40} fallbackLabel={host.name} />

              <View style={styles.headerText}>
                <Text style={styles.hostName} numberOfLines={1}>{host.name || '…'}</Text>
                <View style={styles.liveRow}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveLabel}>{t('liveHost.live' as any)}</Text>
                  <Text style={styles.liveTimer}>{formatLiveDuration(elapsedSeconds)}</Text>
                  {mic.isMuted && (
                    <Ionicons name="mic-off" size={13} color="#FFFFFF" style={{ marginLeft: spacing.xs }} />
                  )}
                </View>
              </View>

              <TouchableOpacity
                style={styles.moreBtn}
                onPress={() => setMenuVisible(true)}
                activeOpacity={0.7}
              >
                <Ionicons name="ellipsis-vertical" size={20} color="#FFFFFF" />
              </TouchableOpacity>
            </View>

            <View style={styles.statsRow}>
              {/* Icons picked to match what TikTok/Bigo Live actually use, so a normal viewer
                  recognizes them at a glance: hand-tap for Tapins (this app's own "Tap In"
                  support action), eye for who's watching now, a play mark for cumulative
                  views (YouTube/TikTok's own view-count convention), diamond for host
                  earnings (Bigo's broadcaster currency is literally called Diamonds). */}
              <View style={styles.statPill}>
                <Ionicons name="hand-left" size={13} color="#FFFFFF" />
                <Text style={styles.statText}>{formatViews(host.tapins)}</Text>
              </View>
              <View style={styles.statPill}>
                <Ionicons name="eye" size={13} color="#FFFFFF" />
                <Text style={styles.statText}>{formatViews(host.liveViewers)}</Text>
              </View>
              <View style={styles.statPill}>
                <Ionicons name="play-circle" size={13} color="#FFFFFF" />
                <Text style={styles.statText}>{formatViews(host.totalViews)}</Text>
              </View>
              <View style={styles.statPill}>
                <Ionicons name="diamond" size={13} color="#FFFFFF" />
                <Text style={styles.statText}>{formatViews(host.earnedCoins)}</Text>
              </View>
            </View>
          </View>

          {/* Keeps the top of the camera visible, chat anchored to the bottom. */}
          <View style={{ flex: 1 }} />

          {/* Floats just above the chat — absolute, so it never shifts the pinned banner or
              message list underneath it. */}
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
                    setModerationMessage(message);
                    setModerationTarget({
                      messageId: message.id,
                      senderId: message.senderId,
                      name: message.name,
                      isModerator: chat.moderatorSenderIds.has(message.senderId),
                      isPinned: chat.pinnedMessage?.id === message.id,
                      isSelf: message.senderId === chat.currentUserId,
                    });
                  }}
                />
              </View>
            </View>
          </View>

          {/* Vertically centered on the whole screen, like TikTok/Instagram Live's action column. */}
          <View style={styles.countersOverlay} pointerEvents="box-none">
            <LiveCounters
              likes={chat.likes}
              chats={chat.chats}
              shares={chat.shares}
              onLike={chat.likeStream}
              onShare={handleShare}
            />
          </View>

          <View style={[styles.inputBar, { marginBottom: keyboardHeight + insets.bottom + spacing.sm }]}>
            {chat.inputError && <Text style={styles.inputErrorText}>{chat.inputError}</Text>}
            <View style={styles.inputPill}>
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
              <SendButton onPress={handleSendChat} disabled={!chatText.trim()} />
            </View>
          </View>
        </>
      )}

      <LiveModerationMenu
        target={moderationTarget}
        viewerRole="host"
        onClose={() => setModerationTarget(null)}
        onAction={handleModerationAction}
      />

      {/* 3-dot menu */}
      <Modal visible={menuVisible} transparent animationType="fade" onRequestClose={() => setMenuVisible(false)}>
        <TouchableOpacity
          style={StyleSheet.absoluteFillObject}
          activeOpacity={1}
          onPress={() => setMenuVisible(false)}
        />
        <View style={[styles.menuCard, { top: insets.top + spacing.sm + 96 }]}>
          {menuItems.map((item) => (
            <TouchableOpacity
              key={item.key}
              style={styles.menuRow}
              onPress={item.onPress}
              activeOpacity={0.7}
            >
              <Ionicons name={item.icon} size={19} color={item.danger ? colors.error : '#FFFFFF'} />
              <Text style={[styles.menuRowText, item.danger && { color: colors.error }]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
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
  header: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  chatSection: {
    height: 260,
  },
  joinToastLayer: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 260 + spacing.sm,
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
  inputPill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 44,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(20,20,20,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingLeft: spacing.lg,
    paddingRight: 3,
  },
  textInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    padding: 0,
  },
  sendButton: {
    width: SEND_BUTTON_SIZE,
    height: SEND_BUTTON_SIZE,
    borderRadius: SEND_BUTTON_SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerText: {
    flex: 1,
  },
  hostName: {
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 2,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.error,
  },
  liveLabel: {
    color: colors.error,
    fontSize: fontSize.xs,
    fontWeight: '800',
  },
  liveTimer: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  moreBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  statText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  menuCard: {
    position: 'absolute',
    right: spacing.lg,
    width: 200,
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  menuRowText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
});
