import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from '../components/AppImage';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius, postBackgroundPresets } from '../lib/theme';
import { t } from '../lib/i18n';
import { normalizeDurationSeconds, formatDuration, isMomentiDuration } from '../lib/utils';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from '../lib/supabase';
import { ensureSupabaseProfile, getCurrentSupabaseUserId } from '../lib/auth';

interface CreatePostScreenProps {
  onBack: () => void;
  onPostCreated?: (postId: string) => void;
  onPublished?: () => void;
  mode?: 'post' | 'video' | 'momenti';
}

type PickedAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  duration?: number;
};

function SelectedVideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(
    {
      uri,
      contentType: 'progressive' as const,
    },
    (p: any) => {
      p.loop = true;
      p.volume = 0;
      p.muted = true;
      p.play();
    }
  );

  useEffect(() => {
    try {
      player.volume = 0;
      player.muted = true;
      player.play();
    } catch {
      // Keep the existing thumbnail/card fallback visible if preview playback races.
    }

    return () => {
      try {
        player.pause();
      } catch {
        // Ignore teardown races.
      }
    };
  }, [player]);

  return (
    <VideoView
      style={styles.selectedVideoPreview}
      player={player}
      contentFit="cover"
      nativeControls={false}
      useExoShutter={false}
    />
  );
}

export default function CreatePostScreen({ onBack, onPostCreated, onPublished, mode = 'post' }: CreatePostScreenProps) {
  const insets = useSafeAreaInsets();
  const isPostMode = mode === 'post';
  const isVideoMode = mode === 'video';
  const isMomentiMode = mode === 'momenti';
  const [content, setContent] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaName, setMediaName] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [mediaAsset, setMediaAsset] = useState<PickedAsset | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [thumbnailChoices, setThumbnailChoices] = useState<Array<{ uri: string; time: number }>>([]);
  const [selectedThumbnailUri, setSelectedThumbnailUri] = useState<string | null>(null);
  const [thumbnailLoading, setThumbnailLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [moderating, setModerating] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadEtaSeconds, setUploadEtaSeconds] = useState<number | null>(null);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [selectedBackgroundKey, setSelectedBackgroundKey] = useState(postBackgroundPresets[0].key);

  const selectedBackground = postBackgroundPresets.find((preset) => preset.key === selectedBackgroundKey) || postBackgroundPresets[0];

  useEffect(() => {
    getCurrentSupabaseUserId().then((id) => setUserId(id));
  }, []);

  const formatUploadEta = (seconds: number | null) => {
    if (seconds === null) return null;
    if (seconds <= 0) return 'bijna klaar';
    if (seconds < 60) return `nog ${seconds} sec`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `nog ${minutes}m ${rest.toString().padStart(2, '0')}s`;
  };

  const updateUploadProgress = (progress: number, startedAt: number) => {
    const clamped = Math.max(0, Math.min(1, progress));
    setUploadProgress(Math.round(clamped * 100));
    if (clamped > 0 && clamped < 1) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const remaining = Math.max(1, Math.ceil((elapsed * (1 - clamped)) / clamped));
      setUploadEtaSeconds(remaining);
    } else if (clamped >= 1) {
      setUploadEtaSeconds(0);
    } else {
      setUploadEtaSeconds(null);
    }
  };

  const uploadMediaToSupabase = async (
    bucket: string,
    folder: string,
    asset: PickedAsset,
    fallbackName: string,
    startedAt: number
  ) => {
    if (!userId) {
      throw new Error('Missing user id. Please reopen the composer.');
    }

    const mimeType = asset.mimeType || (fallbackName.endsWith('.mp4') || bucket === 'videos' ? 'video/mp4' : 'image/jpeg');
    const baseName = fallbackName || (mimeType.startsWith('video/') ? 'video.mp4' : 'image.jpg');
    const safeExt = (baseName.split('.').pop() || (mimeType.startsWith('video/') ? 'mp4' : 'jpg'))
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase() || (mimeType.startsWith('video/') ? 'mp4' : 'jpg');
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const path = `${userId}/${folder}/${fileName}`;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`;
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;

    if (!accessToken) {
      throw new Error('Session expired. Please sign in again.');
    }

    const fileResponse = await globalThis.fetch(asset.uri);
    if (!fileResponse.ok) {
      throw new Error('Could not read selected file.');
    }
    const body = await fileResponse.blob();

    return await new Promise<string>((resolve, reject) => {
      const xhr = new (globalThis as any).XMLHttpRequest();
      xhr.open('POST', uploadUrl);
      xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.setRequestHeader('content-type', mimeType);

      xhr.upload.onprogress = (event: any) => {
        if (!event.lengthComputable) return;
        updateUploadProgress(event.loaded / event.total, startedAt);
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          updateUploadProgress(1, startedAt);
          const { data } = supabase.storage.from(bucket).getPublicUrl(path);
          resolve(data.publicUrl);
          return;
        }

        reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
      };

      xhr.onerror = () => reject(new Error('Network request failed'));
      xhr.send(body as any);
    });
  };

  const formatVideoDuration = (value: number | null) => {
    const normalized = normalizeDurationSeconds(value);
    if (!normalized) return null;
    return normalized >= 60 ? `${formatDuration(normalized)}` : `${normalized} sec`;
  };

  const previewDurationLabel = mediaType === 'video'
    ? (videoDuration !== null ? `Duur: ${formatVideoDuration(videoDuration) || 'onbekend'}` : 'Duur onbekend')
    : null;

  const pickCustomThumbnail = async () => {
    if (!mediaUri || mediaType !== 'video') {
      Alert.alert('Error', 'Pick a video first.');
      return;
    }

    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        t('createPost.permissionNeeded' as any),
        t('createPost.permissionDesc' as any)
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.9,
      allowsMultipleSelection: false,
    });

    if (!result.canceled && result.assets[0]) {
      setSelectedThumbnailUri(result.assets[0].uri);
    }
  };

  const pickMedia = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        t('createPost.permissionNeeded' as any),
        t('createPost.permissionDesc' as any)
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: isPostMode ? 'images' : 'videos',
      allowsEditing: isPostMode,
      quality: 0.9,
      allowsMultipleSelection: false,
    });

    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0] as PickedAsset;
      setMediaUri(asset.uri);
      setMediaName(asset.fileName || null);
      setMediaAsset(asset);
      setMediaType(isPostMode ? 'image' : 'video');
      const normalizedDuration = normalizeDurationSeconds(asset.duration);
      setVideoDuration(!isPostMode ? normalizedDuration : null);
      setThumbnailChoices([]);
      setSelectedThumbnailUri(null);

      if (!isPostMode) {
        const duration = normalizedDuration || 0;
        const durationMs = duration > 0 ? duration * 1000 : 0;
        const offsets = durationMs > 0
          ? [Math.max(500, Math.floor(durationMs * 0.15)), Math.max(1000, Math.floor(durationMs * 0.5)), Math.max(1500, Math.floor(durationMs * 0.85))]
          : [500, 2000, 4500];

        setThumbnailLoading(true);
        try {
          const generated = await Promise.all(
            offsets.map(async (time) => {
              const thumb = await VideoThumbnails.getThumbnailAsync(asset.uri, { time });
              return { uri: thumb.uri, time };
            })
          );
          setThumbnailChoices(generated);
          setSelectedThumbnailUri(generated[0]?.uri || null);
        } catch (error) {
          console.warn('Thumbnail generation failed:', error);
          setThumbnailChoices([]);
          setSelectedThumbnailUri(null);
        } finally {
          setThumbnailLoading(false);
        }
      }
    }
  };

  const removeMedia = () => {
    setMediaUri(null);
    setMediaName(null);
    setMediaAsset(null);
    setMediaType(null);
    setVideoDuration(null);
    setThumbnailChoices([]);
    setSelectedThumbnailUri(null);
    setThumbnailLoading(false);
  };

  const handlePost = async () => {
    const text = content.trim();

    if (isPostMode) {
      if (!text && !mediaUri) {
        Alert.alert(t('createPost.emptyError' as any));
        return;
      }
    } else if (!mediaUri) {
      Alert.alert('Error', isVideoMode ? 'Select a video first.' : 'Select a Momenti first.');
      return;
    }

    const currentUserId = userId || (await getCurrentSupabaseUserId()) || (await ensureSupabaseProfile());
    if (!currentUserId) {
      Alert.alert(t('createPost.signInRequired' as any));
      return;
    }

    setUserId(currentUserId);
    setPosting(true);
    setModerating(false);
    setUploadProgress(null);
    setUploadEtaSeconds(null);
    setUploadLabel(null);

    try {
      const ensuredUserId = await ensureSupabaseProfile(currentUserId);
      if (!ensuredUserId) {
        throw new Error('Channel not found. Please try again.');
      }

      const { data: channelData, error: channelError } = await supabase
        .from('channels')
        .select('id')
        .eq('user_id', ensuredUserId)
        .maybeSingle();

      if (channelError) {
        throw new Error(channelError.message);
      }

      const channelId = channelData?.id || '';
      if (!channelId) {
        throw new Error('Channel not found. Please try again.');
      }

      if (isPostMode) {
        let finalImageUrl: string | null = null;

        if (mediaUri && mediaType === 'image' && mediaAsset) {
          // Convex storage + AI moderation is unavailable in this build;
          // upload post images directly to Supabase storage instead.
          setModerating(true);
          const uploadStartedAt = Date.now();
          setUploadLabel('Afbeelding uploaden');
          finalImageUrl = await uploadMediaToSupabase(
            'thumbnails',
            'posts',
            mediaAsset,
            mediaName || 'post-image.jpg',
            uploadStartedAt
          );
          setModerating(false);
        }

        const isTextOnlyPost = !finalImageUrl;
        const trimmedContent = text.trim();
        const basePayload: Record<string, any> = {
          user_id: currentUserId,
          channel_id: channelId,
          content: trimmedContent,
          image_url: finalImageUrl,
        };
        const postPayload: Record<string, any> = {
          ...basePayload,
          background_color: isTextOnlyPost ? selectedBackground.backgroundColor : null,
          text_color: isTextOnlyPost ? selectedBackground.textColor : null,
          background_style: isTextOnlyPost ? selectedBackgroundKey : null,
        };

        let { data: post, error } = await supabase
          .from('community_posts')
          .insert(postPayload)
          .select('id')
          .single();

        // The live database may not have the styling columns yet
        // (supabase_migrations.sql not applied) — retry without them.
        if (error && /could not find|does not exist|schema cache/i.test(error.message)) {
          ({ data: post, error } = await supabase
            .from('community_posts')
            .insert(basePayload)
            .select('id')
            .single());
        }

        if (error) throw new Error(error.message);

        Alert.alert(t('createPost.success' as any), t('createPost.successDesc' as any), [
          {
            text: 'OK',
            onPress: () => {
              if (post?.id && onPostCreated) onPostCreated(post.id);
              onPublished?.();
              onBack();
            },
          },
        ]);
        return;
      }

      const tags = tagsText
        .split(',')
        .map((tag: string) => tag.trim())
        .filter(Boolean)
        .slice(0, 10);

      if (!mediaAsset) {
        throw new Error('No media asset selected.');
      }

      const uploadStartedAt = Date.now();
      setUploadLabel(isVideoMode ? 'Video uploaden' : 'Momenti uploaden');
      const finalVideoUrl = await uploadMediaToSupabase(
        'videos',
        isVideoMode ? 'videos' : 'momenti',
        mediaAsset,
        mediaName || `${mode}.mp4`,
        uploadStartedAt
      );

      let finalThumbnailUrl: string | null = null;
      if (selectedThumbnailUri) {
        setUploadLabel('Thumbnail uploaden');
        const thumbnailAsset: PickedAsset = {
          uri: selectedThumbnailUri,
          fileName: `thumbnail-${mediaName || mode}.jpg`,
          mimeType: 'image/jpeg',
        };
        finalThumbnailUrl = await uploadMediaToSupabase(
          'thumbnails',
          isVideoMode ? 'videos' : 'momenti',
          thumbnailAsset,
          `thumbnail-${mediaName || mode}.jpg`,
          uploadStartedAt
        );
      }

      const normalizedDuration = normalizeDurationSeconds(videoDuration);
      const isMomenti = isMomentiDuration(normalizedDuration, isMomentiMode);
      const { data: videoRow, error } = await supabase
        .from('videos')
        .insert({
          channel_id: channelId,
          user_id: currentUserId,
          title: text || (isVideoMode ? 'New video' : 'New Momenti'),
          description: text || null,
          thumbnail_url: finalThumbnailUrl,
          video_url: finalVideoUrl,
          duration: normalizedDuration,
          views: 0,
          likes: 0,
          dislikes: 0,
          status: 'published',
          is_short: isMomenti,
          tags,
        })
        .select('id')
        .single();

      if (error) throw new Error(error.message);

      Alert.alert(
        'Success',
        isVideoMode ? 'Video uploaded successfully.' : 'Momenti shared successfully.',
        [
          {
            text: 'OK',
            onPress: () => {
              if (videoRow?.id && onPostCreated) onPostCreated(videoRow.id);
              onPublished?.();
              onBack();
            },
          },
        ]
      );
    } catch (err: any) {
      setModerating(false);
      console.error('Post creation error:', err);
      Alert.alert('Error', err.message || 'Could not create post.');
    } finally {
      setPosting(false);
      setModerating(false);
      setUploadProgress(null);
      setUploadEtaSeconds(null);
      setUploadLabel(null);
    }
  };

  const canPost = !posting && (isPostMode ? (content.trim().length > 0 || mediaUri !== null) : mediaUri !== null);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.closeBtn} disabled={posting}>
          <Ionicons name="close" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {isVideoMode ? 'Upload Video' : isMomentiMode ? 'Create Momenti' : t('createPost.title' as any)}
        </Text>
        <TouchableOpacity
          style={[styles.postBtn, !canPost && styles.postBtnDisabled]}
          onPress={handlePost}
          disabled={!canPost}
        >
          {posting ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <Text style={styles.postBtnText}>
              {isPostMode ? t('createPost.post' as any) : isVideoMode ? 'Upload' : 'Share'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Moderation banner */}
        {moderating && (
          <View style={styles.moderatingBanner}>
            <ActivityIndicator size="small" color={colors.tapIn} />
            <Text style={styles.moderatingText}>
              {t('createPost.moderating' as any)}
            </Text>
          </View>
        )}

        {(uploadProgress !== null || uploadLabel) && (
          <View style={styles.uploadBanner}>
            <View style={styles.uploadBannerTopRow}>
              <Text style={styles.uploadBannerTitle}>{uploadLabel || 'Uploading'}</Text>
              <Text style={styles.uploadBannerPercent}>{uploadProgress ?? 0}%</Text>
            </View>
            <View style={styles.uploadProgressTrack}>
              <View style={[styles.uploadProgressFill, { width: `${uploadProgress ?? 0}%` }]} />
            </View>
            {uploadEtaSeconds !== null && (
              <Text style={styles.uploadBannerEta}>
                {formatUploadEta(uploadEtaSeconds)}
              </Text>
            )}
          </View>
        )}

        {/* Text input */}
        <TextInput
          style={styles.textInput}
          placeholder={isVideoMode ? 'Add a caption for your video...' : isMomentiMode ? 'Add a caption for your Momenti...' : t('createPost.placeholder' as any)}
          placeholderTextColor={colors.textTertiary}
          value={content}
          onChangeText={setContent}
          multiline
          maxLength={2000}
          editable={!posting}
          textAlignVertical="top"
          autoFocus
        />

        {isPostMode && !mediaUri && (
          <View style={styles.backgroundPickerSection}>
            <Text style={styles.backgroundPickerTitle}>Kies achtergrond</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.backgroundPickerScroll}>
              {postBackgroundPresets.map((preset) => {
                const active = selectedBackgroundKey === preset.key;
                return (
                  <TouchableOpacity
                    key={preset.key}
                    style={[styles.backgroundPreset, active && styles.backgroundPresetActive]}
                    onPress={() => setSelectedBackgroundKey(preset.key)}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.backgroundSwatch, { backgroundColor: preset.backgroundColor }]} />
                    <Text style={styles.backgroundPresetLabel}>{preset.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        )}

        {isPostMode && !mediaUri && (
          <View style={[styles.textPostPreview, { backgroundColor: selectedBackground.backgroundColor }]}>
            <Text style={[styles.textPostPreviewContent, { color: selectedBackground.textColor }]} numberOfLines={6}>
              {content.trim() || 'Je tekst komt hier bovenaan te staan'}
            </Text>
          </View>
        )}

        {/* Media preview */}
        {mediaUri && mediaType === 'image' && (
          <View style={styles.imagePreviewContainer}>
            <Image
              source={{ uri: mediaUri }}
              style={styles.imagePreview}
              contentFit="cover"
              transition={200}
            />
            <TouchableOpacity
              style={styles.removeImageBtn}
              onPress={removeMedia}
              disabled={posting}
            >
              <Ionicons name="close-circle" size={28} color="#FFF" />
            </TouchableOpacity>
          </View>
        )}
        {mediaUri && mediaType === 'video' && (
          <View style={styles.videoPreviewContainer}>
            <View style={styles.videoPreviewIconWrap}>
              <SelectedVideoPreview uri={mediaUri} />
              <View style={styles.videoPreviewOverlay}>
                <Ionicons name="videocam" size={24} color="#FFFFFF" />
                {previewDurationLabel && (
                  <View style={styles.videoPreviewDurationBadge}>
                    <Text style={styles.videoPreviewDurationText}>{previewDurationLabel}</Text>
                  </View>
                )}
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.videoPreviewTitle}>{isVideoMode ? 'Video geselecteerd' : 'Momenti geselecteerd'}</Text>
              <Text style={styles.videoPreviewMeta} numberOfLines={1}>{mediaName || mediaUri}</Text>
              {previewDurationLabel && (
                <View style={styles.videoPreviewDurationRow}>
                  <Ionicons name="time-outline" size={14} color={colors.tapIn} />
                  <Text style={styles.videoPreviewDurationMeta}>{previewDurationLabel}</Text>
                </View>
              )}
            </View>
            <TouchableOpacity onPress={removeMedia} disabled={posting}>
              <Ionicons name="close-circle" size={28} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        )}

        {!isPostMode && mediaUri && (
          <View style={styles.thumbnailSection}>
            <Text style={styles.thumbnailTitle}>Kies 1 van 3 thumbnails</Text>
            <TouchableOpacity
              style={styles.customThumbnailBtn}
              onPress={pickCustomThumbnail}
              disabled={posting}
            >
              <Ionicons name="image-outline" size={18} color={colors.tapIn} />
              <Text style={styles.customThumbnailBtnText}>Upload eigen thumbnail</Text>
            </TouchableOpacity>
            {selectedThumbnailUri && !thumbnailChoices.some((thumb: { uri: string; time: number }) => thumb.uri === selectedThumbnailUri) && (
              <View style={styles.customThumbnailPreviewWrap}>
                <Image source={{ uri: selectedThumbnailUri }} style={styles.customThumbnailPreview} contentFit="cover" />
                <Text style={styles.customThumbnailLabel}>Eigen thumbnail geselecteerd</Text>
              </View>
            )}
            {thumbnailLoading ? (
              <View style={styles.thumbnailLoading}>
                <ActivityIndicator size="small" color={colors.tapIn} />
                <Text style={styles.thumbnailLoadingText}>Thumbnails worden gemaakt...</Text>
              </View>
            ) : thumbnailChoices.length > 0 ? (
              <View style={styles.thumbnailChoicesRow}>
                {thumbnailChoices.map((thumb: { uri: string; time: number }, index: number) => {
                  const selected = selectedThumbnailUri === thumb.uri;
                  return (
                    <TouchableOpacity
                      key={`${thumb.uri}-${index}`}
                      style={[styles.thumbnailChoice, selected && styles.thumbnailChoiceSelected]}
                      onPress={() => setSelectedThumbnailUri(thumb.uri)}
                      activeOpacity={0.8}
                    >
                      <Image source={{ uri: thumb.uri }} style={styles.thumbnailChoiceImage} contentFit="cover" />
                      <Text style={styles.thumbnailChoiceLabel}>Optie {index + 1}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              <Text style={styles.thumbnailFallback}>Geen thumbnail-opties beschikbaar. De eerste frame wordt gebruikt.</Text>
            )}
          </View>
        )}

        {(!isPostMode && mediaUri) && (
          <View style={styles.tagsSection}>
            <Text style={styles.tagsTitle}>Tags</Text>
            <TextInput
              style={styles.tagsInput}
              placeholder="Bijv. familie, fun, vakantie"
              placeholderTextColor={colors.textTertiary}
              value={tagsText}
              onChangeText={setTagsText}
              editable={!posting}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        )}

        {/* Character count */}
        <Text style={styles.charCount}>{content.length}/2000</Text>
      </ScrollView>

      {/* Bottom toolbar */}
      <View style={[styles.toolbar, { paddingBottom: insets.bottom + spacing.sm }]}>
        {isPostMode ? (
          <TouchableOpacity
            style={styles.toolbarBtn}
            onPress={pickMedia}
            disabled={posting}
          >
            <Ionicons
              name="image-outline"
              size={24}
              color={mediaUri ? colors.tapIn : colors.textSecondary}
            />
            <Text
              style={[
                styles.toolbarBtnText,
                mediaUri && { color: colors.tapIn },
              ]}
            >
              {t('createPost.addImage' as any)}
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.toolbarBtn} onPress={pickMedia} disabled={posting}>
            <Ionicons name={isVideoMode ? 'videocam-outline' : 'flash-outline'} size={24} color={mediaUri ? colors.tapIn : colors.textSecondary} />
            <Text style={[styles.toolbarBtnText, mediaUri && { color: colors.tapIn }]}>
              {isVideoMode ? 'Choose video' : 'Choose Momenti'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Info text */}
        <View style={styles.toolbarInfo}>
          <Ionicons name="shield-checkmark" size={14} color={colors.textTertiary} />
          <Text style={styles.toolbarInfoText}>
            {t('createPost.moderationNote' as any)}
          </Text>
        </View>
      </View>
    </KeyboardAvoidingView>
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
  postBtn: {
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    minWidth: 80,
    alignItems: 'center',
  },
  postBtnDisabled: {
    opacity: 0.4,
  },
  postBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  scrollContent: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  moderatingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#E3F2FD',
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginTop: spacing.md,
  },
  moderatingText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  uploadBanner: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  uploadBannerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  uploadBannerTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  uploadBannerPercent: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  uploadProgressTrack: {
    height: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceLight,
    overflow: 'hidden',
  },
  uploadProgressFill: {
    height: '100%',
    backgroundColor: colors.tapIn,
    borderRadius: 999,
  },
  uploadBannerEta: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  },
  textInput: {
    color: colors.text,
    fontSize: fontSize.lg,
    lineHeight: 26,
    minHeight: 120,
    paddingTop: spacing.lg,
  },
  backgroundPickerSection: {
    marginTop: spacing.lg,
  },
  backgroundPickerTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  backgroundPickerScroll: {
    gap: spacing.sm,
  },
  backgroundPreset: {
    width: 84,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: spacing.sm,
    alignItems: 'center',
  },
  backgroundPresetActive: {
    borderColor: colors.tapIn,
  },
  backgroundSwatch: {
    width: '100%',
    height: 42,
    borderRadius: borderRadius.md,
    marginBottom: spacing.xs,
  },
  backgroundPresetLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
  },
  textPostPreview: {
    marginTop: spacing.lg,
    borderRadius: borderRadius.lg,
    minHeight: 180,
    padding: spacing.lg,
    justifyContent: 'center',
  },
  textPostPreviewContent: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    lineHeight: 30,
  },
  imagePreviewContainer: {
    marginTop: spacing.md,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    position: 'relative',
  },
  imagePreview: {
    width: '100%',
    height: 250,
    borderRadius: borderRadius.lg,
  },
  removeImageBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 14,
  },
  charCount: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textAlign: 'right',
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    backgroundColor: colors.background,
  },
  toolbarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
  },
  toolbarBtnText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  toolbarInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  toolbarInfoText: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  videoPreviewContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  videoPreviewIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  selectedVideoPreview: {
    width: '100%',
    height: '100%',
  },
  videoPreviewOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  videoPreviewDurationBadge: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius: borderRadius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 120,
  },
  videoPreviewDurationText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  videoPreviewDurationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    alignSelf: 'flex-start',
    backgroundColor: '#EAF6FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  videoPreviewDurationMeta: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '800',
  },
  videoPreviewTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  videoPreviewMeta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  thumbnailSection: {
    marginTop: spacing.lg,
  },
  thumbnailTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  thumbnailLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
  },
  thumbnailLoadingText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  thumbnailChoicesRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  thumbnailChoice: {
    flex: 1,
    borderRadius: borderRadius.lg,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  thumbnailChoiceSelected: {
    borderColor: colors.tapIn,
  },
  thumbnailChoiceImage: {
    width: '100%',
    aspectRatio: 0.75,
  },
  thumbnailChoiceLabel: {
    color: colors.text,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: spacing.xs,
  },
  thumbnailFallback: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
  },
  customThumbnailBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.tapIn,
    alignSelf: 'flex-start',
    marginBottom: spacing.md,
  },
  customThumbnailBtnText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  customThumbnailPreviewWrap: {
    marginBottom: spacing.md,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  customThumbnailPreview: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  customThumbnailLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    padding: spacing.sm,
  },
  tagsSection: {
    marginTop: spacing.lg,
  },
  tagsTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  tagsInput: {
    color: colors.text,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
});