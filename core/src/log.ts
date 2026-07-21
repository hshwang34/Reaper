// Minimal timestamped logger with tags — host-swappable.
//
// @rh/core runs inside three different hosts (the sidecar demo rig, the hosted
// control plane, the Electron app's main process), each with its own idea of
// where logs should go. Default sink is the console so the package works
// standalone; hosts that want structured logging call setLogger() once at boot.

export interface Logger {
  log(tag: string, ...args: unknown[]): void;
  warn(tag: string, ...args: unknown[]): void;
  err(tag: string, ...args: unknown[]): void;
}

const pad = (n: number) => String(n).padStart(2, "0");

function ts(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const consoleLogger: Logger = {
  log: (tag, ...args) => console.log(`[${ts()}] ${tag}`, ...args),
  warn: (tag, ...args) => console.warn(`[${ts()}] ${tag} ⚠`, ...args),
  err: (tag, ...args) => console.error(`[${ts()}] ${tag} ✖`, ...args),
};

let sink: Logger = consoleLogger;

/** Replace the log sink for this process (e.g. Electron main, hosted server). */
export function setLogger(logger: Logger): void {
  sink = logger;
}

export function log(tag: string, ...args: unknown[]): void {
  sink.log(tag, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  sink.warn(tag, ...args);
}

export function err(tag: string, ...args: unknown[]): void {
  sink.err(tag, ...args);
}
