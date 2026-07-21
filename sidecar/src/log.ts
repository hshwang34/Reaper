// Minimal timestamped logger with tags.

const pad = (n: number) => String(n).padStart(2, "0");

function ts(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(tag: string, ...args: unknown[]): void {
  console.log(`[${ts()}] ${tag}`, ...args);
}

export function warn(tag: string, ...args: unknown[]): void {
  console.warn(`[${ts()}] ${tag} ⚠`, ...args);
}

export function err(tag: string, ...args: unknown[]): void {
  console.error(`[${ts()}] ${tag} ✖`, ...args);
}
