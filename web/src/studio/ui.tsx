// Small studio building blocks: the plain-words status chip, cards, toggles.
// The studio is a streamer's tool, not a console — internal state names
// (IDLE, AUTHORIZING, …) never reach the screen; these do.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RouterState } from "@rh/shared";

export function statusOf(
  state: RouterState,
  armed: boolean,
  paused: boolean,
  remaining?: number,
): { label: string; tone: "idle" | "ready" | "busy" | "live" | "paused" } {
  if (paused) return { label: "Paused. Chat can't start hijacks", tone: "paused" };
  if (!armed || state === "OFFLINE") return { label: "Not turned on yet", tone: "idle" };
  switch (state) {
    case "IDLE":
      return { label: "Ready · waiting for a viewer", tone: "ready" };
    case "AUTHORIZING":
    case "CONNECTING":
    case "BUFFERING":
      return { label: "Starting an effect…", tone: "busy" };
    case "LIVE":
      return { label: remaining != null ? `Effect live · ${remaining}s left` : "Effect live", tone: "live" };
    case "TEARDOWN":
      return { label: "Wrapping up…", tone: "busy" };
  }
}

const TONE: Record<ReturnType<typeof statusOf>["tone"], string> = {
  idle: "bg-zinc-800 text-zinc-300",
  ready: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40",
  busy: "bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/40",
  live: "bg-brand-600 text-white shadow-[0_0_0_4px_rgba(187,50,27,.25)]",
  paused: "bg-zinc-800 text-zinc-400 ring-1 ring-zinc-600",
};

export function StatusChip({ label, tone }: ReturnType<typeof statusOf>) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold ${TONE[tone]}`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${
          tone === "live" ? "animate-pulse bg-white" : tone === "ready" ? "bg-emerald-400" : tone === "busy" ? "bg-amber-300" : "bg-zinc-500"
        }`}
      />
      {label}
    </span>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-zinc-950/70 p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold text-zinc-100">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** An accessible on/off switch. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-zinc-100">{label}</span>
        {hint && <span className="mt-0.5 block text-sm text-zinc-400">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="h-6 w-11 rounded-full bg-zinc-700 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** One-of-N choice as a segmented control (each option a real radio). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  const hint = options.find((o) => o.value === value)?.hint;
  return (
    <fieldset className="py-2">
      <legend className="mb-2 text-sm text-zinc-100">{label}</legend>
      <div className="flex flex-wrap gap-1 rounded-xl bg-zinc-900 p-1">
        {options.map((o) => (
          <label
            key={o.value}
            className={`flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-lg px-3 py-2 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400 ${
              value === o.value ? "bg-zinc-700 font-semibold text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <input
              type="radio"
              className="sr-only"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
      {hint && <p className="mt-1.5 text-sm text-zinc-400">{hint}</p>}
    </fieldset>
  );
}

/** BRAND §4.8: the one source of button recipes. 44px minimum touch target. */
export const btn = {
  primary:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40",
  secondary:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-zinc-100 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40",
  ghost:
    "inline-flex min-h-11 items-center gap-1 rounded-lg px-3 py-1 text-sm text-zinc-400 hover:bg-white/5 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40",
  danger:
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40",
};

/** A grey placeholder block while something loads (always paired with words nearby). */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-xl bg-white/5 ${className}`} />;
}

/** A failed load: what happened + the next step (BRAND §5). Never an empty state. */
export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-400/30 bg-red-950/30 p-4">
      <p className="text-sm text-red-200">{message}</p>
      {onRetry && (
        <button type="button" className={btn.secondary} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * Inline confirm for a destructive or money-adjacent action (BRAND §4.5):
 * a red button that names what happens, and a ghost way out.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-zinc-950 p-6" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" className="text-lg font-semibold text-zinc-50">
          {title}
        </h2>
        {body && <p className="mt-2 text-sm text-zinc-300">{body}</p>}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button type="button" className={btn.ghost} onClick={onCancel} autoFocus>
            {cancelLabel}
          </button>
          <button type="button" className={btn.danger} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** How long an undo stays on offer. */
export const UNDO_MS = 6000;

/**
 * A 6-second "Undo" for a change that overwrites something (a safety level,
 * a ban). Lighter than a modal: the change happens at once, and this offers
 * the way back. A newer change replaces the toast.
 */
export function useUndo() {
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const clear = () => {
    window.clearTimeout(timer.current);
    setUndo(null);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const offer = (text: string, run: () => void) => {
    window.clearTimeout(timer.current);
    setUndo({ text, run });
    timer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  };
  return { undo, offer, clear };
}

export function UndoToast({ undo, onClose }: { undo: { text: string; run: () => void } | null; onClose: () => void }) {
  if (!undo) return null;
  return (
    <div
      role="status"
      className="fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-zinc-100 py-1 pl-4 pr-1 text-sm font-semibold text-zinc-900 shadow-xl"
    >
      <span>{undo.text}</span>
      <button
        type="button"
        onClick={() => {
          undo.run();
          onClose();
        }}
        className="inline-flex min-h-11 items-center rounded-lg px-3 font-bold text-brand-700 hover:bg-black/5"
      >
        Undo
      </button>
    </div>
  );
}
