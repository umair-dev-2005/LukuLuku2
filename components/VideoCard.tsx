import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions } from 'react-native';
import { Image } from './AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews, formatTimeAgo, formatDuration } from '../lib/utils';
import { supabase, Video, Channel } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from './VerifiedBadge';

const { width } = Dimensions.get('window');
const channelCache = new Map<string, Channel | null>();
const verificationCache = new Map<string, { isVerified: boolean; verificationType: string | null }>();

interface VideoCardProps {
  video: Video;
  onPress: (video: Video) => void;
  onChannelPress?: (channelId: string) => void;
}

export default function VideoCard({ video, onPress, onChannelPress }: VideoCardProps) {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [verificationType, setVerificationType] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const cachedChannel = channelCache.get(video.channel_id);
    if (cachedChannel !== undefined) {
      setChannel(cachedChannel);
      if (cachedChannel?.user_id) {
        const cachedVerification = verificationCache.get(cachedChannel.user_id);
        if (cachedVerification) {
          setIsVerified(cachedVerification.isVerified);
          setVerificationType(cachedVerification.verificationType);
        }
      }
      return () => {
        cancelled = true;
      };
    }

    supabase
      .from('channels')
      .select('*')
      .eq('id', video.channel_id)
      .single()
      .then(({ data }: { data: Channel | null }) => {
        if (cancelled) return;
        channelCache.set(video.channel_id, data || null);
        setChannel(data);
        if (data?.user_id) {
          const cachedVerification = verificationCache.get(data.user_id);
          if (cachedVerification) {
            setIsVerified(cachedVerification.isVerified);
            setVerificationType(cachedVerification.verificationType);
            return;
          }
          supabase
            .from('profiles')
            .select('is_verified, verification_type')
            .eq('user_id', data.user_id)
            .single()
            .then(({ data: profile }: { data: { is_verified?: boolean; verification_type?: string | null } | null }) => {
              if (cancelled) return;
              const nextVerification = {
                isVerified: !!profile?.is_verified,
                verificationType: profile?.verification_type || null,
              };
              verificationCache.set(data.user_id, nextVerification);
              if (profile?.is_verified) {
                setIsVerified(true);
                setVerificationType(profile.verification_type || null);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) {
          channelCache.set(video.channel_id, null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [video.channel_id]);

  const durationText = formatDuration(video.duration);

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={() => onPress(video)}
      activeOpacity={0.9}
    >
      {/* Thumbnail */}
      <View style={styles.thumbnailContainer}>
        {video.thumbnail_url ? (
          <Image
            source={{ uri: video.thumbnail_url }}
            style={styles.thumbnail}
            contentFit="cover"
            transition={0}
            cachePolicy="memory-disk"
          />
        ) : (
          <View style={[styles.thumbnail, styles.placeholderThumb]}>
            <Ionicons name="play-circle" size={48} color={colors.textTertiary} />
          </View>
        )}
        {durationText ? (
          <View style={styles.durationBadge}>
            <Text style={styles.durationBadgeText}>{durationText}</Text>
          </View>
        ) : null}
      </View>

      {/* Info */}
      <View style={styles.info}>
        <TouchableOpacity
          onPress={() => onChannelPress?.(video.channel_id)}
          style={styles.avatarContainer}
        >
          {channel?.avatar_url ? (
            <Image
              source={{ uri: channel.avatar_url }}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={0}
            />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={16} color={colors.textTertiary} />
            </View>
          )}
        </TouchableOpacity>

        <View style={styles.textContainer}>
          <Text style={styles.title} numberOfLines={2}>
            {video.title}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.metaChannelName} numberOfLines={1}>
              {channel?.name || ''}
            </Text>
            <VerifiedBadge isVerified={isVerified} verificationType={verificationType} size={14} />
            <Text style={styles.meta}>
              | {formatViews(video.views)} {t('video.views')} | {formatTimeAgo(video.created_at)}
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.lg,
  },
  thumbnailContainer: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: colors.surface,
    position: 'relative',
  },
  thumbnail: {
    width: '100%',
    height: '100%',
  },
  placeholderThumb: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  durationBadge: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.75)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.sm,
  },
  durationBadgeText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  info: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  avatarContainer: {
    marginRight: spacing.md,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textContainer: {
    flex: 1,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
    lineHeight: 20,
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'nowrap',
  },
  metaChannelName: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '500',
    flexShrink: 1,
  },
  meta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 16,
    flexShrink: 0,
  },
});