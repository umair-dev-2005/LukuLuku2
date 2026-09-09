Feature 4: Economy, Virtual Gifting & Wallet Integration
Depends on Feature 1 (live_streams) and feeds Feature 3 (lk_battle_scores, when a gift is sent
during an active battle). This is the one feature where writes must be atomic and strongly
consistent (real money/coins) — nothing here should be batched or eventually-consistent the way
Feature 2's reaction taps are.

Flow (behavior only)
Buying coins (IAP top-up): viewer picks a coin package → Google Play Billing / Apple IAP
purchase flow → app receives a receipt/token → backend verifies the receipt with Google/Apple
server-side (never trust the client-reported success alone) → on verified success, credit coins
to the viewer's wallet and record the purchase.
Sending a gift: viewer opens the gift catalog bottom sheet on the live stream screen → picks a
gift → app checks current coin balance:Sufficient balance: deduct coins, credit the broadcaster's points/earnings, record the
transaction, trigger the gift animation for everyone in the room — all as one atomic operation
(see 3.3).
Insufficient balance: show an in-stream "Recharge Coins" popup without leaving/interrupting
the video — no transaction is written.
During an LK Battle (Feature 3): if the gift's live_stream_id matches a stream currently in
an active battle, this feature's gift-send step also updates that side's lk_battle_scores
(Feature 3 owns that table; this feature just triggers the update using the gift's point value —
see Feature 3 doc, "Gift sent during battle" row).
Broadcaster earnings: public on-stream counters show points/gems (for engagement/hype); the
actual cash-equivalent balance is calculated and shown privately only on the broadcaster's own
Wallet screen — never displayed publicly.
Entities
gift_catalog — reference table of purchasable gifts
FieldTypeNotesiduuid PKnametexttierenum: basic, premiumpremium = full-screen animationcoin_costintwhat the sender payspoint_valueintwhat the broadcaster earns per send (not 1:1 with coin_cost necessarily — platform margin)animation_asset_reftextclient-side asset key, not a binary blobis_activebooleanretire gifts without deleting send history
viewer_wallets — one row per user, spendable coin balance
FieldTypeNotesuser_iduuid PK, FK → profilescoin_balancebigint default 0never goes negative — check before every spendupdated_attimestamptz
coin_purchases — IAP top-up history
FieldTypeNotesiduuid PKuser_iduuid FK → profilesplatformenum: google_play, apple_iapproduct_idtextstore SKUcoins_creditedintprice_paidnumericcurrencytextISO codereceipt_tokentextfor verification/audit, dedupe replaystatusenum: pending, verified, failedonly verified triggers the wallet creditcreated_attimestamptz
broadcaster_earnings — one row per broadcaster
FieldTypeNotesuser_iduuid PK, FK → profilespoints_balancebigint default 0convertible, not-yet-cashed-out pointslifetime_points_earnedbigint default 0never decreases, for stats/leaderboardscash_balancenumeric default 0converted value awaiting payoutupdated_attimestamptz
gift_transactions — every gift send, permanent ledger
FieldTypeNotesiduuid PKlive_stream_iduuid FK → live_streamssender_user_iduuid FK → profilesreceiver_user_iduuid FK → profilesthe broadcastergift_iduuid FK → gift_catalogcoin_costintsnapshot at send time (catalog price may change later)point_valueintsnapshot at send timesent_attimestamptz
Snapshotting coin_cost/point_value onto the transaction (rather than joining live togift_catalog) keeps historical ledger accurate even if catalog prices change later.

Real-time vs historical
Real-time only (no new table):Gift animation trigger for the room — broadcast over the realtime channel at send time.
Public on-stream point/gem counter tick — derived from broadcaster_earnings.points_balance
changes, pushed live; the DB write itself is still atomic and immediate (see below), only thedisplay update is a realtime concern.
Historical / durable, and must be atomic:Every gift send = one DB transaction that (a) decrements viewer_wallets.coin_balance, (b)
increments broadcaster_earnings.points_balance + lifetime_points_earned, (c) insertsgift_transactions, and (d) if applicable, updates lk_battle_scores (Feature 3) — all-or-
nothing, never partially applied.
Coin purchases — always durable, never batched.
Actions/events → writes
EventTriggerWritesCoin package purchasedIAP receipt verified server-sideINSERT coin_purchases (verified); UPDATE viewer_wallets.coin_balance += coins_creditedGift sent (sufficient balance)viewer confirms sendUPDATE viewer_wallets (-coin_cost); UPDATE broadcaster_earnings (+point_value, +lifetime); INSERT gift_transactions; broadcast animation; (conditionally) UPDATE lk_battle_scoresGift attempted (insufficient balance)balance check failsno writes; show recharge popup
Relationships
profiles 1→1 viewer_wallets, 1→1 broadcaster_earnings (every user can technically have both).
profiles 1→many coin_purchases, 1→many gift_transactions (as sender and separately as
receiver).
live_streams 1→many gift_transactions.
gift_catalog 1→many gift_transactions.
Open questions for client
Platform margin: is point_value a fixed ratio of coin_cost across all gifts, or set per-gift?
Refund handling: if a purchase is later refunded by Apple/Google, does coin_balance get clawed
back, and what if those coins were already spent on gifts?
Any daily/monthly gifting or spending limits per user (fraud/compliance concern)?