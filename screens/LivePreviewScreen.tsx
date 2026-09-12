import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  Keyboard,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../lib/theme';
import { t } from '../lib/i18n';
import { getCurrentSupabaseUserId } from '../lib/auth';
import { useMicLevel } from '../hooks/useMicLevel';
import { useStreamCategories } from '../hooks/useStreamCategories';

interface LivePreviewScreenProps {
  onBack: () => void;
  onStartStreaming: (setup: { facing: CameraType; isMuted: boolean }) => void;
}

const TITLE_MAX_LENGTH = 60;
const MIC_BAR_COUNT = 5;

export default function LivePreviewScreen({ onBack, onStartStreaming }: LivePreviewScreenProps) {
  const insets = useSafeAreaInsets();
  const [facing, setFacing] = useState<CameraType>('front');
  const [title, setTitle] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const mic = useMicLevel();
  const { categories, loading: categoriesLoading, error: categoriesError, retry: retryCategories } = useStreamCategories();

  const trimmedTitle = title.trim();
  const canStart = trimmedTitle.length > 0 && !!selectedCategoryId;

  const needsPermissionPrompt = !cameraPermission?.granted || mic.permissionDenied || !mic.hasPermission;

  const handleFlipCamera = () => {
    setFacing((prev) => (prev === 'front' ? 'back' : 'front'));
  };

  const handleAllowAccess = async () => {
    if (!cameraPermission?.granted) {
      await requestCameraPermission();
    }
    if (!mic.hasPermission) {
      await mic.requestPermission();
    }
  };

  const handleStartStreaming = async () => {
    if (!canStart || isStarting) return;

    setIsStarting(true);
    try {
      const userId = await getCurrentSupabaseUserId();
      if (!userId) {
        Alert.alert(t('liveGo.signInRequired' as any));
        return;
      }

      // Give this screen's camera session time to actually release (setIsStarting(true)
      // above already swapped the CameraView out) before the next screen opens its own —
      // without this gap the new CameraView can come up black on Android.
      await new Promise((resolve) => setTimeout(resolve, 350));

      // UI phase only — title/category aren't sent anywhere yet; they'll be written to the
      // live_streams row (live_stream_init RPC) in this feature's ZegoCloud integration plan.
      // Carry forward only what LiveBroadcastScreen actually needs today: which camera and
      // whether the mic was already muted here.
      onStartStreaming({ facing, isMuted: mic.isMuted });
    } finally {
      setIsStarting(false);
    }
  };

  const micBars = useMemo(() => Array.from({ length: MIC_BAR_COUNT }), []);
  const titleInputRef = useRef<TextInput>(null);
  // A tiny delay is needed on Android: calling .focus() synchronously from another
  // TouchableOpacity's onPress can land before that touch has fully released, and the
  // keyboard then never comes up.
  const focusTitleInput = () => setTimeout(() => titleInputRef.current?.focus(), 50);

  // Manual keyboard tracking instead of KeyboardAvoidingView: on this screen native
  // adjustResize doesn't reliably resize the window (edge-to-edge), and KeyboardAvoidingView's
  // own padding/height math ends up double-counting against it. Measuring the keyboard's own
  // height and shifting just the bottom panel by exactly that much is reliable on both platforms.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'android' ? 'keyboardDidShow' : 'keyboardWillShow';
    const hideEvent = Platform.OS === 'android' ? 'keyboardDidHide' : 'keyboardWillHide';
    const showSub = Keyboard.addListener(showEvent, (e) => setKeyboardHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View style={styles.container}>
      {/* Camera preview fills the screen. Dropped as soon as "Start Streaming" is pressed
          (isStarting) so this camera session fully releases before LiveBroadcastScreen's
          CameraView tries to open the same hardware — mounting two CameraViews back-to-back
          on Android otherwise races and the new one can come up black. */}
      {cameraPermission?.granted && !isStarting ? (
        <CameraView style={StyleSheet.absoluteFill} facing={facing} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.cameraFallback]} />
      )}

      <View style={StyleSheet.absoluteFill}>
        {/* Top bar: close + camera flip / mic controls */}
        <View style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}>
          <TouchableOpacity onPress={onBack} style={styles.iconButton} activeOpacity={0.7}>
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>

          <View style={styles.topRightControls}>
            <TouchableOpacity onPress={handleFlipCamera} style={styles.iconButton} activeOpacity={0.7}>
              <Ionicons name="camera-reverse" size={24} color="#FFFFFF" />
            </TouchableOpacity>

            <TouchableOpacity onPress={mic.toggleMute} style={styles.iconButton} activeOpacity={0.7}>
              <Ionicons name={mic.isMuted ? 'mic-off' : 'mic'} size={22} color="#FFFFFF" />
            </TouchableOpacity>

            <View style={styles.micLevelRow}>
              {micBars.map((_, index) => {
                const threshold = (index + 1) / MIC_BAR_COUNT;
                const active = !mic.isMuted && mic.level >= threshold - 0.15;
                return (
                  <View
                    key={index}
                    style={[
                      styles.micBar,
                      { height: 6 + index * 3 },
                      active && styles.micBarActive,
                    ]}
                  />
                );
              })}
            </View>
          </View>
        </View>

        {needsPermissionPrompt && (
          <View style={styles.permissionOverlay}>
            <Ionicons name="videocam-outline" size={40} color="#FFFFFF" />
            <Text style={styles.permissionTitle}>{t('liveGo.permissionNeededTitle' as any)}</Text>
            <Text style={styles.permissionDesc}>{t('liveGo.permissionNeededDesc' as any)}</Text>
            {(cameraPermission?.canAskAgain === false || (mic.permissionDenied && !mic.canAskAgain)) ? (
              <TouchableOpacity style={styles.permissionButton} onPress={mic.openSettings} activeOpacity={0.85}>
                <Text style={styles.permissionButtonText}>{t('liveGo.openSettings' as any)}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.permissionButton} onPress={handleAllowAccess} activeOpacity={0.85}>
                <Text style={styles.permissionButtonText}>{t('liveGo.allowAccess' as any)}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={{ flex: 1 }} />

        {/* Bottom panel: title, categories, start button */}
        <View
          style={[
            styles.bottomPanel,
            {
              marginBottom: keyboardHeight,
              paddingBottom: keyboardHeight > 0 ? spacing.md : insets.bottom + spacing.lg,
            },
          ]}
        >
          <View style={styles.titleRow}>
            <TextInput
              ref={titleInputRef}
              style={styles.titleInput}
              placeholder={t('liveGo.titlePlaceholder' as any)}
              placeholderTextColor="rgba(255,255,255,0.6)"
              value={title}
              onChangeText={setTitle}
              maxLength={TITLE_MAX_LENGTH}
              returnKeyType="done"
            />
            <Text style={styles.titleCounter}>{title.length}/{TITLE_MAX_LENGTH}</Text>
          </View>

          <Text style={styles.categoryLabel}>{t('liveGo.categoryLabel' as any)}</Text>

          {categoriesLoading ? (
            <View style={styles.categoriesLoading}>
              <ActivityIndicator size="small" color="#FFFFFF" />
            </View>
          ) : categoriesError ? (
            <TouchableOpacity onPress={retryCategories} style={styles.categoriesError} activeOpacity={0.7}>
              <Text style={styles.categoriesErrorText}>{t('liveGo.categoriesError' as any)}</Text>
              <Text style={styles.categoriesRetryText}>{t('liveGo.retry' as any)}</Text>
            </TouchableOpacity>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoriesRow}
            >
              {categories.map((category) => {
                const selected = category.id === selectedCategoryId;
                return (
                  <TouchableOpacity
                    key={category.id}
                    style={[styles.categoryChip, selected && styles.categoryChipSelected]}
                    onPress={() => setSelectedCategoryId(category.id)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.categoryChipText, selected && styles.categoryChipTextSelected]}>
                      {category.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          <TouchableOpacity
            style={[styles.startButton, !canStart && styles.startButtonDisabled]}
            onPress={handleStartStreaming}
            disabled={!canStart || isStarting}
            activeOpacity={0.85}
          >
            {isStarting ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="radio" size={20} color="#FFFFFF" />
                <Text style={styles.startButtonText}>{t('liveGo.startStreaming' as any)}</Text>
              </>
            )}
          </TouchableOpacity>

          {!canStart && (
            <TouchableOpacity onPress={focusTitleInput} activeOpacity={0.7}>
              <Text style={styles.startHint}>{t('liveGo.needTitleAndCategory' as any)}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  cameraFallback: {
    backgroundColor: '#1A1A1A',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  topRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  micLevelRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 24,
    paddingHorizontal: 4,
  },
  micBar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  micBarActive: {
    backgroundColor: colors.tapIn,
  },
  permissionOverlay: {
    position: 'absolute',
    top: '35%',
    left: spacing.xxl,
    right: spacing.xxl,
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: borderRadius.xl,
    padding: spacing.xl,
  },
  permissionTitle: {
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionDesc: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 18,
  },
  permissionButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.tapIn,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
  },
  permissionButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  bottomPanel: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  titleInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: '600',
    height: 40,
    padding: 0,
  },
  titleCounter: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.xs,
    marginBottom: spacing.xs,
  },
  categoryLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  categoriesRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  categoriesLoading: {
    height: 40,
    justifyContent: 'center',
  },
  categoriesError: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  categoriesErrorText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: fontSize.sm,
  },
  categoriesRetryText: {
    color: colors.tapIn,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  categoryChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  categoryChipSelected: {
    backgroundColor: colors.tapIn,
    borderColor: colors.tapIn,
  },
  categoryChipText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  categoryChipTextSelected: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  startButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.tapIn,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
    shadowColor: colors.tapIn,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  startButtonDisabled: {
    backgroundColor: colors.disabled,
    shadowOpacity: 0,
    elevation: 0,
  },
  startButtonText: {
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  startHint: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
});
