#!/usr/bin/env bash
# Encode recorded hijack clips for the marketing site and rebuild the manifest.
#
#   tools/encode-clips.sh <files...>          # marketing site (public/clips/)
#   tools/encode-clips.sh --app <files...>    # the app's effect previews (below)
#
# Input file names must be `<preset>-before.<ext>` or `<preset>-after.<ext>`
# (what the /decart-test recorder downloads). Output goes to public/clips/ as
# 960px-wide H.264 MP4s with no audio, plus a poster JPEG for each `after`.
# Then manifest.json is regenerated from every `*-after.mp4` present.
#
# --app mode writes the viewer/studio effect previews to web/public/previews/:
#   <id>.jpg   the AFTER frame at 1.5 s (the still every card shows)
#   <id>.webm  <= 6 s VP9 loop, 640x360, no audio, aimed at <= 500 KB:
#              ~1.5 s of "before", a 0.4 s crossfade, then "after"
#   manifest.json  { "ids": [...] } — the web app reads this ONE file instead of
#              probing 17 URLs (the SPA fallback answers missing files with 200).
# That folder is COMMITTED (unlike the raw recordings), so a recorded set ships
# with the app. Re-run it with the same file names to refresh a set.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }

if [[ "${1:-}" == "--app" ]]; then
  shift
  pv="$here/../web/public/previews"
  mkdir -p "$pv"
  # Both feeds forced to the same 640x360 / 30 fps so xfade accepts them.
  norm="scale=640:360:force_original_aspect_ratio=increase,crop=640:360,fps=30,format=yuv420p,setsar=1"
  for after in "$@"; do
    base="$(basename "$after")"
    [[ "$base" == *-after.* ]] || continue
    id="${base%%-after.*}"
    before=""
    for cand in "$@"; do
      [[ "$(basename "$cand")" == "$id-before."* ]] && before="$cand"
    done
    echo "preview $id"
    ffmpeg -y -loglevel error -ss 1.5 -i "$after" -frames:v 1 -vf "scale=800:-2:flags=lanczos" -q:v 4 "$pv/$id.jpg"
    # Retry at lower quality until the loop fits ~500 KB.
    for crf in 34 38 42; do
      if [[ -n "$before" ]]; then
        ffmpeg -y -loglevel error -i "$before" -i "$after" -filter_complex \
          "[0:v]trim=0:1.9,setpts=PTS-STARTPTS,$norm[b];[1:v]trim=0:4.5,setpts=PTS-STARTPTS,$norm[a];[b][a]xfade=transition=fade:duration=0.4:offset=1.5[v]" \
          -map "[v]" -an -t 6 -c:v libvpx-vp9 -b:v 0 -crf "$crf" -row-mt 1 "$pv/$id.webm"
      else
        echo "  (no $id-before file: the loop is the after clip alone)"
        ffmpeg -y -loglevel error -i "$after" -vf "trim=0:6,setpts=PTS-STARTPTS,$norm" \
          -an -t 6 -c:v libvpx-vp9 -b:v 0 -crf "$crf" -row-mt 1 "$pv/$id.webm"
      fi
      [[ "$(wc -c <"$pv/$id.webm")" -le 500000 ]] && break
    done
    echo "  $id.webm $(( $(wc -c <"$pv/$id.webm") / 1024 )) KB (crf $crf)"
  done
  # Manifest = every id that has a still on disk.
  ids=""
  for jpg in "$pv"/*.jpg; do
    [[ -e "$jpg" ]] || continue
    n="$(basename "${jpg%.jpg}")"
    ids="${ids:+$ids, }\"$n\""
  done
  printf '{ "ids": [%s] }\n' "$ids" > "$pv/manifest.json"
  echo "manifest: $pv/manifest.json"; cat "$pv/manifest.json"
  exit 0
fi

out="$here/public/clips"
mkdir -p "$out"

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
