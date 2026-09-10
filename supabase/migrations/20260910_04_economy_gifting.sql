-- =====================================================================================
-- MIGRATION 04 — ECONOMY, VIRTUAL GIFTING & WALLET INTEGRATION (LukuLuku Live Streaming)
-- =====================================================================================
-- Creates the *coin/points* currency layer for live streaming:
--   ENUMS  : gift_tier (low, medium_low, medium_high, high, super),
--            gift_animation_style (banner, large, fullscreen),
--            coin_purchase_platform, coin_purchase_status
--   TABLES : gift_catalog, coin_packages, viewer_wallets, coin_purchases,
--            broadcaster_earnings, gift_transactions
--   VIEW   : broadcaster_public_points   (public-safe: points only, NEVER cash_balance)
--   RPCs   : coin_wallet_ensure, coin_wallet_balance,
--            coin_purchase_record, coin_purchase_mark_verified, coin_purchase_mark_failed,
--            gift_send, gift_live_stream_points, gift_live_stream_top_senders
--   SEED   : 50 gifts (gift_catalog) + 10 coin packages (coin_packages)
--
-- MUST RUN AFTER:
--   20260910_01_live_streaming_core.sql   (live_streams already exists; 01 adds side tables)
--   20260910_03_lk_battles.sql            (provides public.lk_battle_add_points + lk_battles, and
--                                          for CO-HOSTING public.live_cohost_sessions +
--                                          public.live_cohost_active_session, which gift_send
--                                          calls to stamp gift_transactions.cohost_session_id)
--
-- CO-HOSTING (user approved 2026-09-11): nothing new is needed to gift across the 50/50
-- screen — gifting the partner = calling gift_send() with the PARTNER's live_stream_id; the
-- receiver is still resolved server-side from that stream's host. The only addition is the
-- nullable ledger column gift_transactions.cohost_session_id (points-in-session per side).
--
-- SAFE TO RE-RUN: yes — every object is created with if-not-exists / or-replace /
-- drop-then-create semantics, and both seeds use ON CONFLICT (id) DO NOTHING.
-- EXCEPTION: a database that already holds an OLDER DRAFT of this file (gift_tier =
-- 'basic'/'premium', gift_catalog without slug, coin_purchases without coin_package_id)
-- must run the ROLLBACK block at the bottom FIRST. Section 0 detects that case and aborts
-- with a clear message instead of half-applying.
--
-- ------------------------------------------------------------------------------------
-- PRICING RULES (user, 2026-09-10)
--   * Broadcaster earns 60% of a gift's coin cost as points; LukuLuku keeps 40%.
--     point_value = greatest(1, round(coin_cost * 0.60)) — stored per gift, not computed.
--   * Gifts are priced in 5 tiers: low 1-50, medium_low 51-300, medium_high 301-1,000,
--     high 1,001-5,000, super 5,001-20,000 coins. A CHECK keeps tier and coin_cost in sync.
--   * How big the animation is lives in gift_catalog.animation_style, NOT in the tier.
--   * coin_packages is the ONLY source of how many coins a store product is worth.
--     Neither the client nor the verifying server ever passes a coin amount any more.
--
-- ------------------------------------------------------------------------------------
-- IMPORTANT — TWO SEPARATE MONEY SYSTEMS. DO NOT CONFUSE THEM.
--   public.wallets            = PRE-EXISTING SRD *cash* wallet. Real payouts via
--                               create_withdrawal(). THIS FILE NEVER TOUCHES IT.
--   public.viewer_wallets     = NEW. Spendable *coins* bought via Google/Apple IAP.
--   public.broadcaster_earnings = NEW. Points earned from gifts + a converted
--                               cash_balance that is *staged* for payout.
-- The bridge broadcaster_earnings.cash_balance -> wallets.balance is intentionally
-- NOT built here (it needs an FX/margin policy decision + an admin approval flow).
-- ------------------------------------------------------------------------------------

begin;

-- =====================================================================================
-- 0. STALE-DRAFT GUARD
-- =====================================================================================
-- Every create below is "if not exists", so on a DB that already has an OLDER draft of this
-- file they would silently keep the old shapes and then fail half-way (e.g. seeding 'low'
-- into an enum that only knows 'basic'/'premium'). Detect that up front and abort the whole
-- transaction with an actionable message. On a fresh DB, or on a re-run of THIS version,
-- this block is a no-op.
do $$
declare
  v_tier_labels text[];
begin
  select array_agg(e.enumlabel::text order by e.enumsortorder)
    into v_tier_labels
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e      on e.enumtypid = t.oid
  where n.nspname = 'public' and t.typname = 'gift_tier';

  if v_tier_labels is not null
     and v_tier_labels <> array['low', 'medium_low', 'medium_high', 'high', 'super'] then
    raise exception 'STALE_DRAFT: public.gift_tier already exists with labels %. Run the ROLLBACK block at the bottom of 20260910_04_economy_gifting.sql first, then re-run this file.', v_tier_labels;
  end if;

  if to_regclass('public.gift_catalog') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'gift_catalog'
                       and column_name = 'slug') then
    raise exception 'STALE_DRAFT: public.gift_catalog exists without the slug column. Run the ROLLBACK block of 20260910_04_economy_gifting.sql first.';
  end if;

  if to_regclass('public.coin_purchases') is not null
     and not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'coin_purchases'
                       and column_name = 'coin_package_id') then
    raise exception 'STALE_DRAFT: public.coin_purchases exists without the coin_package_id column. Run the ROLLBACK block of 20260910_04_economy_gifting.sql first.';
  end if;
end $$;


-- =====================================================================================
-- 1. ENUMS
-- =====================================================================================

-- Price tier of a gift. Declared in ascending price order on purpose: enum comparison and
-- ORDER BY follow declaration order, so "order by tier" lists cheap -> expensive.
-- NOTE: a DB where an older draft of this enum ('basic','premium') already exists must run
-- the ROLLBACK block first — the duplicate_object guard below would otherwise keep the old
-- labels (section 0 aborts in that case).
do $$ begin
  create type public.gift_tier as enum ('low', 'medium_low', 'medium_high', 'high', 'super');
exception when duplicate_object then null; end $$;

-- How the client renders a gift. Separate from gift_tier so an admin can, for example, give
-- a cheap promo/event gift a full-screen animation without lying about its price tier.
do $$ begin
  create type public.gift_animation_style as enum ('banner', 'large', 'fullscreen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.coin_purchase_platform as enum ('google_play', 'apple_iap');
exception when duplicate_object then null; end $$;

-- 'refunded' IS included deliberately. Apple/Google can revoke a purchase days later via
-- a server notification. Without a distinct terminal state we would have to overload
-- 'failed' (which means "never credited") and lose the ability to tell a clawback apart
-- from a bad receipt. Adding an enum value later requires ALTER TYPE ... ADD VALUE, which
-- has transaction-block restrictions, so it is cheaper to reserve it now.
-- NOTE: no automatic coin clawback logic is implemented in this migration — see the
-- open question about refunds where the coins were already spent.
do $$ begin
  create type public.coin_purchase_status as enum ('pending', 'verified', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

comment on type public.gift_tier is
  'Price band of a gift, in coins: low 1-50, medium_low 51-300, medium_high 301-1000, high 1001-5000, super 5001-20000. Enforced against gift_catalog.coin_cost by gift_catalog_tier_band_check. Says NOTHING about animation size — see gift_animation_style.';
comment on type public.gift_animation_style is
  'How big the gift animation is on screen. banner = small side animation (default for low + medium_low); large = big in-frame animation (medium_high); fullscreen = full-screen takeover (high + super). Deliberately not tied to gift_tier by a constraint so promo gifts can deviate.';
comment on type public.coin_purchase_status is
  'pending = receipt recorded, not yet verified with the store. verified = receipt verified server-side AND coins credited (exactly once). failed = receipt rejected, nothing credited. refunded = was verified+credited, then revoked by the store.';


-- =====================================================================================
-- 2. gift_catalog — reference table of purchasable gifts
-- =====================================================================================

create table if not exists public.gift_catalog (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null,
  name                text not null,
  emoji               text,
  tier                public.gift_tier not null,
  animation_style     public.gift_animation_style not null,
  coin_cost           bigint not null,
  point_value         bigint not null,
  animation_asset_ref text,
  sort_order          int not null default 0,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint gift_catalog_name_key        unique (name),
  constraint gift_catalog_slug_key        unique (slug),
  constraint gift_catalog_slug_check      check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint gift_catalog_name_check      check (length(btrim(name)) between 1 and 60),
  constraint gift_catalog_emoji_check     check (emoji is null or length(emoji) between 1 and 16),
  constraint gift_catalog_coin_cost_check check (coin_cost between 1 and 20000),
  constraint gift_catalog_point_value_check check (point_value >= 1),
  -- The tier is not a free choice: it is the price band coin_cost falls in.
  constraint gift_catalog_tier_band_check check (
    tier = case
             when coin_cost <=    50 then 'low'::public.gift_tier
             when coin_cost <=   300 then 'medium_low'::public.gift_tier
             when coin_cost <=  1000 then 'medium_high'::public.gift_tier
             when coin_cost <=  5000 then 'high'::public.gift_tier
             else                         'super'::public.gift_tier
           end
  )
);

comment on table public.gift_catalog is
  'Reference/config table of purchasable live-stream gifts. Retire a gift with is_active=false — NEVER delete a row, gift_transactions references it with ON DELETE RESTRICT so send history stays intact.';
comment on column public.gift_catalog.slug is
  'Stable lowercase-kebab machine key (e.g. luku-clap). Use it — never the uuid or the display name — as the i18n key in lib/i18n.ts for the nl / en / srn gift names. Never rename a slug once shipped.';
comment on column public.gift_catalog.name is
  'Default (English) display name. Fallback only; the client shows the translated name looked up by slug.';
comment on column public.gift_catalog.emoji is
  'Fallback glyph the client can show before the animation asset has loaded (or if it fails to load).';
comment on column public.gift_catalog.tier is
  'Price band (see type gift_tier). Must match coin_cost — enforced by gift_catalog_tier_band_check. Changing a price across a band boundary therefore requires changing the tier in the same UPDATE.';
comment on column public.gift_catalog.animation_style is
  'How big the animation is on screen (banner / large / fullscreen). This replaces the old "premium = full-screen" meaning of tier.';
comment on column public.gift_catalog.coin_cost is
  'Coins the SENDER pays, 1-20000. Snapshotted onto gift_transactions.coin_cost at send time, so changing this later does not rewrite history.';
comment on column public.gift_catalog.point_value is
  'Points the RECEIVER earns per unit. MARGIN RULE (user, 2026-09-10): point_value = greatest(1, round(coin_cost * 0.60)) — the broadcaster gets 60%, LukuLuku keeps 40%. Stated here and NOT as a CHECK on purpose, so a future promo gift may deviate. Minimum 1 so a gift is never worth nothing to the creator.';
comment on column public.gift_catalog.animation_asset_ref is
  'Client-side asset key (e.g. lottie file name). Convention: ''gift_'' || replace(slug, ''-'', ''_''). Never a binary blob.';

-- Gift sheet: active gifts grouped by tier tab, cheap -> expensive inside each tab.
-- Serves both "where is_active order by tier, coin_cost, sort_order" (whole sheet) and
-- "where is_active and tier = X order by coin_cost" (one tab). Tier bands are monotonic in
-- coin_cost, so ordering by tier first never reorders prices.
create index if not exists gift_catalog_active_tier_cost_idx
  on public.gift_catalog (tier, coin_cost asc, sort_order asc)
  where is_active;

drop trigger if exists gift_catalog_set_updated_at on public.gift_catalog;
create trigger gift_catalog_set_updated_at
  before update on public.gift_catalog
  for each row execute function public.update_updated_at_column();


-- =====================================================================================
-- 2b. coin_packages — the coin top-up packages sold through Google Play / App Store
-- =====================================================================================
-- SINGLE SOURCE OF TRUTH for "how many coins is store product X worth". Both
-- coin_purchase_record() and coin_purchase_mark_verified() resolve the package from
-- (platform, product_id) here; no coin amount is ever accepted from the client or from the
-- verifying Edge Function.

create table if not exists public.coin_packages (
  id                     uuid primary key default gen_random_uuid(),
  slug                   text not null,
  name                   text not null,
  sort_order             int  not null default 0,
  base_coins             bigint not null,
  bonus_coins            bigint not null default 0,
  total_coins            bigint generated always as (base_coins + bonus_coins) stored,
  price_usd              numeric(10,2) not null,
  price_srd              numeric(12,2) not null,
  google_play_product_id text,
  apple_product_id       text,
  badge                  text,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint coin_packages_slug_key          unique (slug),
  constraint coin_packages_google_play_product_id_key unique (google_play_product_id),
  constraint coin_packages_apple_product_id_key       unique (apple_product_id),
  constraint coin_packages_slug_check        check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint coin_packages_name_check        check (length(btrim(name)) between 1 and 60),
  constraint coin_packages_base_coins_check  check (base_coins > 0),
  constraint coin_packages_bonus_coins_check check (bonus_coins >= 0),
  constraint coin_packages_price_usd_check   check (price_usd > 0),
  constraint coin_packages_price_srd_check   check (price_srd > 0),
  -- Store product-id character rules: Google = lowercase letters, digits, '_' and '.',
  -- starting with a letter/digit; Apple also allows uppercase. Max 150 is a sanity cap.
  constraint coin_packages_google_play_product_id_check check (
    google_play_product_id is null or google_play_product_id ~ '^[a-z0-9][a-z0-9._]{0,149}$'),
  constraint coin_packages_apple_product_id_check check (
    apple_product_id is null or apple_product_id ~ '^[A-Za-z0-9][A-Za-z0-9._]{0,149}$'),
  -- A package that cannot be bought on either store is a config mistake.
  constraint coin_packages_has_product_id_check check (
    google_play_product_id is not null or apple_product_id is not null),
  constraint coin_packages_badge_check check (
    badge is null or length(btrim(badge)) between 1 and 32)
);

comment on table public.coin_packages is
  'Coin top-up packages sold as consumable in-app products. THE single source of truth for how many coins a store product credits: coin_purchase_record() / coin_purchase_mark_verified() look the package up by (platform, product_id) and never accept a coin amount from outside. Retire a package with is_active=false — NEVER delete a row that has purchases (coin_purchases references it ON DELETE RESTRICT).';
comment on column public.coin_packages.slug is
  'Stable lowercase-kebab machine key; the i18n key in lib/i18n.ts for the nl / en / srn package name.';
comment on column public.coin_packages.base_coins is
  'Coins the price itself buys (baseline ~100 base coins per 1 USD / per ~38.5 SRD).';
comment on column public.coin_packages.bonus_coins is
  'Extra free coins on top of base_coins. Snapshotted onto coin_purchases at purchase time, so changing a bonus later does not change what past buyers were credited.';
comment on column public.coin_packages.total_coins is
  'GENERATED = base_coins + bonus_coins. Exactly what one purchase of this package credits.';
comment on column public.coin_packages.price_usd is
  'REFERENCE / DISPLAY VALUE ONLY. The price the user actually pays is set per country in Google Play Console / App Store Connect and must be shown from the store SDK (localized price string). This value may drift from the store and is never used for crediting or accounting.';
comment on column public.coin_packages.price_srd is
  'REFERENCE / DISPLAY VALUE ONLY, in Surinamese dollars. The real charged price comes from the store SDK. This value may drift from the store price AND from the live SRD exchange rate; never use it for crediting or accounting.';
comment on column public.coin_packages.google_play_product_id is
  'Google Play in-app product id (consumable). Must exist in Play Console with the same id. Looked up when coin_purchases.platform = google_play.';
comment on column public.coin_packages.apple_product_id is
  'App Store Connect consumable product id. PERMANENT: Apple never lets a product id be reused once created, even after deleting the product — never rename or recycle it. Looked up when coin_purchases.platform = apple_iap.';
comment on column public.coin_packages.badge is
  'Optional marketing badge key (e.g. popular, best_value). Free text, length-checked; the client maps it to a translated label.';

-- Top-up sheet: active packages in display order. (Product-id lookups use the unique keys.)
create index if not exists coin_packages_active_sort_idx
  on public.coin_packages (sort_order asc)
  where is_active;

drop trigger if exists coin_packages_set_updated_at on public.coin_packages;
create trigger coin_packages_set_updated_at
  before update on public.coin_packages
  for each row execute function public.update_updated_at_column();


-- =====================================================================================
-- 3. viewer_wallets — one row per user, spendable COIN balance (NOT cash)
-- =====================================================================================

create table if not exists public.viewer_wallets (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  coin_balance bigint not null default 0 check (coin_balance >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.viewer_wallets is
  'Spendable COIN balance per user. This is NOT public.wallets (that one is the SRD cash wallet used by create_withdrawal()). Coins only ever enter via a verified coin_purchases row and only ever leave via gift_send(). There is no client INSERT/UPDATE policy — all writes go through SECURITY DEFINER RPCs.';
comment on column public.viewer_wallets.coin_balance is
  'CHECK (>= 0) is the last line of defence: a race that would overdraw the wallet aborts the whole gift transaction instead of going negative.';

-- ON DELETE CASCADE (not set null / restrict): this is *state*, not a ledger. The durable
-- financial record lives in coin_purchases + gift_transactions, which survive user deletion.
-- Cascade also keeps supabase/functions/delete-account working (it calls auth.admin.deleteUser).

drop trigger if exists viewer_wallets_set_updated_at on public.viewer_wallets;
create trigger viewer_wallets_set_updated_at
  before update on public.viewer_wallets
  for each row execute function public.update_updated_at_column();


-- =====================================================================================
-- 4. broadcaster_earnings — one row per broadcaster
-- =====================================================================================

create table if not exists public.broadcaster_earnings (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  points_balance        bigint not null default 0 check (points_balance >= 0),
  lifetime_points_earned bigint not null default 0 check (lifetime_points_earned >= 0),
  cash_balance          numeric(18,2) not null default 0 check (cash_balance >= 0),
  cash_currency         text not null default 'SRD',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.broadcaster_earnings is
  'Per-broadcaster gift earnings. points_balance/lifetime_points_earned are PUBLIC-SAFE (exposed through the broadcaster_public_points view). cash_balance is PRIVATE — owner + admin only — and is staged value awaiting a future payout RPC that would move it into public.wallets.balance. That bridge is NOT built in this migration.';
comment on column public.broadcaster_earnings.points_balance is
  'Points not yet converted to cash. Decreases on conversion.';
comment on column public.broadcaster_earnings.lifetime_points_earned is
  'Monotonically increasing. Never decremented — this is the number leaderboards and stats read.';
comment on column public.broadcaster_earnings.cash_balance is
  'Converted, not-yet-paid-out value. NEVER select this column into a public/room-wide query — use public.broadcaster_public_points instead.';

drop trigger if exists broadcaster_earnings_set_updated_at on public.broadcaster_earnings;
create trigger broadcaster_earnings_set_updated_at
  before update on public.broadcaster_earnings
  for each row execute function public.update_updated_at_column();

-- Global "top earners" leaderboard path.
create index if not exists broadcaster_earnings_lifetime_points_idx
  on public.broadcaster_earnings (lifetime_points_earned desc)
  where lifetime_points_earned > 0;


-- =====================================================================================
-- 5. coin_purchases — IAP top-up history (replay-protected)
-- =====================================================================================

create table if not exists public.coin_purchases (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,
  platform        public.coin_purchase_platform not null,
  product_id      text not null,
  receipt_token   text not null,
  -- ON DELETE RESTRICT: ledger integrity — a package that was ever bought cannot be deleted
  -- (retire it with is_active=false instead).
  coin_package_id uuid not null references public.coin_packages(id) on delete restrict,
  base_coins      bigint not null check (base_coins > 0),   -- snapshot of coin_packages.base_coins
  bonus_coins     bigint not null check (bonus_coins >= 0), -- snapshot of coin_packages.bonus_coins
  coins_expected  bigint generated always as (base_coins + bonus_coins) stored,
  coins_credited  bigint not null default 0 check (coins_credited >= 0),
  price_paid      numeric(18,2) check (price_paid >= 0),
  currency        text,
  status          public.coin_purchase_status not null default 'pending',
  failure_reason  text,
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Credit rule, enforced by the DB as a backstop to coin_purchase_mark_verified():
  --   pending / failed -> nothing credited (0)
  --   verified         -> exactly the snapshotted base + bonus
  --   refunded         -> left open for a future clawback design (no rule yet)
  constraint coin_purchases_credit_matches_snapshot_check check (
    case status
      when 'verified' then coins_credited = base_coins + bonus_coins
      when 'refunded' then true
      else                 coins_credited = 0
    end
  )
);

comment on table public.coin_purchases is
  'IAP top-up ledger. A row is created as pending by the buyer (coin_purchase_record); ONLY the service role / verifying Edge Function may flip it to verified and credit coins (coin_purchase_mark_verified). The coin amount always comes from coin_packages (snapshotted here), never from the client or the verifier. No client INSERT/UPDATE policy exists.';
comment on column public.coin_purchases.user_id is
  'ON DELETE SET NULL, not CASCADE: the purchase record (and its receipt uniqueness) must survive account deletion for accounting/replay protection. Account deletion therefore anonymises rather than erases.';
comment on column public.coin_purchases.product_id is
  'Store product id. Written first from the client call, then OVERWRITTEN by coin_purchase_mark_verified with the product id the store itself confirmed — the store is authoritative.';
comment on column public.coin_purchases.coin_package_id is
  'The coin_packages row this purchase resolved to (via platform + product_id). ON DELETE RESTRICT.';
comment on column public.coin_purchases.base_coins is
  'Snapshot of coin_packages.base_coins at record time (or at verify time when the store notification arrived first, or when the verified product differed from what the client claimed). Keeps history accurate if the package changes later.';
comment on column public.coin_purchases.bonus_coins is
  'Snapshot of coin_packages.bonus_coins, same timing as base_coins.';
comment on column public.coin_purchases.coins_expected is
  'GENERATED = base_coins + bonus_coins. Server-resolved from coin_packages (no longer a client claim). What this purchase credits once verified.';
comment on column public.coin_purchases.coins_credited is
  'Written exactly once, by coin_purchase_mark_verified, at the moment the wallet is credited. CHECK coin_purchases_credit_matches_snapshot_check: 0 for pending/failed, = base_coins + bonus_coins for verified.';
comment on column public.coin_purchases.receipt_token is
  'Store purchase token / transaction id. Together with platform this is the replay-protection key: UNIQUE (platform, receipt_token) makes a duplicated store webhook a no-op instead of a double credit.';

-- === REPLAY PROTECTION (the important one) ===========================================
-- A store webhook firing twice, or a client retrying, cannot create a second row.
create unique index if not exists coin_purchases_platform_receipt_key
  on public.coin_purchases (platform, receipt_token);

-- A user's purchase history screen.
create index if not exists coin_purchases_user_created_idx
  on public.coin_purchases (user_id, created_at desc);

-- Ops: find receipts stuck awaiting verification.
create index if not exists coin_purchases_pending_idx
  on public.coin_purchases (created_at asc)
  where status = 'pending';

-- "Sales per package" analytics + protects the RESTRICT lookup on package delete.
create index if not exists coin_purchases_package_idx
  on public.coin_purchases (coin_package_id);

drop trigger if exists coin_purchases_set_updated_at on public.coin_purchases;
create trigger coin_purchases_set_updated_at
  before update on public.coin_purchases
  for each row execute function public.update_updated_at_column();


-- =====================================================================================
-- 6. gift_transactions — permanent gift ledger
-- =====================================================================================

create table if not exists public.gift_transactions (
  id               uuid primary key default gen_random_uuid(),

  -- ON DELETE RESTRICT: a stream that recorded real-money gifts must not be deletable.
  -- Correct lifecycle is status='ended', not DELETE. (See report note.)
  live_stream_id   uuid not null references public.live_streams(id) on delete restrict,

  -- ON DELETE SET NULL: preserves the ledger row (amounts, stream, gift) while
  -- anonymising the person, so supabase/functions/delete-account keeps working.
  sender_user_id   uuid references auth.users(id) on delete set null,
  receiver_user_id uuid references auth.users(id) on delete set null,

  -- ON DELETE RESTRICT: catalog rows are retired via is_active, never deleted.
  gift_id          uuid not null references public.gift_catalog(id) on delete restrict,

  quantity         int    not null default 1 check (quantity > 0 and quantity <= 999),
  coin_cost        bigint not null check (coin_cost >= 0),   -- PER UNIT, snapshotted
  point_value      bigint not null check (point_value >= 0), -- PER UNIT, snapshotted
  total_coin_cost   bigint generated always as (coin_cost   * quantity) stored,
  total_point_value bigint generated always as (point_value * quantity) stored,

  -- Snapshot of gift_catalog.tier. No default: gift_send() always writes it.
  gift_tier        public.gift_tier not null,

  -- Set when the gift landed inside an active LK Battle window (file 03 decides this).
  battle_id        uuid references public.lk_battles(id) on delete set null,

  -- Set when the receiving stream was in a LIVE co-host session at send time (file 03's
  -- live_cohost_active_session decides this). Also added idempotently below the table.
  cohost_session_id uuid references public.live_cohost_sessions(id) on delete set null,

  -- Optional client-generated idempotency key. See gift_send().
  client_tx_id     uuid,

  sent_at          timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

comment on table public.gift_transactions is
  'Permanent, append-only gift ledger. Written ONLY by gift_send(). No client INSERT/UPDATE/DELETE policy exists. FKs deliberately never CASCADE — deleting a stream is RESTRICTed, deleting a user SET NULLs the identity but keeps the money record.';
comment on column public.gift_transactions.coin_cost is
  'PER-UNIT coin price snapshotted from gift_catalog at send time. Snapshotting (instead of joining live to the catalog) keeps the historical ledger correct after a price change.';
comment on column public.gift_transactions.point_value is
  'PER-UNIT point value snapshotted from gift_catalog at send time.';
comment on column public.gift_transactions.quantity is
  'Combo/spam-tap gifting collapses into ONE row instead of N rows. total_coin_cost / total_point_value are GENERATED, so the row can never disagree with itself.';
comment on column public.gift_transactions.battle_id is
  'Non-null when lk_battle_add_points() reported an active battle at send time. Lets the battle recap screen list the exact gifts that produced the score without re-deriving from timestamps.';
comment on column public.gift_transactions.client_tx_id is
  'Optional idempotency key supplied by the client. Unique per sender (partial unique index). A double-tap / network retry that reuses the same key returns the ORIGINAL transaction instead of debiting twice.';

-- CO-HOSTING column, for a gift_transactions table that already existed before this version
-- of the file (create table if not exists would skip it). gift_transactions is OUR table
-- (created above), so this is allowed. Plain ADD COLUMN IF NOT EXISTS + a guarded, named FK,
-- so a re-run is a no-op. ON DELETE SET NULL (never cascade): ledger rows must survive.
alter table public.gift_transactions
  add column if not exists cohost_session_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.gift_transactions'::regclass
                    and conname  = 'gift_transactions_cohost_session_id_fkey') then
    alter table public.gift_transactions
      add constraint gift_transactions_cohost_session_id_fkey
      foreign key (cohost_session_id) references public.live_cohost_sessions(id)
      on delete set null;
  end if;
end $$;

comment on column public.gift_transactions.cohost_session_id is
  'Non-null when the receiving stream (live_stream_id) was inside a LIVE co-host session at send time — stamped by gift_send() from live_cohost_active_session(). Cross-room gifting on the 50/50 screen needs nothing else: gifting the partner = sending to the partner''s live_stream_id. file 06 sums total_point_value per (cohost_session_id, live_stream_id) for each side''s "points earned in this co-hosting". ON DELETE SET NULL keeps the money record.';

-- === IDEMPOTENCY ===
create unique index if not exists gift_transactions_sender_client_tx_key
  on public.gift_transactions (sender_user_id, client_tx_id)
  where client_tx_id is not null and sender_user_id is not null;

-- Sender's own gift history ("Coins spent" screen).
create index if not exists gift_transactions_sender_sent_idx
  on public.gift_transactions (sender_user_id, sent_at desc);

-- Receiver's earnings history ("Gifts received" screen).
create index if not exists gift_transactions_receiver_sent_idx
  on public.gift_transactions (receiver_user_id, sent_at desc);

-- Per-stream gift feed + per-stream totals for the end-of-stream summary screen.
create index if not exists gift_transactions_stream_sent_idx
  on public.gift_transactions (live_stream_id, sent_at desc);

-- Top-gifter leaderboard for a stream (GROUP BY sender within one stream).
create index if not exists gift_transactions_stream_sender_idx
  on public.gift_transactions (live_stream_id, sender_user_id);

-- Battle recap: which gifts fed this battle.
create index if not exists gift_transactions_battle_idx
  on public.gift_transactions (battle_id, sent_at desc)
  where battle_id is not null;

-- Co-hosting: points each side earned in one session (file 06's
-- live_engagement_counts_cohost sums per (session, receiving stream)), plus the index the
-- ON DELETE SET NULL from live_cohost_sessions needs.
create index if not exists gift_transactions_cohost_session_idx
  on public.gift_transactions (cohost_session_id, live_stream_id)
  where cohost_session_id is not null;

-- "Most gifted gift" analytics + protects the RESTRICT lookup on catalog delete.
create index if not exists gift_transactions_gift_idx
  on public.gift_transactions (gift_id);


-- =====================================================================================
-- 7. PUBLIC-SAFE READ PATH FOR EARNINGS (points yes, cash NEVER)
-- =====================================================================================
-- broadcaster_earnings itself is owner+admin only. The on-stream hype counter needs to be
-- readable by every viewer in the room. Column-level GRANTs are unverified in this project,
-- so instead of relying on them we expose a view that is *defined* to omit cash_balance.
-- security_invoker = false (the PostgreSQL default) means the view runs as its owner and
-- therefore bypasses the underlying RLS — the view's column list IS the security boundary.

create or replace view public.broadcaster_public_points as
  select
    be.user_id,
    be.points_balance,
    be.lifetime_points_earned,
    be.updated_at
  from public.broadcaster_earnings be;

-- security_invoker is a PG15+ view option. On PG<15 a view already runs as its owner,
-- so failing to set it is harmless — swallow the error rather than abort the migration.
do $$ begin
  execute 'alter view public.broadcaster_public_points set (security_invoker = false)';
exception when others then null; end $$;

comment on view public.broadcaster_public_points is
  'PUBLIC-SAFE projection of broadcaster_earnings. Intentionally omits cash_balance and cash_currency. Runs with security_invoker=false so it can read past the owner-only RLS on the base table; the column list is the security boundary. NEVER add a cash column here.';


-- =====================================================================================
-- 8. ROW LEVEL SECURITY
-- =====================================================================================
-- Money tables get SELECT-own only. There is deliberately NO client INSERT/UPDATE policy
-- on viewer_wallets, broadcaster_earnings, coin_purchases or gift_transactions — every
-- write flows through the SECURITY DEFINER RPCs below.
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally NOT enabled, because the SECURITY
-- DEFINER RPCs run as the table owner and must be able to write.

alter table public.gift_catalog         enable row level security;
alter table public.coin_packages        enable row level security;
alter table public.viewer_wallets       enable row level security;
alter table public.broadcaster_earnings enable row level security;
alter table public.coin_purchases       enable row level security;
alter table public.gift_transactions    enable row level security;

-- ---- gift_catalog: public reference data, admin-managed -----------------------------
drop policy if exists "Anyone can read active gifts" on public.gift_catalog;
create policy "Anyone can read active gifts"
  on public.gift_catalog for select to anon, authenticated
  using (is_active or public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Admins manage the gift catalog" on public.gift_catalog;
create policy "Admins manage the gift catalog"
  on public.gift_catalog for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- coin_packages: public reference data (top-up sheet), admin-managed ---------------
-- Readable by anon too, so the store screen can render before sign-in.
drop policy if exists "Anyone can read active coin packages" on public.coin_packages;
create policy "Anyone can read active coin packages"
  on public.coin_packages for select to anon, authenticated
  using (is_active or public.has_role(auth.uid(), 'admin'::public.app_role));

drop policy if exists "Admins manage coin packages" on public.coin_packages;
create policy "Admins manage coin packages"
  on public.coin_packages for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- viewer_wallets: own coin balance only ------------------------------------------
drop policy if exists "Users read own coin wallet" on public.viewer_wallets;
create policy "Users read own coin wallet"
  on public.viewer_wallets for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- broadcaster_earnings: own row only (this is where cash_balance lives) ----------
drop policy if exists "Broadcasters read own earnings" on public.broadcaster_earnings;
create policy "Broadcasters read own earnings"
  on public.broadcaster_earnings for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- coin_purchases: own purchases only ---------------------------------------------
drop policy if exists "Users read own coin purchases" on public.coin_purchases;
create policy "Users read own coin purchases"
  on public.coin_purchases for select to authenticated
  using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'::public.app_role));

-- ---- gift_transactions: rows you sent or received ------------------------------------
-- Deliberately NOT publicly readable: a room-wide gift feed / top-gifter list is served by
-- the SECURITY DEFINER helpers below so we control exactly which columns leave the server.
drop policy if exists "Users read own gift transactions" on public.gift_transactions;
create policy "Users read own gift transactions"
  on public.gift_transactions for select to authenticated
  using (
    auth.uid() = sender_user_id
    or auth.uid() = receiver_user_id
    or public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- ---- GRANTS (Supabase default privileges are unverified in this project) -------------
grant select on public.gift_catalog             to anon, authenticated;
grant insert, update, delete on public.gift_catalog to authenticated;  -- gated by admin policy
grant select on public.coin_packages            to anon, authenticated;
grant insert, update, delete on public.coin_packages to authenticated; -- gated by admin policy
grant select on public.viewer_wallets           to authenticated;
grant select on public.broadcaster_earnings     to authenticated;
grant select on public.coin_purchases           to authenticated;
grant select on public.gift_transactions        to authenticated;
grant select on public.broadcaster_public_points to anon, authenticated;

-- No INSERT/UPDATE/DELETE grant on the four money tables, on purpose.


-- =====================================================================================
-- 9. RPCs
-- =====================================================================================
-- AUTO-PROVISIONING DECISION: lazy upsert inside the RPCs, NOT a trigger.
--   * A trigger would have to hang off auth.users or profiles — both are pre-existing
--     tables and are off-limits per the non-breaking mandate.
--   * Lazy provisioning means no empty rows for the (many) users who never gift.
--   * `insert ... on conflict (user_id) do nothing` is race-safe under concurrency.

-- -------------------------------------------------------------------------------------
-- coin_wallet_ensure() — create-if-missing + return the caller's own coin wallet.
-- Safe for the client to call when opening the gift sheet.
-- -------------------------------------------------------------------------------------
create or replace function public.coin_wallet_ensure()
returns public.viewer_wallets
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.viewer_wallets;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'LKG05';
  end if;

  insert into public.viewer_wallets (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select * into v_row from public.viewer_wallets where user_id = v_uid;
  return v_row;
end;
$$;

comment on function public.coin_wallet_ensure() is
  'Lazily provisions and returns the calling user own coin wallet. Cannot touch anyone else — the user id comes from auth.uid(), never from a parameter.';

-- -------------------------------------------------------------------------------------
-- coin_wallet_balance() — cheap balance read (returns 0 if no wallet row yet).
-- -------------------------------------------------------------------------------------
create or replace function public.coin_wallet_balance()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select w.coin_balance from public.viewer_wallets w where w.user_id = auth.uid()),
    0::bigint
  );
$$;

comment on function public.coin_wallet_balance() is
  'Returns the calling user coin balance, or 0 when no wallet row has been provisioned yet.';


-- -------------------------------------------------------------------------------------
-- coin_purchase_record(...) — buyer records a PENDING receipt. CREDITS NOTHING.
-- -------------------------------------------------------------------------------------
-- Trust model: the client may only ever create a 'pending' row for itself. It cannot set
-- status, cannot set coins_credited, cannot pick the user, and — since 2026-09-10 — cannot
-- say how many coins the purchase is worth: the package is resolved here from
-- (p_platform, p_product_id) against coin_packages and base/bonus are snapshotted onto the
-- row. Re-calling with the same (platform, receipt_token) returns the existing row id
-- instead of erroring — this makes the client retry path (app relaunch, flaky network)
-- harmless, even if the package was deactivated in between.
--
-- The old signature took a client-sent p_coins_expected. Drop it so the two overloads can
-- never coexist (a call with 5 args would otherwise be ambiguous).
drop function if exists public.coin_purchase_record(public.coin_purchase_platform, text, text, bigint, numeric, text);

create or replace function public.coin_purchase_record(
  p_platform      public.coin_purchase_platform,
  p_product_id    text,
  p_receipt_token text,
  p_price_paid    numeric default null,
  p_currency      text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_token   text := nullif(trim(p_receipt_token), '');
  v_product text := nullif(trim(p_product_id), '');
  v_pkg     public.coin_packages;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'LKG05';
  end if;
  if v_token is null then
    raise exception 'RECEIPT_TOKEN_REQUIRED' using errcode = 'LKC01';
  end if;
  if v_product is null then
    raise exception 'PRODUCT_ID_REQUIRED' using errcode = 'LKC02';
  end if;

  -- Retry fast path: receipt already recorded (app relaunch, or a second device replaying
  -- the same purchase). Checked BEFORE the package lookup so a retry still succeeds after
  -- the package has been deactivated.
  select cp.id into v_id
  from public.coin_purchases cp
  where cp.platform = p_platform and cp.receipt_token = v_token;
  if found then
    return v_id;
  end if;

  -- Resolve the package against the store-specific product-id column.
  select * into v_pkg
  from public.coin_packages pk
  where (p_platform = 'google_play' and pk.google_play_product_id = v_product)
     or (p_platform = 'apple_iap'   and pk.apple_product_id       = v_product);

  if not found then
    raise exception 'UNKNOWN_PRODUCT: % on %', v_product, p_platform using errcode = 'LKC06';
  end if;
  if not v_pkg.is_active then
    raise exception 'PRODUCT_INACTIVE: %', v_product using errcode = 'LKC07';
  end if;

  insert into public.coin_purchases (
    user_id, platform, product_id, receipt_token,
    coin_package_id, base_coins, bonus_coins,
    price_paid, currency, status
  )
  values (
    v_uid, p_platform, v_product, v_token,
    v_pkg.id, v_pkg.base_coins, v_pkg.bonus_coins,
    p_price_paid, p_currency, 'pending'
  )
  on conflict (platform, receipt_token) do nothing
  returning id into v_id;

  if v_id is null then
    -- Lost a race with a concurrent record / store notification for the same receipt.
    select cp.id into v_id
    from public.coin_purchases cp
    where cp.platform = p_platform and cp.receipt_token = v_token;
  end if;

  return v_id;
end;
$$;

comment on function public.coin_purchase_record(public.coin_purchase_platform, text, text, numeric, text) is
  'Buyer-callable. Records an UNVERIFIED (pending) IAP receipt for auth.uid(). Resolves the coin package from (platform, product_id) and snapshots base/bonus coins — the client never supplies a coin amount. Never credits coins and never sets status. Idempotent on (platform, receipt_token). Raise codes: LKG05 not authenticated, LKC01 receipt token missing, LKC02 product id missing, LKC06 unknown product for this store, LKC07 package inactive. On LKC07 the client should still hand the receipt to the verifying Edge Function — a purchase the store already charged for a known (even retired) package is honoured there. LKC06 means the store product has no coin_packages row: a configuration error to fix on the server side.';


-- -------------------------------------------------------------------------------------
-- coin_purchase_mark_verified(...) — SERVICE ROLE ONLY. Credits coins EXACTLY ONCE.
-- -------------------------------------------------------------------------------------
-- Replay protection is two-layered:
--   1. UNIQUE (platform, receipt_token) means a duplicated store webhook can never create
--      a second purchase row to credit.
--   2. The row is locked with SELECT ... FOR UPDATE and the credit only happens on the
--      pending -> verified edge. A concurrent second call blocks on the lock, then sees
--      status='verified' and returns the already-credited amount without touching the
--      wallet. So even two webhooks racing in parallel credit once.
--
-- Coin amount (since 2026-09-10): NOT a parameter any more. The function credits exactly
-- the base_coins + bonus_coins snapshotted on the purchase row (CHECK
-- coin_purchases_credit_matches_snapshot_check enforces the same rule in the table).
--
-- p_product_id is REQUIRED and must be the product id the STORE confirmed (Google
-- purchases.products.get / Apple signed transaction), not the one the client sent. The
-- pending row's product_id and snapshot came from the client, so without this check a
-- user could buy the cheapest package and record its receipt against the most expensive
-- product id. When the two differ, the store wins: the package is re-resolved from the
-- verified product id and re-snapshotted before crediting ('product_mismatch' = true in
-- the result so the Edge Function can log/alert).
--
-- Package resolution at verify time does NOT require is_active: the store has already
-- charged the user, so a package retired after the purchase (or a restore of an old one)
-- is still honoured. Only a product id with no coin_packages row at all is rejected.
--
-- The old signature took a p_coins amount. Drop it idempotently. (Its error code LKC03
-- INVALID_COIN_AMOUNT is retired and deliberately not reused.)
drop function if exists public.coin_purchase_mark_verified(public.coin_purchase_platform, text, bigint, uuid, text, numeric, text);

create or replace function public.coin_purchase_mark_verified(
  p_platform      public.coin_purchase_platform,
  p_receipt_token text,
  p_product_id    text,
  p_user_id       uuid    default null,
  p_price_paid    numeric default null,
  p_currency      text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token    text := nullif(trim(p_receipt_token), '');
  v_product  text := nullif(trim(p_product_id), '');
  v_row      public.coin_purchases;
  v_pkg      public.coin_packages;
  v_user     uuid;
  v_credit   bigint;
  v_balance  bigint;
  v_mismatch boolean := false;
begin
  if v_token is null then
    raise exception 'RECEIPT_TOKEN_REQUIRED' using errcode = 'LKC01';
  end if;
  if v_product is null then
    raise exception 'PRODUCT_ID_REQUIRED' using errcode = 'LKC02';
  end if;

  select * into v_row
  from public.coin_purchases
  where platform = p_platform and receipt_token = v_token
  for update;

  if not found then
    -- Store notification / restore arrived before (or without) the client's record call.
    -- p_user_id is then mandatory: we have no other way to know who to credit.
    if p_user_id is null then
      raise exception 'PURCHASE_NOT_FOUND' using errcode = 'LKC04';
    end if;

    -- Resolve + snapshot the package NOW, from the store-verified product id.
    select * into v_pkg
    from public.coin_packages pk
    where (p_platform = 'google_play' and pk.google_play_product_id = v_product)
       or (p_platform = 'apple_iap'   and pk.apple_product_id       = v_product);
    if not found then
      raise exception 'UNKNOWN_PRODUCT: % on %', v_product, p_platform using errcode = 'LKC06';
    end if;

    -- ON CONFLICT DO NOTHING + re-select FOR UPDATE: if a client record (or a second
    -- webhook) inserts the same receipt concurrently, we lock THAT row instead of failing
    -- with a unique violation. Replay protection still comes from the unique key.
    insert into public.coin_purchases (
      user_id, platform, product_id, receipt_token,
      coin_package_id, base_coins, bonus_coins,
      price_paid, currency, status
    )
    values (
      p_user_id, p_platform, v_product, v_token,
      v_pkg.id, v_pkg.base_coins, v_pkg.bonus_coins,
      p_price_paid, p_currency, 'pending'
    )
    on conflict (platform, receipt_token) do nothing;

    select * into v_row
    from public.coin_purchases
    where platform = p_platform and receipt_token = v_token
    for update;
  end if;

  -- Already settled: return the previous outcome. NO second credit.
  if v_row.status <> 'pending' then
    return jsonb_build_object(
      'purchase_id',    v_row.id,
      'status',         v_row.status,
      'coins_credited', v_row.coins_credited,
      'already_settled', true,
      'coin_balance',   coalesce(
        (select w.coin_balance from public.viewer_wallets w where w.user_id = v_row.user_id), 0)
    );
  end if;

  -- The store is authoritative about WHICH product was bought. If the client recorded a
  -- different product id, re-resolve and re-snapshot from the verified one.
  if v_row.product_id is distinct from v_product then
    v_mismatch := true;
    select * into v_pkg
    from public.coin_packages pk
    where (p_platform = 'google_play' and pk.google_play_product_id = v_product)
       or (p_platform = 'apple_iap'   and pk.apple_product_id       = v_product);
    if not found then
      raise exception 'UNKNOWN_PRODUCT: % on %', v_product, p_platform using errcode = 'LKC06';
    end if;
    v_row.coin_package_id := v_pkg.id;
    v_row.base_coins      := v_pkg.base_coins;
    v_row.bonus_coins     := v_pkg.bonus_coins;
  end if;

  v_user := coalesce(v_row.user_id, p_user_id);
  if v_user is null then
    raise exception 'PURCHASE_HAS_NO_USER' using errcode = 'LKC05';
  end if;

  -- Credit exactly the snapshotted total — never an amount from outside.
  v_credit := v_row.base_coins + v_row.bonus_coins;

  -- Lazy-provision the coin wallet, then credit.
  insert into public.viewer_wallets (user_id) values (v_user)
  on conflict (user_id) do nothing;

  update public.viewer_wallets
     set coin_balance = coin_balance + v_credit
   where user_id = v_user
  returning coin_balance into v_balance;

  update public.coin_purchases
     set status          = 'verified',
         coins_credited  = v_credit,
         coin_package_id = v_row.coin_package_id,
         base_coins      = v_row.base_coins,
         bonus_coins     = v_row.bonus_coins,
         user_id         = v_user,
         product_id      = v_product,
         price_paid      = coalesce(p_price_paid, price_paid),
         currency        = coalesce(p_currency, currency),
         verified_at     = now()
   where id = v_row.id;

  return jsonb_build_object(
    'purchase_id',      v_row.id,
    'status',           'verified',
    'coins_credited',   v_credit,
    'base_coins',       v_row.base_coins,
    'bonus_coins',      v_row.bonus_coins,
    'coin_package_id',  v_row.coin_package_id,
    'product_mismatch', v_mismatch,
    'already_settled',  false,
    'user_id',          v_user,
    'coin_balance',     v_balance
  );
end;
$$;

comment on function public.coin_purchase_mark_verified(public.coin_purchase_platform, text, text, uuid, numeric, text) is
  'SERVICE ROLE ONLY (EXECUTE is revoked from public/anon/authenticated). Called by the Edge Function that has verified the receipt with Google/Apple; p_product_id MUST be the product id the store confirmed. Flips pending -> verified and credits exactly the snapshotted base_coins + bonus_coins from coin_packages — exactly once, even if the store webhook fires twice. No coin amount is accepted. Raise codes: LKC01 receipt token missing, LKC02 product id missing, LKC04 no pending row and no p_user_id, LKC05 no user to credit, LKC06 product id has no coin_packages row.';


-- -------------------------------------------------------------------------------------
-- coin_purchase_mark_failed(...) — SERVICE ROLE ONLY. Closes a bad receipt.
-- -------------------------------------------------------------------------------------
create or replace function public.coin_purchase_mark_failed(
  p_platform      public.coin_purchase_platform,
  p_receipt_token text,
  p_reason        text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated int;
begin
  update public.coin_purchases
     set status = 'failed', failure_reason = p_reason
   where platform = p_platform
     and receipt_token = trim(p_receipt_token)
     and status = 'pending';   -- never downgrade an already-credited purchase
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

comment on function public.coin_purchase_mark_failed(public.coin_purchase_platform, text, text) is
  'SERVICE ROLE ONLY. Marks a pending receipt as failed. Guarded by status=''pending'' so a verified purchase can never be downgraded (and thus never re-credited).';


-- -------------------------------------------------------------------------------------
-- gift_send(...) — THE atomic gift operation
-- -------------------------------------------------------------------------------------
-- One transaction does all of:
--   a) resolve the receiver SERVER-SIDE from live_streams.host_user_id (never trusted from
--      the client — otherwise a viewer could gift points to an account they control),
--   b) validate stream status='live' and gift is_active,
--   c) SELECT ... FOR UPDATE the sender's viewer_wallets row, refuse on insufficient funds,
--   d) debit coins,
--   e) upsert + credit broadcaster_earnings (points_balance + lifetime_points_earned),
--   f) insert the gift_transactions ledger row with per-unit coin_cost/point_value
--      SNAPSHOTTED from the catalog,
--   g) call lk_battle_add_points() unconditionally (returns NULL when no battle is active),
--      and live_cohost_active_session() (returns NULL when the stream is not co-hosting) to
--      stamp gift_transactions.cohost_session_id,
--   h) return the new balance + transaction id.
-- If ANY step raises, the whole thing rolls back — no partial debit, no orphan ledger row.
--
-- IDEMPOTENCY: p_client_tx_id is optional but STRONGLY recommended for the UI, because the
-- gift button is a spam-tap surface and a retried request over a flaky mobile connection
-- would otherwise double-charge. When supplied, a repeat call with the same key returns the
-- original transaction unchanged. Left NULL, every call is a distinct gift (which is what
-- you want for genuine rapid-fire combo sends that the user really did make).
create or replace function public.gift_send(
  p_live_stream_id uuid,
  p_gift_id        uuid,
  p_quantity       int  default 1,
  p_client_tx_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid          uuid := auth.uid();
  v_receiver     uuid;
  v_stream_state text;
  v_gift         public.gift_catalog;
  v_qty          int;
  v_total_coins  bigint;
  v_total_points bigint;
  v_balance      bigint;
  v_battle_id    uuid;
  v_cohost_id    uuid;
  v_tx_id        uuid;
  v_existing     public.gift_transactions;
begin
  ------------------------------------------------------------------ auth + args
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'LKG05';
  end if;

  v_qty := coalesce(p_quantity, 1);
  if v_qty < 1 or v_qty > 999 then
    raise exception 'INVALID_QUANTITY' using errcode = 'LKG04';
  end if;

  ------------------------------------------------------- fast idempotency check
  if p_client_tx_id is not null then
    select * into v_existing
    from public.gift_transactions
    where sender_user_id = v_uid and client_tx_id = p_client_tx_id;

    if found then
      return jsonb_build_object(
        'transaction_id', v_existing.id,
        'coin_balance',   public.coin_wallet_balance(),
        'coins_spent',    v_existing.total_coin_cost,
        'points_awarded', v_existing.total_point_value,
        'receiver_user_id', v_existing.receiver_user_id,
        'battle_id',      v_existing.battle_id,
        'duplicate',      true
      );
    end if;
  end if;

  ---------------------------------------- (a)+(b) resolve receiver + validate
  -- The receiver is ALWAYS derived here, never accepted as a parameter.
  select ls.host_user_id, ls.status
    into v_receiver, v_stream_state
  from public.live_streams ls
  where ls.id = p_live_stream_id;

  if not found then
    raise exception 'STREAM_NOT_FOUND' using errcode = 'LKG08';
  end if;
  if coalesce(v_stream_state, '') <> 'live' then
    raise exception 'STREAM_NOT_LIVE' using errcode = 'LKG01';
  end if;
  if v_receiver is null then
    raise exception 'STREAM_HAS_NO_HOST' using errcode = 'LKG07';
  end if;
  if v_receiver = v_uid then
    -- Self-gifting would let a user convert their own coins into points/cash for free.
    raise exception 'SELF_GIFT_NOT_ALLOWED' using errcode = 'LKG06';
  end if;

  select * into v_gift from public.gift_catalog where id = p_gift_id;
  if not found or not v_gift.is_active then
    raise exception 'GIFT_NOT_AVAILABLE' using errcode = 'LKG02';
  end if;

  v_total_coins  := v_gift.coin_cost   * v_qty;
  v_total_points := v_gift.point_value * v_qty;

  ------------------------------------------- (c)+(d) lock wallet, check, debit
  insert into public.viewer_wallets (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select w.coin_balance into v_balance
  from public.viewer_wallets w
  where w.user_id = v_uid
  for update;

  if v_balance < v_total_coins then
    raise exception 'INSUFFICIENT_COINS: need % have %', v_total_coins, v_balance
      using errcode = 'LKG03';
  end if;

  update public.viewer_wallets
     set coin_balance = coin_balance - v_total_coins
   where user_id = v_uid
  returning coin_balance into v_balance;

  ------------------------------------------------ (e) credit broadcaster points
  insert into public.broadcaster_earnings (user_id, points_balance, lifetime_points_earned)
  values (v_receiver, v_total_points, v_total_points)
  on conflict (user_id) do update
    set points_balance         = broadcaster_earnings.points_balance + excluded.points_balance,
        lifetime_points_earned = broadcaster_earnings.lifetime_points_earned + excluded.lifetime_points_earned,
        updated_at             = now();

  ------------------------------- (g) battle hook — safe to call unconditionally
  -- Returns NULL when p_live_stream_id is not a side of a currently-active battle.
  v_battle_id := public.lk_battle_add_points(p_live_stream_id, v_total_points);

  -------------------------- (g) co-hosting stamp — safe to call unconditionally
  -- Returns NULL when p_live_stream_id is not in a LIVE co-host session (file 03). Two
  -- partial-unique-index probes, no lock. Only labels the ledger row; nothing else changes.
  v_cohost_id := public.live_cohost_active_session(p_live_stream_id);

  ---------------------------------------------------- (f) write the ledger row
  insert into public.gift_transactions (
    live_stream_id, sender_user_id, receiver_user_id, gift_id,
    quantity, coin_cost, point_value, gift_tier, battle_id, cohost_session_id, client_tx_id
  )
  values (
    p_live_stream_id, v_uid, v_receiver, v_gift.id,
    v_qty, v_gift.coin_cost, v_gift.point_value, v_gift.tier, v_battle_id, v_cohost_id, p_client_tx_id
  )
  returning id into v_tx_id;

  ------------------------------------------------------------------ (h) result
  return jsonb_build_object(
    'transaction_id',   v_tx_id,
    'coin_balance',     v_balance,
    'coins_spent',      v_total_coins,
    'points_awarded',   v_total_points,
    'receiver_user_id', v_receiver,
    'gift_id',          v_gift.id,
    'gift_tier',        v_gift.tier,
    'animation_style',  v_gift.animation_style,
    'quantity',         v_qty,
    'battle_id',        v_battle_id,
    'duplicate',        false
  );

exception
  -- Loser of an idempotency-key race: the winner's row is already committed-or-committing.
  when unique_violation then
    if p_client_tx_id is null then
      raise;
    end if;
    select * into v_existing
    from public.gift_transactions
    where sender_user_id = v_uid and client_tx_id = p_client_tx_id;
    if not found then
      raise;
    end if;
    return jsonb_build_object(
      'transaction_id', v_existing.id,
      'coin_balance',   public.coin_wallet_balance(),
      'coins_spent',    v_existing.total_coin_cost,
      'points_awarded', v_existing.total_point_value,
      'receiver_user_id', v_existing.receiver_user_id,
      'battle_id',      v_existing.battle_id,
      'duplicate',      true
    );
end;
$$;

comment on function public.gift_send(uuid, uuid, int, uuid) is
  'THE atomic gift operation. Debits the sender coin wallet, credits broadcaster points, writes the gift_transactions ledger row with snapshotted prices (and cohost_session_id when the stream is co-hosting), and feeds lk_battle_add_points() — all or nothing. Co-hosting: to gift the partner, pass the partner''s live_stream_id. The receiver is resolved server-side from live_streams.host_user_id and is never client-supplied. Raise codes: LKG01 stream not live, LKG02 gift unavailable, LKG03 insufficient coins, LKG04 bad quantity, LKG05 not authenticated, LKG06 self-gift, LKG07 host missing, LKG08 stream not found. LKG03 is the signal for the client Recharge Coins popup.';


-- -------------------------------------------------------------------------------------
-- gift_live_stream_points(p_live_stream_id) — public on-stream hype counter
-- -------------------------------------------------------------------------------------
-- Returns points ONLY. Never reads cash_balance. Any viewer of a live stream may call it.
create or replace function public.gift_live_stream_points(p_live_stream_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host   uuid;
  v_status text;
  v_points bigint;
  v_stream_points bigint;
begin
  select ls.host_user_id, ls.status into v_host, v_status
  from public.live_streams ls where ls.id = p_live_stream_id;

  if not found then
    raise exception 'STREAM_NOT_FOUND' using errcode = 'LKG08';
  end if;
  -- Mirror the existing live_streams SELECT policy: public only while live.
  -- NULL-safe on purpose: auth.uid() is NULL for anon, and `<>` against NULL yields NULL.
  if coalesce(v_status, '') <> 'live' and v_host is distinct from auth.uid() then
    raise exception 'STREAM_NOT_VISIBLE' using errcode = 'LKG09';
  end if;

  select coalesce(be.points_balance, 0) into v_points
  from public.broadcaster_earnings be where be.user_id = v_host;

  select coalesce(sum(gt.total_point_value), 0) into v_stream_points
  from public.gift_transactions gt where gt.live_stream_id = p_live_stream_id;

  return jsonb_build_object(
    'live_stream_id',           p_live_stream_id,
    'host_user_id',             v_host,
    'host_points_balance',      coalesce(v_points, 0),
    'stream_points_this_session', v_stream_points
  );
end;
$$;

comment on function public.gift_live_stream_points(uuid) is
  'Public-safe on-stream point/gem counter. Returns points only — cash_balance is never read or returned. Only works for streams the caller could already see (live, or their own).';


-- -------------------------------------------------------------------------------------
-- gift_live_stream_top_senders(p_live_stream_id, p_limit) — top-gifter leaderboard
-- -------------------------------------------------------------------------------------
create or replace function public.gift_live_stream_top_senders(
  p_live_stream_id uuid,
  p_limit          int default 10
)
returns table (
  sender_user_id uuid,
  display_name   text,
  avatar_url     text,
  total_coins    bigint,
  total_points   bigint,
  gift_count     bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_host   uuid;
  v_status text;
begin
  select ls.host_user_id, ls.status into v_host, v_status
  from public.live_streams ls where ls.id = p_live_stream_id;

  if not found then
    raise exception 'STREAM_NOT_FOUND' using errcode = 'LKG08';
  end if;
  -- NULL-safe on purpose: auth.uid() is NULL for anon, and `<>` against NULL yields NULL.
  if coalesce(v_status, '') <> 'live' and v_host is distinct from auth.uid() then
    raise exception 'STREAM_NOT_VISIBLE' using errcode = 'LKG09';
  end if;

  return query
  select gt.sender_user_id,
         p.display_name,
         p.avatar_url,
         sum(gt.total_coin_cost)::bigint,
         sum(gt.total_point_value)::bigint,
         count(*)::bigint
  from public.gift_transactions gt
  left join public.profiles p on p.user_id = gt.sender_user_id
  where gt.live_stream_id = p_live_stream_id
    and gt.sender_user_id is not null
  group by gt.sender_user_id, p.display_name, p.avatar_url
  order by 4 desc
  limit greatest(least(coalesce(p_limit, 10), 100), 1);
end;
$$;

comment on function public.gift_live_stream_top_senders(uuid, int) is
  'Room-wide top-gifter leaderboard for one stream. SECURITY DEFINER because gift_transactions RLS is own-rows-only; this function controls exactly which columns leave the server (no coin balances, no cash).';


-- =====================================================================================
-- 10. FUNCTION GRANTS — the real gate on the IAP credit path
-- =====================================================================================
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase additionally
-- auto-grants them to anon + authenticated. So EVERY function here is first revoked from
-- public, anon AND authenticated, then re-opened only to the roles meant to call it. Do not
-- shorten these back to "from public". The two functions that can mint/close purchases are
-- service_role only, so a client JWT literally cannot call them no matter what it sends.

revoke all on function public.coin_wallet_ensure()                                                               from public, anon, authenticated;
revoke all on function public.coin_wallet_balance()                                                              from public, anon, authenticated;
revoke all on function public.coin_purchase_record(public.coin_purchase_platform, text, text, numeric, text)     from public, anon, authenticated;
revoke all on function public.coin_purchase_mark_verified(public.coin_purchase_platform, text, text, uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.coin_purchase_mark_failed(public.coin_purchase_platform, text, text)               from public, anon, authenticated;
revoke all on function public.gift_send(uuid, uuid, int, uuid)                                                   from public, anon, authenticated;
revoke all on function public.gift_live_stream_points(uuid)                                                      from public, anon, authenticated;
revoke all on function public.gift_live_stream_top_senders(uuid, int)                                            from public, anon, authenticated;

-- Server-only (verifying Edge Function).
grant execute on function public.coin_purchase_mark_verified(public.coin_purchase_platform, text, text, uuid, numeric, text) to service_role;
grant execute on function public.coin_purchase_mark_failed(public.coin_purchase_platform, text, text) to service_role;

-- Client-callable surface.
grant execute on function public.coin_wallet_ensure()   to authenticated;
grant execute on function public.coin_wallet_balance()  to authenticated;
grant execute on function public.coin_purchase_record(public.coin_purchase_platform, text, text, numeric, text) to authenticated;
grant execute on function public.gift_send(uuid, uuid, int, uuid) to authenticated;
grant execute on function public.gift_live_stream_points(uuid) to anon, authenticated;
grant execute on function public.gift_live_stream_top_senders(uuid, int) to anon, authenticated;


-- =====================================================================================
-- 11. SEED — gift catalog (50 gifts) + coin packages (10) — idempotent
-- =====================================================================================
-- Fixed UUIDs so re-running is a no-op and client asset maps can hardcode them.

-- ---- 11a. gift_catalog --------------------------------------------------------------
-- id suffix NN = sort_order (01..50). Tier counts: low 15, medium_low 15, medium_high 10,
-- high 6, super 4. Every coin_cost sits inside its tier band (gift_catalog_tier_band_check
-- would reject the insert otherwise).
-- point_value = greatest(1, round(coin_cost * 0.60)), written out as literal integers so
-- the seed is readable. 1-coin gifts (Rose, Heart, Thumbs Up) earn 1 point: 60% of 1 is
-- 0.6, which rounds up to 1, so LukuLuku's margin on those three gifts is 0 — accepted so
-- that a 1-coin gift is never worth nothing to the creator.
-- animation_asset_ref = 'gift_' || replace(slug, '-', '_').

insert into public.gift_catalog
  (id, slug, name, emoji, tier, animation_style, coin_cost, point_value, animation_asset_ref, sort_order, is_active)
values
  -- LOW (1-50 coins) -> banner
  ('a1000000-0000-4000-8000-000000000001', 'rose',             'Rose',             '🌹',   'low',         'banner',         1,     1, 'gift_rose',             1, true),
  ('a1000000-0000-4000-8000-000000000002', 'heart',            'Heart',            '❤️',  'low',         'banner',         1,     1, 'gift_heart',            2, true),
  ('a1000000-0000-4000-8000-000000000003', 'thumbs-up',        'Thumbs Up',        '👍',   'low',         'banner',         1,     1, 'gift_thumbs_up',        3, true),
  ('a1000000-0000-4000-8000-000000000004', 'luku-clap',        'Luku Clap',        '👏',   'low',         'banner',         5,     3, 'gift_luku_clap',        4, true),
  ('a1000000-0000-4000-8000-000000000005', 'hi-wave',          'Hi Wave',          '👋',   'low',         'banner',         5,     3, 'gift_hi_wave',          5, true),
  ('a1000000-0000-4000-8000-000000000006', 'star',             'Star',             '⭐',   'low',         'banner',         5,     3, 'gift_star',             6, true),
  ('a1000000-0000-4000-8000-000000000007', 'lollipop',         'Lollipop',         '🍭',   'low',         'banner',        10,     6, 'gift_lollipop',         7, true),
  ('a1000000-0000-4000-8000-000000000008', 'ice-cream',        'Ice Cream',        '🍦',   'low',         'banner',        10,     6, 'gift_ice_cream',        8, true),
  ('a1000000-0000-4000-8000-000000000009', 'coffee',           'Coffee',           '☕',   'low',         'banner',        10,     6, 'gift_coffee',           9, true),
  ('a1000000-0000-4000-8000-000000000010', 'donut',            'Donut',            '🍩',   'low',         'banner',        15,     9, 'gift_donut',           10, true),
  ('a1000000-0000-4000-8000-000000000011', 'balloon',          'Balloon',          '🎈',   'low',         'banner',        20,    12, 'gift_balloon',         11, true),
  ('a1000000-0000-4000-8000-000000000012', 'sunflower',        'Sunflower',        '🌻',   'low',         'banner',        25,    15, 'gift_sunflower',       12, true),
  ('a1000000-0000-4000-8000-000000000013', 'mango',            'Mango',            '🥭',   'low',         'banner',        30,    18, 'gift_mango',           13, true),
  ('a1000000-0000-4000-8000-000000000014', 'rainbow',          'Rainbow',          '🌈',   'low',         'banner',        40,    24, 'gift_rainbow',         14, true),
  ('a1000000-0000-4000-8000-000000000015', 'coconut',          'Coconut',          '🥥',   'low',         'banner',        50,    30, 'gift_coconut',         15, true),
  -- MEDIUM_LOW (51-300 coins) -> banner
  ('a1000000-0000-4000-8000-000000000016', 'flying-kiss',      'Flying Kiss',      '💋',   'medium_low',  'banner',        60,    36, 'gift_flying_kiss',     16, true),
  ('a1000000-0000-4000-8000-000000000017', 'fire',             'Fire',             '🔥',   'medium_low',  'banner',        75,    45, 'gift_fire',            17, true),
  ('a1000000-0000-4000-8000-000000000018', 'sunglasses',       'Sunglasses',       '😎',   'medium_low',  'banner',        90,    54, 'gift_sunglasses',      18, true),
  ('a1000000-0000-4000-8000-000000000019', 'party-popper',     'Party Popper',     '🎉',   'medium_low',  'banner',        99,    59, 'gift_party_popper',    19, true),
  ('a1000000-0000-4000-8000-000000000020', 'teddy-bear',       'Teddy Bear',       '🧸',   'medium_low',  'banner',       120,    72, 'gift_teddy_bear',      20, true),
  ('a1000000-0000-4000-8000-000000000021', 'bouquet',          'Bouquet',          '💐',   'medium_low',  'banner',       150,    90, 'gift_bouquet',         21, true),
  ('a1000000-0000-4000-8000-000000000022', 'birthday-cake',    'Birthday Cake',    '🎂',   'medium_low',  'banner',       160,    96, 'gift_birthday_cake',   22, true),
  ('a1000000-0000-4000-8000-000000000023', 'headphones',       'Headphones',       '🎧',   'medium_low',  'banner',       180,   108, 'gift_headphones',      23, true),
  ('a1000000-0000-4000-8000-000000000024', 'guitar',           'Guitar',           '🎸',   'medium_low',  'banner',       199,   119, 'gift_guitar',          24, true),
  ('a1000000-0000-4000-8000-000000000025', 'parrot',           'Parrot',           '🦜',   'medium_low',  'banner',       220,   132, 'gift_parrot',          25, true),
  ('a1000000-0000-4000-8000-000000000026', 'disco-ball',       'Disco Ball',       '🪩',   'medium_low',  'banner',       240,   144, 'gift_disco_ball',      26, true),
  ('a1000000-0000-4000-8000-000000000027', 'trophy',           'Trophy',           '🏆',   'medium_low',  'banner',       250,   150, 'gift_trophy',          27, true),
  ('a1000000-0000-4000-8000-000000000028', 'money-rain',       'Money Rain',       '💸',   'medium_low',  'banner',       270,   162, 'gift_money_rain',      28, true),
  ('a1000000-0000-4000-8000-000000000029', 'crown',            'Crown',            '👑',   'medium_low',  'banner',       299,   179, 'gift_crown',           29, true),
  ('a1000000-0000-4000-8000-000000000030', 'fireworks',        'Fireworks',        '🎆',   'medium_low',  'banner',       300,   180, 'gift_fireworks',       30, true),
  -- MEDIUM_HIGH (301-1000 coins) -> large
  ('a1000000-0000-4000-8000-000000000031', 'love-letter',      'Love Letter',      '💌',   'medium_high', 'large',        350,   210, 'gift_love_letter',     31, true),
  ('a1000000-0000-4000-8000-000000000032', 'luxury-watch',     'Luxury Watch',     '⌚',   'medium_high', 'large',        400,   240, 'gift_luxury_watch',    32, true),
  ('a1000000-0000-4000-8000-000000000033', 'performance-mic',  'Performance Mic',  '🎤',   'medium_high', 'large',        450,   270, 'gift_performance_mic', 33, true),
  ('a1000000-0000-4000-8000-000000000034', 'motorbike',        'Motorbike',        '🏍️',  'medium_high', 'large',        500,   300, 'gift_motorbike',       34, true),
  ('a1000000-0000-4000-8000-000000000035', 'ring',             'Ring',             '💍',   'medium_high', 'large',        550,   330, 'gift_ring',            35, true),
  ('a1000000-0000-4000-8000-000000000036', 'money-bag',        'Money Bag',        '💰',   'medium_high', 'large',        600,   360, 'gift_money_bag',       36, true),
  ('a1000000-0000-4000-8000-000000000037', 'palm-island',      'Palm Island',      '🏝️',  'medium_high', 'large',        700,   420, 'gift_palm_island',     37, true),
  ('a1000000-0000-4000-8000-000000000038', 'diamond',          'Diamond',          '💎',   'medium_high', 'large',        800,   480, 'gift_diamond',         38, true),
  ('a1000000-0000-4000-8000-000000000039', 'sports-car',       'Sports Car',       '🏎️',  'medium_high', 'large',        900,   540, 'gift_sports_car',      39, true),
  ('a1000000-0000-4000-8000-000000000040', 'magic-lamp',       'Magic Lamp',       '🪔',   'medium_high', 'large',       1000,   600, 'gift_magic_lamp',      40, true),
  -- HIGH (1001-5000 coins) -> fullscreen
  ('a1000000-0000-4000-8000-000000000041', 'helicopter',       'Helicopter',       '🚁',   'high',        'fullscreen',  1500,   900, 'gift_helicopter',      41, true),
  ('a1000000-0000-4000-8000-000000000042', 'lion',             'Lion',             '🦁',   'high',        'fullscreen',  2000,  1200, 'gift_lion',            42, true),
  ('a1000000-0000-4000-8000-000000000043', 'super-yacht',      'Super Yacht',      '🛥️',  'high',        'fullscreen',  2500,  1500, 'gift_super_yacht',     43, true),
  ('a1000000-0000-4000-8000-000000000044', 'private-jet',      'Private Jet',      '🛩️',  'high',        'fullscreen',  3000,  1800, 'gift_private_jet',     44, true),
  ('a1000000-0000-4000-8000-000000000045', 'pegasus',          'Pegasus',          '🦄',   'high',        'fullscreen',  4000,  2400, 'gift_pegasus',         45, true),
  ('a1000000-0000-4000-8000-000000000046', 'castle',           'Castle',           '🏰',   'high',        'fullscreen',  5000,  3000, 'gift_castle',          46, true),
  -- SUPER (5001-20000 coins) -> fullscreen
  ('a1000000-0000-4000-8000-000000000047', 'luku-rocket',      'Luku Rocket',      '🚀',   'super',       'fullscreen',  7500,  4500, 'gift_luku_rocket',     47, true),
  ('a1000000-0000-4000-8000-000000000048', 'golden-dragon',    'Golden Dragon',    '🐉',   'super',       'fullscreen', 10000,  6000, 'gift_golden_dragon',   48, true),
  ('a1000000-0000-4000-8000-000000000049', 'galaxy',           'Galaxy',           '🌌',   'super',       'fullscreen', 15000,  9000, 'gift_galaxy',          49, true),
  ('a1000000-0000-4000-8000-000000000050', 'universe',         'Universe',         '🪐',   'super',       'fullscreen', 20000, 12000, 'gift_universe',        50, true)
on conflict (id) do nothing;

-- PRICING DECISION (user, 2026-09-10), spec 04 open question 1:
-- LukuLuku's platform margin is 40%, so point_value = greatest(1, round(coin_cost * 0.60))
-- on EVERY gift, whatever its tier (one flat rate keeps the split easy to explain to
-- creators). These are per-gift stored values, NOT a computed ratio, so a future promo gift
-- can deviate from 60% without a schema change, and past gift_transactions rows keep the
-- snapshotted value they were sold at even if these catalog numbers are edited later.
--
-- To re-price the whole catalog at a different margin later, an admin runs:
--   update public.gift_catalog set point_value = greatest(1, round(coin_cost * 0.60));  -- 40% margin
-- Existing ledger rows are unaffected by design.

-- ---- 11b. coin_packages -------------------------------------------------------------
-- id suffix NN = sort_order (01..10). Baseline ~1 USD = 100 base coins, ~38.5 SRD = 100
-- base coins; bonus coins grow with package size. The SAME product id is used on both
-- stores: online.lukuluku.app.coins_<base_coins> (app bundle id / Android package is
-- online.lukuluku.app). Those product ids must be created in Google Play Console and App
-- Store Connect as CONSUMABLE products with exactly these ids; prices shown to users come
-- from the stores, price_usd / price_srd here are reference values only.

insert into public.coin_packages
  (id, slug, name, sort_order, base_coins, bonus_coins, price_usd, price_srd, google_play_product_id, apple_product_id, badge, is_active)
values
  ('c1000000-0000-4000-8000-000000000001', 'mini-tryout', 'Mini Tryout',  1,   100,     0,   0.99,    38.00, 'online.lukuluku.app.coins_100',    'online.lukuluku.app.coins_100',    null,         true),
  ('c1000000-0000-4000-8000-000000000002', 'starter',     'Starter',      2,   300,    15,   2.99,   115.00, 'online.lukuluku.app.coins_300',    'online.lukuluku.app.coins_300',    null,         true),
  ('c1000000-0000-4000-8000-000000000003', 'popular',     'Popular',      3,   500,    30,   4.99,   190.00, 'online.lukuluku.app.coins_500',    'online.lukuluku.app.coins_500',    'popular',    true),
  ('c1000000-0000-4000-8000-000000000004', 'standard',    'Standard',     4,  1000,   100,   9.99,   385.00, 'online.lukuluku.app.coins_1000',   'online.lukuluku.app.coins_1000',   null,         true),
  ('c1000000-0000-4000-8000-000000000005', 'pro',         'Pro',          5,  2000,   250,  19.99,   770.00, 'online.lukuluku.app.coins_2000',   'online.lukuluku.app.coins_2000',   null,         true),
  ('c1000000-0000-4000-8000-000000000006', 'advanced',    'Advanced',     6,  3000,   450,  29.99,  1155.00, 'online.lukuluku.app.coins_3000',   'online.lukuluku.app.coins_3000',   null,         true),
  ('c1000000-0000-4000-8000-000000000007', 'vip',         'VIP',          7,  5000,   800,  49.99,  1925.00, 'online.lukuluku.app.coins_5000',   'online.lukuluku.app.coins_5000',   'best_value', true),
  ('c1000000-0000-4000-8000-000000000008', 'high-roller', 'High Roller',  8, 10000,  2000,  99.99,  3850.00, 'online.lukuluku.app.coins_10000',  'online.lukuluku.app.coins_10000',  null,         true),
  ('c1000000-0000-4000-8000-000000000009', 'super-vip',   'Super VIP',    9, 20000,  5000, 199.99,  7700.00, 'online.lukuluku.app.coins_20000',  'online.lukuluku.app.coins_20000',  null,         true),
  ('c1000000-0000-4000-8000-000000000010', 'whale-tier',  'Whale Tier',  10, 50000, 15000, 499.99, 19250.00, 'online.lukuluku.app.coins_50000',  'online.lukuluku.app.coins_50000',  null,         true)
on conflict (id) do nothing;

commit;


-- =====================================================================================
-- ROLLBACK (manual — run only if you must undo this migration)
-- =====================================================================================
-- WARNING: dropping these tables destroys the coin/points ledger, the 50-gift catalog seed
-- and the 10 coin-package seed. Export first.
-- This block also cleans up an OLDER DRAFT of this file (old function signatures with a
-- coin-amount parameter, gift_tier = 'basic'/'premium'); every drop is IF EXISTS, so it is
-- safe to run whichever version is installed.
-- CO-HOSTING ONLY (keep the economy, drop just the co-hosting ledger column): re-create
-- gift_send() from a version of this file without the live_cohost_active_session() call
-- FIRST, then:
--   drop index if exists public.gift_transactions_cohost_session_idx;
--   alter table public.gift_transactions drop constraint if exists gift_transactions_cohost_session_id_fkey;
--   alter table public.gift_transactions drop column     if exists cohost_session_id;
-- (Dropping gift_transactions below removes the column with it.)
--
-- begin;
--   drop function if exists public.gift_live_stream_top_senders(uuid, int);
--   drop function if exists public.gift_live_stream_points(uuid);
--   drop function if exists public.gift_send(uuid, uuid, int, uuid);
--   drop function if exists public.coin_purchase_mark_failed(public.coin_purchase_platform, text, text);
--   drop function if exists public.coin_purchase_mark_verified(public.coin_purchase_platform, text, text, uuid, numeric, text);
--   drop function if exists public.coin_purchase_mark_verified(public.coin_purchase_platform, text, bigint, uuid, text, numeric, text);  -- older draft
--   drop function if exists public.coin_purchase_record(public.coin_purchase_platform, text, text, numeric, text);
--   drop function if exists public.coin_purchase_record(public.coin_purchase_platform, text, text, bigint, numeric, text);             -- older draft
--   drop function if exists public.coin_wallet_balance();
--   drop function if exists public.coin_wallet_ensure();
--   drop view     if exists public.broadcaster_public_points;
--   drop table    if exists public.gift_transactions;
--   drop table    if exists public.coin_purchases;       -- (its FK to coin_packages goes with it)
--   drop table    if exists public.coin_packages;        -- includes the 10 seeded packages
--   drop table    if exists public.broadcaster_earnings;
--   drop table    if exists public.viewer_wallets;
--   drop table    if exists public.gift_catalog;         -- includes the 50 seeded gifts
--   drop type     if exists public.coin_purchase_status;
--   drop type     if exists public.coin_purchase_platform;
--   drop type     if exists public.gift_animation_style;
--   drop type     if exists public.gift_tier;
-- commit;
-- =====================================================================================
