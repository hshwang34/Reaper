# Recording the real effect for the site

The hero monitor plays **recorded clips of the actual
`lucy-2.5` output** when they exist, and falls back to a CSS simulation
(labelled as such) when they don't. Nothing on the public site calls the
model; the only compute spent is the one-off recording session below.

Cost of a full set: six presets × ~10 s ≈ 60 s of model time ≈ **$1.20** at
the published $0.02/s.

## "What's possible": one base clip, one render per edit

The **What's possible** section (`src/possible.ts`) lets a reader pick a kind of
edit, watch its prompt type into the hijack page, and pay $5; the stream then cuts to
the real `lucy-2.5` render of that prompt for 5 seconds. It needs one recorded
base clip plus one render per entry in `src/capabilities.json`, all the same
length and frame-aligned, so a payment can land at any moment.

The footage is of us, not a borrowed stream: restyling someone else's face on
the product's own site is a rights problem and reads as shady.

### Record the base clip (≈ 2 minutes)

Webcam or phone on a tripod, 16:9, 720p or better, **camera locked off**.

- Chest-up framing, centred, desk and **microphone in shot**, a lamp or LED
  strip behind for the "stream" look.
- **Wear headphones** (the *Remove an object* render takes them off).
- Talk to camera for **30 s** as if to chat: react, laugh, gesture. Keep hands
  off your face and stay in frame.
- **End in the pose you started in** — the clip loops.
- Front light on your face; no window behind you.

### Render (≈ $4–5 of model time for 7 edits × 30 s)

```bash
# dry run: prints the cost and the hard ceiling, spends nothing
node scripts/render-lucy.mjs ~/Movies/base.mov
# the real thing
node scripts/render-lucy.mjs ~/Movies/base.mov --yes
# redo one or two after changing their prompt
node scripts/render-lucy.mjs ~/Movies/base.mov --yes --only vfx,attribute
```

Writes `public/clips/possible/{base,<id>}.{mp4,jpg}` and `manifest.json`. Each
render mints its own `ek_` token capped at clip length + 15 s, and the prompt is
sent with Decart's rewriter **off**, so the prompt the site types out is exactly
what the model received. The manifest records the prompt each clip was made
from; if `capabilities.json` changes, that edit falls back to a labelled
stand-in until it is re-rendered. `--mock` runs the whole pipeline with no
Decart calls (the site flags a mock manifest in red; never ship one).

Watch every clip before committing. If an edit doesn't hold up (object removal
and character swaps are the hardest for a realtime model), tune its prompt and
re-render, or drop it from `capabilities.json`, rather than ship a weak one.

## 1. Record at the rig (about five minutes)

1. Run the demo rig with a real Decart key: `npm run dev` from the repo root.
2. Open `http://localhost:5173/decart-test` in Chrome.
3. Pick a preset in the **Record clip** row, set the length (8–10 s is plenty),
   and press **Record**. The page mints a duration-capped token, connects,
   waits for the first real frame, records the raw camera and the model output
   side by side for the chosen length, then disconnects and downloads two files:
   `<preset>-before.webm` and `<preset>-after.webm`.
4. Repeat for each preset you want on the site. Sit centred, decent light, and
   do something for the camera; the clip loops.

If minting fails with "job-gated", the sidecar is on a build where tokens
require an active job; fire a dev hijack from `/router` first, or use the OBS
recording route below.

### Alternative: record from OBS

Start an OBS recording, run a test hijack per preset from `/router`
(**Send $N test tip**), stop recording. You get the effect exactly as viewers
see it, including the wipe. Cut each hijack out with `ffmpeg -ss … -t …` and
feed the pieces to the encoder as `after` clips (no `before` needed; the
monitor then uses the CSS idle frame between hijacks).

## 2. Encode for the web

```bash
cd site
tools/encode-clips.sh ~/Downloads/*-before.webm ~/Downloads/*-after.webm
```

The script writes `public/clips/<preset>-{before,after}.mp4` (H.264, 960 px
wide, ~500 KB per 10 s) plus a poster JPEG per `after` clip, and regenerates
`public/clips/manifest.json` from whatever is in the folder. Needs `ffmpeg`
(`brew install ffmpeg`).

## 3. Check and ship

```bash
npm run dev        # the hero now says "Real output from the model"
npm run build
vercel             # preview URL; `vercel --prod` to publish
```

Commit the encoded `.mp4`/`.jpg` files and the manifest. Keep the raw `.webm`
recordings out of the repo.

## App effect previews (all effects, one sitting)

The viewer page and studio show `web/public/previews/<id>.{jpg,webm}` when present (CSS art otherwise).

1. `npm run dev`, open `/decart-test`, pick a sample photo (for Photo swap), press **Record all effects**.
   One camera grant, ~10 s per effect, 2 files each into Downloads. **Stop** ends it early.
2. `site/tools/encode-clips.sh --app ~/Downloads/*-before.webm ~/Downloads/*-after.webm`
   writes the still, a <=6 s loop (<=500 KB) and `manifest.json`. Commit `web/public/previews/`.
