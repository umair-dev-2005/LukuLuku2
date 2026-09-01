/**
 * Simple VAST 3.0 XML parser for React Native
 * Parses HilltopAds VAST responses to extract media files and tracking URLs
 */

export interface VastAd {
  mediaUrl: string | null;
  duration: number; // seconds
  impressionUrls: string[];
  clickThroughUrl: string | null;
  clickTrackingUrls: string[];
  trackingEvents: {
    start: string[];
    firstQuartile: string[];
    midpoint: string[];
    thirdQuartile: string[];
    complete: string[];
  };
}

function extractCDATA(text: string): string {
  // Remove CDATA wrapper if present
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function extractTagContent(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results: string[] = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(extractCDATA(match[1]));
  }
  return results;
}

function extractAttribute(tag: string, attr: string): string | null {
  const regex = new RegExp(`${attr}="([^"]*)"`, 'i');
  const match = tag.match(regex);
  return match ? match[1] : null;
}

function parseDuration(dur: string): number {
  // Format: HH:MM:SS or HH:MM:SS.mmm
  const parts = dur.split(':');
  if (parts.length === 3) {
    return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return 0;
}

export async function parseVastXml(vastUrl: string): Promise<VastAd | null> {
  try {
    // Hard timeout so a slow/hanging ad server never leaves the UI stuck on "loading".
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(vastUrl, {
        headers: { Accept: 'application/xml, text/xml' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;
    const xml = await response.text();
    
    if (!xml || xml.trim().length === 0) return null;
    
    // Check for wrapper/redirect
    const wrapperUrls = extractTagContent(xml, 'VASTAdTagURI');
    if (wrapperUrls.length > 0 && wrapperUrls[0]) {
      // Follow the wrapper (max 1 redirect to avoid loops)
      return parseVastXml(wrapperUrls[0]);
    }

    // Extract media files. The native player (expo-video) only reliably plays H.264 MP4,
    // NOT flv or webm — so strongly prefer mp4 and never pick flv (this is exactly what the
    // web does). Among mp4s pick the highest bitrate; only fall back to a non-flv, non-mp4
    // file if there is no mp4 at all.
    const mediaFileRegex = /<MediaFile[^>]*>([\s\S]*?)<\/MediaFile>/gi;
    let bestMp4: string | null = null;
    let bestMp4Bitrate = -1;
    let fallbackUrl: string | null = null;
    let fallbackBitrate = -1;
    let match;

    while ((match = mediaFileRegex.exec(xml)) !== null) {
      const fullTag = match[0];
      const url = extractCDATA(match[1]);
      if (!url) continue;
      const type = (extractAttribute(fullTag, 'type') || '').toLowerCase();
      const bitrate = parseInt(extractAttribute(fullTag, 'bitrate') || '0');
      const lower = url.toLowerCase();

      const isFlv = type.includes('flv') || lower.endsWith('.flv');
      if (isFlv) continue; // never playable in the native player

      const isMp4 = type.includes('mp4') || lower.endsWith('.mp4');
      if (isMp4) {
        if (bitrate > bestMp4Bitrate) { bestMp4 = url; bestMp4Bitrate = bitrate; }
      } else if (bitrate > fallbackBitrate) {
        fallbackUrl = url; fallbackBitrate = bitrate;
      }
    }

    const bestMediaUrl: string | null = bestMp4 || fallbackUrl;

    // Duration
    const durations = extractTagContent(xml, 'Duration');
    const duration = durations.length > 0 ? parseDuration(durations[0]) : 15;

    // Impression URLs
    const impressionUrls = extractTagContent(xml, 'Impression').filter(Boolean);

    // Click through
    const clickThroughUrls = extractTagContent(xml, 'ClickThrough');
    const clickThroughUrl = clickThroughUrls.length > 0 ? clickThroughUrls[0] : null;

    // Click tracking
    const clickTrackingUrls = extractTagContent(xml, 'ClickTracking').filter(Boolean);

    // Tracking events
    const trackingEvents = {
      start: [] as string[],
      firstQuartile: [] as string[],
      midpoint: [] as string[],
      thirdQuartile: [] as string[],
      complete: [] as string[],
    };

    const trackingRegex = /<Tracking\s+event="([^"]*)"[^>]*>([\s\S]*?)<\/Tracking>/gi;
    while ((match = trackingRegex.exec(xml)) !== null) {
      const event = match[1].toLowerCase();
      const url = extractCDATA(match[2]);
      if (event in trackingEvents && url) {
        (trackingEvents as any)[event].push(url);
      }
    }

    return {
      mediaUrl: bestMediaUrl,
      duration,
      impressionUrls,
      clickThroughUrl,
      clickTrackingUrls,
      trackingEvents,
    };
  } catch (error) {
    console.warn('VAST parse error:', error);
    return null;
  }
}

export function fireTrackingPixels(urls: string[]) {
  urls.forEach((url) => {
    fetch(url, { method: 'GET' }).catch(() => {});
  });
}
