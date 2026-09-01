import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatTimeAgo } from '../lib/utils';
import { supabase, Video } from '../lib/supabase';
import { t } from '../lib/i18n';
import { getCurrentSupabaseUserId } from '../lib/auth';
import RankAuraAvatar from '../components/RankAuraAvatar';

interface NotificationsScreenProps {
  onBack: () => void;
  onVideoPress: (video: Video) => void;
  onPostPress: (postId: string) => void;
}

interface NotificationItem {
  id: string;
  type: 'video_like' | 'post_like' | 'video_comment' | 'post_comment' | 'reply' | 'tapin';
  actorName: string;
  actorAvatar: string | null;
  description: string;
  targetTitle: string;
  targetId: string;
  targetKind: 'video' | 'post';
  created_at: string;
  read: boolean;
}

export default function NotificationsScreen({ onBack, onVideoPress, onPostPress }: NotificationsScreenProps) {
  const insets = useSafeAreaInsets();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    getCurrentSupabaseUserId().then((id) => {
      if (id) setCurrentUserId(id);
    });
  }, []);

  const fetchNotifications = useCallback(async () => {
    // Build a combined activity feed
    // Since the notifications table may be empty, we'll aggregate from multiple sources
    const items: NotificationItem[] = [];

    // 1. Fetch from notifications table first (if user is logged in)
    if (currentUserId) {
      const { data: notifs } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', currentUserId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (notifs && notifs.length > 0) {
        // Fetch actor profiles
        const actorIds = [...new Set(notifs.map((n: any) => n.actor_id).filter(Boolean))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, display_name, avatar_url')
          .in('user_id', actorIds);

        const profileMap = new Map<string, any>();
        profiles?.forEach((p: any) => profileMap.set(p.user_id, p));

        // Fetch video titles
        const videoIds = [...new Set(notifs.map((n: any) => n.video_id).filter(Boolean))];
        const postIds = [...new Set(notifs.map((n: any) => n.post_id).filter(Boolean))];
        let videoMap = new Map<string, string>();
        let postMap = new Map<string, string>();
        if (videoIds.length > 0) {
          const { data: videos } = await supabase
            .from('videos')
            .select('id, title')
            .in('id', videoIds);
          videos?.forEach((v: any) => videoMap.set(v.id, v.title));
        }
        if (postIds.length > 0) {
          const { data: posts } = await supabase
            .from('community_posts')
            .select('id, content')
            .in('id', postIds);
          posts?.forEach((p: any) => postMap.set(p.id, p.content));
        }

        notifs.forEach((n: any) => {
          const actor = profileMap.get(n.actor_id);
          let desc = '';
          let type: NotificationItem['type'] = 'video_like';

          switch (n.type) {
            case 'like':
              desc = t('notifications.likedVideo');
              type = 'video_like';
              break;
            case 'comment':
              desc = t('notifications.commentedVideo');
              type = 'video_comment';
              break;
            case 'reply':
              desc = t('notifications.repliedComment');
              type = 'reply';
              break;
            case 'tapin':
              desc = t('notifications.newTapIn');
              type = 'tapin';
              break;
            case 'post_like':
              desc = t('notifications.likedPost');
              type = 'post_like';
              break;
            case 'post_comment':
              desc = t('notifications.commentedPost');
              type = 'post_comment';
              break;
            default:
              desc = n.type;
          }

          const isPostTarget = !!n.post_id || n.type === 'post_like' || n.type === 'post_comment';
          items.push({
            id: n.id,
            type,
            actorName: actor?.display_name || 'Iemand',
            actorAvatar: actor?.avatar_url || null,
            description: desc,
            targetTitle: n.post_id ? (postMap.get(n.post_id) || '') : (videoMap.get(n.video_id) || ''),
            targetId: n.post_id || n.video_id || '',
            targetKind: isPostTarget ? 'post' : 'video',
            created_at: n.created_at,
            read: n.read || false,
          });
        });
      }
    }

    // 2. If no notifications from table, build from recent activity on all content
    // This provides a discovery feed showing recent likes/comments across the platform
    if (items.length === 0) {
      // Recent video likes
      const { data: recentVideoLikes } = await supabase
        .from('video_likes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(15);

      // Recent post likes
      const { data: recentPostLikes } = await supabase
        .from('post_likes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10);

      // Recent comments
      const { data: recentComments } = await supabase
        .from('comments')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(15);

      // Gather all user IDs for profile lookups
      const allUserIds = new Set<string>();
      recentVideoLikes?.forEach((l: any) => allUserIds.add(l.user_id));
      recentPostLikes?.forEach((l: any) => allUserIds.add(l.user_id));
      recentComments?.forEach((c: any) => allUserIds.add(c.user_id));

      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, display_name, avatar_url')
        .in('user_id', [...allUserIds]);

      const profileMap = new Map<string, any>();
      profiles?.forEach((p: any) => profileMap.set(p.user_id, p));

      // Gather video IDs for title lookups
      const videoIds = new Set<string>();
      const postIds = new Set<string>();
      recentVideoLikes?.forEach((l: any) => videoIds.add(l.video_id));
      recentComments?.forEach((c: any) => {
        if (c.video_id) videoIds.add(c.video_id);
        if (c.post_id) postIds.add(c.post_id);
      });
      recentPostLikes?.forEach((l: any) => postIds.add(l.post_id));

      let videoMap = new Map<string, any>();
      let postMap = new Map<string, any>();
      if (videoIds.size > 0) {
        const { data: videos } = await supabase
          .from('videos')
          .select('id, title')
          .in('id', [...videoIds]);
        videos?.forEach((v: any) => videoMap.set(v.id, v));
      }
      if (postIds.size > 0) {
        const { data: posts } = await supabase
          .from('community_posts')
          .select('id, content')
          .in('id', [...postIds]);
        posts?.forEach((p: any) => postMap.set(p.id, p));
      }

      // Video likes
      recentVideoLikes?.forEach((l: any) => {
        const actor = profileMap.get(l.user_id);
        const video = videoMap.get(l.video_id);
        items.push({
          id: `vl_${l.id}`,
          type: 'video_like',
          actorName: actor?.display_name || 'Iemand',
          actorAvatar: actor?.avatar_url || null,
          description: t('notifications.likedVideo'),
          targetTitle: video?.title || '',
          targetId: l.video_id,
          targetKind: 'video',
          created_at: l.created_at,
          read: true,
        });
      });

      // Post likes
      recentPostLikes?.forEach((l: any) => {
        const actor = profileMap.get(l.user_id);
        items.push({
          id: `pl_${l.id}`,
          type: 'post_like',
          actorName: actor?.display_name || 'Iemand',
          actorAvatar: actor?.avatar_url || null,
          description: t('notifications.likedPost'),
          targetTitle: postMap.get(l.post_id)?.content || '',
          targetId: l.post_id,
          targetKind: 'post',
          created_at: l.created_at,
          read: true,
        });
      });

      // Comments
      recentComments?.forEach((c: any) => {
        const actor = profileMap.get(c.user_id);
        const isPostComment = !!c.post_id;
        const isReply = !!c.parent_id;
        const video = c.video_id ? videoMap.get(c.video_id) : null;
        const post = c.post_id ? postMap.get(c.post_id) : null;
        items.push({
          id: `cm_${c.id}`,
          type: isReply ? 'reply' : isPostComment ? 'post_comment' : 'video_comment',
          actorName: actor?.display_name || 'Iemand',
          actorAvatar: actor?.avatar_url || null,
          description: isReply
            ? t('notifications.repliedComment')
            : isPostComment
            ? t('notifications.commentedPost')
            : t('notifications.commentedVideo'),
          targetTitle: post?.content || video?.title || c.content?.substring(0, 40) || '',
          targetId: c.post_id || c.video_id || '',
          targetKind: isPostComment ? 'post' : 'video',
          created_at: c.created_at,
          read: true,
        });
      });

      // Sort by date
      items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }

    setNotifications(items);
    setLoading(false);
    setRefreshing(false);
  }, [currentUserId]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchNotifications();
  }, [fetchNotifications]);

  const getIcon = (type: NotificationItem['type']): { name: string; color: string } => {
    switch (type) {
      case 'video_like':
      case 'post_like':
        return { name: 'heart', color: colors.primary };
      case 'video_comment':
      case 'post_comment':
        return { name: 'chatbubble', color: colors.tapIn };
      case 'reply':
        return { name: 'return-down-forward', color: '#5856D6' };
      case 'tapin':
        return { name: 'person-add', color: '#34C759' };
      default:
        return { name: 'notifications', color: colors.text };
    }
  };

  const handlePress = async (item: NotificationItem) => {
    if (item.targetKind === 'post' || item.type === 'post_like' || item.type === 'post_comment') {
      onPostPress(item.targetId);
    } else if (item.targetId) {
      const { data: video } = await supabase
        .from('videos')
        .select('*')
        .eq('id', item.targetId)
        .single();
      if (video) onVideoPress(video);
    }
  };

  const renderItem = ({ item }: { item: NotificationItem }) => {
    const icon = getIcon(item.type);
    return (
      <TouchableOpacity
        style={[styles.notifItem, !item.read && styles.notifUnread]}
        onPress={() => handlePress(item)}
        activeOpacity={0.7}
      >
        {/* Avatar with icon overlay */}
        <View style={styles.avatarContainer}>
          <RankAuraAvatar
            uri={item.actorAvatar}
            size={44}
            fallbackLabel={item.actorName}
          />
          <View style={[styles.iconBadge, { backgroundColor: icon.color }]}>
            <Ionicons name={icon.name as any} size={10} color="#FFF" />
          </View>
        </View>

        <View style={styles.notifContent}>
          <Text style={styles.notifText} numberOfLines={2}>
            <Text style={styles.notifActor}>{item.actorName}</Text>
            {' '}{item.description}
          </Text>
          {item.targetTitle ? (
            <Text style={styles.notifTarget} numberOfLines={1}>{item.targetTitle}</Text>
          ) : null}
          <Text style={styles.notifTime}>{formatTimeAgo(item.created_at)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('notifications.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="notifications-off-outline" size={64} color={colors.textTertiary} />
          <Text style={styles.emptyTitle}>{t('notifications.empty')}</Text>
          <Text style={styles.emptyDesc}>{t('notifications.emptyDesc')}</Text>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item: NotificationItem) => item.id}
          renderItem={renderItem}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xxl },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: { padding: spacing.sm },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  list: { paddingBottom: 100 },
  notifItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  notifUnread: {
    backgroundColor: 'rgba(88, 86, 214, 0.06)',
  },
  avatarContainer: {
    position: 'relative',
  },
  notifAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: colors.background,
  },
  notifContent: { flex: 1 },
  notifText: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
  notifActor: {
    fontWeight: '700',
  },
  notifTarget: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  notifTime: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 4,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    marginTop: spacing.lg,
  },
  emptyDesc: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
});