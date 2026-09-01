import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, TextInput, Alert, ActivityIndicator, StyleSheet, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { clearAuthCache } from '../lib/auth';
import { supabase } from '../lib/supabase';
import {
  acceptCommunityTerms,
  getSupportEmail,
  hasAcceptedCommunityTerms,
  loadBlockedUserIds,
  saveDeletionRequest,
  saveReportDraft,
  subscribeCommunitySafetyChanges,
  unblockUser,
} from '../lib/communitySafety';

interface CommunitySafetyToolsProps {
  userId?: string | null;
  onDeleted?: () => void;
}

const REPORT_REASONS = ['Spam', 'Harassment', 'Hate speech', 'Nudity', 'Violence', 'Other'] as const;

export default function CommunitySafetyTools({ userId, onDeleted }: CommunitySafetyToolsProps) {
  const [communityTermsAccepted, setCommunityTermsAccepted] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<string[]>([]);
  const [showDeletionModal, setShowDeletionModal] = useState(false);
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [deletionConfirmText, setDeletionConfirmText] = useState('');
  const [reportReason, setReportReason] = useState<(typeof REPORT_REASONS)[number]>('Spam');
  const [reportDetails, setReportDetails] = useState('');
  const [reportTargetId, setReportTargetId] = useState('');
  const [reportTargetUserId, setReportTargetUserId] = useState('');
  const [reportContentType, setReportContentType] = useState<'post' | 'video' | 'short' | 'comment' | 'profile'>('post');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportSuccess, setReportSuccess] = useState<string | null>(null);

  useEffect(() => {
    void hasAcceptedCommunityTerms().then(setCommunityTermsAccepted);
    void loadBlockedUserIds().then(setBlockedUsers);
    return subscribeCommunitySafetyChanges(() => {
      void hasAcceptedCommunityTerms().then(setCommunityTermsAccepted);
      void loadBlockedUserIds().then(setBlockedUsers);
    });
  }, []);

  const blockedUsersCount = blockedUsers.length;

  const handleAcceptCommunityTerms = async () => {
    await acceptCommunityTerms();
    setCommunityTermsAccepted(true);
    Alert.alert('Terms accepted', 'Community terms are now active on this device.');
  };

  const handleRequestAccountDeletion = async () => {
    if (!userId) return;
    if (deletionConfirmText.trim().toUpperCase() !== 'DELETE') {
      Alert.alert('Delete account', 'Type DELETE to continue.');
      return;
    }

    setDeletionSubmitting(true);
    try {
      await saveDeletionRequest(userId);
      const { data, error } = await supabase.functions.invoke('delete-account');
      if (error || !data?.success) {
        throw error ?? new Error('Delete failed');
      }
      await supabase.auth.signOut();
      clearAuthCache();
      setShowDeletionModal(false);
      setDeletionConfirmText('');
      Alert.alert('Account deleted', 'Your account and backend data were deleted, then you were signed out.');
      onDeleted?.();
    } catch (error: any) {
      Alert.alert('Delete account', error?.message || 'Could not start deletion.');
    } finally {
      setDeletionSubmitting(false);
    }
  };

  const handleSubmitReport = async () => {
    if (!userId) {
      Alert.alert('Report', 'Please sign in first.');
      return;
    }
    if (!reportTargetId.trim() || !reportTargetUserId.trim()) {
      Alert.alert('Report', 'Enter the content ID and creator ID.');
      return;
    }

    setReportSubmitting(true);
    try {
      await saveReportDraft({
        contentType: reportContentType,
        contentId: reportTargetId.trim(),
        targetUserId: reportTargetUserId.trim(),
        reporterUserId: userId,
        reason: reportReason,
        details: reportDetails.trim() || undefined,
      });
      setReportSuccess('Report queued for review within 24 hours.');
      Alert.alert('Report submitted', 'Your report was saved and queued for review.');
      setReportDetails('');
      setReportTargetId('');
      setReportTargetUserId('');
    } catch (error: any) {
      Alert.alert('Report', error?.message || 'Could not submit the report.');
    } finally {
      setReportSubmitting(false);
    }
  };

  const handleUnblock = async (blockedUserId: string) => {
    await unblockUser(blockedUserId);
    setBlockedUsers((current: string[]) => current.filter((id: string) => id !== blockedUserId));
  };

  return (
    <View style={styles.wrapper}>
      <TouchableOpacity style={styles.termsRow} onPress={handleAcceptCommunityTerms} activeOpacity={0.85}>
        <Ionicons
          name={communityTermsAccepted ? 'checkbox' : 'square-outline'}
          size={20}
          color={communityTermsAccepted ? colors.tapIn : colors.textSecondary}
        />
        <Text style={styles.termsText}>
          {communityTermsAccepted ? 'Community terms accepted' : 'Accept community terms'}
        </Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Community safety</Text>
        <Text style={styles.cardText}>Users can report objectionable content and block abusive accounts.</Text>
        <Text style={styles.cardMeta}>Blocked users: {blockedUsersCount}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Report content</Text>
        <Text style={styles.cardText}>Submit the content ID and creator ID so the team can review it within 24 hours.</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reasonRow}>
          {REPORT_REASONS.map((reason) => (
            <TouchableOpacity
              key={reason}
              style={[styles.reasonPill, reportReason === reason && styles.reasonPillActive]}
              onPress={() => setReportReason(reason)}
            >
              <Text style={[styles.reasonText, reportReason === reason && styles.reasonTextActive]}>{reason}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TextInput
          style={styles.input}
          value={reportTargetId}
          onChangeText={setReportTargetId}
          placeholder="Content ID"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={reportTargetUserId}
          onChangeText={setReportTargetUserId}
          placeholder="Creator user ID"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
        />
        <TextInput
          style={[styles.input, styles.textArea]}
          value={reportDetails}
          onChangeText={setReportDetails}
          placeholder="Details"
          placeholderTextColor={colors.textTertiary}
          multiline
        />
        <TouchableOpacity style={styles.primaryBtn} onPress={handleSubmitReport} disabled={reportSubmitting}>
          {reportSubmitting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.primaryBtnText}>Submit report</Text>}
        </TouchableOpacity>
        {reportSuccess ? <Text style={styles.successText}>{reportSuccess}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Blocked users</Text>
        <Text style={styles.cardText}>Blocked accounts are removed instantly from your feed on this device.</Text>
        {blockedUsers.length === 0 ? (
          <Text style={styles.cardMeta}>No blocked users</Text>
        ) : (
          blockedUsers.map((blockedUserId: string) => (
            <View key={blockedUserId} style={styles.blockedRow}>
              <Text style={styles.blockedText} numberOfLines={1}>{blockedUserId}</Text>
              <TouchableOpacity onPress={() => handleUnblock(blockedUserId)}>
                <Text style={styles.unblockText}>Unblock</Text>
              </TouchableOpacity>
            </View>
          ))
        )}
      </View>

      <TouchableOpacity style={styles.deleteBtn} onPress={() => setShowDeletionModal(true)}>
        <Ionicons name="trash-outline" size={20} color={colors.error} />
        <Text style={styles.deleteText}>Delete account</Text>
      </TouchableOpacity>

      <Modal visible={showDeletionModal} transparent animationType="slide" onRequestClose={() => setShowDeletionModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Delete account</Text>
              <TouchableOpacity onPress={() => setShowDeletionModal(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>
            <Text style={styles.modalDesc}>
              Type DELETE to confirm permanent account deletion. There is no tolerance for objectionable content or abusive users. If you need help, email {getSupportEmail()}.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={deletionConfirmText}
              onChangeText={setDeletionConfirmText}
              placeholder="DELETE"
              placeholderTextColor={colors.textTertiary}
              autoCapitalize="characters"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setShowDeletionModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmitBtn, deletionSubmitting && { opacity: 0.6 }]}
                onPress={handleRequestAccountDeletion}
                disabled={deletionSubmitting}
              >
                {deletionSubmitting ? <ActivityIndicator size="small" color="#FFF" /> : <Text style={styles.modalSubmitText}>Delete</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    gap: spacing.sm,
  },
  termsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: borderRadius.lg,
  },
  termsText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: 8,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  cardText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  cardMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  reasonRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.sm,
  },
  reasonPill: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  reasonPillActive: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  reasonText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  reasonTextActive: {
    color: colors.textInverse,
  },
  input: {
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
    marginBottom: spacing.sm,
  },
  textArea: {
    minHeight: 90,
  },
  primaryBtn: {
    backgroundColor: colors.tapIn,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  successText: {
    color: colors.success,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  blockedText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    flex: 1,
  },
  unblockText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  deleteText: {
    color: colors.error,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.xl,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  modalTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  modalDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
    marginBottom: spacing.lg,
  },
  modalInput: {
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
    marginBottom: spacing.lg,
  },
  modalActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  modalCancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
  },
  modalCancelText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  modalSubmitBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
    alignItems: 'center',
  },
  modalSubmitText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
});