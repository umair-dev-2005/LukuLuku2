import { t } from './i18n';
import { SUPABASE_URL } from './supabase';

export function formatViews(views: number): string {
  if (views >= 1000000) {
    return `${(views / 1000000).toFixed(1)}M`;
  }
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1)}K`;
  }
  return views.toString();
}

export function formatTimeAgo(dateString: string): string {
  const now = new Date();
  const date = new Date(dateString);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${t('time.minutesAgo')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${t('time.hoursAgo')}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} ${t('time.daysAgo')}`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} ${t('time.weeksAgo')}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${t('time.monthsAgo')}`;
  const years = Math.floor(days / 365);
  return `${years} ${t('time.yearsAgo')}`;
}

export function normalizeDurationSeconds(duration: number | string | null | undefined): number | null {
  if (duration === null || duration === undefined) {
    return null;
  }

  const numericDuration = typeof duration === 'string' ? Number(duration) : duration;

  if (typeof numericDuration !== 'number' || !Number.isFinite(numericDuration) || numericDuration <= 0) {
    return null;
  }

  return numericDuration > 1000 ? Math.round(numericDuration / 1000) : Math.round(numericDuration);
}

export function normalizePlayableMediaUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[a-z][a-z\d+\-.]*:/i.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('/storage/')) {
    return `${SUPABASE_URL}${trimmed}`;
  }

  if (trimmed.startsWith('storage/')) {
    return `${SUPABASE_URL}/${trimmed}`;
  }

  if (/^[^/?#]+\/.+/.test(trimmed)) {
    return `${SUPABASE_URL}/storage/v1/object/public/${trimmed.replace(/^\/+/, '')}`;
  }

  return null;
}

export function isMomentiDuration(duration: number | string | null | undefined, fallbackIsShort = false): boolean {
  const normalized = normalizeDurationSeconds(duration);
  if (normalized !== null) {
    return normalized < 60;
  }

  return fallbackIsShort;
}

export function formatDuration(seconds: number | string | null): string {
  const normalized = normalizeDurationSeconds(seconds);
  if (!normalized) return '';
  const mins = Math.floor(normalized / 60);
  const secs = Math.floor(normalized % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

type RankingMeta = {
  title?: string;
  description?: string | null;
  tags?: string[] | string | null;
  created_at?: string | null;
  views?: number | null;
  likes?: number | null;
  playCount?: number | null;
  sortOrder?: number | null;
  namespace?: string | null;
};

type GameRankingMeta = RankingMeta & {
  id?: string | null;
  url?: string | null;
  banner_image?: string | null;
  image?: string | null;
};

const WORD_REGEX = /[a-z0-9à-ÿ]+/gi;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\-]+/g, ' ')
    .replace(/[^a-z0-9à-ÿ\s]/gi, ' ')
    .trim();
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnitValue(seed: string, value: string): number {
  return hashString(`${seed}|${value}`) / 4294967295;
}

function splitTags(tags: RankingMeta['tags']): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags.flatMap((tag) => normalizeText(String(tag)).split(/\s+/)).filter(Boolean);
  }
  return normalizeText(String(tags)).split(/\s+/).filter(Boolean);
}

function collectTerms(meta: RankingMeta): string[] {
  const bag = new Set<string>();
  const addWords = (value?: string | null) => {
    if (!value) return;
    const words = normalizeText(value).match(WORD_REGEX) || [];
    for (const word of words) {
      if (word.length >= 3) bag.add(word);
    }
  };

  addWords(meta.title || '');
  addWords(meta.description || '');
  for (const tag of splitTags(meta.tags)) {
    if (tag.length >= 3) bag.add(tag);
  }

  return [...bag];
}

export function extractRankingTerms(items: RankingMeta[], limit = 10): string[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    for (const term of collectTerms(item)) {
      counts.set(term, (counts.get(term) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function scoreMeta(meta: RankingMeta, preferredTerms: string[], index: number): number {
  const title = normalizeText(meta.title || '');
  const description = normalizeText(meta.description || '');
  const tags = splitTags(meta.tags);
  const terms = new Set([...title.split(/\s+/), ...description.split(/\s+/), ...tags].filter(Boolean));

  let score = 0;

  const createdAt = meta.created_at ? new Date(meta.created_at).getTime() : NaN;
  if (!Number.isNaN(createdAt)) {
    const ageHours = Math.max(0, (Date.now() - createdAt) / 36e5);
    score += Math.max(0, 42 - ageHours * 1.4);
  }

  const views = meta.views || 0;
  score += Math.min(20, views / 250);

  const likes = meta.likes || 0;
  score += Math.min(14, likes * 1.6);

  const playCount = meta.playCount || 0;
  score += Math.min(16, playCount * 2.5);

  const sortOrder = meta.sortOrder || 0;
  if (sortOrder > 0) {
    score += Math.max(0, 6 - sortOrder);
  }

  const namespace = normalizeText(meta.namespace || '');
  if (namespace.includes('gamepix')) {
    score += 1;
  }

  if (views < 100) {
    score += 10;
  } else if (views < 1000) {
    score += 5;
  }

  if (preferredTerms.length > 0) {
    let matchedTerms = 0;
    for (const preferred of preferredTerms) {
      const normalizedPreferred = normalizeText(preferred);
      if (!normalizedPreferred) continue;
      if (terms.has(normalizedPreferred)) {
        score += 16;
        matchedTerms += 1;
        continue;
      }
      if (title.includes(normalizedPreferred) || description.includes(normalizedPreferred)) {
        score += 10;
        matchedTerms += 1;
      }
    }

    if (matchedTerms > 0) {
      score += Math.min(12, matchedTerms * 2);
    } else {
      score += 2;
    }
  }

  // Preserve stable ordering for equally ranked items.
  score -= index * 0.001;

  return score;
}

export function sortByFeedScore<T>(
  items: T[],
  getMeta: (item: T, index: number) => RankingMeta,
  preferredTerms: string[] = []
): T[] {
  return [...items]
    .map((item, index) => ({ item, index, score: scoreMeta(getMeta(item, index), preferredTerms, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

  function seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  export function getRandomizedMomentiOrder<T extends { created_at: string }>(
    items: T[],
    seed: number,
    recentWindowHours = 48,
    recentBoost = 0.5
  ): T[] {
    const rand = seededRandom(seed);
    const now = Date.now();
    return items
      .map((item) => {
        const ageHours = (now - new Date(item.created_at).getTime()) / (1000 * 60 * 60);
        const isRecent = ageHours <= recentWindowHours;
        const randomValue = rand();
        const score = isRecent ? randomValue + recentBoost : randomValue;
        return { item, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

function scoreGameMeta(meta: GameRankingMeta, preferredTerms: string[], seed: string, index: number): number {
  const title = normalizeText(meta.title || '');
  const description = normalizeText(meta.description || '');
  const namespace = normalizeText(meta.namespace || '');
  const tags = splitTags(meta.tags);
  const text = `${title} ${description} ${namespace} ${tags.join(' ')}`.trim();

  let score = 0;

  if (title) score += 2;
  if (description) score += 1;
  if (meta.banner_image || meta.image) score += 1;

  const genreHints = ['puzzle', 'action', 'arcade', 'sports', 'racing', 'strategy', 'adventure', 'casual', 'simulation'];
  for (const hint of genreHints) {
    if (text.includes(hint)) score += 1.5;
  }

  for (const preferred of preferredTerms) {
    const normalizedPreferred = normalizeText(preferred);
    if (!normalizedPreferred) continue;
    if (text.includes(normalizedPreferred)) {
      score += 1.25;
    }
  }

  const freshness = 1 - Math.min(1, index / 24);
  score += freshness;
  score += seededUnitValue(seed, meta.id || meta.url || `${title}|${index}`) * 6;

  return score;
}

export function rankGameFeed<T>(
  items: T[],
  getMeta: (item: T, index: number) => GameRankingMeta,
  preferredTerms: string[] = [],
  seed: string = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
): T[] {
  return [...items]
    .map((item, index) => ({ item, index, score: scoreGameMeta(getMeta(item, index), preferredTerms, seed, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}