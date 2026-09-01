import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Share,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatTimeAgo } from '../lib/utils';
import { supabase, CommunityPost, Comment, Channel, Profile, ContentClaim, insertNotification } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';
import { ensureSupabaseProfile, getCurrentSupabaseUserId } from '../lib/auth';
import LinkedText from '../components/LinkedText';
import AuthPromptModal from '../components/AuthPromptModal';
import { blockUser, loadBlockedUserIds, saveReportDraft, subscribeCommunitySafetyChanges } from '../lib/communitySafety';
import RankAuraAvatar from '../components/RankAuraAvatar';
import { useRankBadges, getAvatarBadge } from '../hooks/useRankBadges';

declare const require: any;

interface BangiPostScreenProps {
  postId: string;
  onBack: () => void;
  onHomePress?: () => void;
  onChannelPress: (channelId: string) => void;
  onPostPress?: (postId: string) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}

interface CommentWithProfile extends Comment {
  profile?: {
    display_name: string;
    avatar_url: string | null;
    is_verified: boolean;
    verification_type: string;
  };
  replies?: CommentWithProfile[];
}

interface BangiPostPreview extends CommunityPost {
  channelName?: string;
  channelAvatar?: string;
  channelId?: string;
  isVerified?: boolean;
  verificationType?: string | null;
  commentCount?: number;
  likeCount?: number;
}

function countCommentTree(comments: CommentWithProfile[]): number {
  return comments.reduce(
    (total: number, comment: CommentWithProfile) => total + 1 + countCommentTree(comment.replies || []),
    0
  );
}

export default function BangiPostScreen({ postId, onBack, onHomePress, onChannelPress, onPostPress, onSignIn, onSignUp }: BangiPostScreenProps) {
  const [authPromptVisible, setAuthPromptVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [comments, setComments] = useState<CommentWithProfile[]>([]);
  const [relatedPosts, setRelatedPosts] = useState<BangiPostPreview[]>([]);
  const [trendingPosts, setTrendingPosts] = useState<BangiPostPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [contentClaim, setContentClaim] = useState<ContentClaim | null>(null);
  const [contentClaimantName, setContentClaimantName] = useState<string | null>(null);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [showSafetyMenu, setShowSafetyMenu] = useState(false);
  const [safetyPrompt, setSafetyPrompt] = useState<{
    kind: 'post' | 'comment';
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const { badgeByUserId, badgeByChannelId } = useRankBadges();

  const resolveActiveUserId = useCallback(async () => {
    const activeUserId = currentUserId || (await getCurrentSupabaseUserId()) || (await ensureSupabaseProfile());
    if (activeUserId && activeUserId !== currentUserId) {
      setCurrentUserId(activeUserId);
    }
    return activeUserId;
  }, [currentUserId]);

  useEffect(() => {
    const syncCurrentUser = async () => {
      const id = await getCurrentSupabaseUserId();
      setCurrentUserId(id);
    };

    syncCurrentUser();
  }, []);

  useEffect(() => {
    void loadBlockedUserIds().then(setBlockedUserIds);
    return subscribeCommunitySafetyChanges(() => {
      void loadBlockedUserIds().then(setBlockedUserIds);
    });
  }, []);

  useEffect(() => {
    const loadContentClaim = async () => {
      const { data: claim } = await supabase
        .from('content_claims')
        .select('id, claimant_user_id, video_id, claim_status, created_at, updated_at')
        .eq('video_id', post?.video_id || '')
        .maybeSingle();

      if (!claim) {
        setContentClaim(null);
        setContentClaimantName(null);
        return;
      }

      setContentClaim(claim as ContentClaim);
      const { data: claimantProfile } = await supabase
        .from('profiles')
        .select('display_name, username')
        .eq('user_id', claim.claimant_user_id)
        .maybeSingle();
      setContentClaimantName(claimantProfile?.display_name || claimantProfile?.username || null);
    };

    if (post?.video_id) {
      loadContentClaim();
    }
  }, [post?.video_id]);

  const fetchComments = useCallback(async () => {
    const { data: allComments } = await supabase
      .from('comments')
      .select('*')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });

    if (!allComments || allComments.length === 0) {
      setComments([]);
      return;
    }

    const filteredComments = allComments.filter((comment: Comment) => !blockedUserIds.includes(comment.user_id));
    const userIds = [...new Set(filteredComments.map((c: Comment) => c.user_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, display_name, avatar_url, is_verified, verification_type')
      .in('user_id', userIds);

    const profileMap = new Map<string, Profile>();
    profiles?.forEach((p: Profile) => profileMap.set(p.user_id, p));

    const commentMap = new Map<string, CommentWithProfile>();
    const topLevel: CommentWithProfile[] = [];

    filteredComments.forEach((c: Comment) => {
      const matchedProfile = profileMap.get(c.user_id);
      const enhanced: CommentWithProfile = {
        ...c,
        profile: matchedProfile
          ? {
              display_name: matchedProfile.display_name,
              avatar_url: matchedProfile.avatar_url,
              is_verified: matchedProfile.is_verified,
              verification_type: matchedProfile.verification_type,
            }
          : undefined,
        replies: [],
      };
      commentMap.set(c.id, enhanced);
    });

    filteredComments.forEach((c: Comment) => {
      const enhanced = commentMap.get(c.id)!;
      if (c.parent_id && commentMap.has(c.parent_id)) {
        commentMap.get(c.parent_id)!.replies!.push(enhanced);
      } else {
        topLevel.push(enhanced);
      }
    });

    setComments(topLevel);
  }, [blockedUserIds, postId]);

  const fetchPost = useCallback(async () => {
    const { data: postData } = await supabase
      .from('community_posts')
      .select('*')
      .eq('id', postId)
      .single();

    if (!postData) {
      setLoading(false);
      return;
    }

    let resolvedPost: CommunityPost = postData;
    if (!resolvedPost.image_url && resolvedPost.video_id) {
      const { data: videoData } = await supabase
        .from('videos')
        .select('thumbnail_url')
        .eq('id', resolvedPost.video_id)
        .maybeSingle();

      if (videoData?.thumbnail_url) {
        resolvedPost = {
          ...resolvedPost,
          image_url: videoData.thumbnail_url,
        };
      }
    }

    setPost(resolvedPost);
    setLikeCount(resolvedPost.likes || 0);

    const { data: ch } = await supabase
      .from('channels')
      .select('*')
      .eq('id', resolvedPost.channel_id)
      .single();
    if (ch) {
      setChannel(ch);
      const { data: prof } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', ch.user_id)
        .single();
      if (prof) setProfile(prof);
    }

    if (currentUserId) {
      const { data: likeData } = await supabase
        .from('post_likes')
        .select('id')
        .eq('post_id', postId)
        .eq('user_id', currentUserId)
        .maybeSingle();
      if (likeData) setLiked(true);

      const { data: likeRows } = await supabase
        .from('post_likes')
        .select('id')
        .eq('post_id', postId);
      setLikeCount(likeRows?.length || resolvedPost.likes || 0);
    }

    const { data: relatedData } = await supabase
      .from('community_posts')
      .select('*, channels(id, name, avatar_url, user_id), videos(id, title, thumbnail_url, views, channel_id)')
      .neq('id', postId)
      .order('created_at', { ascending: false })
      .limit(20);

    const { data: trendingData } = await supabase
      .from('community_posts')
      .select('*, channels(id, name, avatar_url, user_id), videos(id, title, thumbnail_url, views, channel_id)')
      .neq('id', postId)
      .order('likes', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(20);

    const enrichPosts = async (postsData: any[] | null | undefined): Promise<BangiPostPreview[]> => {
      const source = (postsData || []) as any[];
      if (source.length === 0) return [];

      const channelIds = [...new Set(source.map((item) => item.channel_id).filter(Boolean))];
      const { data: channels } = await supabase
        .from('channels')
        .select('id, name, avatar_url, user_id')
        .in('id', channelIds);
      const channelMap = new Map<string, Channel>();
      channels?.forEach((item: Channel) => channelMap.set(item.id, item));

      const userIds = [...new Set(source.map((item) => item.user_id).filter(Boolean))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, is_verified, verification_type')
        .in('user_id', userIds);
      const verifiedMap = new Map<string, { isVerified: boolean; verificationType: string | null }>();
      profiles?.forEach((item: { user_id: string; is_verified: boolean; verification_type: string | null }) => {
        if (item.is_verified) verifiedMap.set(item.user_id, { isVerified: true, verificationType: item.verification_type });
      });

      const postIds = source.map((item) => item.id);
      const [commentCountsRes, likeCountsRes] = await Promise.all([
        supabase.from('comments').select('post_id').in('post_id', postIds),
        supabase.from('post_likes').select('post_id').in('post_id', postIds),
      ]);

      const commentCountMap = new Map<string, number>();
      commentCountsRes.data?.forEach((comment: { post_id: string }) => {
        commentCountMap.set(comment.post_id, (commentCountMap.get(comment.post_id) || 0) + 1);
      });

      const likeCountMap = new Map<string, number>();
      likeCountsRes.data?.forEach((like: { post_id: string }) => {
        likeCountMap.set(like.post_id, (likeCountMap.get(like.post_id) || 0) + 1);
      });

      const videoIds = source.filter((item) => item.video_id && !item.image_url).map((item) => item.video_id as string);
      const videoThumbMap = new Map<string, string>();
      if (videoIds.length > 0) {
        const { data: videoData } = await supabase
          .from('videos')
          .select('id, thumbnail_url')
          .in('id', videoIds);
        videoData?.forEach((video: { id: string; thumbnail_url: string | null }) => {
          if (video.thumbnail_url) videoThumbMap.set(video.id, video.thumbnail_url);
        });
      }

      return source.map((item) => {
        const ch = channelMap.get(item.channel_id);
        return {
          ...item,
          image_url: item.image_url || (item.video_id ? videoThumbMap.get(item.video_id) : null) || null,
          channelName: ch?.name,
          channelAvatar: ch?.avatar_url || undefined,
          channelId: ch?.id,
          isVerified: verifiedMap.get(item.user_id)?.isVerified || false,
          verificationType: verifiedMap.get(item.user_id)?.verificationType || null,
          commentCount: commentCountMap.get(item.id) || 0,
          likeCount: likeCountMap.get(item.id) || item.likes || 0,
        } as BangiPostPreview;
      });
    };

    const [enrichedRelated, enrichedTrending] = await Promise.all([
      enrichPosts(relatedData),
      enrichPosts(trendingData),
    ]);

    setRelatedPosts(enrichedRelated);
    setTrendingPosts(enrichedTrending);

    await fetchComments();
    setLoading(false);
  }, [postId, currentUserId, fetchComments]);

  useEffect(() => {
    fetchPost();
  }, [fetchPost]);

   const handleLike = async () => {
      const activeUserId = await resolveActiveUserId();
      if (!activeUserId) {
        setAuthPromptVisible(true);
        return;
      }
    if (liked) {
      await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', postId)
        .eq('user_id', activeUserId);
      setLiked(false);
      setLikeCount((c: number) => Math.max(0, c - 1));
    } else {
      await supabase
        .from('post_likes')
        .insert({ post_id: postId, user_id: activeUserId });
      setLiked(true);
      setLikeCount((c: number) => c + 1);
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${post?.content || ''}\nhttps://lukuluku.online/post/${postId}`,
      });
    } catch (error) {
      console.warn('Share failed:', error);
    }
  };

  const handleDeletePost = () => {
    if (!post || post.user_id !== currentUserId) return;

    Alert.alert(
      'Post verwijderen',
      'Weet je zeker dat je deze Bangi-post wilt verwijderen? Deze actie kan niet ongedaan worden gemaakt.',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Verwijderen',
          style: 'destructive',
          onPress: async () => {
            const activeUserId = await resolveActiveUserId();
            if (!activeUserId || post.user_id !== activeUserId) {
              Alert.alert('Fout', 'Je kunt alleen je eigen post verwijderen.');
              return;
            }

            setSubmitting(true);
            const { error: commentsError } = await supabase.from('comments').delete().eq('post_id', post.id);
            if (commentsError) {
              setSubmitting(false);
              Alert.alert('Fout', commentsError.message);
              return;
            }

            const { error: likesError } = await supabase.from('post_likes').delete().eq('post_id', post.id);
            if (likesError) {
              setSubmitting(false);
              Alert.alert('Fout', likesError.message);
              return;
            }

            const { error: postError } = await supabase.from('community_posts').delete().eq('id', post.id).eq('user_id', activeUserId);
            setSubmitting(false);

            if (postError) {
              Alert.alert('Fout', postError.message);
              return;
            }

            onBack();
          },
        },
      ]
    );
  };

  const handleSubmitComment = async () => {
      const activeUserId = await resolveActiveUserId();
      if (!activeUserId) {
        setAuthPromptVisible(true);
        return;
      }
    const text = commentText.trim();
    if (!text || submitting) return;

    setSubmitting(true);
    const payload: any = {
      post_id: postId,
      user_id: activeUserId,
      content: text,
    };
    if (replyTo) {
      payload.parent_id = replyTo.id;
    }

    const { error } = await supabase.from('comments').insert(payload);
    if (error) {
      Alert.alert('Fout', error.message);
    } else {
      setCommentText('');
      setReplyTo(null);
      await fetchComments();

      if (profile?.user_id && profile.user_id !== activeUserId) {
        await insertNotification({
          user_id: profile.user_id,
          actor_id: activeUserId,
          type: 'post_comment',
          post_id: postId,
        });
      }

      if (replyTo?.id) {
        const { data: parentComment } = await supabase
          .from('comments')
          .select('user_id')
          .eq('id', replyTo.id)
          .maybeSingle();

        if (parentComment?.user_id && parentComment.user_id !== activeUserId) {
          await insertNotification({
            user_id: parentComment.user_id,
            actor_id: activeUserId,
            type: 'reply',
            post_id: postId,
          });
        }
      }
    }
    setSubmitting(false);
  };

  const handleReportPost = async () => {
    if (!post) return;
    const activeUserId = currentUserId || (await getCurrentSupabaseUserId()) || (await ensureSupabaseProfile());
    if (!activeUserId) {
      Alert.alert('Report', 'Please sign in first.');
      return;
    }

    await saveReportDraft({
      contentType: 'post',
      contentId: post.id,
      targetUserId: post.user_id,
      reporterUserId: activeUserId,
      reason: 'Inappropriate content',
      details: post.content,
    });
    await blockUser(post.user_id);
    setBlockedUserIds((current: string[]) => (current.includes(post.user_id) ? current : [...current, post.user_id]));
    Alert.alert('Report submitted', 'The post was reported and the creator was blocked on this device.');
  };

  const handleReportComment = async (comment: CommentWithProfile) => {
    const activeUserId = currentUserId || (await getCurrentSupabaseUserId()) || (await ensureSupabaseProfile());
    if (!activeUserId) {
      Alert.alert('Report', 'Please sign in first.');
      return;
    }

    await saveReportDraft({
      contentType: 'comment',
      contentId: comment.id,
      targetUserId: comment.user_id,
      reporterUserId: activeUserId,
      reason: 'Inappropriate comment',
      details: comment.content,
    });
    await blockUser(comment.user_id);
    setBlockedUserIds((current: string[]) => (current.includes(comment.user_id) ? current : [...current, comment.user_id]));
    Alert.alert('Report submitted', 'The comment was reported and the user was blocked on this device.');
  };

  if (loading) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onHomePress?.()} style={styles.homeBtn} hitSlop={8}>
            <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Bangi</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </View>
    );
  }

  if (!post) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={onBack} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onHomePress?.()} style={styles.homeBtn} hitSlop={8}>
            <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Bangi</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyText}>Post niet gevonden</Text>
        </View>
      </View>
    );
  }

  const totalComments = countCommentTree(comments);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onHomePress?.()} style={styles.homeBtn} hitSlop={8}>
          <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Bangi</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Post author */}
        <TouchableOpacity
          style={styles.authorRow}
          onPress={() => channel && onChannelPress(channel.id)}
        >
          {channel?.avatar_url ? (
            <RankAuraAvatar
              uri={channel.avatar_url}
              size={44}
              badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel.user_id, channel.id)}
              fallbackLabel={channel.name}
            />
          ) : (
            <RankAuraAvatar
              size={44}
              badge={getAvatarBadge(badgeByUserId, badgeByChannelId, channel?.user_id, channel?.id)}
              fallbackLabel={channel?.name || 'U'}
            />
          )}
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={styles.authorName}>{channel?.name || ''}</Text>
              <VerifiedBadge
                isVerified={profile?.is_verified || false}
                verificationType={profile?.verification_type}
                size={16}
              />
            </View>
            <Text style={styles.postTime}>{formatTimeAgo(post.created_at)}</Text>
          </View>
        </TouchableOpacity>

        {contentClaim && (
          <View style={styles.claimBanner}>
            <View style={styles.claimBannerRow}>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.tapIn} />
              <Text style={styles.claimBannerTitle}>Content ID claim</Text>
            </View>
            <Text style={styles.claimBannerText}>
              Status: {contentClaim.claim_status}
              {contentClaimantName ? ` · Claimant: ${contentClaimantName}` : ''}
            </Text>
            <Text style={styles.claimBannerText}>
              Inkomsten-niveau claim.
            </Text>
          </View>
        )}

        {/* Post content */}
        {post.image_url ? (
          <LinkedText style={styles.postContent}>{post.content}</LinkedText>
        ) : (
          <View style={[styles.textOnlyPostCard, { backgroundColor: post.background_color || colors.surface }]}>
            <Text style={[styles.textOnlyPostText, { color: post.text_color || colors.text }]}>
              {post.content}
            </Text>
          </View>
        )}

        {post.poll_question && post.poll_options?.length ? (
          <View style={styles.pollCard}>
            <Text style={styles.pollQuestion}>{post.poll_question}</Text>
            {post.poll_options.map((option: { id: string; label: string; votes: number }) => {
              const totalVotes = post.poll_options?.reduce(
                (sum: number, item: { votes: number }) => sum + item.votes,
                0
              ) || 0;
              const percent = totalVotes > 0 ? Math.round((option.votes / totalVotes) * 100) : 0;
              return (
                <View key={option.id} style={styles.pollOption}>
                  <View style={styles.pollOptionRow}>
                    <Text style={styles.pollOptionLabel}>{option.label}</Text>
                    <Text style={styles.pollOptionVotes}>{percent}%</Text>
                  </View>
                  <View style={styles.pollTrack}>
                    <View style={[styles.pollFill, { width: `${percent}%` }]} />
                  </View>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Post image */}
        {post.image_url && (
          <Image
            source={{ uri: post.image_url }}
            style={styles.postImage}
            contentFit="cover"
            transition={200}
          />
        )}

        {/* Actions */}
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.actionBtn} onPress={handleLike}>
            <Ionicons
              name={liked ? 'heart' : 'heart-outline'}
              size={24}
              color={liked ? colors.primary : colors.text}
            />
            <Text style={[styles.actionText, liked && { color: colors.primary }]}>
              {likeCount}
            </Text>
          </TouchableOpacity>
          <View style={styles.actionBtn}>
            <Ionicons name="chatbubble-outline" size={22} color={colors.text} />
            <Text style={styles.actionText}>{totalComments}</Text>
          </View>
          <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
            <Ionicons name="share-social-outline" size={22} color={colors.text} />
            <Text style={styles.actionText}>{t('video.share')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setShowSafetyMenu((value: boolean) => !value)}>
            <Ionicons name="shield-outline" size={22} color={colors.text} />
            <Text style={styles.actionText}>Safety</Text>
          </TouchableOpacity>
          {post.user_id === currentUserId && (
            <TouchableOpacity style={styles.actionBtn} onPress={handleDeletePost}>
              <Ionicons name="trash-outline" size={22} color={colors.error} />
              <Text style={[styles.actionText, { color: colors.error }]}>Verwijderen</Text>
            </TouchableOpacity>
          )}
        </View>

        {showSafetyMenu && (
          <View style={styles.safetyCard}>
            <TouchableOpacity
              style={styles.safetyAction}
              onPress={() => setSafetyPrompt({
                kind: 'post',
                title: 'Report this content as inappropriate?',
                message: 'Are you sure?',
                onConfirm: handleReportPost,
              })}
            >
              <Ionicons name="flag-outline" size={18} color={colors.tapIn} />
              <Text style={styles.safetyActionText}>Report post</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.safetyAction} onPress={async () => {
              if (!post) return;
              await blockUser(post.user_id);
              setBlockedUserIds((current: string[]) => (current.includes(post.user_id) ? current : [...current, post.user_id]));
              Alert.alert('Blocked', 'This creator is now blocked and hidden from your feed.');
            }}>
              <Ionicons name="ban-outline" size={18} color={colors.error} />
              <Text style={styles.safetyActionText}>Block creator</Text>
            </TouchableOpacity>
          </View>
        )}

        <Modal visible={!!safetyPrompt} transparent animationType="fade" onRequestClose={() => setSafetyPrompt(null)}>
          <View style={styles.confirmOverlay}>
            <View style={styles.confirmCard}>
              <Text style={styles.confirmTitle}>{safetyPrompt?.title || 'Report this content as inappropriate?'}</Text>
              <Text style={styles.confirmMessage}>{safetyPrompt?.message || 'Are you sure?'}</Text>
              <View style={styles.confirmActions}>
                <TouchableOpacity style={styles.confirmCancelBtn} onPress={() => setSafetyPrompt(null)}>
                  <Text style={styles.confirmCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.confirmSubmitBtn} onPress={async () => {
                  const action = safetyPrompt?.onConfirm;
                  setSafetyPrompt(null);
                  await action?.();
                }}>
                  <Text style={styles.confirmSubmitText}>Report</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Comments section */}
        <View style={styles.commentsSection}>
          <Text style={styles.commentsSectionTitle}>
            {t('bangi.comments')} ({totalComments})
          </Text>

          {comments.length === 0 ? (
            <Text style={styles.emptyComments}>{t('bangi.noComments')}</Text>
          ) : (
            comments.map((comment: CommentWithProfile) => (
              <View key={comment.id}>
                <CommentThread
                  comment={comment}
                  onReply={(id, name) => setReplyTo({ id, name })}
                  onProfilePress={async (userId) => {
                    const { data: commenterChannel } = await supabase
                      .from('channels')
                      .select('id')
                      .eq('user_id', userId)
                      .maybeSingle();

                    if (commenterChannel?.id) {
                      onChannelPress(commenterChannel.id);
                    }
                  }}
                  onReport={handleReportComment}
                  badgeByUserId={badgeByUserId}
                  badgeByChannelId={badgeByChannelId}
                />
              </View>
            ))
          )}
        </View>

        <View style={styles.relatedSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.relatedTitle}>{t('bangi.relatedPosts')}</Text>
          </View>
          {relatedPosts.length === 0 ? (
            <Text style={styles.emptyRelated}>{t('bangi.noRelatedPosts')}</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedScroll}>
              {relatedPosts.map((item: BangiPostPreview) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.relatedCard}
                  activeOpacity={0.8}
                  onPress={() => onPostPress?.(item.id)}
                >
                  {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={styles.relatedImage} contentFit="cover" transition={200} />
                  ) : (
                    <View style={[styles.relatedImage, styles.relatedImagePlaceholder]}>
                      <Ionicons name="chatbubble-ellipses" size={22} color={colors.textTertiary} />
                    </View>
                  )}
                  <View style={styles.relatedCardContent}>
                    <View style={styles.relatedAuthorRow}>
                      <Text style={styles.relatedAuthor} numberOfLines={1}>
                        {item.channelName || ''}
                      </Text>
                      <VerifiedBadge isVerified={item.isVerified || false} verificationType={item.verificationType} size={12} />
                    </View>
                    <Text style={styles.relatedText} numberOfLines={2}>{item.content}</Text>
                    <View style={styles.relatedMetaRow}>
                      <Text style={styles.relatedMeta}>{item.likeCount ?? item.likes} likes</Text>
                      <Text style={styles.relatedMeta}>· {item.commentCount ?? 0} comments</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        <View style={styles.relatedSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.relatedTitle}>{t('bangi.trendingPosts')}</Text>
          </View>
          {trendingPosts.length === 0 ? (
            <Text style={styles.emptyRelated}>{t('bangi.noTrendingPosts')}</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedScroll}>
              {trendingPosts.map((item: BangiPostPreview) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.relatedCard}
                  activeOpacity={0.8}
                  onPress={() => onPostPress?.(item.id)}
                >
                  {item.image_url ? (
                    <Image source={{ uri: item.image_url }} style={styles.relatedImage} contentFit="cover" transition={200} />
                  ) : (
                    <View style={[styles.relatedImage, styles.relatedImagePlaceholder]}>
                      <Ionicons name="flame-outline" size={22} color={colors.tapIn} />
                    </View>
                  )}
                  <View style={styles.relatedCardContent}>
                    <View style={styles.relatedAuthorRow}>
                      <Text style={styles.relatedAuthor} numberOfLines={1}>
                        {item.channelName || ''}
                      </Text>
                      <VerifiedBadge isVerified={item.isVerified || false} verificationType={item.verificationType} size={12} />
                    </View>
                    <Text style={styles.relatedText} numberOfLines={2}>{item.content}</Text>
                    <View style={styles.relatedMetaRow}>
                      <Text style={styles.relatedMeta}>{item.likeCount ?? item.likes} likes</Text>
                      <Text style={styles.relatedMeta}>· {item.commentCount ?? 0} comments</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Comment input */}
      <View style={[styles.commentInputBar, { paddingBottom: insets.bottom + spacing.sm }]}>
        {replyTo && (
          <View style={styles.replyIndicator}>
            <Text style={styles.replyIndicatorText}>
              ↳ {t('video.reply')} @{replyTo.name}
            </Text>
            <TouchableOpacity onPress={() => setReplyTo(null)}>
              <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.commentInput}
            value={commentText}
            onChangeText={setCommentText}
            placeholder={currentUserId ? t('video.addComment') : t('video.signInToComment')}
            placeholderTextColor={colors.textTertiary}
            multiline
            scrollEnabled
            blurOnSubmit={false}
            maxLength={500}
            editable={true}
            autoCapitalize="sentences"
            autoCorrect
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!commentText.trim() || submitting) && styles.sendBtnDisabled]}
            onPress={handleSubmitComment}
            disabled={!commentText.trim() || submitting}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#FFF" />
            ) : (
              <Ionicons name="send" size={18} color="#FFF" />
            )}
          </TouchableOpacity>
        </View>
              </View>

              <AuthPromptModal
                visible={authPromptVisible}
                hasAccount={true}
                onSignIn={() => {
                  setAuthPromptVisible(false);
                  onSignIn();
                }}
                onSignUp={() => {
                  setAuthPromptVisible(false);
                  onSignUp();
                }}
                onClose={() => setAuthPromptVisible(false)}
              />
            </KeyboardAvoidingView>
          );
        }

// Comment with nested replies
function CommentThread({
  comment,
  onReply,
  onProfilePress,
  onReport,
  badgeByUserId,
  badgeByChannelId,
  depth = 0,
}: {
  comment: CommentWithProfile;
  onReply: (id: string, name: string) => void;
  onProfilePress: (userId: string) => void;
  onReport: (comment: CommentWithProfile) => void;
  badgeByUserId: Record<string, any>;
  badgeByChannelId: Record<string, any>;
  depth?: number;
}) {
  const [showReplies, setShowReplies] = useState(depth === 0);
  const replies = comment.replies || [];
  const displayName = comment.profile?.display_name || 'Gebruiker';

  return (
    <View style={[styles.commentItem, depth > 0 && styles.replyItem]}>
      <View style={styles.commentRow}>
        <TouchableOpacity onPress={() => onProfilePress(comment.user_id)} activeOpacity={0.8}>
          <RankAuraAvatar
            uri={comment.profile?.avatar_url}
            size={depth > 0 ? 24 : 32}
            badge={getAvatarBadge(badgeByUserId, badgeByChannelId, comment.user_id, null)}
            fallbackLabel={displayName}
          />
        </TouchableOpacity>
        <View style={styles.commentBody}>
          <View style={styles.nameRow}>
            <TouchableOpacity onPress={() => onProfilePress(comment.user_id)} activeOpacity={0.8}>
              <Text style={styles.commentAuthor}>{displayName}</Text>
            </TouchableOpacity>
            <VerifiedBadge
              isVerified={comment.profile?.is_verified || false}
              verificationType={comment.profile?.verification_type}
              size={12}
            />
            <Text style={styles.commentTime}>{formatTimeAgo(comment.created_at)}</Text>
          </View>
          <LinkedText style={styles.commentText}>{comment.content}</LinkedText>
          <View style={styles.commentActions}>
            <TouchableOpacity style={styles.commentActionBtn}>
              <Ionicons name="heart-outline" size={14} color={colors.textTertiary} />
              {comment.likes > 0 && (
                <Text style={styles.commentLikeCount}>{comment.likes}</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.commentActionBtn}
              onPress={() => onReply(comment.id, displayName)}
            >
              <Text style={styles.replyBtn}>{t('video.reply')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.commentActionBtn} onPress={() => onReport(comment)}>
              <Text style={styles.replyBtn}>Report</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Replies */}
      {replies.length > 0 && depth === 0 && (
        <TouchableOpacity
          style={styles.viewRepliesBtn}
          onPress={() => setShowReplies(!showReplies)}
        >
          <View style={styles.replyLine} />
          <Text style={styles.viewRepliesText}>
            {showReplies
              ? t('video.hideReplies')
              : `${replies.length} ${t('video.replies')}`}
          </Text>
        </TouchableOpacity>
      )}

      {showReplies &&
        replies.map((reply: CommentWithProfile) => (
          <View key={reply.id}>
            <CommentThread
              comment={reply}
              onReply={onReply}
              onProfilePress={onProfilePress}
              onReport={onReport}
              badgeByUserId={badgeByUserId}
              badgeByChannelId={badgeByChannelId}
              depth={depth + 1}
            />
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  backBtn: { padding: spacing.sm },
  homeBtn: {
    padding: spacing.xs,
    marginRight: spacing.xs,
  },
  homeLogo: {
    width: 26,
    height: 26,
    borderRadius: 13,
  },
  headerTitle: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    textAlign: 'center',
  },
  scrollContent: { flex: 1 },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  authorAvatar: { width: 44, height: 44, borderRadius: 22 },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  authorName: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  postTime: { color: colors.textTertiary, fontSize: fontSize.xs, marginTop: 2 },
  claimBanner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surfaceLight,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  claimBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: 2,
  },
  claimBannerTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  claimBannerText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  postContent: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 24,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  textOnlyPostCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    minHeight: 180,
    justifyContent: 'center',
  },
  textOnlyPostText: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    lineHeight: 30,
  },
  pollCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  pollQuestion: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  pollOption: {
    marginBottom: spacing.sm,
  },
  pollOptionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  pollOptionLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    flex: 1,
    paddingRight: spacing.sm,
  },
  pollOptionVotes: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  pollTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden',
  },
  pollFill: {
    height: '100%',
    backgroundColor: colors.tapIn,
    borderRadius: 999,
  },
  postImage: {
    width: '100%',
    height: 300,
    marginBottom: spacing.md,
  },
  actionsRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xxl,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  actionText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    backgroundColor: colors.borderLight,
    marginHorizontal: spacing.lg,
  },
  commentsSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  commentsSectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: spacing.lg,
  },
  emptyComments: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
  },
  relatedSection: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  relatedTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  emptyRelated: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    paddingVertical: spacing.sm,
  },
  relatedScroll: {
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  relatedCard: {
    width: 220,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  relatedImage: {
    width: '100%',
    height: 124,
  },
  relatedImagePlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  relatedCardContent: {
    padding: spacing.sm,
  },
  relatedAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  relatedAuthor: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  relatedText: {
    color: colors.text,
    fontSize: fontSize.sm,
    lineHeight: 18,
    minHeight: 36,
  },
  relatedMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },
  relatedMeta: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  commentItem: {
    marginBottom: spacing.md,
  },
  replyItem: {
    marginLeft: 36,
    marginTop: spacing.sm,
  },
  commentRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  commentAvatar: { width: 32, height: 32, borderRadius: 16 },
  replyAvatar: { width: 24, height: 24, borderRadius: 12 },
  commentBody: { flex: 1 },
  commentAuthor: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  commentTime: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginLeft: 'auto',
  },
  commentText: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
    marginTop: 2,
  },
  commentActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginTop: spacing.xs,
  },
  commentActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  commentLikeCount: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  replyBtn: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  viewRepliesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: 44,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  replyLine: {
    width: 24,
    height: 1,
    backgroundColor: colors.textTertiary,
  },
  viewRepliesText: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  // Comment input bar
  commentInputBar: {
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  replyIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.sm,
    marginBottom: spacing.xs,
  },
  replyIndicatorText: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  commentInput: {
    flex: 1,
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: fontSize.md,
    maxHeight: 100,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.tapIn,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
  },
  safetyCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    gap: spacing.sm,
  },
  safetyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  safetyActionText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  confirmCard: {
    backgroundColor: colors.background,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  confirmTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  confirmMessage: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  confirmCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
  },
  confirmCancelText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  confirmSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
    alignItems: 'center',
  },
  confirmSubmitText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
});