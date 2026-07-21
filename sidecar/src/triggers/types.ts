import type { TipEvent } from "@rh/shared";

/** A source of tip events. `start` begins emitting; `stop` tears down. */
export interface TriggerAdapter {
  name: string;
  start(emit: (e: TipEvent) => void): void;
  stop(): void;
}
