import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  PanResponder,
  Share,
  Pressable,
  InteractionManager,
  Modal,
  Animated,   // <-- yeh add karein
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { Image } from '../components/AppImage';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatViews, formatTimeAgo, formatDuration, normalizePlayableMediaUrl } from '../lib/utils';
import { supabase, Video, Channel, Comment, ContentClaim, insertNotification } from '../lib/supabase';
import { t } from '../lib/i18n';
import VerifiedBadge from '../components/VerifiedBadge';
import { getCurrentSupabaseUserId } from '../lib/auth';
import { useActiveAds, SponsoredAd, isAdWithinCampaignWindow, adHasImpressionsLeft } from '../hooks/useActiveAds';
import PreRollAd from '../components/PreRollAd';
import LinkedText from '../components/LinkedText';
import { ResponsePickerModal, ResponsesList, VideoReactionsLayer, type MediaItem, type ResponseFeedItem } from '../components/VideoInteractionLayers';
import { blockUser, saveReportDraft } from '../lib/communitySafety';
import AuthPromptModal from '../components/AuthPromptModal';

declare const require: any;

// Remember the last ad shown so we can rotate to a different one when more than one is
// available (a pre-roll shows on every long video).
let lastShownPrerollAdId: string | null = null;

const { width } = Dimensions.get('window');
const viewedVideoIds = new Set<string>();
const WATCH_HISTORY_KEY = 'lukuluku_watch_history_v1';
const WATCH_SAVE_INTERVAL_SECONDS = 5;

interface WatchHistoryItem {
  videoId: string;
  currentTime: number;
  duration: number | null;
  title: string;
  thumbnail_url: string | null;
  updatedAt: number;
}

interface VideoPlayerScreenProps {
  video: Video;
  onBack: () => void;
  onHomePress?: () => void;
  onChannelPress: (channelId: string) => void;
  onVideoPress: (video: Video) => void;
  onSignIn: () => void;
  onSignUp: () => void;
}

interface VideoPlayerContentProps extends VideoPlayerScreenProps {
  playableVideoUrl: string;
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

function VideoPlayerMedia({
  player,
  onFirstFrameRender,
  isVideoLoading,
}: {
  player: any;
  onFirstFrameRender: () => void;
  isVideoLoading: boolean;
}) {
  return (
    <VideoView
      style={styles.player}
      player={player}
      contentFit="contain"
      nativeControls={false}
      useExoShutter={false}
      onFirstFrameRender={onFirstFrameRender}
    />
  );
}

function VideoPlayerFallback({ video, onBack, onHomePress, insets }: Pick<VideoPlayerScreenProps, 'video' | 'onBack' | 'onHomePress'> & { insets: { top: number } }) {
  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.playerContainer}>
        {video.thumbnail_url ? (
          <Image
            source={{ uri: video.thumbnail_url }}
            style={StyleSheet.absoluteFillObject}
            contentFit="cover"
            transition={0}
            cachePolicy="memory-disk"
          />
        ) : null}
        <View style={styles.loadingOverlay}>
          <Text style={styles.playerFallbackText}>Video niet beschikbaar</Text>
        </View>
        <TouchableOpacity style={styles.backBtn} onPress={onBack}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.homeBtn} onPress={() => onHomePress?.()} hitSlop={8}>
          <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function VideoPlayerScreen(props: VideoPlayerScreenProps) {
  const insets = useSafeAreaInsets();
  const [resolvedVideo, setResolvedVideo] = useState<Video | null>(null);
  const [resolvingVideo, setResolvingVideo] = useState(false);
  const primaryVideoUrl = props.video.video_url;
  const mediaVideoUrl = (props.video as any).media_url || null;
  const alternateVideoUrl = (props.video as any).url || null;
  const sourceVideoUrl =
    (resolvedVideo as any)?.video_url ||
    (resolvedVideo as any)?.media_url ||
    (resolvedVideo as any)?.url ||
    primaryVideoUrl ||
    mediaVideoUrl ||
    alternateVideoUrl ||
    null;

  useEffect(() => {
    const hasPlayableUrl = !!primaryVideoUrl || !!mediaVideoUrl || !!alternateVideoUrl;
    if (hasPlayableUrl) {
      setResolvedVideo(null);
      setResolvingVideo(false);
      return;
    }

    let cancelled = false;
    setResolvingVideo(true);

    void (async () => {
      try {
        const { data } = await supabase
          .from('videos')
          .select('*')
          .eq('id', props.video.id)
          .maybeSingle();

        if (!cancelled) {
          setResolvedVideo((data as Video | null) || null);
        }
      } catch {
        if (!cancelled) {
          setResolvedVideo(null);
        }
      } finally {
        if (!cancelled) {
          setResolvingVideo(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [props.video.id, primaryVideoUrl, mediaVideoUrl, alternateVideoUrl]);

  const normalizedPlayableVideoUrl = normalizePlayableMediaUrl(sourceVideoUrl);
  const rawPlayableVideoUrl = sourceVideoUrl?.trim() || null;
  const playableVideoUrl = normalizedPlayableVideoUrl || rawPlayableVideoUrl;

  if (resolvingVideo && !playableVideoUrl) {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.playerContainer}>
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#FFFFFF" />
          </View>
          <TouchableOpacity style={styles.backBtn} onPress={props.onBack}>
            <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.homeBtn} onPress={() => props.onHomePress?.()} hitSlop={8}>
            <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!playableVideoUrl) {
    return <VideoPlayerFallback video={props.video} onBack={props.onBack} onHomePress={props.onHomePress} insets={insets} />;
  }

  return <VideoPlayerScreenContent {...props} playableVideoUrl={playableVideoUrl} />;
}

function VideoPlayerScreenContent({
  video,
  onBack,
  onHomePress,
  onChannelPress,
  onVideoPress,
  playableVideoUrl,
  onSignIn,
  onSignUp,
}: VideoPlayerContentProps) {
  const [authPromptVisible, setAuthPromptVisible] = useState(false);
  const insets = useSafeAreaInsets();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [channelTapinCount, setChannelTapinCount] = useState<number | null>(null);
  const [comments, setComments] = useState<CommentWithProfile[]>([]);
  const [relatedVideos, setRelatedVideos] = useState<Video[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(video.likes || 0);
  const [isVerified, setIsVerified] = useState(false);
  const [verificationType, setVerificationType] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [hasTapped, setHasTapped] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [contentClaim, setContentClaim] = useState<ContentClaim | null>(null);
  const [contentClaimantName, setContentClaimantName] = useState<string | null>(null);
  const [displayViews, setDisplayViews] = useState(video.views);
  const [showResponsePicker, setShowResponsePicker] = useState(false);
  const [optimisticResponses, setOptimisticResponses] = useState<ResponseFeedItem[]>([]);
  const [showSafetyMenu, setShowSafetyMenu] = useState(false);
  const [reportPrompt, setReportPrompt] = useState(false);
  const lastTapRef = useRef(0);
  const lastTapZoneRef = useRef<'left' | 'center' | 'right' | null>(null);   // <-- naya
  const singleTapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);   // <-- naya
  const seekFeedbackAnim = useRef(new Animated.Value(0)).current;   // <-- naya
  const [seekFeedbackDirection, setSeekFeedbackDirection] = useState<'forward' | 'backward' | null>(null);   // <-- naya
  const playPauseFeedbackAnim = useRef(new Animated.Value(0)).current;
  const [showPlayPauseIcon, setShowPlayPauseIcon] = useState(false);
  const lastSavedProgressRef = useRef(0);
  const resumeProgressRef = useRef<WatchHistoryItem | null>(null);
  const dismissingRef = useRef(false);
  const adFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ad state — pre-roll ads are read from the `public_ads_active` Supabase view (same
  // source as the web platform). We rotate between active 'preroll' ads.
  const { ads: prerollAds, loading: prerollAdsLoading } = useActiveAds('preroll');
  const prerollAdsRef = useRef<SponsoredAd[]>(prerollAds);
  prerollAdsRef.current = prerollAds;

  const [showAd, setShowAd] = useState(true);
  const [adDone, setAdDone] = useState(false);
  const [selectedAd, setSelectedAd] = useState<SponsoredAd | null>(null);
  const [adResolved, setAdResolved] = useState(false); // true once we've decided luku-ad vs VAST
  const [videoPlayerError, setVideoPlayerError] = useState<string | null>(null);

  // Decide synchronously (once per video) whether this is a "pre-roll slot" — i.e. every
  // Nth long video — so the player can avoid auto-playing before an ad is shown.
  const countedVideoRef = useRef<string | null>(null);
  const isAdSlotRef = useRef(false);
  if (countedVideoRef.current !== video.id) {
    countedVideoRef.current = video.id;
    // Show a pre-roll on every long video (no cooldown). Shorts never get a pre-roll.
    isAdSlotRef.current = !video.is_short;
  }

  // Pick a random active paid pre-roll ad (creative + campaign window + impressions left),
  // mirroring the web. If none qualify, returns null and the player shows the VAST ad.
  const pickPrerollAd = useCallback((): SponsoredAd | null => {
    const eligible = prerollAdsRef.current.filter(
      (ad) => !!ad.creative_url && isAdWithinCampaignWindow(ad) && adHasImpressionsLeft(ad)
    );
    if (eligible.length === 0) return null;
    const candidates =
      eligible.length > 1 ? eligible.filter((ad) => ad.id !== lastShownPrerollAdId) : eligible;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)] || eligible[0];
    // Count the impression server-side, same as the web (best-effort, ignore failures).
    try {
      void supabase.rpc('increment_ad_impression', { p_ad_id: chosen.id });
    } catch {
      // Ignore impression tracking errors.
    }
    return chosen;
  }, []);

  // Reset ad state whenever the video changes.
  useEffect(() => {
    setShowAd(true);
    setAdDone(false);
    setSelectedAd(null);
    setAdResolved(false);
    setFirstFrameRendered(false);
  }, [video.id]);

  // Once ads have finished loading, decide what to show: a paid LukuLuku ad if one is
  // active, otherwise selectedAd stays null and the player shows the VAST network ad.
  useEffect(() => {
    if (!isAdSlotRef.current || adDone || adResolved) return;
    if (prerollAdsLoading) return; // wait until ads are loaded before deciding
    const chosen = pickPrerollAd();
    if (chosen) {
      lastShownPrerollAdId = chosen.id;
      setSelectedAd(chosen);
    }
    setAdResolved(true);
  }, [prerollAds, prerollAdsLoading, adDone, adResolved, pickPrerollAd]);

  useEffect(() => {
    const loadContentClaim = async () => {
      try {
        const { data: claim } = await supabase
          .from('content_claims')
          .select('id, claimant_user_id, video_id, claim_status, created_at, updated_at')
          .eq('video_id', video.id)
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
      } catch (error) {
        console.warn('Content claim failed to load:', error);
        setContentClaim(null);
        setContentClaimantName(null);
      }
    };

    loadContentClaim();
  }, [video.id]);

  // Video loading state - thumbnail stays until first frame renders
  const [firstFrameRendered, setFirstFrameRendered] = useState(false);
  const dragStartY = useRef(0);
  const dragDistance = useRef(0);

  const shouldShowAd = !video.is_short && showAd && !adDone && adResolved;

  const player = useVideoPlayer(
    {
      uri: playableVideoUrl,
      contentType: 'progressive' as const,
    },
    (p: any) => {
      p.bufferOptions = {
        preferredForwardBufferDuration: 1.5,
        minBufferForPlayback: 0.05,
      };
      p.volume = 1;
      p.muted = false;
      // Don't auto-play on a pre-roll slot — wait for the ad to finish (or fail). On
      // non-ad videos, start immediately.
      if (!isAdSlotRef.current) {
        p.play();
      }
    }
  );

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const isVideoLoading = status === 'loading' || status === 'idle';
  const { currentTime, duration } = useEvent(player, 'timeUpdate', { currentTime: 0, duration: 0 });

  const loadWatchProgress = useCallback(async () => {
    try {
      const value = await AsyncStorage.getItem(WATCH_HISTORY_KEY);
      if (!value) {
        resumeProgressRef.current = null;
        return;
      }

      const parsed = JSON.parse(value) as WatchHistoryItem[];
      const saved = Array.isArray(parsed) ? parsed.find((item) => item.videoId === video.id) || null : null;
      resumeProgressRef.current = saved;

      if (saved && saved.currentTime > 5 && saved.duration && saved.currentTime < saved.duration * 0.95) {
        requestAnimationFrame(() => {
          try {
            player.currentTime = saved.currentTime;
          } catch {
            // Ignore resume failures and keep playback normal.
          }
        });
      }
    } catch {
      resumeProgressRef.current = null;
    }
  }, [player, video.id]);

  const saveWatchProgress = useCallback(async (force = false) => {
    const safeDuration = duration > 0 ? duration : resumeProgressRef.current?.duration || null;
    const progressRatio = safeDuration ? currentTime / safeDuration : 0;
    if (!force) {
      if (currentTime < WATCH_SAVE_INTERVAL_SECONDS) return;
      if (currentTime - lastSavedProgressRef.current < WATCH_SAVE_INTERVAL_SECONDS) return;
      if (safeDuration && progressRatio >= 0.98) return;
    }

    lastSavedProgressRef.current = currentTime;

    const nextItem: WatchHistoryItem = {
      videoId: video.id,
      currentTime,
      duration: safeDuration,
      title: video.title,
      thumbnail_url: video.thumbnail_url || null,
      updatedAt: Date.now(),
    };

    try {
      const raw = await AsyncStorage.getItem(WATCH_HISTORY_KEY);
      const existing = raw ? (JSON.parse(raw) as WatchHistoryItem[]) : [];
      const filtered = Array.isArray(existing) ? existing.filter((item) => item.videoId !== video.id) : [];
      const nextHistory = [nextItem, ...filtered].slice(0, 30);
      await AsyncStorage.setItem(WATCH_HISTORY_KEY, JSON.stringify(nextHistory));
    } catch {
      // Ignore storage errors; playback should keep working.
    }
  }, [currentTime, duration, video.id, video.thumbnail_url, video.title]);

  const handleDismiss = useCallback((nextAction: () => void) => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    try {
      player.pause();
    } catch {
      // Ignore teardown race.
    }
    void saveWatchProgress(true);
    nextAction();
    setTimeout(() => {
      dismissingRef.current = false;
    }, 250);
  }, [player, saveWatchProgress]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_: any, gesture: any) =>
        gesture.dy > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onMoveShouldSetPanResponderCapture: (_: any, gesture: any) =>
        gesture.dy > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_: any, gesture: any) => {
        if (gesture.dy > 110 && gesture.vy > 0.15) {
          handleDismiss(() => onHomePress?.());
        }
      },
      onPanResponderTerminate: (_: any, gesture: any) => {
        if (gesture.dy > 110 && gesture.vy > 0.15) {
          handleDismiss(() => onHomePress?.());
        }
      },
    })
  ).current;

  // Load-timeout safety net: if an ad is supposed to show but never actually starts
  // playing within a few seconds, skip it and play the video. Cleared once the ad starts.
  useEffect(() => {
    if (adFallbackTimerRef.current) {
      clearTimeout(adFallbackTimerRef.current);
      adFallbackTimerRef.current = null;
    }

    if (!shouldShowAd) return;

    adFallbackTimerRef.current = setTimeout(() => {
      setShowAd(false);
      setAdDone(true);
      try {
        player.play();
      } catch {
        // Ignore play race.
      }
    }, 8000);

    return () => {
      if (adFallbackTimerRef.current) {
        clearTimeout(adFallbackTimerRef.current);
        adFallbackTimerRef.current = null;
      }
    };
  }, [player, shouldShowAd]);

  // Once the ad actually starts playing, cancel the load-timeout so a normal-length ad
  // isn't cut off (the user can still skip via the ad's own skip button).
  const handleAdStart = useCallback(() => {
    if (adFallbackTimerRef.current) {
      clearTimeout(adFallbackTimerRef.current);
      adFallbackTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    void loadWatchProgress();
    lastSavedProgressRef.current = 0;
    return () => {
      void saveWatchProgress(true);
    };
  }, [loadWatchProgress, saveWatchProgress]);

  useEffect(() => {
    void saveWatchProgress(false);
  }, [currentTime, saveWatchProgress]);

  const handleAdComplete = useCallback(() => {
    setAdDone(true);
    setShowAd(false);
    player.play();
  }, [player]);

  const handleAdError = useCallback(() => {
    // Ad failed to load, just play the video
    setAdDone(true);
    setShowAd(false);
    player.play();
  }, [player]);

  const fetchComments = useCallback(async () => {
    try {
      const { data: allComments } = await supabase
        .from('comments')
        .select('*')
        .eq('video_id', video.id)
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
        const enhanced: CommentWithProfile = {
          ...c,
          profile: profileMap.get(c.user_id),
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
      console.warn('Video comments failed to load:', error);
      setComments([]);
    }
  }, [video.id]);

  const handleFirstFrameRender = useCallback(() => {
    setFirstFrameRendered(true);
  }, []);

  // Check auth
  useEffect(() => {
    const syncCurrentUser = async () => {
      try {
        const id = await getCurrentSupabaseUserId();
        setCurrentUserId(id);
      } catch (error) {
        console.warn('Current user sync failed:', error);
      }
    };

    syncCurrentUser();
  }, []);

  useEffect(() => {
    setDisplayViews(video.views);
  }, [video.id, video.views]);

  useEffect(() => {
    let cancelled = false;
    const handle = InteractionManager.runAfterInteractions(() => {
      const loadChannel = async () => {
        try {
          const { data } = await supabase
            .from('channels')
            .select('*')
            .eq('id', video.channel_id)
            .single();

          if (!data || cancelled) return;
          setChannel(data);

          // Use the channel's trigger-maintained tapiners column (counting the tapins table
          // returns 0 under RLS). Keeps the count identical to every other screen.
          if (!cancelled) {
            setChannelTapinCount(data.tapiners ?? 0);
          }

          const { data: prof } = await supabase
            .from('profiles')
            .select('is_verified, verification_type')
            .eq('user_id', data.user_id)
            .single();

          if (!cancelled && prof?.is_verified) {
            setIsVerified(true);
            setVerificationType(prof.verification_type || null);
          }
        } catch (error) {
          console.warn('Video channel failed to load:', error);
        }
      };

      const loadRelated = async () => {
        try {
          const { data } = await supabase
            .from('videos')
            .select('*')
            .eq('status', 'published')
            .neq('id', video.id)
            .limit(10);
          if (!cancelled && data) setRelatedVideos(data);
        } catch (error) {
          console.warn('Related videos failed to load:', error);
        }
      };

      const syncViews = async () => {
        try {
          const { data } = await supabase
            .from('videos')
            .select('views')
            .eq('id', video.id)
            .maybeSingle();

          if (cancelled) {
            return;
          }

          const currentViews = typeof data?.views === 'number' ? data.views : video.views;

          if (viewedVideoIds.has(video.id)) {
            setDisplayViews(currentViews);
            return;
          }

          const nextViews = currentViews + 1;
          viewedVideoIds.add(video.id);
          setDisplayViews(nextViews);

          const { error } = await supabase
            .from('videos')
            .update({ views: nextViews })
            .eq('id', video.id);

          if (error) {
            console.warn('View count update failed:', error.message);
          }
        } catch (error) {
          console.warn('Video view sync failed:', error);
        }
      };

      void loadChannel();
      void loadRelated();
      void syncViews();
    });

    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [video.channel_id, video.id, video.views]);

  useEffect(() => {
    if (!channel || !currentUserId) {
      setHasTapped(false);
      return;
    }

    supabase
      .from('tapins')
      .select('id')
      .eq('user_id', currentUserId)
      .eq('channel_id', channel.id)
      .maybeSingle()
      .then(({ data }: { data: { id: string } | null }) => {
        setHasTapped(!!data);
      });
  }, [channel, currentUserId]);

  const handleTapIn = async () => {
    try {
      if (!currentUserId || !channel) return;

      const { data: existingTap } = await supabase
        .from('tapins')
        .select('id')
        .eq('user_id', currentUserId)
        .eq('channel_id', channel.id)
        .maybeSingle();

      if (existingTap) {
        setHasTapped(true);
        return;
      }

      const { error } = await supabase.from('tapins').insert({
        user_id: currentUserId,
        channel_id: channel.id,
      });

      if (error) {
        Alert.alert('Error', error.message);
        return;
      }

      // DB trigger bumps channels.tapiners; reflect optimistically (re-counting returns 0 under RLS).
      const nextTapiners = (channelTapinCount ?? channel.tapiners ?? 0) + 1;
      setChannelTapinCount(nextTapiners);
      setChannel({ ...channel, tapiners: nextTapiners });
      setHasTapped(true);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Kon de tap niet opslaan.');
    }
  };

  // Check if liked & load comments
  useEffect(() => {
    if (currentUserId) {
      supabase
        .from('video_likes')
        .select('id')
        .eq('video_id', video.id)
        .eq('user_id', currentUserId)
        .maybeSingle()
        .then(({ data }: { data: { id: string } | null }) => { if (data) setLiked(true); });
    }
    fetchComments();
  }, [video.id, currentUserId, fetchComments]);

  const handleLike = useCallback(async () => {
      if (!currentUserId) {
        setAuthPromptVisible(true);
        return;
      }
    try {
      if (liked) {
        await supabase
          .from('video_likes')
          .delete()
          .eq('video_id', video.id)
          .eq('user_id', currentUserId);
        setLiked(false);
        setLikeCount((count: number) => Math.max(0, count - 1));
      } else {
        await supabase
          .from('video_likes')
          .insert({ video_id: video.id, user_id: currentUserId, like_type: 'like' });
        setLiked(true);
        setLikeCount((count: number) => count + 1);
      }
    } catch (error: any) {
      Alert.alert('Fout', error.message || 'Kon de like niet opslaan.');
    }
  }, [currentUserId, liked, video.id]);

  const DOUBLE_TAP_DELAY = 280;
  const SIDE_ZONE_RATIO = 0.33; // left/right 33% each, center 34%

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

/// Changed Position
   const handleTogglePlayback = useCallback(() => {
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

     const handleSeek = useCallback(
       (seconds: number) => {
         try {
           player.seekBy(seconds);
         } catch {
           const safeDuration = duration > 0 ? duration : video.duration || 0;
           const nextTime = Math.max(0, Math.min(safeDuration || Number.MAX_SAFE_INTEGER, currentTime + seconds));
           player.currentTime = nextTime;
         }
       },
       [currentTime, duration, player, video.duration]
     );

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
        handleSeek(10);
        triggerSeekFeedback('forward');
      } else if (zone === 'left') {
        handleSeek(-10);
        triggerSeekFeedback('backward');
      }
      // zone === 'center' par double-tap ka koi action nahi (like ab sirf heart icon se)
      return;
    }

    lastTapRef.current = now;
    lastTapZoneRef.current = zone;

    singleTapTimeoutRef.current = setTimeout(() => {
      handleTogglePlayback();
      triggerPlayPauseFeedback();
      lastTapZoneRef.current = null;
    }, DOUBLE_TAP_DELAY);
  }, [handleSeek, handleTogglePlayback, triggerSeekFeedback]);


  // AB YE KARO:
  const handleShare = async () => {
    try {
      await Share.share({
        message: `${video.title}\nhttps://lukuluku.online/watch/${video.id}`,
      });
    } catch (error) {
      console.warn('Share failed:', error);
    }
  };

  const parseStorageObject = (publicUrl: string) => {
    const marker = '/storage/v1/object/public/';
    const index = publicUrl.indexOf(marker);
    if (index === -1) return null;
    const relative = publicUrl.slice(index + marker.length);
    const [bucket, ...rest] = relative.split('/');
    if (!bucket || rest.length === 0) return null;
    return { bucket, path: rest.join('/') };
  };

  const handleDeleteVideo = () => {
    if (!channel || channel.user_id !== currentUserId || deleting) return;

    Alert.alert(
      'Video verwijderen',
      'Weet je zeker dat je deze video wilt wissen? Dit kan niet ongedaan worden gemaakt.',
      [
        { text: 'Annuleren', style: 'cancel' },
        {
          text: 'Verwijderen',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await supabase.from('comments').delete().eq('video_id', video.id);
              await supabase.from('video_likes').delete().eq('video_id', video.id);

              for (const url of [video.video_url, video.thumbnail_url].filter(Boolean) as string[]) {
                const parsed = parseStorageObject(url);
                if (parsed) {
                  await supabase.storage.from(parsed.bucket).remove([parsed.path]);
                }
              }

              const { error } = await supabase.from('videos').delete().eq('id', video.id);
              if (error) throw new Error(error.message);

              onBack();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Kon de video niet verwijderen.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  const openCommentProfile = useCallback(async (userId: string) => {
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
      console.warn('Open comment profile failed:', error);
    }
  }, [onChannelPress]);

  const handleReportVideo = useCallback(async () => {
    if (!video) return;
    const activeUserId = currentUserId || (await getCurrentSupabaseUserId());
    if (!activeUserId) {
      Alert.alert('Report', 'Please sign in first.');
      return;
    }

    await saveReportDraft({
      contentType: 'video',
      contentId: video.id,
      targetUserId: video.user_id,
      reporterUserId: activeUserId,
      reason: 'Inappropriate content',
      details: video.title,
    });
    await blockUser(video.user_id);
    Alert.alert('Report submitted', 'The video was reported and the creator was blocked on this device.');
  }, [currentUserId, video]);

  const handleSubmitComment = async () => {
      if (!currentUserId) {
        setAuthPromptVisible(true);
        return;
      }
    const text = commentText.trim();
    if (!text || submitting) return;

    setSubmitting(true);
    const payload: any = {
      video_id: video.id,
      user_id: currentUserId,
      content: text,
    };
    if (replyTo) {
      payload.parent_id = replyTo.id;
    }

    try {
      const { error } = await supabase.from('comments').insert(payload);
      if (error) {
        Alert.alert('Fout', error.message);
        return;
      }

      setCommentText('');
      setReplyTo(null);
      setShowComments(true);
      await fetchComments();

      if (channel?.user_id && channel.user_id !== currentUserId) {
        await insertNotification({
          user_id: channel.user_id,
          actor_id: currentUserId,
          type: 'comment',
          video_id: video.id,
        });
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
            video_id: video.id,
          });
        }
      }
    } catch (error: any) {
      Alert.alert('Fout', error.message || 'Kon de reactie niet plaatsen.');
    } finally {
      setSubmitting(false);
    }
  };

  const totalComments = comments.reduce(
    (acc: number, c: CommentWithProfile) => acc + 1 + (c.replies?.length || 0),
    0
  );

  const canResponseLink = !!currentUserId && video.user_id !== currentUserId;
  const sourceKind = video.is_short ? 'short' : 'video';

  const handlePickResponse = useCallback(
    async (item: MediaItem) => {
      if (!currentUserId) {
              setAuthPromptVisible(true);
              return;
            }

      try {
        const responseKind = item.kind === 'short' || item.is_short ? 'short' : 'video';
        const responseRow: ResponseFeedItem = {
          ...item,
          responseRowId: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          responseVideoId: item.id,
          responseType: 'response',
        };

        setOptimisticResponses((prev: ResponseFeedItem[]) => [...prev, responseRow]);
        setShowResponsePicker(false);

        const { error } = await supabase.from('video_responses').insert({
          source_video_id: video.id,
          source_kind: sourceKind,
          response_video_id: item.id,
          response_kind: responseKind,
          response_type: video.is_short ? 'duet' : 'response',
          user_id: currentUserId,
        });

        if (error) {
          setOptimisticResponses((prev: ResponseFeedItem[]) => prev.filter((entry) => entry.responseVideoId !== item.id));
          Alert.alert('Fout', error.message);
        }
      } catch (error: any) {
        setOptimisticResponses((prev: ResponseFeedItem[]) => prev.filter((entry) => entry.responseVideoId !== item.id));
        Alert.alert('Fout', error.message || 'Kon de reactie niet opslaan.');
      }
    },
    [currentUserId, sourceKind, video.id, video.is_short]
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Video player with pre-roll ad */}
      <View style={styles.playerContainer} {...panResponder.panHandlers}>
        {shouldShowAd ? (
          <PreRollAd
            creativeUrl={selectedAd?.creative_url ?? undefined}
            ctaUrl={selectedAd?.cta_url ?? undefined}
            companyName={selectedAd?.company_name ?? undefined}
            skipAfterSeconds={5}
            onStart={handleAdStart}
            onComplete={handleAdComplete}
            onError={handleAdError}
          />
        ) : (
          <>
            <VideoPlayerMedia
              player={player}
              onFirstFrameRender={handleFirstFrameRender}
              isVideoLoading={isVideoLoading}
            />
            {!shouldShowAd && playableVideoUrl ? (
              <>
                <Pressable style={styles.doubleTapLayer} onPress={handleVideoTap} />
                <VideoReactionsLayer player={player} videoId={video.id} currentUserId={currentUserId} />
              </>
            ) : null}
          </>
        )}
        <View style={styles.controlsOverlay} pointerEvents="box-none">
          <View style={styles.topControlsRow} pointerEvents="box-none">
            <TouchableOpacity style={styles.backBtn} onPress={() => handleDismiss(onBack)} activeOpacity={0.85}>
              <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.homeBtn} onPress={() => handleDismiss(() => onHomePress?.())} hitSlop={8} activeOpacity={0.85}>
              <Image source={require('../assets/luku_luku_512.png')} style={styles.homeLogo} contentFit="cover" />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity style={styles.topActionBtn} onPress={handleLike} activeOpacity={0.85}>
              <Ionicons name={liked ? 'heart' : 'heart-outline'} size={22} color={liked ? colors.primary : '#FFFFFF'} />
            </TouchableOpacity>

         </View>

         {/* Buttons Walay Code Ki Jagah */}
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
         <Ionicons name={isPlaying ? 'play' : 'pause'} size={32} color="#FFFFFF" />
       </Animated.View>
     )}
     </View>
     </View>


      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Title & stats */}
        <Text style={styles.title}>{video.title}</Text>
        <Text style={styles.stats}>
          {formatViews(displayViews)} {t('video.views')}
          {video.duration ? ` · ${formatDuration(video.duration)}` : ''}
          · {formatTimeAgo(video.created_at)}
        </Text>
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

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={handleLike}
          >
            <Ionicons
              name={liked ? 'heart' : 'heart-outline'}
              size={22}
              color={liked ? colors.primary : colors.text}
            />
            <Text style={[styles.actionText, liked && { color: colors.primary }]}>
              {likeCount}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => setShowComments(!showComments)}
          >
            <Ionicons name="chatbubble-outline" size={20} color={colors.text} />
            <Text style={styles.actionText}>{totalComments}</Text>
          </TouchableOpacity>
          {canResponseLink && (
            <TouchableOpacity style={styles.actionBtn} onPress={() => setShowResponsePicker(true)}>
              <Ionicons name="return-up-back-outline" size={20} color={colors.text} />
              <Text style={styles.actionText}>{video.is_short ? 'Duet' : 'Reageer met video'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.actionBtn} onPress={handleShare}>
            <Ionicons name="share-social-outline" size={20} color={colors.text} />
            <Text style={styles.actionText}>{t('video.share')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={() => setReportPrompt(true)}>
            <Ionicons name="flag-outline" size={20} color={colors.text} />
            <Text style={styles.actionText}>Report</Text>
          </TouchableOpacity>
           {channel && channel.user_id === currentUserId && (
            <TouchableOpacity style={styles.deleteActionBtn} onPress={handleDeleteVideo} disabled={deleting}>
              {deleting ? (
                <ActivityIndicator size="small" color={colors.text} />
              ) : (
                <Ionicons name="trash-outline" size={20} color={colors.text} />
              )}
              <Text style={styles.actionText}>Delete</Text>
            </TouchableOpacity>
          )}
        </View>

        <Modal visible={reportPrompt} transparent animationType="fade" onRequestClose={() => setReportPrompt(false)}>
          <View style={styles.reportOverlay}>
            <View style={styles.reportCard}>
              <Text style={styles.reportTitle}>Report this content as inappropriate?</Text>
              <Text style={styles.reportMessage}>Are you sure?</Text>
              <View style={styles.reportActions}>
                <TouchableOpacity style={styles.reportCancelBtn} onPress={() => setReportPrompt(false)}>
                  <Text style={styles.reportCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.reportSubmitBtn}
                  onPress={async () => {
                    setReportPrompt(false);
                    await handleReportVideo();
                  }}
                >
                  <Text style={styles.reportSubmitText}>Report</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Channel */}
        {channel && (
          <TouchableOpacity
            style={styles.channelRow}
            onPress={() => onChannelPress(channel.id)}
          >
            {channel.avatar_url ? (
              <Image source={{ uri: channel.avatar_url }} style={styles.channelAvatar} contentFit="cover" cachePolicy="memory-disk" transition={0} />
            ) : (
              <View style={[styles.channelAvatar, styles.avatarPlaceholder]}>
                <Ionicons name="person" size={18} color={colors.textTertiary} />
              </View>
            )}
            <View style={styles.channelInfo}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Text style={styles.channelName}>{channel.name}</Text>
                <VerifiedBadge isVerified={isVerified} verificationType={verificationType} size={14} />
              </View>
              <Text style={styles.channelSubs}>{channelTapinCount ?? channel.tapiners} tapiners</Text>
            </View>
            <TouchableOpacity
              style={[styles.tapInBtn, hasTapped && styles.tapInBtnActive]}
              onPress={handleTapIn}
              disabled={hasTapped}
            >
              <Text style={[styles.tapInText, hasTapped && styles.tapInTextActive]}>
                {hasTapped ? 'TAPINED' : t('video.tapIn')}
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        )}

        {/* Description */}
        {video.description && (
          <View style={styles.descriptionBox}>
            <LinkedText style={styles.descriptionText}>{video.description}</LinkedText>
          </View>
        )}

        <ResponsesList
          sourceId={video.id}
          onPressMedia={onVideoPress}
          optimisticResponses={optimisticResponses}
        />

        {/* Comments */}
        {showComments && (
          <View style={styles.commentsSection}>
            <Text style={styles.sectionTitle}>
              {t('video.comments')} ({totalComments})
            </Text>
            {comments.length === 0 ? (
              <Text style={styles.noComments}>{t('video.noComments')}</Text>
            ) : (
              comments.map((comment: CommentWithProfile) => (
                <React.Fragment key={comment.id}>
                  <VideoCommentThread
                    comment={comment}
                    onReply={(id, name) => setReplyTo({ id, name })}
                    onProfilePress={openCommentProfile}
                  />
                </React.Fragment>
              ))
            )}
          </View>
        )}

        {/* Related videos */}
        <View style={styles.relatedSection}>
          <Text style={styles.sectionTitle}>{t('video.moreVideos')}</Text>
          {relatedVideos.map((rv: Video) => (
            <TouchableOpacity
              key={rv.id}
              style={styles.relatedVideoRow}
              onPress={() => {
                player.pause();
                void saveWatchProgress(true);
                onVideoPress(rv);
              }}
            >
              {rv.thumbnail_url ? (
                <Image source={{ uri: rv.thumbnail_url }} style={styles.relatedThumb} contentFit="cover" cachePolicy="memory-disk" transition={0} />
              ) : (
                <View style={[styles.relatedThumb, styles.thumbPlaceholder]}>
                  <Ionicons name="play-circle" size={20} color={colors.textTertiary} />
                </View>
              )}
              <View style={styles.relatedInfo}>
                <Text style={styles.relatedTitle} numberOfLines={2}>{rv.title}</Text>
                <Text style={styles.relatedMeta}>
                  {formatViews(rv.views)} weergaven · {formatTimeAgo(rv.created_at)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* Comment input bar */}
      <View style={[styles.commentInputBar, { paddingBottom: insets.bottom + spacing.sm }]}>
        {replyTo && (
          <View style={styles.replyIndicator}>
            <Text style={styles.replyIndicatorText}>
              · {t('video.reply')} @{replyTo.name}
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
            maxLength={500}
            editable={!!currentUserId}
            onFocus={() => setShowComments(true)}
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

      <ResponsePickerModal
              visible={showResponsePicker}
              sourceId={video.id}
              sourceKind={sourceKind}
              sourceUserId={video.user_id}
              responseType={video.is_short ? 'duet' : 'response'}
              currentUserId={currentUserId}
              onClose={() => setShowResponsePicker(false)}
              onPick={handlePickResponse}
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
          </KeyboardAvoidingView>
        );
      }

// Comment thread with replies
function VideoCommentThread({
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
  const [showReplies, setShowReplies] = useState(depth === 0);
  const replies = comment.replies || [];
  const displayName = comment.profile?.display_name || 'Gebruiker';

  return (
    <View style={[styles.commentItem, depth > 0 && styles.replyItem]}>
      <View style={styles.commentRow}>
        <TouchableOpacity onPress={() => onProfilePress(comment.user_id)} activeOpacity={0.8}>
          {comment.profile?.avatar_url ? (
            <Image
              source={{ uri: comment.profile.avatar_url }}
              style={[styles.commentAvatar, depth > 0 && styles.replyAvatar]}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.commentAvatar, depth > 0 && styles.replyAvatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={depth > 0 ? 10 : 12} color={colors.textTertiary} />
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.commentContent}>
          <View style={styles.commentMeta}>
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
              <Text style={styles.replyBtnText}>{t('video.reply')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>

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
          <React.Fragment key={reply.id}>
            <VideoCommentThread
              comment={reply}
              onReply={onReply}
              onProfilePress={onProfilePress}
              depth={depth + 1}
            />
          </React.Fragment>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  playerContainer: {
    width,
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    position: 'relative',
  },
homeLogo: {
  width: 28,
  height: 28,
  borderRadius: 14,
},
  player: { width: '100%', height: '100%' },
  doubleTapLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
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
seekFeedbackText: {
  color: '#FFFFFF',
  fontSize: fontSize.sm,
  fontWeight: '600',
},
seekFeedbackCenter: {
  alignSelf: 'center',
  width: 65,
  height: 65,
  borderRadius: 100,
},
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 40,
    elevation: 40,
  },
  topControlsRow: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    right: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  topActionBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  homeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    marginLeft: spacing.sm,
  },
  playbackControlsRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.xl + 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
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
  content: { flex: 1 },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    lineHeight: 24,
  },
  stats: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.lg,
    marginTop: 4,
  },
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
  actions: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
    flexWrap: 'wrap',
  },
  deleteActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  reportOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  reportCard: {
    backgroundColor: colors.background,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  reportTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  reportMessage: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  reportActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  reportCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
  },
  reportCancelText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  reportSubmitBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: colors.tapIn,
    alignItems: 'center',
  },
  reportSubmitText: {
    color: colors.textInverse,
    fontSize: fontSize.sm,
    fontWeight: '700',
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
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  channelAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  avatarPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  channelInfo: {
    flex: 1,
    marginLeft: spacing.md,
  },
  channelName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  channelSubs: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
  tapInBtn: {
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
  },
  tapInBtnActive: {
    backgroundColor: colors.surfaceLight,
  },
  tapInText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  tapInTextActive: {
    color: colors.textSecondary,
  },
  descriptionBox: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  descriptionText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  commentsSection: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  noComments: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  // Comment styles
  commentItem: { marginBottom: spacing.md },
  replyItem: { marginLeft: 36, marginTop: spacing.sm },
  commentRow: { flexDirection: 'row', gap: spacing.md },
  commentAvatar: { width: 32, height: 32, borderRadius: 16 },
  replyAvatar: { width: 24, height: 24, borderRadius: 12 },
  commentContent: { flex: 1 },
  commentMeta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  commentAuthor: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  commentTime: { color: colors.textTertiary, fontSize: fontSize.xs, marginLeft: 'auto' },
  commentText: { color: colors.text, fontSize: fontSize.md, lineHeight: 20, marginTop: 2 },
  commentActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.xs },
  commentActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  commentLikeCount: { color: colors.textTertiary, fontSize: fontSize.xs },
  replyBtnText: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' },
  viewRepliesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: 44,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  replyLine: { width: 24, height: 1, backgroundColor: colors.textTertiary },
  viewRepliesText: { color: colors.tapIn, fontSize: fontSize.xs, fontWeight: '600' },
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
  replyIndicatorText: { color: colors.tapIn, fontSize: fontSize.xs, fontWeight: '500' },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
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
  sendBtnDisabled: { opacity: 0.4 },
  // Related
  relatedSection: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  relatedVideoRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  relatedThumb: {
    width: 160,
    height: 90,
    borderRadius: borderRadius.md,
  },
  thumbPlaceholder: {
    backgroundColor: colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  relatedInfo: { flex: 1, justifyContent: 'center' },
  relatedTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '500',
    lineHeight: 20,
  },
  relatedMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 4,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  playerFallback: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playerFallbackText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});

// Comment thread with replies