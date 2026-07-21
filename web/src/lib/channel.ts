// Hosted-portal channel context. The hosted control plane serves the viewer
// portal at /c/<channel> (login or id); every API call and the WS hello must
// then be channel-scoped. Local pages (/portal, /router, /viewer on the demo
// rig or inside the Electron app) have no channel — same code, local paths.

/** The channel slug when running under /c/<channel>, else null. */
export function channelSlug(): string | null {
  const m = location.pathname.match(/^\/c\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Prefix an /api path with the channel scope when hosted. */
export function apiPath(path: string): string {
  const ch = channelSlug();
  if (!ch) return path;
  return path.replace(/^\/api\//, `/api/c/${encodeURIComponent(ch)}/`);
}
