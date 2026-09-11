-- LukuLuku live-streaming schema FINGERPRINT — READ-ONLY (changes nothing).
-- Run in the Supabase SQL Editor and compare with the expected values
-- (items + fingerprint per row) from the migration files.
with
t(name) as (values
  ('live_streams'), ('stream_categories'), ('live_stream_runtime'),
  ('live_stream_viewer_sessions'), ('live_stream_chat_counts'),
  ('live_stream_reaction_counts'), ('lk_battles'), ('lk_battle_scores'),
  ('lk_battle_end_requests'), ('live_cohost_sessions'), ('gift_catalog'),
  ('coin_packages'), ('viewer_wallets'), ('coin_purchases'),
  ('broadcaster_earnings'), ('gift_transactions'), ('stream_moderators'),
  ('stream_moderation_actions'), ('user_punishments'),
  ('profanity_dictionaries'), ('stream_reports'), ('stream_chat_rate_state'),
  ('live_engagement_counters'), ('live_shares'),
  ('broadcaster_public_points')
),
rel as (
  select c.oid, c.relname, c.relkind, c.relpersistence, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join t on t.name = c.relname
  where n.nspname = 'public'
),
fn as (
  select p.oid, p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef, p.provolatile, p.prosrc
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proname like 'live\_%'
      or p.proname like 'lk\_%'
      or p.proname like 'gift\_%'
      or p.proname like 'coin\_%'
      or p.proname like 'stream\_mod\_%')
),
items(cat, item) as (
  select '01 tables',
         concat_ws(':', relname, relkind::text, relpersistence::text,
                   'rls=' || relrowsecurity::text)
  from rel

  union all
  select case when r.relname = 'live_streams'
              then '02a live_streams columns' else '02b columns' end,
         concat_ws(':', r.relname || '.' || a.attname,
                   format_type(a.atttypid, a.atttypmod),
                   'nn=' || a.attnotnull::text,
                   'def=' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
                   'gen=' || a.attgenerated::text)
  from rel r
  join pg_attribute a
    on a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d
    on d.adrelid = r.oid and d.adnum = a.attnum

  union all
  select '03 constraints',
         concat_ws(':', r.relname || '.' || co.conname, co.contype::text,
                   pg_get_constraintdef(co.oid))
  from rel r
  join pg_constraint co
    on co.conrelid = r.oid and co.contype <> 'n'

  union all
  select '04 indexes', concat_ws(':', i.indexname, i.indexdef)
  from pg_indexes i
  join rel r on r.relname = i.tablename
  where i.schemaname = 'public'

  union all
  select case when p.tablename = 'live_streams'
              then '05a live_streams policies' else '05b policies' end,
         concat_ws(':', p.tablename || '.' || p.policyname, p.cmd,
                   p.permissive, array_to_string(p.roles, ','),
                   coalesce(p.qual, ''), coalesce(p.with_check, ''))
  from pg_policies p
  join rel r on r.relname = p.tablename
  where p.schemaname = 'public'

  union all
  select '06 triggers',
         concat_ws(':', r.relname || '.' || tg.tgname,
                   pg_get_triggerdef(tg.oid))
  from rel r
  join pg_trigger tg on tg.tgrelid = r.oid and not tg.tgisinternal

  union all
  select '07 enums',
         ty.typname || ':' ||
         (select string_agg(e.enumlabel, ',' order by e.enumsortorder)
          from pg_enum e where e.enumtypid = ty.oid)
  from pg_type ty
  join pg_namespace n on n.oid = ty.typnamespace
  where n.nspname = 'public' and ty.typtype = 'e'
    and ty.typname <> 'app_role'

  union all
  select '08 functions',
         concat_ws(':', proname || '(' || args || ')',
                   'secdef=' || prosecdef::text,
                   'vol=' || provolatile::text,
                   'body=' || md5(replace(prosrc, chr(13), '')))
  from fn

  union all
  select '09 function grants',
         concat_ws(':', proname || '(' || args || ')',
           'anon=' || has_function_privilege('anon', oid, 'EXECUTE')::text,
           'auth=' || has_function_privilege('authenticated', oid, 'EXECUTE')::text,
           'svc=' || has_function_privilege('service_role', oid, 'EXECUTE')::text)
  from fn

  union all
  select '10 table grants',
         concat_ws(':', r.relname,
           'anon=' || has_table_privilege('anon', r.oid, 'SELECT')::text
                   || has_table_privilege('anon', r.oid, 'INSERT')::text
                   || has_table_privilege('anon', r.oid, 'UPDATE')::text
                   || has_table_privilege('anon', r.oid, 'DELETE')::text,
           'auth=' || has_table_privilege('authenticated', r.oid, 'SELECT')::text
                   || has_table_privilege('authenticated', r.oid, 'INSERT')::text
                   || has_table_privilege('authenticated', r.oid, 'UPDATE')::text
                   || has_table_privilege('authenticated', r.oid, 'DELETE')::text)
  from rel r
  where r.relname <> 'live_streams'

  union all
  select '11 seed gifts',
         concat_ws(':', id::text, slug, tier::text, coin_cost::text,
                   point_value::text, animation_style::text, is_active::text)
  from public.gift_catalog

  union all
  select '12 seed packages',
         concat_ws(':', id::text, slug,
                   base_coins::text || '+' || bonus_coins::text,
                   price_usd::text, price_srd::text,
                   google_play_product_id, apple_product_id)
  from public.coin_packages

  union all
  select '13 seed categories',
         concat_ws(':', slug, sort_order::text, is_active::text)
  from public.stream_categories

  union all
  select '14 seed profanity',
         concat_ws(':', lower(word_or_pattern), category::text, language,
                   match_whole_word::text, source, is_active::text)
  from public.profanity_dictionaries
)
select cat,
       count(*) as items,
       left(md5(string_agg(item, '|' order by item collate "C")), 10)
         as fingerprint
from items
group by cat
union all
select '15 vault key',
       (select count(*) from vault.secrets
        where name = 'live_chat_signing_key'),
       'expect 1'
order by 1;
