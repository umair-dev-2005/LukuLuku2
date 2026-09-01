import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';

interface AuthPromptModalProps {
  visible: boolean;
  hasAccount: boolean; // true = user has an account but is logged out, false = no account exists at all
  onSignIn: () => void;
  onSignUp: () => void;
  onClose: () => void;
}

export default function AuthPromptModal({ visible, hasAccount, onSignIn, onSignUp, onClose }: AuthPromptModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>
            {hasAccount ? 'Sign in to continue' : 'Create an account to continue'}
          </Text>
          <Text style={styles.message}>
            {hasAccount
              ? 'Please sign in to your account to perform this action.'
              : 'You need an account to perform this action. It only takes a moment.'}
          </Text>

          <TouchableOpacity style={styles.primaryBtn} onPress={onSignIn}>
            <Text style={styles.primaryBtnText}>Sign In</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={onSignUp}>
            <Text style={styles.secondaryBtnText}>Sign Up</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    backgroundColor: colors.background,
    borderRadius: borderRadius.lg,
    padding: spacing.xl,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  message: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  primaryBtnText: {
    color: colors.textInverse,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  secondaryBtnText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  cancelBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
});