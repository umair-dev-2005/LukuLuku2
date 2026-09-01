import { AppState, Platform } from 'react-native';
import {
  getTrackingPermissionsAsync,
  requestTrackingPermissionsAsync,
} from 'expo-tracking-transparency';

let hasRequested = false;

// Resolve once the app is in the foreground. iOS silently denies the ATT prompt
// if it is requested while the app is not `active`, so we wait for that state.
function waitUntilActive(): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        sub.remove();
        resolve();
      }
    });
  });
}

/**
 * Request App Tracking Transparency permission. Required by App Store Guideline
 * 5.1.2(i) because the app serves third-party network ads (HilltopAds VAST) that
 * fire tracking pixels. Safe no-op on Android/web. Only prompts once; if the user
 * has already answered (granted/denied) iOS will not show the dialog again.
 */
export async function requestTrackingPermission(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (hasRequested) return;
  hasRequested = true;

  try {
    const { status, canAskAgain } = await getTrackingPermissionsAsync();
    // `undetermined` means the user has never been asked yet.
    if (status === 'undetermined' && canAskAgain) {
      await waitUntilActive();
      await requestTrackingPermissionsAsync();
    }
  } catch {
    // Tracking permission is best-effort; never let it break app startup.
  }
}
