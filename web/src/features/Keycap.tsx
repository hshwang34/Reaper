// A keyboard key, drawn as one. Used wherever the panic hotkey is named so
// it reads as "press this", not as a product term.
export function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-100">
      {children}
    </kbd>
  );
}
