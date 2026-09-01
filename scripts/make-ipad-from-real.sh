#!/usr/bin/env bash
# Frames the 6 real LukuLuku screenshots onto iPad App Store canvas (2064 x 2752).
set -euo pipefail

SRC="/Users/apple/.claude/image-cache/c662693e-a363-45bc-af9d-d418cd043579"
OUT="appstore-screenshots/ipad-app"
FB="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FR="/System/Library/Fonts/Supplemental/Arial.ttf"
GRAD_TOP="#FF4D4D"; GRAD_BOT="#B81522"; SUBCOL="#FFE2E2"
CW=2064; CH=2752; IMGW=1034; IMGY=400; RAD=58
WM_PS=60; HEAD_PS=92; SUB_PS=50; WM_Y=150; HEAD_Y=290

mkdir -p "$OUT"

# srcNum | outname | headline | subcaption
ITEMS=(
  "1|01-home|Climb the Leaderboard|Earn tapins & get discovered"
  "2|02-momenti|Share Your Moments|Short videos your community loves"
  "3|03-signin|Join in Seconds|Sign in with Google or Apple"
  "4|04-splash|Welcome to LukuLuku|Your home for video & connection"
  "5|05-leaderboard|Top Creators Every Day|Tapins, views & Bangi ranked"
  "6|06-bangi|Bangi: Post & Connect|Share thoughts with the community"
)

for item in "${ITEMS[@]}"; do
  IFS='|' read -r num name head sub <<< "$item"
  tmp=$(mktemp -d)
  IMGX=$(( (CW - IMGW) / 2 ))

  magick "$SRC/$num.png" -resize "${IMGW}x" "$tmp/r.png"

  # rounded corners
  magick "$tmp/r.png" \
    \( +clone -alpha extract -draw "fill black polygon 0,0 0,$RAD $RAD,0 fill white circle $RAD,$RAD $RAD,0" \
       \( +clone -flip \) -compose Multiply -composite \
       \( +clone -flop \) -compose Multiply -composite \) \
    -alpha off -compose CopyOpacity -composite "$tmp/round.png"

  # drop shadow
  magick "$tmp/round.png" \( +clone -background black -shadow 55x28+0+20 \) \
    +swap -background none -layers merge +repage "$tmp/shadow.png"

  # background + text
  magick -size "${CW}x${CH}" gradient:"$GRAD_TOP"-"$GRAD_BOT" "$tmp/bg.png"
  magick -background none -fill white -font "$FB" -pointsize "$WM_PS" label:"LukuLuku" "$tmp/wm.png"
  magick -background none -fill white -font "$FB" -size "$((CW-200))x" -pointsize "$HEAD_PS" -gravity center caption:"$head" "$tmp/head.png"
  magick -background none -fill "$SUBCOL" -font "$FR" -size "$((CW-260))x" -pointsize "$SUB_PS" -gravity center caption:"$sub" "$tmp/sub.png"
  HH=$(magick identify -format '%h' "$tmp/head.png")
  SUB_Y=$(( HEAD_Y + HH + 28 ))

  magick "$tmp/bg.png" \
    "$tmp/wm.png"     -gravity North -geometry "+0+${WM_Y}"   -composite \
    "$tmp/head.png"   -gravity North -geometry "+0+${HEAD_Y}" -composite \
    "$tmp/sub.png"    -gravity North -geometry "+0+${SUB_Y}"  -composite \
    "$tmp/shadow.png" -gravity NorthWest -geometry "+$((IMGX-22))+$((IMGY-22))" -composite \
    -resize "${CW}x${CH}!" -quality 95 "$OUT/$name.png"

  rm -rf "$tmp"
  echo "$name.png done"
done
echo "Done -> $OUT/"
