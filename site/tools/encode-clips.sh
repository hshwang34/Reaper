#!/usr/bin/env bash
# Encode recorded hijack clips for the marketing site and rebuild the manifest.
#
#   tools/encode-clips.sh <files...>
#
# Input file names must be `<preset>-before.<ext>` or `<preset>-after.<ext>`
# (what the /decart-test recorder downloads). Output goes to public/clips/ as
# 960px-wide H.264 MP4s with no audio, plus a poster JPEG for each `after`.
# Then manifest.json is regenerated from every `*-after.mp4` present.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/public/clips"
mkdir -p "$out"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }

for src in "$@"; do
  base="$(basename "$src")"
  name="${base%.*}"
  case "$name" in
    *-before|*-after) ;;
    *) echo "skip $base: name must end in -before or -after"; continue ;;
  esac
  echo "encode $base → $name.mp4"
  ffmpeg -y -loglevel error -i "$src" \
    -an -vf "scale=960:-2:flags=lanczos,fps=30,format=yuv420p" \
    -c:v libx264 -preset slow -crf 27 -movflags +faststart \
    "$out/$name.mp4"
  if [[ "$name" == *-after ]]; then
    ffmpeg -y -loglevel error -ss 1 -i "$out/$name.mp4" -frames:v 1 -q:v 4 "$out/${name%-after}.jpg"
  fi
done

# Rebuild the manifest from what's on disk.
{
  echo '{'
  echo '  "clips": ['
  first=1
  for after in "$out"/*-after.mp4; do
    [[ -e "$after" ]] || continue
    preset="$(basename "${after%-after.mp4}")"
    before="$out/$preset-before.mp4"
    [[ $first -eq 1 ]] || echo ','
    first=0
    printf '    { "preset": "%s", "after": "/clips/%s-after.mp4"' "$preset" "$preset"
    [[ -e "$before" ]] && printf ', "before": "/clips/%s-before.mp4"' "$preset"
    printf ', "poster": "/clips/%s.jpg" }' "$preset"
  done
  echo
  echo '  ]'
  echo '}'
} > "$out/manifest.json"

echo "manifest: $out/manifest.json"
cat "$out/manifest.json"
