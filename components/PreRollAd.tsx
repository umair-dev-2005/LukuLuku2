import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEvent } from 'expo';
import { colors, fontSize, spacing, borderRadius } from '../lib/theme';
import { parseVastXml, fireTrackingPixels, VastAd } from '../lib/vastParser';

const { width } = Dimensions.get('window');
// Real HilltopAds VAST tag (same one the web platform uses). Served when no paid
// LukuLuku pre-roll ad is currently active — gives a rotating, skippable network ad.
const DEFAULT_HILLTOP_VAST =
  'https://fluffy-management.com/dFmsFazHd.GANbv_ZvG/UF/deom/9/uKZxUMlMkJPVTYYb5QN-j/MW1fOcDDU/tAN/jckV2NM/zqUY4/O/QR';

type PrerollSelection =
  | {
      type: 'luku';
      _id: string;
      creativeUrl: string;
      ctaUrl: string | null;
      campaignTitle: string;
      companyName: string;
      skipAfterSeconds: number;
    }
  | {
      type: 'vast';
      vastUrl: string;
      skipAfterSeconds: number;
    };

interface PreRollAdProps {
  // A "luku" creative (a paid company ad video from Supabase). When present it is played
  // directly; otherwise we fall back to the VAST network tag.
  creativeUrl?: string | null;
  ctaUrl?: string | null;
  companyName?: string | null;
  vastUrl?: string;
  skipAfterSeconds?: number;
  onStart?: () => void;
  onComplete: () => void;
  onError: () => void;
}

function LukuLukuPreroll({
  ad,
  onStart,
  onComplete,
  onFallback,
}: {
  ad: Extract<PrerollSelection, { type: 'luku' }>;
  onStart?: () => void;
  onComplete: () => void;
  onFallback: () => void;
}) {
  const completedRef = useRef(false);
  const [canSkip, setCanSkip] = useState(false);
  const [adStarted, setAdStarted] = useState(false);

  const player = useVideoPlayer(
    {
      uri: ad.creativeUrl,
      contentType: 'progressive',
    },
    (p: { bufferOptions: { preferredForwardBufferDuration: number; minBufferForPlayback: number }; muted: boolean; volume: number; loop: boolean; play: () => void }) => {
      p.bufferOptions = {
        // Larger buffers so heavier creatives (e.g. HEVC) can buffer enough to start.
        preferredForwardBufferDuration: 6,
        minBufferForPlayback: 1,
      };
      p.muted = true;
      p.volume = 0;
      p.loop = false;
      p.play();
    }
  );

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { currentTime, duration } = useEvent(player, 'timeUpdate', { currentTime: 0, duration: 0 });

  const startedRef = useRef(false);

  useEffect(() => {
    if (status === 'error') {
      onFallback();
    }
  }, [onFallback, status]);

  useEffect(() => {
    // The ad has actually started once playback time advances past 0.
    if (currentTime > 0 && !startedRef.current) {
      startedRef.current = true;
      setAdStarted(true);
      onStart?.();
    }

    if (currentTime >= ad.skipAfterSeconds) {
      setCanSkip(true);
    }

    if (!completedRef.current && duration > 0 && currentTime >= duration - 0.1) {
      completedRef.current = true;
      onComplete();
    }
  }, [ad.skipAfterSeconds, currentTime, duration, onComplete, onStart]);

  const handleAdClick = useCallback(() => {
    if (ad.ctaUrl) {
      void Linking.openURL(ad.ctaUrl).catch(() => {});
    }
  }, [ad.ctaUrl]);

  const remaining = Math.max(0, ad.skipAfterSeconds - Math.floor(currentTime));

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.videoContainer} onPress={handleAdClick} activeOpacity={0.95}>
        <VideoView style={styles.video} player={player} contentFit="contain" nativeControls={false} />
      </TouchableOpacity>

      <View style={styles.adLabel}>
        <Text style={styles.adLabelText}>AD</Text>
      </View>

      <View style={styles.skipContainer}>
        {canSkip ? (
          <TouchableOpacity style={styles.skipBtn} onPress={onComplete}>
            <Text style={styles.skipText}>Overslaan ▶</Text>
          </TouchableOpacity>
        ) : adStarted ? (
          <View style={styles.countdownBadge}>
            <Text style={styles.countdownText}>Overslaan in {remaining}s</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function VastPrerollPlayer({
  vastUrl,
  skipAfterSeconds,
  onStart,
  onComplete,
  onError,
}: {
  vastUrl: string;
  skipAfterSeconds: number;
  onStart?: () => void;
  onComplete: () => void;
  onError: () => void;
}) {
  const [adData, setAdData] = useState<VastAd | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [canSkip, setCanSkip] = useState(false);
  const [adStarted, setAdStarted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedEventsRef = useRef<Set<string>>(new Set());
  const completedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Safety net: never let the "Advertentie laden..." spinner stick. If no ad has
    // loaded within 7s, give up and let the video play.
    const failTimer = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        onError();
      }
    }, 7000);
    (async () => {
      try {
        const data = await parseVastXml(vastUrl);
        if (cancelled) return;
        if (!data || !data.mediaUrl) {
          setLoading(false);
          onError();
          return;
        }
        setAdData(data);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setLoading(false);
          onError();
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(failTimer);
    };
  }, [onError, vastUrl]);

  const player = useVideoPlayer(adData?.mediaUrl || '', () => {});

  // The VAST media URL arrives asynchronously (after parsing), so configure + start the
  // player here once it's available — the one-time setup callback above runs before that.
  useEffect(() => {
    if (!adData?.mediaUrl) return;
    try {
      (player as any).bufferOptions = {
        preferredForwardBufferDuration: 5,
        minBufferForPlayback: 1,
      };
      player.muted = true; // network ads autoplay muted (same as the web)
      player.play();
    } catch {
      // Ignore start races.
    }
  }, [adData, player]);

  const handleComplete = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    player.pause();
    onComplete();
  }, [onComplete, player]);

  const handleSkip = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    player.pause();
    onComplete();
  }, [onComplete, player]);

  useEffect(() => {
    if (!adData || loading) return;

    fireTrackingPixels(adData.impressionUrls);

    timerRef.current = setInterval(() => {
      setElapsed((prev: number) => {
        const next = prev + 0.5;
        const duration = adData.duration || 15;

        if (next >= 0.5 && !firedEventsRef.current.has('start')) {
          firedEventsRef.current.add('start');
          fireTrackingPixels(adData.trackingEvents.start);
          setAdStarted(true);
          onStart?.();
        }
        if (next >= duration * 0.25 && !firedEventsRef.current.has('firstQuartile')) {
          firedEventsRef.current.add('firstQuartile');
          fireTrackingPixels(adData.trackingEvents.firstQuartile);
        }
        if (next >= duration * 0.5 && !firedEventsRef.current.has('midpoint')) {
          firedEventsRef.current.add('midpoint');
          fireTrackingPixels(adData.trackingEvents.midpoint);
        }
        if (next >= duration * 0.75 && !firedEventsRef.current.has('thirdQuartile')) {
          firedEventsRef.current.add('thirdQuartile');
          fireTrackingPixels(adData.trackingEvents.thirdQuartile);
        }
        if (next >= duration && !completedRef.current) {
          completedRef.current = true;
          fireTrackingPixels(adData.trackingEvents.complete);
          handleComplete();
        }

        if (next >= skipAfterSeconds) {
          setCanSkip(true);
        }

        return next;
      });
    }, 500);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [adData, handleComplete, loading, skipAfterSeconds]);

  const handleAdClick = useCallback(() => {
    if (adData?.clickThroughUrl) {
      fireTrackingPixels(adData.clickTrackingUrls);
      Linking.openURL(adData.clickThroughUrl).catch(() => {});
    }
  }, [adData]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Advertentie laden...</Text>
      </View>
    );
  }

  if (!adData?.mediaUrl) return null;

  const remaining = Math.max(0, skipAfterSeconds - Math.floor(elapsed));

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.videoContainer} onPress={handleAdClick} activeOpacity={0.95}>
        <VideoView style={styles.video} player={player} contentFit="contain" nativeControls={false} />
      </TouchableOpacity>

      <View style={styles.adLabel}>
        <Text style={styles.adLabelText}>AD</Text>
      </View>

      <View style={styles.skipContainer}>
        {canSkip ? (
          <TouchableOpacity style={styles.skipBtn} onPress={handleSkip}>
            <Text style={styles.skipText}>Overslaan ▶</Text>
          </TouchableOpacity>
        ) : adStarted ? (
          <View style={styles.countdownBadge}>
            <Text style={styles.countdownText}>Overslaan in {remaining}s</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function PreRollAd({
  creativeUrl,
  ctaUrl,
  companyName,
  vastUrl,
  skipAfterSeconds,
  onStart,
  onComplete,
  onError,
}: PreRollAdProps) {
  const skip = skipAfterSeconds && skipAfterSeconds > 0 ? skipAfterSeconds : 5;
  // If we have a paid company creative, play it. If it fails to load we fall back to VAST.
  const [useVastFallback, setUseVastFallback] = useState(!creativeUrl);

  if (creativeUrl && !useVastFallback) {
    return (
      <LukuLukuPreroll
        ad={{
          type: 'luku',
          _id: '',
          creativeUrl,
          ctaUrl: ctaUrl ?? null,
          campaignTitle: companyName ?? 'LukuLuku Ads',
          companyName: companyName ?? 'LukuLuku Ads',
          skipAfterSeconds: skip,
        }}
        onStart={onStart}
        onComplete={onComplete}
        onFallback={() => setUseVastFallback(true)}
      />
    );
  }

  return (
    <VastPrerollPlayer
      vastUrl={vastUrl || DEFAULT_HILLTOP_VAST}
      skipAfterSeconds={skip}
      onStart={onStart}
      onComplete={onComplete}
      onError={onError}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    width,
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  videoContainer: {
    width: '100%',
    height: '100%',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  loadingText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    marginTop: spacing.md,
  },
  adLabel: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    backgroundColor: 'rgba(255,180,0,0.9)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  adLabelText: {
    color: '#000',
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  skipContainer: {
    position: 'absolute',
    bottom: spacing.md,
    right: spacing.md,
  },
  skipBtn: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  skipText: {
    color: '#000',
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  countdownBadge: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.sm,
  },
  countdownText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
});