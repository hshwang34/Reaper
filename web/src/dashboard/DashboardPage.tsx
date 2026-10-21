// Streamer dashboard (hosted) — per-channel Rules + Payouts + Recent hijacks. Session model: the OAuth callback redirects
// here with #code=… (a single-use, ~60s exchange code — never the refresh
// token itself, which would sit in browser history); we redeem it once for a
// session, keep the access token in memory and the refresh in localStorage,
// and rotate the refresh on every later load (refresh tokens are
// single-use). No cookie auth — every call goes through the session-
// credential API client, which rotates once on a 401 and otherwise surfaces
// the failure here instead of swallowing it.

import { useEffect, useMemo, useState } from "react";
import type { Settings } from "@rh/shared";
import {
  ApiError,
  createApiClient,
  redeemExchangeCode,
  rotateRefresh,
  type ApiClient,
  type LedgerRow,
  type SessionTokens,
} from "../lib/apiClient.js";
import { SafetyEditor } from "../features/SafetyEditor.js";
import { friendlyStreamerError } from "../lib/friendlyError.js";
import { effectName, hijackReason, hijackResult } from "../lib/streamerCopy.js";
import { ConfirmDialog, ErrorCard, Skeleton, btn } from "../studio/ui.js";
import { ModerationPanel, ReviewPanel } from "../features/SafetyPanels.js";
import { PayoutsPanel } from "./PayoutsPanel.js";

const REFRESH_KEY = "rhDashRefresh";

/** Persist (or drop) the refresh token. On refusal the stored refresh is
 *  dropped: it is either burned (rotation is single-use), expired, or
 *  revoked, and retrying it on every page load would just be a silent 401
 *  loop until the user happens to sign in again. */
function remember(tokens: SessionTokens | null): SessionTokens | null {
  if (tokens) localStorage.setItem(REFRESH_KEY, tokens.refresh);
  else localStorage.removeItem(REFRESH_KEY);
  return tokens;
}

export default function DashboardPage() {
  const [session, setSession] = useState<SessionTokens | null>(null);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      // 1. A fresh sign-in lands with #code=… — redeem it once. Clear the
      //    hash first so a reload never re-presents a burned code.
      const hash = new URLSearchParams(location.hash.slice(1));
      const code = hash.get("code");
      if (code) history.replaceState(null, "", location.pathname);
      if (code) {
        const s = remember(await redeemExchangeCode(code));
        if (!s) setProblem("That sign-in link has expired. Sign in again.");
        setSession(s);
      } else {
        // 2. Returning visit: rotate the stored refresh token.
        const refresh = localStorage.getItem(REFRESH_KEY);
        if (refresh) {
          const s = remember(await rotateRefresh(refresh));
          if (!s) setProblem("You were signed out. Sign in again.");
          setSession(s);
        }
      }
      setChecked(true);
    })();
  }, []);

  if (!checked) {
    return (
      <div className="grid h-screen place-items-center text-zinc-400">
        Loading your dashboard…
      </div>
    );
  }
  if (!session) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Your studio dashboard</h1>
          {problem && (
            <p role="alert" className="text-sm text-amber-300">
              {problem}
            </p>
          )}
          <a
            href="/auth/twitch"
            className={btn.primary}
          >
            Sign in with Twitch
          </a>
        </div>
      </div>
    );
  }
  return (
    <Dashboard
      session={session}
      onSignedOut={(why) => {
        remember(null);
        setProblem(why);
        setSession(null);
      }}
    />
  );
}

function Dashboard({
  session,
  onSignedOut,
}: {
  session: SessionTokens;
  onSignedOut: (why: string) => void;
}) {
  // One client for the session's lifetime; rotations mutate its tokens in
  // place and persist through `remember`, so React state needn't churn.
  const client: ApiClient = useMemo(
    () =>
      createApiClient({
        channel: session.channelId,
        credential: { kind: "session", tokens: session, onRotate: remember },
      }),
    [session],
  );

  const [settings, setSettings] = useState<Settings | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Errors belong next to the thing that failed, never one global line.
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  /** Run a call; a 401 that survived rotation means the session is gone.
   *  Any other failure goes to `onFail` as a sentence, not a raw message. */
  async function guarded<T>(work: () => Promise<T>, onFail: (message: string) => void): Promise<T | undefined> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onSignedOut("You were signed out. Sign in again.");
        return undefined;
      }
      onFail(friendlyStreamerError(e));
      return undefined;
    }
  }

  const loadSettings = () => {
    setSettingsError(null);
    void guarded(client.getSettings, setSettingsError).then((s) => s && setSettings(s));
  };
  const loadLedger = () => {
    setLedgerError(null);
    void guarded(client.ledger, setLedgerError).then((rows) => rows && setLedger(rows));
  };
  useEffect(() => {
    loadSettings();
    loadLedger();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 3500);
  };

  async function save(patch: Partial<Settings>) {
    setSaveError(null);
    const next = await guarded(() => client.saveSettings(patch), (m) => setSaveError(`Couldn't save that. ${m}`));
    if (next) {
      setSettings(next);
      flash("Saved");
    }
  }

  const hijackPage = `${location.origin}/c/${encodeURIComponent(session.login)}`;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {confirmSignOut && (
        <ConfirmDialog
          title="Sign out of Stream Hijack?"
          body="Chat won't be able to pay until you sign in again."
          confirmLabel="Sign out"
          cancelLabel="Stay"
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => onSignedOut("")}
        />
      )}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Studio</h1>
          <p className="text-sm text-zinc-400">
            {session.login} ·{" "}
            <button
              onClick={() =>
                void navigator.clipboard.writeText(hijackPage).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                })
              }
              className="inline-flex min-h-11 items-center underline"
              title={hijackPage}
            >
              {copied ? "Copied" : "Copy hijack link"}
            </button>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {note && (
            <span role="status" className="text-sm text-emerald-300">
              {note}
            </span>
          )}
          <button className={btn.ghost} onClick={() => setConfirmSignOut(true)}>
            Sign out
          </button>
        </div>
      </header>

      {/* In cloud mode the approval queue lives here (the control plane's
          engine holds parked jobs, not the streamer's local bridge). */}
      <ReviewPanel client={client} />

      <section className="space-y-3" aria-busy={!settings && !settingsError}>
        <h2 className="text-lg font-semibold text-zinc-100">Rules</h2>
        {saveError && (
          <p role="alert" className="text-sm text-red-300">
            {saveError}
          </p>
        )}
        {settings ? (
          // Hosted: every change autosaves — the channel row is the source
          // of truth and the engine reads it fresh on the next payment.
          <SafetyEditor settings={settings} onChange={(p) => void save(p)} />
        ) : settingsError ? (
          <ErrorCard message={`We couldn't load your rules. ${settingsError}`} onRetry={loadSettings} />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">Loading your rules…</p>
            <Skeleton className="h-28" />
          </div>
        )}
      </section>

      <ModerationPanel
        client={client}
        settings={settings}
        onBan={(name) => settings && void save({ bannedViewers: [...settings.bannedViewers, name] })}
        onUnban={(name) =>
          settings && void save({ bannedViewers: settings.bannedViewers.filter((x) => x !== name) })
        }
      />

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Payouts</h2>
        <PayoutsPanel client={client} from="dashboard" />
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Recent hijacks</h2>
        {ledgerError ? (
          <ErrorCard message="We couldn't load your earnings. Try again." onRetry={loadLedger} />
        ) : ledger === null ? (
          <div aria-busy="true" className="space-y-2">
            <p className="text-sm text-zinc-400">Loading hijacks…</p>
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : ledger.length === 0 ? (
          <p className="text-sm text-zinc-400">No hijacks yet. Share your hijack page and chat can start paying.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-zinc-400">
                <tr>
                  <th className="py-1 pr-4">When</th>
                  <th className="py-1 pr-4">From</th>
                  <th className="py-1 pr-4">Paid</th>
                  <th className="py-1 pr-4">Seconds</th>
                  <th className="py-1 pr-4">Result</th>
                  <th className="py-1">Effect</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {ledger.map((r) => {
                  const o = hijackResult(r);
                  const why = hijackReason(r);
                  return (
                    <tr key={r.jobId} className="border-t border-zinc-900">
                      <td className="py-1.5 pr-4 text-zinc-400">{new Date(r.createdAt).toLocaleString()}</td>
                      <td className="py-1.5 pr-4">{r.username || "someone in chat"}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.amountUsd > 0 ? `$${r.amountUsd}` : "Free test"}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{r.durationSec}</td>
                      <td className={`py-1.5 pr-4 ${o.tone}`}>
                        {o.label}
                        {why && <span className="block text-xs text-zinc-400">{why}</span>}
                      </td>
                      <td className="max-w-[16rem] truncate py-1.5 text-zinc-400" title={effectName(r.prompt)}>
                        {effectName(r.prompt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
