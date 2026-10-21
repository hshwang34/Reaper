# Stream Hijack — brand guide

Source of truth for names, voice, vocabulary and UI patterns. Every brief and PR that touches
user-facing text is checked against this (section 9). Decisions: #18 (voice), #19 (vocabulary).
Our users are streamers and their chat, not engineers.

## 1. Name and wordmark

- Product name: **Stream Hijack** — two words, both capitalised. Never "StreamHijack",
  "Reality Hijack", "Reaper" or "SH" on a user surface. Domain: streamhijack.com.
- Wordmark: `Stream` in the body colour + `Hijack` in accent (`#ff9073`), Instrument Sans 750,
  letter-spacing −0.055em, 22px (19px under 480px), next to the icon (rounded 14px). Don't
  recolour, outline or stretch it.
- The overlay's OBS source is named **AI Hijack**.

## 2. Voice

Playful and streamer-native by default: short, warm, a little mischievous. **Exception: money,
refunds, errors and safety stay plain and calm** — no jokes, no emoji, no exclamation marks, no
blame. The test: if someone is worried about their money or their safety, the sentence should be
dull and exact.

| Surface | Do | Don't |
|---|---|---|
| Welcome | "Let chat take over your stream." | "Leverage AI-driven real-time video transformation." |
| Empty state | "No hijacks yet. Chat's gotta pay to play." | "No data available." |
| Picker | "Pick an effect. Make it weird." | "Select a preset from the list below." |
| Success | "You're up next. Watch the stream." | "Job queued successfully (id 4f2a)." |
| Payment | "You'll pay $10 for 10 seconds of Lava Room." | "Yo, $10 gets you 10s of lava chaos!!" |
| Refund | "It didn't play, so you're refunded. It can take a few days to show on your statement." | "Oops! We goofed, your money's coming back soon." |
| Error | "That photo is over 25 MB. Pick a smaller one." | "Whoops, something went sideways!" |
| Safety block | "This didn't pass the safety checks. See what we found below." | "Nice try. Not happening." |
| Offline | "Mika isn't live right now. Come back when they're streaming." | "Error 503: streamer unavailable." |
| Setup help | "Open OBS and we'll add the overlay for you." | "Provision the browser source via the WebSocket API." |

Rules: ~7th-grade reading level; sentences under 20 words; sentence case everywhere (no Title
Case buttons, no ALL CAPS except 12px+ section eyebrows); say what happened and what to do
next; "you" and "your"; contractions are fine; at most one emoji per screen and never on money,
refund, error or safety text.

## 3. Vocabulary — one word per concept

| Concept | We say | Never |
|---|---|---|
| The thing a viewer buys | **effect** | preset, look, style, filter |
| The event on stream | **hijack** (verb: "hijack the stream") | job, session, run |
| Person who streams | **streamer**; their area is the **studio** | creator (except "Creator studio" header), host, broadcaster |
| Person who pays | **viewer** (marketing) / **you** (on their page) | tipper, donor, user |
| The people watching | **chat** | audience, community |
| Display shown on stream | **overlay** (the OBS source "AI Hijack") | browser source, scene item |
| First-run flow | **setup** | onboarding, wizard, provisioning |
| The viewer's page | **hijack page** | portal |
| Paying | **pay** / **payment** | tip (decision #13; local demo rig only) |
| Time bought | **seconds** — "$1 = 1 second" | duration, session length |
| Checks on submissions | **safety checks** | moderation, classifier, filter |
| Streamer sign-off | **approval** — "the streamer approves it first" | review, queue |
| Typed description | **your own idea** / **custom effect** | prompt (in headings; a field label may say "describe") |
| Reference photo | **photo** | reference image, upload |

Vendor names (Decart, Lucy, Sightengine, OpenAI, Anthropic) never appear on a user surface — say
"AI" or "our safety checks". Stripe may be named where money is explained, because viewers see
it at checkout and streamers connect it.

## 4. Buttons

1. **Verb + object**, sentence case: "Pay $10", "Copy code", "Add photo", "Save changes". Not
   "Submit", "OK", "Yes", "Continue" alone.
2. **One primary button per screen or step.** Primary = filled brand (`bg-brand-600`, white
   text). Everything else is secondary (outlined), ghost (text) or a link. Selected chips and
   toggles use an outlined selected style, never the primary fill.
3. When money moves, the primary states outcome and cost: "Pay $10 · 10s of Lava Room".
4. While working, the label becomes the progress ("Checking your idea…") and the button is
   disabled. Offer Cancel when the wait can exceed 5 s.
5. **Destructive actions confirm.** Red button that names what is lost ("Delete this effect?" →
   "Delete effect" / "Keep it"). Never red for a normal cancel.
6. Cancel and back are ghost, never the same weight as the primary.
7. Minimum touch target 44px. A disabled button needs a visible reason nearby.
8. Style source: `btn.primary / secondary / ghost / danger` in `web/src/studio/ui.tsx`. Every
   surface uses the same recipes.

## 5. Patterns

**Error** — *what happened + what to do.* No codes, no blame, no jokes. Shown next to the action
that failed, `role="alert"`, red text paired with words (never colour alone). Raw server or
network messages ("Failed to fetch") are always mapped to a template; the fallback is
"Something went wrong on our side. Try again in a moment." Always offer the next step.

**Empty** — *what's missing + how to fill it*, one primary action. Playful voice allowed.
"No hijacks yet. Share your hijack page and chat can start paying."

**Loading** — *present-tense verb + object + …* with a skeleton or spinner: "Loading effects…",
"Checking your idea…", "Taking you to checkout…". Over 5 s, add one calm line: "Still working.
This can take a few seconds." Never a blank screen; never a spinner without words.

**Success** — short, specific, what happens next. Playful allowed unless money is the subject.

## 6. Colour tokens (`web/src/index.css`, `BrandShell.tsx`)

| Token | Value | Use |
|---|---|---|
| App background | `#121112` | `.brand-app` |
| App text | `#f5f2ec` | body |
| Muted text | `#b8aaa3` | helper text, header context |
| Divider | `#39302e` | rules |
| Accent / brand-400 | `#ff9073` | wordmark "Hijack", focus ring, selected chips |
| brand-200 / 300 | `#ffd0c3` / `#ffb49d` | accent text on dark |
| brand-500 | `#ff795c` | switch on-state |
| brand-600 | `#bb321b` | primary button fill (white text) |
| brand-700 / 800 / 900 | `#9e2a18` / `#762315` / `#542019` | hover / deep tints |
| Success / warning / danger | emerald-400 / amber-300 / red-300 | status text, always paired with a word or icon |
| Focus | 2px solid `#ff9073`, offset 4px | every interactive element |

## 7. Type tokens

- Family: "Instrument Sans", "Helvetica Neue", Arial, sans-serif. (The webfont must actually be
  loaded on every surface that uses `.brand-app`, or the stack falls to Helvetica.)
- Wordmark 22/19px, weight 750, −0.055em. `h1` −0.035em. Hero h1 2–3rem bold; section h2
  1.125rem semibold; body 1rem; helper 0.875rem.
- **Minimum size 12px** for anything a viewer must read; policy text (consent, retention,
  refunds) is 14px.
- Prices, seconds and countdowns use tabular figures.
- Motion respects `prefers-reduced-motion`: no autoplay, no decorative transitions.

## 8. Jargon blocklist

Enforced by a test over user-facing string literals (currently `web/src/portal/**` and
`web/src/features/EffectArt.tsx`; the scope widens as each surface is rewritten). Case-insensitive,
one term per line. Identifiers, comments, test files and the local-demo-rig-only claim-code view
are exempt.

```
preset
browser source
websocket
classifier
sidecar
jwt
mint
runtime
decart
lucy
sightengine
openai
anthropic
passthrough
reference image
moderation
llm
payload
tipper
```

## 9. Checklist for any PR that touches copy

- Only words from section 3; zero blocklist hits.
- Money, refund, error and safety text is plain and calm, and its meaning is unchanged.
- One primary button per screen; destructive actions confirm.
- Loading, empty and error states exist and follow section 5.
- The website and the app use the same words for the same things.
