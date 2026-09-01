import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../lib/theme';

// Badge config per verification_type
const BADGE_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  music: { icon: 'musical-notes', color: '#FFD700' },
  film: { icon: 'film-outline', color: '#FFD700' },
  default: { icon: 'checkmark-circle', color: '#FFD700' },
  none: { icon: 'checkmark-circle', color: '#FFD700' },
};

interface VerifiedBadgeProps {
  isVerified: boolean;
  verificationType?: string | null;
  size?: number;
}

export default function VerifiedBadge({ isVerified, verificationType, size = 16 }: VerifiedBadgeProps) {
  if (!isVerified) return null;

  const config = BADGE_CONFIG[verificationType || ''] || BADGE_CONFIG.default;

  return (
    <Ionicons name={config.icon} size={size} color={config.color} />
  );
}