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

export { Engine, REVIEW_TTL_MS, type EngineEmit } from "./engine.js";
export { CorrelationStore, type MatchResult, type MatchOptions } from "./correlation.js";
export {
  ANONYMOUS_TIPPER,
  checkPrompt,
  displayName,
  emptySuite,
  imagesReady,
  moderateImage,
  moderateText,
  ModerationUnavailable,
  photoChecks,
  summarize,
  textChecks,
  textReady,
  type ChainVerdict,
  type CheckReporter,
  type ClassifierVerdict,
  type ContentPolicy,
  type ImageClassifier,
  type ImageVerdict,
  type ModerationResult,
  type ModerationSuite,
  type TextClassifier,
} from "./moderation.js";
export {
  claudeClassifiers,
  jsonForPrompt,
  DEFAULT_CLASSIFIER_MODEL,
  moderationFromEnv,
  openAiImageClassifier,
  openAiTextClassifier,
  sightengineImageClassifier,
  type ModerationEnv,
} from "./moderationProviders.js";
export { dHash, hamming, ImageRejected, prepareUpload, sha256Hex, sniffImage } from "./images.js";
export {
  MAX_ANONYMOUS_BLOCKS,
  MAX_BLOCKS_PER_REQUESTER,
  sweepUploadDir,
  UPLOAD_TTL_MS,
  UploadRegistry,
  type BlockSource,
  type TakedownOptions,
} from "./uploadRegistry.js";
export {
  clientKey,
  ipHash,
  jsonlSafetyLedger,
  memorySafetyLedger,
  RateLimiter,
  StrikeTracker,
  type ModerationEventInput,
  type SafetyLedger,
} from "./safetyLedger.js";
export {
  createSubmission,
  isBanned,
  parseEnhance,
  type IntakeDeps,
  type StoredImage,
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
