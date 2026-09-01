import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
  Alert,
  Animated,
  Easing,
  Dimensions,
  ScrollView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { Image } from './AppImage';
import { useEvent } from 'expo';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { formatTimeAgo, formatViews, isMomentiDuration } from '../lib/utils';
import { supabase, type Video, type Short, type VideoResponse, type VideoReaction, type Channel } from '../lib/supabase';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

const EMOJIS = ['😂', '❤️', '🔥', '😮', '😢', '👏', '🇸🇷'] as const;
const BUBBLE_DURATION = 2500;

type MediaKind = 'video' | 'short';
type SourceKind = 'video' | 'short';
type ResponseType = 'response' | 'duet';

export type MediaItem = {
  id: string;
  kind: MediaKind;
  channel_id: string;
  user_id: string;
  title: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
  views: number;
  likes: number;
  dislikes: number;
  created_at: string;
  duration: number | null;
  is_short: boolean;
};

export type ResponseFeedItem = MediaItem & {
  responseRowId: string;
  responseVideoId: string;
  responseType: ResponseType;
};

type Bubble = {
  id: string;
  emoji: string;
  leftPercent: number;
  opacity: any;
  translateY: any;
};

function mediaItemToVideo(item: MediaItem): Video {
  return {
    id: item.id,
    channel_id: item.channel_id,
    user_id: item.user_id,
    title: item.title,
    description: item.description,
    thumbnail_url: item.thumbnail_url,
    video_url: item.video_url,
    duration: item.duration,
    views: item.views,
    likes: item.likes,
    dislikes: item.dislikes,
    status: 'published',
    is_short: item.is_short,
    created_at: item.created_at,
  };
}

function mediaItemLabel(item: MediaItem): string {
  return item.kind === 'short' || isMomentiDuration(item.duration, item.is_short) ? 'Momenti' : 'Video';
}

function MediaCard({ item, channelName, onPress }: { item: MediaItem; channelName: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.mediaCard} onPress={onPress} activeOpacity={0.88}>
      {item.thumbnail_url ? (
        <Image source={{ uri: item.thumbnail_url }} style={styles.mediaThumb} contentFit="cover" />
      ) : (
        <View style={[styles.mediaThumb, styles.mediaThumbPlaceholder]}>
          <Ionicons name="play-circle" size={28} color={colors.textTertiary} />
        </View>
      )}
      <View style={styles.mediaMeta}>
        <Text style={styles.mediaType}>{mediaItemLabel(item)}</Text>
        <Text style={styles.mediaTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.mediaChannel} numberOfLines={1}>
          {channelName}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

export function ResponsePickerModal({
  visible,
  sourceId,
  sourceKind,
  sourceUserId,
  responseType,
  currentUserId,
  onClose,
  onPick,
}: {
  visible: boolean;
  sourceId: string;
  sourceKind: SourceKind;
  sourceUserId: string | null;
  responseType: ResponseType;
  currentUserId: string | null;
  onClose: () => void;
  onPick: (item: MediaItem) => void;
}) {
  const [videos, setVideos] = useState<MediaItem[]>([]);
  const [momenti, setMomenti] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!visible || !currentUserId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);

      try {
        const [videosRes, shortsRes] = await Promise.all([
          supabase
            .from('videos')
            .select('id, channel_id, user_id, title, description, video_url, thumbnail_url, views, likes, dislikes, duration, created_at, is_short, status')
            .eq('user_id', currentUserId)
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(20),
          supabase
            .from('shorts')
            .select('id, channel_id, user_id, title, description, video_url, thumbnail_url, views, likes, dislikes, created_at, status')
            .eq('user_id', currentUserId)
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .limit(20),
        ]);

        const mappedVideos: MediaItem[] = (videosRes.data || []).map((item: any) => ({
          id: item.id,
          channel_id: item.channel_id,
          user_id: item.user_id,
          title: item.title,
          description: item.description,
          video_url: item.video_url,
          thumbnail_url: item.thumbnail_url,
          views: item.views,
          likes: item.likes,
          dislikes: item.dislikes,
          created_at: item.created_at,
          duration: item.duration ?? null,
          is_short: Boolean(item.is_short),
          kind: 'video' as const,
        }));

        const mappedMomenti: MediaItem[] = (shortsRes.data || []).map((item: any) => ({
          id: item.id,
          channel_id: item.channel_id,
          user_id: item.user_id,
          title: item.title,
          description: item.description,
          video_url: item.video_url,
          thumbnail_url: item.thumbnail_url,
          views: item.views,
          likes: item.likes,
          dislikes: item.dislikes,
          created_at: item.created_at,
          duration: null,
          is_short: true,
          kind: 'short' as const,
        }));

        const channelIds = [...new Set([...mappedVideos, ...mappedMomenti].map((item) => item.channel_id))];
        let nameMap: Record<string, string> = {};
        if (channelIds.length > 0) {
          const { data: channels } = await supabase.from('channels').select('id, name').in('id', channelIds);
          nameMap = Object.fromEntries((channels || []).map((channel: Channel) => [channel.id, channel.name]));
        }

        if (!cancelled) {
          setVideos(mappedVideos);
          setMomenti(mappedMomenti);
          setChannelNames(nameMap);
        }
      } catch (error) {
        console.warn('Response picker failed to load:', error);
        if (!cancelled) {
          setVideos([]);
          setMomenti([]);
          setChannelNames({});
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [visible, currentUserId]);

  const sections = [
    { key: 'videos', title: 'Video’s', data: videos },
    { key: 'momenti', title: 'Momenti', data: momenti },
  ].filter((section) => section.data.length > 0);

  const handlePick = useCallback(
    (item: MediaItem) => {
      if (!currentUserId) {
        Alert.alert('Log in om te reageren');
        return;
      }
      if (item.user_id === sourceUserId && item.id === sourceId) {
        Alert.alert('Je kunt je eigen bron niet linken');
        return;
      }
      onPick(item);
    },
    [currentUserId, onPick, sourceId, sourceUserId]
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <TouchableOpacity style={StyleSheet.absoluteFillObject} activeOpacity={1} onPress={onClose} />
        <View style={styles.pickerSheet}>
          <BlurView intensity={24} tint="dark" style={styles.pickerBlur}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{responseType === 'duet' ? 'Duet' : 'Reageer met video'}</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Ionicons name="close" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false}>
              {loading ? (
                <View style={styles.loadingWrap}>
                  <Text style={styles.loadingText}>Laden…</Text>
                </View>
              ) : sections.length === 0 ? (
                <Text style={styles.emptyText}>Geen eigen video's gevonden.</Text>
              ) : (
                sections.map((section) => (
                  <View key={section.key} style={styles.sectionBlock}>
                    <Text style={styles.sectionTitle}>{section.title}</Text>
                    <FlatList
                      data={section.data}
                      keyExtractor={(item: MediaItem) => item.id}
                      numColumns={2}
                      scrollEnabled={false}
                      columnWrapperStyle={styles.gridRow}
                      renderItem={({ item }: { item: MediaItem }) => (
                        <MediaCard
                          item={item}
                          channelName={channelNames[item.channel_id] || ''}
                          onPress={() => handlePick(item)}
                        />
                      )}
                    />
                  </View>
                ))
              )}
            </ScrollView>
          </BlurView>
        </View>
      </View>
    </Modal>
  );
}

export function ResponsesList({
  sourceId,
  onPressMedia,
  refreshToken = 0,
  optimisticResponses = [],
}: {
  sourceId: string;
  onPressMedia: (video: Video) => void;
  refreshToken?: number;
  optimisticResponses?: ResponseFeedItem[];
}) {
  const [responses, setResponses] = useState<ResponseFeedItem[]>([]);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const { data: responseRows } = await supabase
        .from('video_responses')
        .select('*')
        .eq('source_video_id', sourceId)
        .order('created_at', { ascending: false });

      if (!responseRows || responseRows.length === 0) {
        setResponses(optimisticResponses);
        setChannelNames({});
        return;
      }

      const videoIds = responseRows.filter((row: VideoResponse) => row.response_kind === 'video').map((row: VideoResponse) => row.response_video_id);
      const shortIds = responseRows.filter((row: VideoResponse) => row.response_kind === 'short').map((row: VideoResponse) => row.response_video_id);

      const [videosRes, shortsRes] = await Promise.all([
        videoIds.length > 0
          ? supabase
              .from('videos')
              .select('id, channel_id, user_id, title, description, video_url, thumbnail_url, views, likes, dislikes, duration, created_at, is_short')
              .in('id', videoIds)
          : Promise.resolve({ data: [] as any[] }),
        shortIds.length > 0
          ? supabase
              .from('shorts')
              .select('id, channel_id, user_id, title, description, video_url, thumbnail_url, views, likes, dislikes, created_at')
              .in('id', shortIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const mapById = new Map<string, ResponseFeedItem>();

      (videosRes.data || []).forEach((item: any) => {
        mapById.set(item.id, {
          id: item.id,
          channel_id: item.channel_id,
          user_id: item.user_id,
          title: item.title,
          description: item.description,
          video_url: item.video_url,
          thumbnail_url: item.thumbnail_url,
          views: item.views,
          likes: item.likes,
          dislikes: item.dislikes,
          created_at: item.created_at,
          duration: item.duration ?? null,
          is_short: Boolean(item.is_short),
          kind: 'video',
          responseRowId: '',
          responseVideoId: item.id,
          responseType: 'response',
        });
      });

      (shortsRes.data || []).forEach((item: any) => {
        mapById.set(item.id, {
          id: item.id,
          channel_id: item.channel_id,
          user_id: item.user_id,
          title: item.title,
          description: item.description,
          video_url: item.video_url,
          thumbnail_url: item.thumbnail_url,
          views: item.views,
          likes: item.likes,
          dislikes: item.dislikes,
          created_at: item.created_at,
          duration: null,
          is_short: true,
          kind: 'short',
          responseRowId: '',
          responseVideoId: item.id,
          responseType: 'duet',
        });
      });

      const loaded = responseRows
        .map((row: VideoResponse) => {
          const media = mapById.get(row.response_video_id);
          if (!media) return null;
          return {
            ...media,
            responseRowId: row.id,
            responseVideoId: row.response_video_id,
            responseType: row.response_type,
          } as ResponseFeedItem;
        })
        .filter(Boolean) as ResponseFeedItem[];

      const merged = new Map<string, ResponseFeedItem>();
      [...optimisticResponses, ...loaded].forEach((item) => {
        merged.set(item.responseVideoId, item);
      });

      const finalResponses = [...merged.values()];

      const channelIds = [...new Set(finalResponses.map((item) => item.channel_id))];
      let names: Record<string, string> = {};
      if (channelIds.length > 0) {
        const { data: channels } = await supabase.from('channels').select('id, name').in('id', channelIds);
        names = Object.fromEntries((channels || []).map((channel: Channel) => [channel.id, channel.name]));
      }

      setResponses(finalResponses);
      setChannelNames(names);
    } catch (error) {
      console.warn('Responses list failed to load:', error);
      setResponses(optimisticResponses);
      setChannelNames({});
    } finally {
      setLoading(false);
    }
  }, [optimisticResponses, sourceId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  if (loading) {
    return (
      <View style={styles.responsesLoading}>
        <Text style={styles.loadingText}>Reacties laden…</Text>
      </View>
    );
  }

  if (responses.length === 0) {
    return null;
  }

  return (
    <View style={styles.responsesWrap}>
      <Text style={styles.sectionTitle}>Reacties op deze video ({responses.length})</Text>
      <FlatList
        data={responses}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item: ResponseFeedItem) => item.responseRowId || item.responseVideoId}
        contentContainerStyle={styles.responsesRow}
        renderItem={({ item }: { item: ResponseFeedItem }) => (
          <TouchableOpacity
            style={styles.responseCard}
            activeOpacity={0.9}
            onPress={() => onPressMedia(mediaItemToVideo(item))}
          >
            {item.thumbnail_url ? (
              <Image source={{ uri: item.thumbnail_url }} style={styles.responseThumb} contentFit="cover" />
            ) : (
              <View style={[styles.responseThumb, styles.mediaThumbPlaceholder]}>
                <Ionicons name="play-circle" size={28} color={colors.textTertiary} />
              </View>
            )}
            <Text style={styles.responseKind}>{item.responseType === 'duet' ? 'Duet' : 'Reactie'}</Text>
            <Text style={styles.responseTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={styles.responseChannel} numberOfLines={1}>
              {channelNames[item.channel_id] || ''}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

export function VideoReactionsLayer({
  player,
  videoId,
  currentUserId,
}: {
  player: any;
  videoId: string;
  currentUserId: string | null;
}) {
  const [reactions, setReactions] = useState<VideoReaction[]>([]);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const dedupeRef = useRef<Set<string>>(new Set());
  const lastSecondRef = useRef<number | null>(null);

  const { currentTime } = useEvent(player, 'timeUpdate', { currentTime: 0 });

  const removeBubble = useCallback((id: string) => {
    setBubbles((prev: Bubble[]) => prev.filter((bubble: Bubble) => bubble.id !== id));
  }, []);

  const spawnBubble = useCallback(
    (emoji: string, id: string) => {
      const bubble: Bubble = {
        id,
        emoji,
        leftPercent: 20 + Math.random() * 60,
        opacity: new Animated.Value(0),
        translateY: new Animated.Value(40),
      };

      setBubbles((prev: Bubble[]) => [...prev, bubble]);

      Animated.sequence([
        Animated.timing(bubble.opacity, {
          toValue: 1,
          duration: 120,
          useNativeDriver: true,
        }),
        Animated.parallel([
          Animated.timing(bubble.translateY, {
            toValue: -180,
            duration: BUBBLE_DURATION - 120,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(bubble.opacity, {
            toValue: 0,
            duration: BUBBLE_DURATION - 120,
            useNativeDriver: true,
          }),
        ]),
      ]).start(() => removeBubble(id));

      setTimeout(() => removeBubble(id), BUBBLE_DURATION);
    },
    [removeBubble]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const { data } = await supabase
          .from('video_reactions')
          .select('*')
          .eq('video_id', videoId)
          .order('created_at', { ascending: true });

        if (!cancelled) {
          setReactions((data || []) as VideoReaction[]);
        }
      } catch (error) {
        console.warn('Video reactions failed to load:', error);
        if (!cancelled) {
          setReactions([]);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [videoId]);

  useEffect(() => {
    if (!Number.isFinite(currentTime)) return;

    const second = Math.floor(currentTime);
    const previous = lastSecondRef.current;
    if (previous !== null && second < previous) {
      dedupeRef.current.clear();
    }
    lastSecondRef.current = second;

    reactions.forEach((reaction: VideoReaction) => {
      if (reaction.timestamp_seconds !== second) return;
      const dedupeKey = `${reaction.id}-${second}`;
      if (dedupeRef.current.has(dedupeKey)) return;
      dedupeRef.current.add(dedupeKey);
      spawnBubble(reaction.emoji, dedupeKey);
    });
  }, [currentTime, reactions, spawnBubble]);

  const handleEmojiPress = useCallback(
    async (emoji: string) => {
      if (!currentUserId) {
        setPickerOpen(false);
        Alert.alert('Log in om te reageren');
        return;
      }

      const timestampSeconds = Math.max(0, Math.floor(currentTime));
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const optimisticReaction: VideoReaction = {
        id: tempId,
        video_id: videoId,
        user_id: currentUserId,
        emoji,
        timestamp_seconds: timestampSeconds,
        created_at: new Date().toISOString(),
      };

      setReactions((prev: VideoReaction[]) => [...prev, optimisticReaction]);
      spawnBubble(emoji, tempId);
      setPickerOpen(false);

      const { error, data } = await supabase
        .from('video_reactions')
        .insert({
          video_id: videoId,
          user_id: currentUserId,
          emoji,
          timestamp_seconds: timestampSeconds,
        })
        .select('*')
        .single();

      if (error) {
        setReactions((prev: VideoReaction[]) => prev.filter((reaction: VideoReaction) => reaction.id !== tempId));
        Alert.alert('Fout', error.message);
        return;
      }

      if (data) {
        setReactions((prev: VideoReaction[]) => prev.map((reaction: VideoReaction) => (reaction.id === tempId ? (data as VideoReaction) : reaction)));
      }
    },
    [currentTime, currentUserId, spawnBubble, videoId]
  );

  const openPicker = useCallback(() => {
    if (!currentUserId) {
      setTooltipVisible(true);
      Alert.alert('Log in om te reageren');
      return;
    }
    setTooltipVisible(false);
    setPickerOpen((value: boolean) => !value);
  }, [currentUserId]);

  useEffect(() => {
    if (!tooltipVisible) return;
    const timer = setTimeout(() => setTooltipVisible(false), 1400);
    return () => clearTimeout(timer);
  }, [tooltipVisible]);

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFillObject}>
      {bubbles.map((bubble: Bubble) => (
        <Animated.View
          key={bubble.id}
          pointerEvents="none"
          style={[
            styles.bubble,
            {
              left: `${bubble.leftPercent}%`,
              opacity: bubble.opacity,
              transform: [{ translateY: bubble.translateY }],
            },
          ]}
        >
          <Text style={styles.bubbleText}>{bubble.emoji}</Text>
        </Animated.View>
      ))}

      <View style={styles.reactionDock} pointerEvents="box-none">
        {tooltipVisible && !currentUserId && (
          <View style={styles.tooltipBubble}>
            <Text style={styles.tooltipText}>Log in om te reageren</Text>
          </View>
        )}

        {pickerOpen && currentUserId && (
          <View style={styles.pickerBubble}>
            {EMOJIS.map((emoji) => (
              <TouchableOpacity key={emoji} style={styles.emojiChoice} onPress={() => void handleEmojiPress(emoji)} activeOpacity={0.9}>
                <Text style={styles.emojiChoiceText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <TouchableOpacity style={[styles.fabButton, !currentUserId && styles.fabButtonDisabled]} onPress={openPicker} activeOpacity={0.9}>
          <BlurView intensity={30} tint="dark" style={styles.fabBlur}>
            <Ionicons name="happy-outline" size={22} color="#FFFFFF" />
          </BlurView>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  pickerBlur: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    maxHeight: screenHeight * 0.78,
    padding: spacing.md,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionBlock: {
    marginTop: spacing.md,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  gridRow: {
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  mediaCard: {
    width: (screenWidth - spacing.lg * 2 - spacing.md * 2 - spacing.sm) / 2,
    marginBottom: spacing.sm,
  },
  mediaThumb: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: 16,
    backgroundColor: colors.surfaceLight,
  },
  mediaThumbPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaMeta: {
    paddingTop: spacing.xs,
  },
  mediaType: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginBottom: 2,
  },
  mediaTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    lineHeight: 18,
  },
  mediaChannel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  emptyText: {
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },
  loadingWrap: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  loadingText: {
    color: colors.textSecondary,
  },
  responsesWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  responsesLoading: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  responsesRow: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  responseCard: {
    width: 150,
    marginRight: spacing.sm,
    paddingTop:10,
  },
  responseThumb: {
    width: '100%',
    height: 84,
    borderRadius: 14,
    backgroundColor: colors.surfaceLight,
  },
  responseKind: {
    color: colors.tapIn,
    fontSize: fontSize.xs,
    fontWeight: '700',
    marginTop: 6,
  },
  responseTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    lineHeight: 18,
  },
  responseChannel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  bubble: {
    position: 'absolute',
    bottom: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubbleText: {
    fontSize: 34,
  },
  reactionDock: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    alignItems: 'flex-end',
    gap: spacing.sm,
    zIndex: 10,
  },
  fabButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    overflow: 'hidden',
    paddingTop:2,
  },
  fabButtonDisabled: {
    opacity: 0.5,
  },
  fabBlur: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  pickerBubble: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    width: 196,
    maxHeight: 110,
    overflow: 'hidden',
    gap: 9,
    borderRadius: 20,
    backgroundColor: 'rgba(12,12,12,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  emojiChoice: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',


  },
  emojiChoiceText: {
    fontSize: 22,
  },
  tooltipBubble: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  tooltipText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
});