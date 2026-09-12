import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../lib/theme';
import { t } from '../../lib/i18n';
import type { ModerationAction } from '../../hooks/useLiveChat';

export interface ModerationTarget {
  messageId: string;
  senderId: string;
  name: string;
  isModerator: boolean;
  isPinned: boolean;
  // Tapping your own message (host or moderator) only ever offers Pin/Unpin — self-mute/
  // kick/ban/report isn't a real action (stream_mod_assert_can_act blocks it server-side too).
  isSelf: boolean;
}

interface LiveModerationMenuProps {
  target: ModerationTarget | null;
  // The person opening this menu. 'host' = the broadcaster's own screen (full set). 'moderator'
  // = a moderator watching from LiveViewerScreen (everything except Make Moderator — only the
  // host assigns those, per stream_mod_assign_moderator()'s host-or-admin rule). 'viewer' = an
  // ordinary viewer on LiveViewerScreen — Report only; they can't pin/mute/kick/ban.
  viewerRole: 'host' | 'moderator' | 'viewer';
  onClose: () => void;
  onAction: (senderId: string, action: ModerationAction) => void;
}

// Durations match what's actually deployed server-side (APP_SCHEMA_OVERVIEW.md migration
// 05): mute duration is configurable (chosen here as 15 min), kick is a fixed 15 min in
// stream_mod_kick(), and a stream-level ban has no duration at all — it blocks the
// broadcaster's own next stream, not a time window. Wiring these to the real
// stream_mod_mute/kick/ban/report/assign_moderator RPCs happens in this feature's
// ZegoCloud integration plan; for now onAction only updates local UI state (useLiveChat.ts).
export default function LiveModerationMenu({ target, viewerRole, onClose, onAction }: LiveModerationMenuProps) {
  const runAction = (action: ModerationAction) => {
    if (!target) return;
    onAction(target.senderId, action);
    onClose();

    // Pin/unpin acts on the message, not the person — no "X was ..." toast needed, the
    // pinned banner appearing/disappearing at the top of the chat is feedback enough.
    if (action === 'pin' || action === 'unpin') return;

    const descKey = {
      mute: 'liveMod.mutedDesc',
      kick: 'liveMod.kickedDesc',
      ban: 'liveMod.bannedDesc',
      report: 'liveMod.reportedDesc',
      promote: 'liveMod.promotedDesc',
      demote: 'liveMod.demotedDesc',
    }[action];
    Alert.alert(`${target.name} ${t(descKey as any)}`);
  };

  const handleReport = () => {
    if (!target) return;
    onClose();
    Alert.alert(
      t('liveMod.reportConfirmTitle' as any),
      t('liveMod.reportConfirmDesc' as any),
      [
        { text: t('liveMod.cancel' as any), style: 'cancel' },
        { text: t('liveMod.reportSubmit' as any), style: 'destructive', onPress: () => runAction('report') },
      ]
    );
  };

  return (
    <Modal visible={!!target} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={onClose} />
      <View style={styles.sheet}>
        {target && (
          <>
            <Text style={styles.title} numberOfLines={1}>{target.name}</Text>

            {viewerRole !== 'viewer' && (
              <TouchableOpacity
                style={styles.row}
                onPress={() => runAction(target.isPinned ? 'unpin' : 'pin')}
                activeOpacity={0.7}
              >
                <Ionicons name={target.isPinned ? 'close-circle-outline' : 'pin-outline'} size={19} color="#FFFFFF" />
                <Text style={styles.rowText}>{t((target.isPinned ? 'liveMod.unpin' : 'liveMod.pin') as any)}</Text>
              </TouchableOpacity>
            )}

            {!target.isSelf && (
              <>
                {(viewerRole === 'host' || viewerRole === 'viewer') && (
                  <TouchableOpacity style={styles.row} onPress={handleReport} activeOpacity={0.7}>
                    <Ionicons name="flag-outline" size={19} color="#FFFFFF" />
                    <Text style={styles.rowText}>{t('liveMod.report' as any)}</Text>
                  </TouchableOpacity>
                )}

                {viewerRole !== 'viewer' && (
                  <>
                    <TouchableOpacity style={styles.row} onPress={() => runAction('mute')} activeOpacity={0.7}>
                      <Ionicons name="mic-off-outline" size={19} color="#FFFFFF" />
                      <Text style={styles.rowText}>{t('liveMod.mute' as any)}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.row} onPress={() => runAction('kick')} activeOpacity={0.7}>
                      <Ionicons name="log-out-outline" size={19} color="#FFFFFF" />
                      <Text style={styles.rowText}>{t('liveMod.kick' as any)}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.row} onPress={() => runAction('ban')} activeOpacity={0.7}>
                      <Ionicons name="ban-outline" size={19} color={colors.error} />
                      <Text style={[styles.rowText, { color: colors.error }]}>{t('liveMod.ban' as any)}</Text>
                    </TouchableOpacity>
                  </>
                )}

                {viewerRole === 'moderator' && (
                  <TouchableOpacity style={styles.row} onPress={handleReport} activeOpacity={0.7}>
                    <Ionicons name="flag-outline" size={19} color="#FFFFFF" />
                    <Text style={styles.rowText}>{t('liveMod.report' as any)}</Text>
                  </TouchableOpacity>
                )}

                {viewerRole === 'host' && (
                  <TouchableOpacity
                    style={styles.row}
                    onPress={() => runAction(target.isModerator ? 'demote' : 'promote')}
                    activeOpacity={0.7}
                  >
                    <Ionicons name={target.isModerator ? 'shield-outline' : 'shield-checkmark-outline'} size={19} color={colors.tapIn} />
                    <Text style={[styles.rowText, { color: colors.tapIn }]}>
                      {t((target.isModerator ? 'liveMod.demote' : 'liveMod.promote') as any)}
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            )}

            <TouchableOpacity style={styles.cancelRow} onPress={onClose} activeOpacity={0.7}>
              <Text style={styles.cancelText}>{t('liveMod.cancel' as any)}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xxxl,
    backgroundColor: 'rgba(20,20,20,0.95)',
    borderRadius: borderRadius.xl,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  title: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  cancelRow: {
    marginTop: spacing.xs,
    paddingVertical: spacing.md,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  cancelText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
});
