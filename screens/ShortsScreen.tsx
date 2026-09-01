import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import AuthPromptModal from '../components/AuthPromptModal';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Share,
  Pressable,
  Animated,
  InteractionManager,
} from 'react-native';
// import type { ListRenderItemInfo } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { Image } from '../components/AppImage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews, formatTimeAgo, extractRankingTerms, sortByFeedScore, isMomentiDuration, getRandomizedMomentiOrder } from '../lib/utils';
import { supabase, Short, Channel, Comment, Video, insertNotification } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';
import { getCurrentSupabaseUserId } from '../lib/auth';
import { loadBlockedUserIds, subscribeCommunitySafetyChanges } from '../lib/communitySafety';
import LinkedText from '../components/LinkedText';
import { ResponsePickerModal, type MediaItem } from '../components/VideoInteractionLayers';
import { normalizePlayableMediaUrl } from '../lib/utils';
import { useEvent } from 'expo';

const { width, height } = Dimensions.get('window');
const WATCH_HISTORY_KEY = 'lukuluku_watch_history_v1';
const shortChannelCache = new Map<string, Channel | null>();
const shortVerificationCache = new Map<string, { isVerified: boolean; verificationType: string | null }>();

interface CommentWithProfile extends Comment {
  profile?: {
    display_name: string;
    avatar_url: string | null;
    is_verified: boolean;
    verification_type: string;
  };
  replies?: CommentWithProfile[];
}

function ShortVideoPlayerFallback({ item }: { item: Short }) {
  return (
    <View style={[styles.video, styles.videoFallback]}>
      {item.thumbnail_url ? (
        <Image
          source={{ uri: item.thumbnail_url }}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          transition={0}
          cachePolicy="memory-disk"
        />
      ) : null}
      <View style={[StyleSheet.absoluteFillObject, { justifyContent: 'center', alignItems: 'center' }]} pointerEvents="none">
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    </View>
  );
}

function ShortVideoPlayerPlayback({
  videoUrl,
  thumbnailUrl,
  isActive,
  onFirstFrameRender,
  onBufferingChange,
  onBack,
}: {
  videoUrl: string;
  thumbnailUrl?: string | null;
  isActive: boolean;
  onFirstFrameRender: () => void;
  onBufferingChange?: (isBuffering: boolean) => void;
  onBack?: () => void;
}) {
  const player = useVideoPlayer(
    {
      uri: videoUrl,
      contentType: 'progressive' as const,
    },
    (p: any) => {
      p.loop = true;
      p.volume = 1;
      // Start muted. Audio is turned on only once the player reports it is actually ready
      // to play (see the status effect below), so sound never runs over a loading spinner.
      p.muted = true;
      p.bufferOptions = {
        // Larger buffers so heavy / high-bitrate videos load enough before playback starts.
        preferredForwardBufferDuration: 10,
        minBufferForPlayback: 1.5,
      };
    }
  );
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime, duration } = useEvent(player, 'timeUpdate', { currentTime: 0, duration: 0 });
  const [liked, setLiked] = useState(false);
  const lastTapRef = useRef(0);
    const lastTapZoneRef = useRef<'left' | 'center' | 'right' | null>(null);
    const singleTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seekFeedbackAnim = useRef(new Animated.Value(0)).current;
    const [seekFeedbackDirection, setSeekFeedbackDirection] = useState<'forward' | 'backward' | null>(null);
    const playPauseFeedbackAnim = useRef(new Animated.Value(0)).current;
  const [showPlayPauseIcon, setShowPlayPauseIcon] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [hasSignalled, setHasSignalled] = useState(false);

  // Sync volume, mute, and playback state with player and active status
  useEffect(() => {
    try {
      player.muted = !isActive || buffering;
      player.volume = isActive ? 1 : 0;

      if (isActive) {
        // Defer playback until after tab switch interactions finish.
        // This keeps the switch instant while starting the video milliseconds later.
        const interaction = InteractionManager.runAfterInteractions(() => {
          player.play();
        });
        return () => interaction.cancel();
      } else {
        player.pause();
      }
    } catch {
      // Ignore start-up races.
    }
  }, [player, isActive, buffering]);

  const signalFirstFrame = useCallback(() => {
    setHasSignalled(true);
    onFirstFrameRender();
  }, [onFirstFrameRender]);

  // Safety-net fallback for first frame
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasSignalled) signalFirstFrame();
    }, 4000);
    return () => clearTimeout(timer);
  }, [player, hasSignalled, signalFirstFrame]);

  // Detect buffering and signal ready state
  useEffect(() => {
    const interval = setInterval(() => {
      let ct = 0, bp = -1, dur = 0;
      try {
        ct = player.currentTime;
        bp = (player as any).bufferedPosition;
        dur = player.duration;
      } catch { return; }

      const nearEnd = dur > 0 && ct >= dur - 0.4;
      const bufferedAhead = bp < 0 ? Number.POSITIVE_INFINITY : bp - ct;
      const playing = nearEnd || bufferedAhead >= 0.25;

      setBuffering(!playing);
      if (playing && isActive && !hasSignalled) {
        signalFirstFrame();
      }
    }, 150);
    return () => clearInterval(interval);
  }, [player, isActive, hasSignalled, signalFirstFrame]);

  // Control playback based on active state
  useEffect(() => {
    if (isActive) {
      player.play();
    } else {
      player.pause();
    }
    return () => {
      try {
        player.pause();
        player.volume = 0;
        player.muted = true;
      } catch { }
    };
  }, [player, isActive]);

  const togglePlayback = useCallback(() => {
    try {
      if (isPlaying) {
        player.pause();
      } else {
        player.play();
      }
    } catch {
      // Ignore player state races.
    }
  }, [isPlaying, player]);

  const seekBySeconds = useCallback(
    (seconds: number) => {
      try {
        player.seekBy(seconds);
      } catch {
        const safeDuration = duration > 0 ? duration : 0;
        const nextTime = Math.max(0, Math.min(safeDuration || Number.MAX_SAFE_INTEGER, currentTime + seconds));
        player.currentTime = nextTime;
      }
    },
    [currentTime, duration, player]
  );
  const DOUBLE_TAP_DELAY = 280;
    const SIDE_ZONE_RATIO = 0.33;

    const triggerSeekFeedback = useCallback((direction: 'forward' | 'backward') => {
      setSeekFeedbackDirection(direction);
      seekFeedbackAnim.setValue(0);
      Animated.sequence([
        Animated.timing(seekFeedbackAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.delay(400),
        Animated.timing(seekFeedbackAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setSeekFeedbackDirection(null));
    }, [seekFeedbackAnim]);

    const triggerPlayPauseFeedback = useCallback(() => {
      setShowPlayPauseIcon(true);
      playPauseFeedbackAnim.setValue(0);
      Animated.sequence([
        Animated.timing(playPauseFeedbackAnim, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.delay(400),
        Animated.timing(playPauseFeedbackAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setShowPlayPauseIcon(false));
    }, [playPauseFeedbackAnim]);

    const handleVideoTap = useCallback((evt: any) => {
      const { width } = Dimensions.get('window');
      const x = evt.nativeEvent.locationX;
      const zone: 'left' | 'center' | 'right' =
        x < width * SIDE_ZONE_RATIO ? 'left' : x > width * (1 - SIDE_ZONE_RATIO) ? 'right' : 'center';

      const now = Date.now();
      const isDoubleTap = now - lastTapRef.current < DOUBLE_TAP_DELAY && lastTapZoneRef.current === zone;

      if (isDoubleTap) {
        if (singleTapTimeoutRef.current) {
          clearTimeout(singleTapTimeoutRef.current);
          singleTapTimeoutRef.current = null;
        }
        lastTapRef.current = 0;
        lastTapZoneRef.current = null;

        if (zone === 'right') {
          seekBySeconds(10);
          triggerSeekFeedback('forward');
        } else if (zone === 'left') {
          seekBySeconds(-10);
          triggerSeekFeedback('backward');
        }
        return;
      }

      lastTapRef.current = now;
      lastTapZoneRef.current = zone;

      singleTapTimeoutRef.current = setTimeout(() => {
        togglePlayback();
        triggerPlayPauseFeedback();
        lastTapZoneRef.current = null;
      }, DOUBLE_TAP_DELAY);
    }, [seekBySeconds, togglePlayback, triggerSeekFeedback, triggerPlayPauseFeedback]);

  const toggleLike = useCallback(() => {
    setLiked((value: boolean) => !value);
  }, []);

  return (
    <View style={styles.videoWrap}>
      {!hasSignalled && thumbnailUrl && (
        <Image
          source={{ uri: thumbnailUrl }}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          transition={0}
          cachePolicy="memory-disk"
        />
      )}
      <VideoView
        style={[styles.video, { opacity: hasSignalled ? 1 : 0 }]}
        player={player}
        contentFit="cover"
        nativeControls={false}
        onFirstFrameRender={signalFirstFrame}
      />
      {buffering && (
        <View
          style={{ ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center' }}
          pointerEvents="none"
        >
          <ActivityIndicator size="large" color="#FFFFFF" />
        </View>
      )}
      <Pressable style={styles.doubleTapLayer} onPress={handleVideoTap} />

            <View style={styles.videoOverlayControls} pointerEvents="box-none">
              <View style={styles.videoTopRow} pointerEvents="box-none">
                {onBack ? (
                  <View style={styles.detailTopColumn}>
                    <TouchableOpacity style={styles.actionChip} onPress={toggleLike} activeOpacity={0.85}>
                      <Ionicons name={liked ? 'heart' : 'heart-outline'} size={22} color={liked ? colors.primary : '#FFFFFF'} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionChip} onPress={onBack} activeOpacity={0.85}>
                      <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <View style={styles.backBtnSpacer} />
                    <TouchableOpacity style={styles.actionChip} onPress={toggleLike} activeOpacity={0.85}>
                      <Ionicons name={liked ? 'heart' : 'heart-outline'} size={22} color={liked ? colors.primary : '#FFFFFF'} />
                    </TouchableOpacity>
                  </>
                )}
              </View>

              {seekFeedbackDirection && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.seekFeedback,
                    seekFeedbackDirection === 'forward' ? styles.seekFeedbackRight : styles.seekFeedbackLeft,
                    {
                      opacity: seekFeedbackAnim,
                      transform: [{ scale: seekFeedbackAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
                    },
                  ]}
                >
                  <Ionicons name={seekFeedbackDirection === 'forward' ? 'play-forward' : 'play-back'} size={28} color="#FFFFFF" />
                  <Text style={styles.seekFeedbackText}>10s</Text>
                </Animated.View>
              )}

              {showPlayPauseIcon && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.seekFeedback,
                    styles.seekFeedbackCenter,
                    {
                      opacity: playPauseFeedbackAnim,
                      transform: [{ scale: playPauseFeedbackAnim.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }],
                    },
                  ]}
                >
                  <Ionicons name={isPlaying ? 'play' : 'pause'} size={24} color="#FFFFFF" />
                </Animated.View>
              )}
            </View>
          </View>
        );
      }

function ShortVideoPlayer({
  item,
  isActive,
  onFirstFrameRender,
  onBack,
}: {
  item: Short;
  isActive: boolean;
  onFirstFrameRender: () => void;
  onBack?: () => void;
}) {
  const videoUrl = normalizePlayableMediaUrl(item.video_url);

  if (!videoUrl) {
    return <ShortVideoPlayerFallback item={item} />;
  }

  return (
    <ShortVideoPlayerPlayback
      videoUrl={videoUrl}
      thumbnailUrl={item.thumbnail_url}
      isActive={isActive}
      onFirstFrameRender={onFirstFrameRender}
      onBack={onBack}
    />
  );
}

function ShortVideoSurface({
  item,
  isActive,
  isPreload,
  onFirstFrameRender,
  onBack,
}: {
  item: Short;
  isActive: boolean;
  isPreload: boolean;
  onFirstFrameRender: () => void;
  onBack?: () => void;
}) {
  const showPlayer = isActive || isPreload;

  return (
    <View style={StyleSheet.absoluteFillObject}>
      {showPlayer && (
        <ShortVideoPlayer
          item={item}
          isActive={isActive}
          onFirstFrameRender={onFirstFrameRender}
          onBack={onBack}
        />
      )}
      {!isActive && item.thumbnail_url && (
        <Image
          source={{ uri: item.thumbnail_url }}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          transition={0}
          cachePolicy="memory-disk"
        />
      )}
    </View>
  );
}

function ShortItem({
  item,
  isActive,
  isPreload,
  onChannelPress,
  onCommentPress,
  onDuetPress,
  currentUserId,
  onBack,
  showDoubleTapLayer = true,
  onRequireAuth,
  itemHeight,
}: {
  item: Short;
  isActive: boolean;
  isPreload: boolean;
  onChannelPress: (channelId: string) => void;
  onCommentPress: (shortId: string) => void;
  onDuetPress: () => void;
  currentUserId: string | null;
  onBack?: () => void;
  showDoubleTapLayer?: boolean;
  onRequireAuth: () => void;
  itemHeight: number;
})  {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [verificationType, setVerificationType] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(item.likes || 0);
  const [commentCount, setCommentCount] = useState(0);
  const lastTapRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const cachedChannel = shortChannelCache.get(item.channel_id);
    if (cachedChannel !== undefined) {
      setChannel(cachedChannel);
      if (cachedChannel?.user_id) {
        const cachedVerification = shortVerificationCache.get(cachedChannel.user_id);
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
      .eq('id', item.channel_id)
      .single()
      .then(({ data }: any) => {
        if (cancelled) return;
        shortChannelCache.set(item.channel_id, data || null);
        if (data) {
          setChannel(data);
          const cachedVerification = shortVerificationCache.get(data.user_id);
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
            .then(({ data: prof }: any) => {
              if (cancelled) return;
              const nextVerification = {
                isVerified: !!prof?.is_verified,
                verificationType: prof?.verification_type || null,
              };
              shortVerificationCache.set(data.user_id, nextVerification);
              if (prof?.is_verified) {
                setIsVerified(true);
                setVerificationType(prof.verification_type);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        if (!cancelled) {
          shortChannelCache.set(item.channel_id, null);
        }
      });

    supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('video_id', item.id)
      .then(({ count }: any) => {
        if (count != null) setCommentCount(count);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [item.channel_id, item.id]);

  useEffect(() => {
    if (currentUserId) {
      supabase
        .from('video_likes')
        .select('id')
        .eq('video_id', item.id)
        .eq('user_id', currentUserId)
        .maybeSingle()
        .then(({ data }: any) => { if (data) setLiked(true); })
        .catch(() => {});
    }
  }, [currentUserId, item.id]);

  const handleLike = useCallback(async () => {
    if (!currentUserId) {
      onRequireAuth();
      return;
    }
    try {
      if (liked) {
        await supabase
          .from('video_likes')
          .delete()
          .eq('video_id', item.id)
          .eq('user_id', currentUserId);
        setLiked(false);
        setLikeCount((c: number) => Math.max(0, c - 1));
      } else {
        await supabase
          .from('video_likes')
          .insert({ video_id: item.id, user_id: currentUserId, like_type: 'like' });
        setLiked(true);
        setLikeCount((c: number) => c + 1);
      }
    } catch (error: any) {
      Alert.alert('Fout', error?.message || 'Kon de like niet opslaan.');
    }
  }, [currentUserId, liked, item.id]);

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${item.title}\nhttps://lukuluku.online/momenti/${item.id}`,
      });
    } catch (error) {
      console.warn('Share failed:', error);
    }
  };



  return (
    <View style={[styles.shortContainer, { height: itemHeight }]}>
      <ShortVideoSurface
        item={item}
        isActive={isActive}
        isPreload={isPreload}
        onFirstFrameRender={() => {}}
        onBack={onBack}
      />

      <View style={styles.bottomGradient} />

      <View style={styles.rightActions}>
        <TouchableOpacity style={styles.actionBtn} onPress={handleLike}>
          <Ionicons
            name={liked ? 'heart' : 'heart-outline'}
            size={28}
            color={liked ? colors.primary : '#FFFFFF'}
          />
          <Text style={styles.actionText}>{formatViews(likeCount)}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => onCommentPress(item.id)}
        >
          <Ionicons name="chatbubble-outline" size={26} color="#FFFFFF" />
          <Text style={styles.actionText}>{commentCount}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
          <Ionicons name="share-social-outline" size={26} color="#FFFFFF" />
        </TouchableOpacity>
        {currentUserId && currentUserId !== item.user_id && (
          <TouchableOpacity style={styles.actionBtn} onPress={onDuetPress}>
            <Ionicons name="return-up-back-outline" size={26} color="#FFFFFF" />
            <Text style={styles.actionText}>Duet</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.bottomInfo}>
        <TouchableOpacity
          style={styles.channelRow}
          onPress={() => onChannelPress(item.channel_id)}
        >
          {channel?.avatar_url ? (
            <Image
              source={{ uri: channel.avatar_url }}
              style={styles.channelAvatar}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.channelAvatar, { backgroundColor: colors.surfaceLight }]} />
          )}
          <Text style={styles.channelName}>{channel?.name || ''}</Text>
          <VerifiedBadge isVerified={isVerified} verificationType={verificationType} size={14} />
        </TouchableOpacity>
        <Text style={styles.shortTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.description ? (
          <LinkedText style={styles.shortDesc}>{item.description}</LinkedText>
        ) : null}
      </View>
    </View>
  );
}

async function insertShortDuetLink({
  sourceShort,
  selectedItem,
  currentUserId,
}: {
  sourceShort: Short;
  selectedItem: MediaItem;
  currentUserId: string;
}) {
  const responseKind = selectedItem.kind === 'short' || selectedItem.is_short ? 'short' : 'video';
  const { error } = await supabase.from('video_responses').insert({
    source_video_id: sourceShort.id,
    source_kind: 'short',
    response_video_id: selectedItem.id,
    response_kind: responseKind,
    response_type: 'duet',
    user_id: currentUserId,
  });

  if (error) {
    throw error;
  }
}

function CommentsModal({
  visible,
  shortId,
  onClose,
  currentUserId,
  onChannelPress,
  onRequireAuth,
}: {
  visible: boolean;
  shortId: string | null;
  onClose: () => void;
  currentUserId: string | null;
  onChannelPress: (channelId: string) => void;
  onRequireAuth: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<CommentWithProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchComments = useCallback(async () => {
    if (!shortId) return;
    setLoading(true);

    try {
      const { data: allComments } = await supabase
        .from('comments')
        .select('*')
        .eq('video_id', shortId)
        .order('created_at', { ascending: true });

      if (!allComments || allComments.length === 0) {
        setComments([]);
        return;
      }

      const userIds = [...new Set(allComments.map((c: Comment) => c.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, display_name, avatar_url, is_verified, verification_type')
        .in('user_id', userIds);

      const profileMap = new Map<string, any>();
      profiles?.forEach((p: any) => profileMap.set(p.user_id, p));

      const commentMap = new Map<string, CommentWithProfile>();
      const topLevel: CommentWithProfile[] = [];

      allComments.forEach((c: Comment) => {
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

      allComments.forEach((c: Comment) => {
        const enhanced = commentMap.get(c.id)!;
        if (c.parent_id && commentMap.has(c.parent_id)) {
          commentMap.get(c.parent_id)!.replies!.push(enhanced);
        } else {
          topLevel.push(enhanced);
        }
      });

      setComments(topLevel);
    } catch (error) {
      console.warn('Comments failed to load:', error);
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [shortId]);

  useEffect(() => {
    if (visible && shortId) fetchComments();
  }, [visible, shortId, fetchComments]);

  const handleSubmit = async () => {
    if (!currentUserId) {
      onRequireAuth();
      return;
    }
    const text = commentText.trim();
    if (!text || submitting || !shortId) return;

    setSubmitting(true);
    try {
      const payload: any = { video_id: shortId, user_id: currentUserId, content: text };
      if (replyTo) payload.parent_id = replyTo.id;

      const { error } = await supabase.from('comments').insert(payload);
      if (!error) {
        setCommentText('');
        setReplyTo(null);
        await fetchComments();

        const { data: shortVideo } = await supabase
          .from('videos')
          .select('channel_id')
          .eq('id', shortId)
          .maybeSingle();

        if (shortVideo?.channel_id) {
          const { data: channelData } = await supabase
            .from('channels')
            .select('user_id')
            .eq('id', shortVideo.channel_id)
            .maybeSingle();

          if (channelData?.user_id && channelData.user_id !== currentUserId) {
            await insertNotification({
              user_id: channelData.user_id,
              actor_id: currentUserId,
              type: 'comment',
              video_id: shortId,
            });
          }
        }

        if (replyTo?.id) {
          const { data: parentComment } = await supabase
            .from('comments')
            .select('user_id')
            .eq('id', replyTo.id)
            .maybeSingle();

          if (parentComment?.user_id && parentComment.user_id !== currentUserId) {
            await insertNotification({
              user_id: parentComment.user_id,
              actor_id: currentUserId,
              type: 'reply',
              video_id: shortId,
            });
          }
        }
      }
    } catch (error) {
      console.warn('Comment submit failed:', error);
    } finally {
      setSubmitting(false);
    }
  };

  const totalComments = comments.reduce((acc: number, c: CommentWithProfile) => acc + 1 + (c.replies?.length || 0), 0);

  const openProfile = useCallback(async (userId: string) => {
    try {
      const { data: commenterChannel } = await supabase
        .from('channels')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();

      if (commenterChannel?.id) {
        onChannelPress(commenterChannel.id);
      }
    } catch (error) {
      console.warn('Open short commenter profile failed:', error);
    }
  }, [onChannelPress]);

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View style={modalStyles.overlay}>
        <KeyboardAvoidingView
          style={modalStyles.container}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={modalStyles.header}>
            <Text style={modalStyles.headerTitle}>
              {t('video.comments')} ({totalComments})
            </Text>
            <TouchableOpacity onPress={onClose} style={modalStyles.closeBtn}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView style={modalStyles.commentsList} showsVerticalScrollIndicator={false}>
            {loading ? (
              <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
            ) : comments.length === 0 ? (
              <Text style={modalStyles.emptyText}>{t('video.noComments')}</Text>
            ) : (
              comments.map((comment: CommentWithProfile) => (
                <React.Fragment key={comment.id}>
                  <ModalCommentThread
                    comment={comment}
                    onReply={(id, name) => setReplyTo({ id, name })}
                    onProfilePress={openProfile}
                  />
                </React.Fragment>
              ))
            )}
            <View style={{ height: 20 }} />
          </ScrollView>

          <View style={[modalStyles.inputBar, { paddingBottom: insets.bottom + spacing.sm }]}>
            {replyTo && (
              <View style={modalStyles.replyIndicator}>
                <Text style={modalStyles.replyText}>↳ {t('video.reply')} @{replyTo.name}</Text>
                <TouchableOpacity onPress={() => setReplyTo(null)}>
                  <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              </View>
            )}
            <View style={modalStyles.inputRow}>
              <TextInput
                style={modalStyles.input}
                value={commentText}
                onChangeText={setCommentText}
                placeholder={currentUserId ? t('video.addComment') : t('video.signInToComment')}
                placeholderTextColor={colors.textTertiary}
                multiline
                maxLength={500}
                editable={!!currentUserId}
              />
              <TouchableOpacity
                style={[modalStyles.sendBtn, (!commentText.trim() || submitting) && { opacity: 0.4 }]}
                onPress={handleSubmit}
                disabled={!commentText.trim() || submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#FFF" />
                ) : (
                  <Ionicons name="send" size={16} color="#FFF" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function ModalCommentThread({
  comment,
  onReply,
  onProfilePress,
  depth = 0,
}: {
  comment: CommentWithProfile;
  onReply: (id: string, name: string) => void;
  onProfilePress: (userId: string) => void;
  depth?: number;
}) {
  const [showReplies, setShowReplies] = useState(true);
  const replies = comment.replies || [];
  const name = comment.profile?.display_name || 'Gebruiker';

  return (
    <View style={[modalStyles.commentItem, depth > 0 && { marginLeft: 32, marginTop: 8 }]}>
      <View style={modalStyles.commentRow}>
        <TouchableOpacity onPress={() => onProfilePress(comment.user_id)} activeOpacity={0.8}>
          {comment.profile?.avatar_url ? (
            <Image source={{ uri: comment.profile.avatar_url }} style={modalStyles.avatar} contentFit="cover" />
          ) : (
            <View style={[modalStyles.avatar, { backgroundColor: colors.surfaceLight, justifyContent: 'center', alignItems: 'center' }]}>
              <Ionicons name="person" size={10} color={colors.textTertiary} />
            </View>
          )}
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <TouchableOpacity onPress={() => onProfilePress(comment.user_id)} activeOpacity={0.8}>
              <Text style={modalStyles.authorName}>{name}</Text>
            </TouchableOpacity>
            <VerifiedBadge
              isVerified={comment.profile?.is_verified || false}
              verificationType={comment.profile?.verification_type}
              size={12}
            />
            <Text style={modalStyles.time}>{formatTimeAgo(comment.created_at)}</Text>
          </View>
          <LinkedText style={modalStyles.commentText}>{comment.content}</LinkedText>
          <TouchableOpacity onPress={() => onReply(comment.id, name)} style={{ marginTop: 4 }}>
            <Text style={modalStyles.replyBtnText}>{t('video.reply')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {replies.length > 0 && depth === 0 && (
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 36, marginTop: 4 }}
          onPress={() => setShowReplies(!showReplies)}
        >
          <View style={{ width: 20, height: 1, backgroundColor: colors.textTertiary }} />
          <Text style={{ color: colors.tapIn, fontSize: fontSize.xs, fontWeight: '600' }}>
            {showReplies ? t('video.hideReplies') : `${replies.length} ${t('video.replies')}`}
          </Text>
        </TouchableOpacity>
      )}

      {showReplies && replies.map((r: CommentWithProfile) => (
        <React.Fragment key={r.id}>
          <ModalCommentThread comment={r} onReply={onReply} onProfilePress={onProfilePress} depth={depth + 1} />
        </React.Fragment>
      ))}
    </View>
  );
}

interface ShortsScreenProps {
  onChannelPress: (channelId: string) => void;
  onVideoPress: (video: Video) => void;
  isActive: boolean;
  onBack?: () => void;
  initialVideoId?: string | null;
  initialVideo?: Video | null;
  onSignIn: () => void;
  onSignUp: () => void;
}

function ShortsScreen({ onChannelPress, onVideoPress, isActive, onBack, initialVideoId, initialVideo, onSignIn, onSignUp }: ShortsScreenProps) {
  const [shorts, setShorts] = useState<Short[]>([]);
  const [listHeight, setListHeight] = useState<number | null>(null);
  const [readyToShowList, setReadyToShowList] = useState(false);
  const [authPromptVisible, setAuthPromptVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [initialScrollIndex, setInitialScrollIndex] = useState<number | null>(null);
  const [commentShortId, setCommentShortId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const shuffleSeedRef = useRef(Math.floor(Math.random() * 1_000_000)).current;
  const [duetShort, setDuetShort] = useState<Short | null>(null);
  const [isReordering, setIsReordering] = useState(false);
  const dismissingRef = useRef(false);
  const listRef = useRef<any>(null);
  const detailMode = !!initialVideoId || !!initialVideo;

  const handleDismiss = useCallback(() => {
    if (!onBack || dismissingRef.current) return;
    dismissingRef.current = true;
    onBack();
    setTimeout(() => {
      dismissingRef.current = false;
    }, 250);
  }, [onBack]);

  const getMomentSignature = (item: Short) => {
    const url = item.video_url?.trim().toLowerCase() || '';
    const title = item.title?.trim().toLowerCase() || '';
    const description = item.description?.trim().toLowerCase() || '';
    return `${item.user_id}|${item.channel_id}|${url || `${title}|${description}`}`;
  };

  useEffect(() => {
    getCurrentSupabaseUserId().then((id) => {
      if (id) setCurrentUserId(id);
    });
  }, []);

  useEffect(() => {
    void loadBlockedUserIds().then(setBlockedUserIds);
    return subscribeCommunitySafetyChanges(() => {
      void loadBlockedUserIds().then(setBlockedUserIds);
    });
  }, []);

  // Re-shuffle moments whenever the user returns to this tab for a fresh experience
  useEffect(() => {
    // Only re-shuffle if we're entering the tab (isActive becomes true),
    // we have data, and we're in feed mode (not detail mode).
    if (isActive && shorts.length > 0 && !detailMode) {
      setIsReordering(true); // Lock playback to prevent audio leak

      const newSeed = Math.floor(Math.random() * 1_000_000);
      const shuffled = getRandomizedMomentiOrder([...shorts], newSeed);

      setShorts(shuffled);
      setActiveIndex(0);
      listRef.current?.scrollToOffset({ offset: 0, animated: false });

      // Small delay to ensure the list has updated before allowing video to play
      const timer = setTimeout(() => {
        setIsReordering(false);
      }, 150);

      return () => clearTimeout(timer);
    }
  }, [isActive]);

  useEffect(() => {
    const loadShorts = async () => {
      try {
        const [{ data: shortsRes }, { data: videosShortsRes }] = await Promise.all([
          supabase
            .from('shorts')
            .select('*')
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(50),
          supabase
            .from('videos')
            .select('*')
            .eq('status', 'published')
            .eq('is_short', true)
            .order('created_at', { ascending: false })
            .limit(50),
        ]);

        const seenSignatures = new Set<string>();
        const combinedSource = [
          ...((videosShortsRes || []) as Short[]),
          ...((shortsRes || []) as Short[]),
        ];
        const selectedInitialVideo = initialVideo ? ({ ...initialVideo } as Short) : null;
        const combined = (selectedInitialVideo ? [selectedInitialVideo, ...combinedSource] : combinedSource)
          .filter((item: Short) => {
            const signature = `${item.user_id || ''}|${item.channel_id || ''}|${(item.video_url || '').trim().toLowerCase()}|${(item.title || '').trim().toLowerCase()}|${(item.thumbnail_url || '').trim().toLowerCase()}`;
            if (seenSignatures.has(signature)) return false;
            seenSignatures.add(signature);
            return true;
          })
          .filter((item: Short) => !blockedUserIds.includes(item.user_id))
          .sort((a: Short, b: Short) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        const preferredTerms = extractRankingTerms(combined as any[]);
        const sortedShorts = getRandomizedMomentiOrder(combined, shuffleSeedRef);
        const selectedVideoId = initialVideo?.id || initialVideoId;
        const initialIndex = selectedVideoId ? sortedShorts.findIndex((item: Short) => item.id === selectedVideoId) : -1;
        setInitialScrollIndex(initialIndex >= 0 ? initialIndex : null);
        setActiveIndex(initialIndex >= 0 ? initialIndex : 0);

        setShorts(sortedShorts);
      } catch (error) {
        console.warn('Shorts feed failed to load:', error);
        setShorts([]);
      } finally {
        setLoading(false);
      }
    };

    loadShorts();
  }, [blockedUserIds, initialVideo, initialVideoId]);

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
      if (viewableItems.length > 0 && viewableItems[0].index != null) {
        setActiveIndex(viewableItems[0].index);
      }
    },
    []
  );

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const listContent = useMemo(() => {
    if (!listHeight || loading) return null;

    return (
      <FlatList<Short>
        style={{ opacity: readyToShowList ? 1 : 0 }}
        ref={listRef}
        onLayout={() => {
          if (initialScrollIndex && initialScrollIndex > 0) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                listRef.current?.scrollToOffset({
                  offset: Math.round(listHeight * initialScrollIndex),
                  animated: false,
                });
                setReadyToShowList(true);
              });
            });
          } else {
            setReadyToShowList(true);
          }
        }}
        data={shorts}
        keyExtractor={(item: Short) => item.id}
        renderItem={({ item, index }: { item: Short; index: number }) => {
          const isItemActive = index === activeIndex && isActive && !isReordering;
          const isPreload = Math.abs(index - activeIndex) <= 1;
          return (
            <ShortItem
              item={item}
              itemHeight={listHeight as number}
              isActive={isItemActive}
              isPreload={isPreload}
              onChannelPress={onChannelPress}
              onCommentPress={(id) => setCommentShortId(id)}
              onDuetPress={() => setDuetShort(item)}
              currentUserId={currentUserId}
              onBack={detailMode ? handleDismiss : undefined}
              showDoubleTapLayer={!detailMode}
              onRequireAuth={() => setAuthPromptVisible(true)}
            />
          );
        }}
        pagingEnabled
        snapToInterval={listHeight}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollToIndexFailed={({ index }: { index: number }) => {
          setTimeout(() => {
            listRef.current?.scrollToIndex({ index, animated: false });
          }, 120);
        }}
        getItemLayout={(_: unknown, index: number) => ({
          length: Math.round(listHeight),
          offset: Math.round(listHeight * index),
          index,
        })}
        initialNumToRender={1}
        maxToRenderPerBatch={1}
        windowSize={3}
        updateCellsBatchingPeriod={100}
      />
    );
  }, [
    readyToShowList, shorts, listHeight, loading, initialScrollIndex, activeIndex, isActive, isReordering,
    onChannelPress, currentUserId, detailMode, handleDismiss
  ]);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }

  if (!listHeight) {
    return (
      <View
        style={{ flex: 1, backgroundColor: '#000000', justifyContent: 'center', alignItems: 'center' }}
        onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
      >
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }

  return (
    <View
      style={{ flex: 1, backgroundColor: '#000000' }}
      onLayout={(e) => setListHeight(e.nativeEvent.layout.height)}
    >
      {detailMode && <View style={styles.detailSwipeHandle} pointerEvents="none" />}
      {listContent}

      <CommentsModal
        visible={!!commentShortId}
        shortId={commentShortId}
        onClose={() => setCommentShortId(null)}
        currentUserId={currentUserId}
        onChannelPress={onChannelPress}
        onRequireAuth={() => setAuthPromptVisible(true)}
      />

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

      <ResponsePickerModal
        visible={!!duetShort}
        sourceId={duetShort?.id || ''}
        sourceKind="short"
        sourceUserId={duetShort?.user_id || null}
        responseType="duet"
        currentUserId={currentUserId}
        onClose={() => setDuetShort(null)}
        onPick={async (item: MediaItem) => {
          if (!duetShort || !currentUserId) return;

          try {
            await insertShortDuetLink({ sourceShort: duetShort, selectedItem: item, currentUserId });
          } catch (error: any) {
            Alert.alert('Fout', error.message || 'Kon de duetlink niet opslaan.');
            return;
          }

          setDuetShort(null);
          onVideoPress({
            id: item.id,
            channel_id: item.channel_id,
            user_id: item.user_id,
            title: item.title,
            description: item.description,
            video_url: item.video_url,
            thumbnail_url: item.thumbnail_url,
            duration: item.duration,
            views: item.views,
            likes: item.likes,
            dislikes: item.dislikes,
            status: 'published',
            is_short: item.is_short,
            created_at: item.created_at,
          });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shortContainer: {
    width,
    backgroundColor: '#000000',
    position: 'relative',
  },
  backBtn: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  detailTopColumn: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: spacing.sm,
  },
  backBtnSpacer: {
    width: 40,
    height: 40,
  },
  detailControlsOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    zIndex: 25,
    elevation: 25,
  },
  likeBtn: {
    position: 'absolute',
    top: 54,
    right: spacing.lg + 52,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playbackBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playbackBtnPrimary: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.tapIn,
    justifyContent: 'center',
    alignItems: 'center',
  },
  seekFeedback: {
      position: 'absolute',
      top: '50%',
      marginTop: -32.5,
      width: 65,
      height: 65,
      borderRadius: 100,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 2,
    },
    seekFeedbackLeft: {
      left: '15%',
    },
    seekFeedbackRight: {
      right: '15%',
    },
    seekFeedbackCenter: {
      alignSelf: 'center',
      width: 56,
      height: 56,
      borderRadius: 28,
    },
    seekFeedbackText: {
      color: '#FFFFFF',
      fontSize: fontSize.sm,
      fontWeight: '600',
    },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  videoWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  videoOverlayControls: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
    elevation: 20,
  },
  videoTopRow: {
    position: 'absolute',
    top: 50,
    left: 12,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  videoBottomRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 120,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  actionChip: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  videoFallback: {
    backgroundColor: '#000000',
  },
 doubleTapLayer: {
   ...StyleSheet.absoluteFillObject,
 },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 200,
    backgroundColor: 'transparent',
    zIndex: 0,
  },
 rightActions: {
   position: 'absolute',
   right: spacing.lg,
   bottom: 160,
   alignItems: 'center',
   gap: spacing.xl,
   zIndex: 30,
   elevation: 30,
 },
  actionBtn: {
    alignItems: 'center',
    gap: 4,
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  bottomInfo: {
    position: 'absolute',
    bottom: 100,
    left: spacing.lg,
    right: 80,
    zIndex: 30,
  elevation: 30,
    },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  channelAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  channelName: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  shortTitle: {
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: '600',
    marginBottom: 4,
  },
  shortDesc: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
  },
  momentiAdWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  detailGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 120,
    backgroundColor: 'transparent',
  },
  detailSwipeHandle: {
    position: 'absolute',
    top: 8,
    left: '35%',
    right: '35%',
    height: 36,
    zIndex: 20,
  },
});

const modalStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: height * 0.65,
    minHeight: height * 0.4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    position: 'relative',
  },
  headerTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  closeBtn: {
    position: 'absolute',
    right: spacing.lg,
    padding: spacing.xs,
  },
  commentsList: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  emptyText: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: 40,
  },
  commentItem: {
    marginBottom: spacing.md,
  },
  commentRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  authorName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  time: {
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
  replyBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  inputBar: {
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
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
  replyText: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceLight,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: fontSize.md,
    maxHeight: 80,
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.tapIn,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default React.memo(ShortsScreen);
