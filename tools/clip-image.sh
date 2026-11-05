#!/bin/zsh
# Saves the image on the macOS clipboard (e.g. after Gemini's "Copy image" button) as a 1024×1024 PNG.
# Waits up to 15 s for the clipboard to change from the last image saved, so one copy is never saved twice.
#
#   tools/clip-image.sh <output.png>
# Exit code: 0 saved, 1 no new image on the clipboard.
set -u
out=$1
state=${TMPDIR:-/tmp}/clip-image.last
tmp=$(mktemp -t clip-image).png
for i in {1..15}; do
  osascript -e "set f to open for access POSIX file \"$tmp\" with write permission" -e 'set eof f to 0' \
    -e 'write (the clipboard as «class PNGf») to f' -e 'close access f' 2>/dev/null
  [ -s "$tmp" ] && [ "$(md5 -q "$tmp")" != "$(cat "$state" 2>/dev/null)" ] && break
  sleep 1
done
if [ ! -s "$tmp" ] || [ "$(md5 -q "$tmp")" = "$(cat "$state" 2>/dev/null)" ]; then
  echo "No new image on the clipboard"; rm -f "$tmp"; exit 1
fi
md5 -q "$tmp" > "$state"
mkdir -p "$(dirname "$out")"
magick "$tmp" -resize '1024x1024!' "$out" && rm -f "$tmp"
magick identify -format '%f %wx%h\n' "$out"
