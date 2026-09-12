import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { t } from '../lib/i18n';

export interface StreamCategory {
  id: string;
  slug: string;
  name: string;
  label: string; // translated label (falls back to the DB `name` if no i18n key exists yet)
}

// Reads public.stream_categories (migration 01) — the "Go Live" picker's source of truth.
// `is_active` rows only, ordered the same way the discovery feed uses (sort_order, name).
// The label shown to the user is translated via lib/i18n.ts using the row's `slug` as the
// key (`streamCategory.<slug>`), per the column comment in the migration; if a brand-new
// category is added on the server without a matching i18n entry yet, the raw `name` is used
// instead of showing a translation-key string.
export function useStreamCategories() {
  const [categories, setCategories] = useState<StreamCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: fetchError } = await supabase
        .from('stream_categories')
        .select('id, slug, name')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });

      if (fetchError) throw fetchError;

      const rows = (data || []).map((row: { id: string; slug: string; name: string }) => {
        const i18nKey = `streamCategory.${row.slug}`;
        const translated = t(i18nKey as any);
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          label: translated === i18nKey ? row.name : translated,
        };
      });
      setCategories(rows);
    } catch (err) {
      console.warn('useStreamCategories: failed to load stream_categories', err);
      setError(true);
      setCategories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { categories, loading, error, retry: load };
}
