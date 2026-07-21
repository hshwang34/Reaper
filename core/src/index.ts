// @rh/core — the portable money path, extracted from the sidecar so ONE
// implementation runs in every host:
//   · sidecar/        — the single-machine demo rig (kept forever)
//   · server/         — the hosted control plane (one Engine per channel)
//   · app/ (Electron) — local mode + the local rtc/frames-ok bridge
//
// Host-specific concerns are injected, never imported: Engine takes a
// `getSettings` provider, the log sink is swappable via setLogger(), and
// EngineEmit/HubHandlers carry the wiring. Anything that knows about .env,
// settings.json, OBS, Decart keys, or HTTP routes stays in the host.

export { Engine, type EngineEmit } from "./engine.js";
export { CorrelationStore, type MatchResult } from "./correlation.js";
export { checkPrompt, type ModerationResult } from "./moderation.js";
export { Hub, type HubHandlers, type HubOptions } from "./hub.js";
export { mintClientToken, decartModel } from "./decart.js";
export { setLogger, log, warn, err, type Logger } from "./log.js";
export { type TriggerAdapter } from "./triggers/types.js";
export { parseFakeTip } from "./triggers/fake.js";
export { createStreamlabsAdapter } from "./triggers/streamlabs.js";
