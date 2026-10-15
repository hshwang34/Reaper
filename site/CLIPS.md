# Recording the real effect for the site

The hero monitor and the looks grid play **recorded clips of the actual
`lucy-2.5` output** when they exist, and fall back to a CSS simulation
(labelled as such) when they don't. Nothing on the public site calls the
model; the only compute spent is the one-off recording session below.

Cost of a full set: six presets × ~10 s ≈ 60 s of model time ≈ **$1.20** at
the published $0.02/s.

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
