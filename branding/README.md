# Reality Hijack identity

The approved direction is the expressive cartoon hijacker in
`hijacker-v2/mascot-expressive.png`. Earlier H and geometric-spy concepts are
explorations, not the current product identity.

Use the same mascot on the marketing site, viewer portal, streamer dashboard,
onboarding, and desktop icon. The master has a cream background: display it as
a rounded cream tile rather than pretending it is transparent. The illustration
is static; “animated” describes its cartoon style.

- Cream: `#f5f2ec`
- Charcoal: `#121112`
- Marketing vermilion: `#ff4b2b`, with dark button text
- App action red: `#bb321b`, with light button text
- App highlight: `#ff9073`
- Font: Instrument Sans, Helvetica Neue, Arial, sans-serif
- Voice: playful invitation, clear limits. “Your stream. Chat’s chaos.”

Regenerate all PNG sizes with `node scripts/export-brand.mjs` from the repository
root. This uses the existing sharp dependency. Commit the exports because the
marketing site builds independently of the application workspaces.

The marketing redesign uses the source of the preferred localhost:4173 website
from the `site-v3` checkout as its base, retaining its simulated replay, control
section, OBS explanation, stock-photo credit, and reduced-motion behavior.
The original checkout is untouched. This project's preview runs on port 4174.

OBS output intentionally has no application header; its existing attribution
chips use the shared accent colors. Safety, offline, and success state colors
retain their semantic meaning.
