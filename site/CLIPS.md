# The opening demo's footage

The player under "Go on. Pick your chaos" plays **one recorded stream clip** and, per
effect, **one real `lucy-2.5` render of that same clip**. Every file has the same frame
count, so clicking an effect jumps to its render at the same moment (`src/heroPlayer.ts`).
Nothing on the site calls the model; the only compute spent is the one-off recording.

The footage is of us, not a borrowed stream: restyling someone else's face on our own
site is a rights problem.

## 1. Record the base clip

Webcam on a tripod, 16:9, 720p or better, camera locked off, about 30 s. Chest-up,
desk and microphone in shot, a light behind for the stream look. Talk to camera as if
to chat; keep hands off your face and stay in frame.

## 2. Render each effect

Run the demo rig with a real Decart key (`npm run dev`), open
`http://localhost:5173/decart-test` in Chrome, play the base clip through as the camera
and record one pass per effect prompt (~$0.60 per 30 s effect at $0.02/s). The downloads
are named `decart-<timestamp>.mp4`. A render longer than the base is fine: the encoder
keeps its first base-length stretch, which is the aligned part.

## 3. Encode

List the clips in `tools/hero-effects.tsv` (tab-separated: id, source file, emoji,
label, one-line description; the `base` row first), then:

```bash
cd site
SRC_DIR=~/path/to/recordings tools/encode-hero.sh tools/hero-effects.tsv
```

It writes `public/clips/hero/` (replace the folder's old files first): per clip a
960×540 and a 640×360 H.264 file plus a poster, all trimmed to the base's frame count,
keyframes every 0.5 s, content-hashed names, and `manifest.json`. The raw recordings
are not committed. Needs `ffmpeg` (`brew install ffmpeg`).

Current set (2026-10-22): about 21 MB for all nine clips at 960×540, 10 MB at 640×360.
Desktop prefetches them in the background once the stream is playing; phones stream
each one only when it is picked.

## 4. Check and ship

```bash
npm run build && npx vite preview
```

Merging to `main` deploys streamhijack.com (Vercel). `vercel.json` caches the hashed
clip files forever and always revalidates the manifest.

## App effect previews

`tools/encode-clips.sh --app` is a separate pipeline: it turns `/decart-test` recordings
into the desktop app's and hijack page's effect previews (`web/public/previews/`).
