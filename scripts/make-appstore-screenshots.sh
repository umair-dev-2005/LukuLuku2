#!/usr/bin/env bash
# Generates App Store screenshots (framed + caption) for LukuLuku.
# iPhone 6.5"  -> 1242 x 2688
# iPad 12.9/13" -> 2064 x 2752
set -euo pipefail

SRC="assets/generated"
OUT="appstore-screenshots"
FB="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FR="/System/Library/Fonts/Supplemental/Arial.ttf"
GRAD_TOP="#FF4D4D"
GRAD_BOT="#B81522"
SUBCOL="#FFE2E2"

# source file | headline | subcaption
ITEMS=(
  "3549290a|All Your Favorites, One Feed|Videos, shorts, games & creators"
  "0eb5206c|Discover Creators & Trends|Find topics you love in seconds"
  "7ad782c3|Watch. Learn. Get Inspired.|Full-screen video with live comments"
  "a3e61485|Momenti: Shorts You'll Love|Swipe through endless short clips"
  "7f08b3c4|Grow Your Channel & Earn|Monetization, wallet & insights"
  "c82f498b|Track Earnings in Real Time|Payouts, analytics & creator tools"
)

gen() {
  local platform=$1 CW=$2 CH=$3 IMGW=$4 IMGY=$5 RAD=$6
  local WM_PS=$7 HEAD_PS=$8 SUB_PS=$9 WM_Y=${10} HEAD_Y=${11} SUB_Y=${12}
  local dir="$OUT/$platform"
  mkdir -p "$dir"
  local i=1
  for item in "${ITEMS[@]}"; do
    IFS='|' read -r key head sub <<< "$item"
    local src="$SRC/$key.png"
    local tmp; tmp=$(mktemp -d)
    local IMGX=$(( (CW - IMGW) / 2 ))

    # 1) resize screenshot to target width, get real height
    magick "$src" -resize "${IMGW}x" "$tmp/r.png"
    local H; H=$(magick identify -format '%h' "$tmp/r.png")

    # 2) rounded corners
    magick "$tmp/r.png" \
      \( +clone -alpha extract -draw "fill black polygon 0,0 0,$RAD $RAD,0 fill white circle $RAD,$RAD $RAD,0" \
         \( +clone -flip \) -compose Multiply -composite \
         \( +clone -flop \) -compose Multiply -composite \) \
      -alpha off -compose CopyOpacity -composite "$tmp/round.png"

    # 3) drop shadow + merge
    magick "$tmp/round.png" \( +clone -background black -shadow 55x28+0+20 \) \
      +swap -background none -layers merge +repage "$tmp/shadow.png"

    # 4) gradient background
    magick -size "${CW}x${CH}" gradient:"$GRAD_TOP"-"$GRAD_BOT" "$tmp/bg.png"

    # 5) text blocks
    magick -background none -fill white -font "$FB" -pointsize "$WM_PS" \
      label:"LukuLuku" "$tmp/wm.png"
    magick -background none -fill white -font "$FB" -size "$((CW-160))x" \
      -pointsize "$HEAD_PS" -gravity center caption:"$head" "$tmp/head.png"
    magick -background none -fill "$SUBCOL" -font "$FR" -size "$((CW-200))x" \
      -pointsize "$SUB_PS" -gravity center caption:"$sub" "$tmp/sub.png"

    # place subcaption just below the actual (possibly multi-line) headline
    local HH; HH=$(magick identify -format '%h' "$tmp/head.png")
    SUB_Y=$(( HEAD_Y + HH + 28 ))

    # 6) composite everything
    magick "$tmp/bg.png" \
      "$tmp/wm.png"     -gravity North -geometry "+0+${WM_Y}"   -composite \
      "$tmp/head.png"   -gravity North -geometry "+0+${HEAD_Y}" -composite \
      "$tmp/sub.png"    -gravity North -geometry "+0+${SUB_Y}"  -composite \
      "$tmp/shadow.png" -gravity NorthWest -geometry "+$((IMGX-22))+$((IMGY-22))" -composite \
      -resize "${CW}x${CH}!" -quality 95 "$dir/$(printf '%02d' $i)-${key}.png"

    rm -rf "$tmp"
    echo "  [$platform] $(printf '%02d' $i)-${key}.png  (screen ${IMGW}x${H})"
    i=$((i+1))
  done
}

echo "iPhone 1242x2688:"
gen iphone 1242 2688 1000 800 60   54 84 46   180 320 470
echo "iPad 2064x2752:"
gen ipad   2064 2752 1120 720 64   60 92 50   190 360 530

echo "Done -> $OUT/"
