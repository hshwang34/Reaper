// @rh/core — the portable money path, extracted from the sidecar so ONE
// implementation runs in every host:
//   · sidecar/        — the single-machine demo rig (kept forever)
//   · server/         — the hosted control plane (one Engine per channel)
//   · app/ (Electron) — local mode + the local rtc/frames-ok bridge
//
// Host-specific concerns are injected, never imported: `createRuntime` takes
// a `getSettings` provider and lifecycle hooks, `buildApiRouter` takes the
// host's auth gate and upload storage, `gatedMint` takes a ledger, and the
// log sink is swappable via setLogger(). Anything that knows about .env,
// settings.json, OBS, or a database stays in the host.

export { Engine, type EngineEmit } from "./engine.js";
export { CorrelationStore, type MatchResult, type MatchOptions } from "./correlation.js";
export { checkPrompt, type ModerationResult } from "./moderation.js";
export {
  createSubmission,
  type SubmissionInput,
  type SubmissionOutcome,
} from "./submissions.js";
export { Hub, type HubHandlers, type HubOptions } from "./hub.js";
export {
  createRuntime,
  type Runtime,
  type RuntimeHooks,
  type RuntimeOptions,
} from "./runtime.js";
export {
  gatedMint,
  memoryLedger,
  MintError,
  type MintLedger,
} from "./mintPolicy.js";
export {
  buildApiRouter,
  type ApiContext,
  type ApiRouterOptions,
  type UploadedFile,
} from "./http/apiRouter.js";
export {
  mintClientToken,
  decartModel,
  SESSION_CAP_EXTRA_SEC,
  TOKEN_TTL_SEC,
} from "./decart.js";
export { setLogger, log, warn, err, type Logger } from "./log.js";
export { type TriggerAdapter } from "./triggers/types.js";
export { parseFakeTip } from "./triggers/fake.js";
export { createStreamlabsAdapter } from "./triggers/streamlabs.js";
