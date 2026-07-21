// Streamer dashboard v0 (hosted) — plan M4: per-channel settings + tip
// connect + the hijack ledger. Session model: the OAuth callback redirects
// here with #refresh=…; we rotate it immediately (refresh tokens are
// single-use) and keep the access token in memory, the new refresh in
// localStorage. No cookie auth — everything is explicit Bearer calls.

import { useCallback, useEffect, useState } from "react";
import type { Settings } from "@rh/shared";
import { PRESETS } from "@rh/shared";

interface Session {
  access: string;
  refresh: string;
  channelId: string;
  login: string;
}

interface LedgerRow {
  jobId: string;
  source: string;
  username: string;
  amountUsd: number;
  durationSec: number;
  prompt: string;
  outcome: string;
  reason: string | null;
  createdAt: number;
}

const REFRESH_KEY = "rhDashRefresh";

async function rotate(refresh: string): Promise<Session | null> {
  const res = await fetch("/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh }),
  });
  if (!res.ok) return null;
  const s = (await res.json()) as Session;
  localStorage.setItem(REFRESH_KEY, s.refresh);
  return s;
}

export default function DashboardPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void (async () => {
      // 1. fresh sign-in lands with #refresh=…
      const hash = new URLSearchParams(location.hash.slice(1));
      const fromHash = hash.get("refresh");
      if (fromHash) history.replaceState(null, "", location.pathname);
      const refresh = fromHash ?? localStorage.getItem(REFRESH_KEY);
      if (refresh) setSession(await rotate(refresh));
      setChecked(true);
    })();
  }, []);

  if (!checked) {
    return (
      <div className="grid h-screen place-items-center text-zinc-500">
        Loading…
      </div>
    );
  }
  if (!session) {
    return (
      <div className="grid h-screen place-items-center">
        <div className="space-y-4 text-center">
          <h1 className="text-2xl font-bold">Reality Hijack — Dashboard</h1>
          <a
            href="/auth/twitch"
            className="inline-block rounded-lg bg-fuchsia-600 px-5 py-2 font-semibold hover:bg-fuchsia-500"
          >
            Sign in with Twitch
          </a>
        </div>
      </div>
    );
  }
  return <Dashboard session={session} />;
}

function Dashboard({ session }: { session: Session }) {
  const authed = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`/api/c/${encodeURIComponent(session.channelId)}${path}`, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: `Bearer ${session.access}`,
        },
      }),
    [session],
  );

  const [settings, setSettings] = useState<Settings | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [slToken, setSlToken] = useState("");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void authed("/settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => {});
    void authed("/ledger")
      .then((r) => r.json())
      .then(setLedger)
      .catch(() => {});
  }, [authed]);

  async function save(patch: Partial<Settings>) {
    const res = await authed("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSettings(await res.json());
    setNote("Saved.");
    setTimeout(() => setNote(null), 1500);
  }

  async function connectStreamlabs() {
    await authed("/trigger/streamlabs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: slToken }),
    });
    setSlToken("");
    setNote("Streamlabs connected.");
    setTimeout(() => setNote(null), 1500);
  }

  const portal = `${location.origin}/c/${encodeURIComponent(session.login)}`;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-zinc-400">
            {session.login} ·{" "}
            <button
              onClick={() => void navigator.clipboard.writeText(portal)}
              className="underline"
              title={portal}
            >
              copy portal link
            </button>
          </p>
        </div>
        {note && <span className="text-sm text-emerald-400">{note}</span>}
      </header>

      {settings && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
            Guardrails
          </h2>
          <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <label className="space-y-1">
              <span className="text-zinc-400">Min tip ($)</span>
              <input
                type="number"
                min={1}
                defaultValue={settings.minTipUSD}
                onBlur={(e) => void save({ minTipUSD: Number(e.target.value) })}
                className="w-full rounded bg-zinc-900 px-2 py-1"
              />
            </label>
            <label className="space-y-1">
              <span className="text-zinc-400">Max duration (s)</span>
              <input
                type="number"
                min={1}
                defaultValue={settings.maxDurationSec}
                onBlur={(e) =>
                  void save({ maxDurationSec: Number(e.target.value) })
                }
                className="w-full rounded bg-zinc-900 px-2 py-1"
              />
            </label>
            <label className="mt-5 flex items-center gap-2">
              <input
                type="checkbox"
                defaultChecked={settings.allowCustomPrompts}
                onChange={(e) =>
                  void save({ allowCustomPrompts: e.target.checked })
                }
              />
              <span className="text-zinc-300">Custom prompts</span>
            </label>
          </div>
          <div className="mt-3">
            <span className="text-xs text-zinc-500">Enabled presets</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    void save({
                      enabledPresetIds: settings.enabledPresetIds.includes(p.id)
                        ? settings.enabledPresetIds.filter((x) => x !== p.id)
                        : [...settings.enabledPresetIds, p.id],
                    })
                  }
                  className={`rounded-full px-3 py-1 text-xs ${
                    settings.enabledPresetIds.includes(p.id)
                      ? "bg-emerald-600"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {p.emoji} {p.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Connect tips (Streamlabs)
        </h2>
        <p className="mb-2 text-sm text-zinc-400">
          Paste your Streamlabs <b>Socket API token</b> (Dashboard → Account
          Settings → API Settings). One-click OAuth replaces this soon.
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            value={slToken}
            onChange={(e) => setSlToken(e.target.value)}
            placeholder="eyJ…"
            className="flex-1 rounded bg-zinc-900 px-3 py-2 text-sm"
          />
          <button
            onClick={() => void connectStreamlabs()}
            disabled={!slToken.trim()}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
          >
            Connect
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
          Hijack ledger
        </h2>
        {ledger.length === 0 ? (
          <p className="text-sm text-zinc-500">No hijacks yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-zinc-500">
                <tr>
                  <th className="py-1 pr-4">When</th>
                  <th className="py-1 pr-4">From</th>
                  <th className="py-1 pr-4">Tip</th>
                  <th className="py-1 pr-4">Secs</th>
                  <th className="py-1 pr-4">Outcome</th>
                  <th className="py-1">Prompt</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                {ledger.map((r) => (
                  <tr key={r.jobId} className="border-t border-zinc-900">
                    <td className="py-1.5 pr-4 text-zinc-500">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-4">{r.username}</td>
                    <td className="py-1.5 pr-4">${r.amountUsd}</td>
                    <td className="py-1.5 pr-4">{r.durationSec}</td>
                    <td
                      className={`py-1.5 pr-4 ${
                        r.outcome === "completed"
                          ? "text-emerald-400"
                          : r.outcome === "failed"
                            ? "text-red-400"
                            : "text-zinc-400"
                      }`}
                    >
                      {r.outcome}
                      {r.reason ? ` (${r.reason})` : ""}
                    </td>
                    <td
                      className="max-w-[16rem] truncate py-1.5 text-zinc-500"
                      title={r.prompt}
                    >
                      {r.prompt}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
