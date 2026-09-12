import { useCallback, useEffect, useRef, useState } from 'react';
import * as Linking from 'expo-linking';
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';

// Defined once, at module scope — passed to useAudioRecorder() as the exact same object
// every render, so there's never any doubt about the recorder's identity being stable
// across re-renders (expo-audio itself also memoizes by content, but pinning the object
// here removes that as a variable entirely).
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

// Live mic-level meter for the "Go Live" preview screen, so the user can visually confirm
// their mic is picking up sound before they actually go live.
//
// NOTE: this is UI-phase only. It uses expo-audio's own recorder just for its metering
// numbers (nothing is ever saved/uploaded) — no ZegoCloud SDK call is made here. Once the
// real ZegoCloud integration is built, this hook's internals get swapped for Zego's own
// `onCapturedSoundLevelUpdate` callback; the returned shape (`level`, `isMuted`, `toggleMute`)
// is kept stable so LivePreviewScreen.tsx does not need to change.
export function useMicLevel(initialMuted = false) {
  const [permissionStatus, setPermissionStatus] = useState<'undetermined' | 'granted' | 'denied'>('undetermined');
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [isMuted, setIsMuted] = useState(initialMuted);
  const [level, setLevel] = useState(0);
  const lastLevelRef = useRef(0);

  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder, 100);
  const hasStartedRef = useRef(false);

  const requestPermission = useCallback(async () => {
    const result = await requestRecordingPermissionsAsync();
    setPermissionStatus(result.granted ? 'granted' : 'denied');
    setCanAskAgain(result.canAskAgain);
    return result.granted;
  }, []);

  // Ask once on mount so the mic indicator can start reacting immediately.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await getRecordingPermissionsAsync();
      if (cancelled) return;
      if (existing.granted) {
        setPermissionStatus('granted');
        setCanAskAgain(existing.canAskAgain);
      } else {
        await requestPermission();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestPermission]);

  // Start the metering-only recording once permission is granted, and make sure it's
  // always stopped again — on mute, and on unmount. Kept as one effect (rather than a
  // separate start effect + separate cleanup-only effect) so there is exactly one place
  // that owns `hasStartedRef`.
  useEffect(() => {
    if (permissionStatus !== 'granted' || isMuted) {
      if (hasStartedRef.current) {
        recorder.stop();
        hasStartedRef.current = false;
      }
      setLevel(0);
      lastLevelRef.current = 0;
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        if (cancelled || hasStartedRef.current) return;
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
        hasStartedRef.current = true;
      } catch (err) {
        console.warn('useMicLevel: could not start mic metering', err);
      }
    })();

    return () => {
      cancelled = true;
      if (hasStartedRef.current) {
        recorder.stop();
        hasStartedRef.current = false;
      }
    };
  }, [permissionStatus, isMuted, recorder]);

  // Metering comes back in dBFS (roughly -50 = quiet room, 0 = loudest). Map that to a
  // friendly 0..1 level for the wave/pulse indicator, skipping no-op updates.
  useEffect(() => {
    if (isMuted || typeof recorderState.metering !== 'number' || Number.isNaN(recorderState.metering)) {
      return;
    }
    const MIN_DB = -50;
    const normalized = Math.max(0, Math.min(1, (recorderState.metering - MIN_DB) / -MIN_DB));
    if (Math.abs(normalized - lastLevelRef.current) < 0.03) return;
    lastLevelRef.current = normalized;
    setLevel(normalized);
  }, [recorderState.metering, isMuted]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  return {
    level,
    isMuted,
    toggleMute,
    hasPermission: permissionStatus === 'granted',
    permissionDenied: permissionStatus === 'denied',
    canAskAgain,
    requestPermission,
    openSettings,
  };
}
