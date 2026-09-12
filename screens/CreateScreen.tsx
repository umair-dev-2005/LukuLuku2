import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';

interface CreateScreenProps {
  onBack: () => void;
  onCreateVideo?: () => void;
  onCreateMomenti?: () => void;
  onCreatePost?: () => void;
  onGoLive?: () => void;
  onAdvertise?: () => void;
}

const CREATE_OPTIONS = [
  {
    key: 'uploadVideo' as const,
    icon: 'videocam' as const,
    labelKey: 'create.uploadVideo' as const,
    descKey: 'create.uploadVideoDesc' as const,
    color: colors.primary,
  },
  {
    key: 'createMomenti' as const,
    icon: 'flash' as const,
    labelKey: 'create.createMomenti' as const,
    descKey: 'create.createMomentiDesc' as const,
    color: '#FF9500',
  },
  {
    key: 'communityPost' as const,
    icon: 'chatbubble-ellipses' as const,
    labelKey: 'create.communityPost' as const,
    descKey: 'create.communityPostDesc' as const,
    color: '#5856D6',
  },
  {
    key: 'goLive' as const,
    icon: 'radio' as const,
    labelKey: 'create.goLive' as const,
    descKey: 'create.goLiveDesc' as const,
    color: colors.tapIn,
  },
  {
    key: 'advertise' as const,
    icon: 'megaphone' as const,
    labelKey: 'create.advertise' as const,
    descKey: 'create.advertiseDesc' as const,
    color: colors.tapIn,
  },
];

export default function CreateScreen({ onBack, onCreateVideo, onCreateMomenti, onCreatePost, onGoLive, onAdvertise }: CreateScreenProps) {
  const insets = useSafeAreaInsets();

  const handleOptionPress = (key: typeof CREATE_OPTIONS[number]['key']) => {
    if (key === 'uploadVideo') {
      onCreateVideo?.();
      return;
    }
    if (key === 'createMomenti') {
      onCreateMomenti?.();
      return;
    }
    if (key === 'communityPost') {
      onCreatePost?.();
      return;
    }
    if (key === 'goLive') {
      onGoLive?.();
      return;
    }
    onAdvertise?.();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.closeBtn}>
          <Ionicons name="close" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('create.title')}</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Options */}
      <View style={styles.optionsContainer}>
        {CREATE_OPTIONS.map((option) => (
          <TouchableOpacity
            key={option.key}
            style={styles.optionCard}
            onPress={() => handleOptionPress(option.key)}
            activeOpacity={0.7}
          >
            <View style={[styles.optionIcon, { backgroundColor: option.color + '15' }]}>
              <Ionicons name={option.icon} size={28} color={option.color} />
            </View>
            <View style={styles.optionText}>
              <Text style={styles.optionLabel}>{t(option.labelKey as any)}</Text>
              <Text style={styles.optionDesc}>{t(option.descKey as any)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textTertiary} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  closeBtn: {
    padding: spacing.sm,
  },
  headerTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
  },
  optionsContainer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
    gap: spacing.md,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  optionIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionText: {
    flex: 1,
  },
  optionLabel: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  optionDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
});