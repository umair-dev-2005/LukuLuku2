# LukuLuku — Guideline 4.7.4 Index of Non-Embedded Games

**App:** LukuLuku
**Submitted by:** (your Apple Developer account / company name)
**Date:** see submission

## Summary for App Review

The "Mini Games" section of LukuLuku does **not** contain any games embedded in the
binary. All mini-games are licensed third-party HTML5 games provided and distributed
by **GamePix** (https://www.gamepix.com). They are loaded at runtime inside an
in-app WebView from `https://play.gamepix.com/<game>/embed`.

LukuLuku is the **publisher/host** of this catalog; the **content provider/distributor
for every game is GamePix**, which licenses the games and is responsible for their
content, age suitability and compliance. GamePix's feed does not expose an individual
per-game studio name, so the developer/provider field for each title is listed as
**GamePix**.

- **Provider / developer of all mini-games:** GamePix
- **Provider website:** https://www.gamepix.com
- **GamePix content / licensing policy:** https://www.gamepix.com/terms
- **Distribution feed used by the app:** https://feeds.gamepix.com/v2/json/?order=quality&sid=U274U
- **Total titles currently available:** 13,195 (dynamic — updates automatically from the GamePix feed)

A full machine-readable index of every game (Title, Developer/Provider, Category,
public URL, in-app embed URL, Description) is attached as:
**`lukuluku_games_index.csv`**

## Compliance notes (4.7 / 4.7.4)

- All games are HTML5 and run in a sandboxed WebView; no native code is downloaded
  or executed.
- All games are sourced exclusively from the GamePix licensed catalog; no
  user-generated or third-party-uploaded games can appear.
- Games do not offer their own in-app purchases or external payment flows.
- The catalog is filtered to age-appropriate, non-gambling casual content consistent
  with the app's age rating.

## Featured / visible examples (shown on Home screen)

| Title | Developer/Provider | URL |
|---|---|---|
| Merge Royal | GamePix | https://play.gamepix.com/merge-royal/ |
| Parmesan Partisan | GamePix | https://play.gamepix.com/parmesan-partisan/ |
| Bus Driver Simulator 3D | GamePix | https://play.gamepix.com/bus-driver-simulator-3d/ |
| Prism Match 3D | GamePix | https://play.gamepix.com/prism-match-3d/ |
| Three Cups Game | GamePix | https://play.gamepix.com/three-cups-game/ |

> For all future updates, this index (and the attached CSV) will be included in the
> Review Notes section of App Store Connect for each version submitted.
