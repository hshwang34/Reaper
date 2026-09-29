// The API client for pages served by the host they talk to (portal, router,
// viewer): same-origin, channel-scoped when running under /c/<channel>, and
// carrying the per-install privilege token when the host issued one. The
// hosted dashboard builds its own session-credential client instead — see
// DashboardPage.

import { createApiClient } from "./apiClient.js";
import { authToken } from "./auth.js";
import { channelSlug } from "./channel.js";

export {
  ApiError,
  createApiClient,
  type ApiClient,
  type LedgerRow,
  type PublicConfig,
  type RouterConfig,
  type SessionTokens,
} from "./apiClient.js";

// Both resolvers are lazy: nothing here reads `window`/`location` at import
// time, so the router machine (which imports this via ports.ts) stays
// loadable under node:test.
export const api = createApiClient({
  channel: channelSlug,
  credential: { kind: "install", token: authToken },
});
