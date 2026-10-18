// Helpers for the Node adapter's tests: a fake clock, fake connections and temp databases.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../node/support.ts';
import type { Connection } from '../node/host.ts';
import type { ServerMessage } from '../protocol/index.ts';

/** A clock tests move by hand. Timers fire in time order when the clock passes them. */
export class FakeClock implements Clock {
  t: number;
  private timers: { at: number; fire: () => void; live: boolean }[] = [];

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimer(at: number, fire: () => void): { cancel(): void } {
    const timer = { at, fire, live: true };
    this.timers.push(timer);
    return { cancel: () => void (timer.live = false) };
  }

  /** Moves time forward, firing every timer that comes due on the way. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (next === undefined) break;
      next.live = false;
      this.t = Math.max(this.t, next.at);
      next.fire();
    }
    this.t = end;
    this.timers = this.timers.filter((t) => t.live);
  }

  get pending(): number {
    return this.timers.filter((t) => t.live).length;
  }
}

/** A connection that records what it was sent. */
export class FakeConnection implements Connection {
  readonly id: string;
  protocol = 1;
  pendingToken: string | null = null;
  bufferedAmount = 0;
  readonly received: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(id: string) {
    this.id = id;
  }

  send(text: string): void {
    this.received.push(JSON.parse(text) as ServerMessage);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

/** A fresh temporary directory, removed by the returned function. */
export const tempDir = (): { dir: string; file: (name: string) => string; remove: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'joystyk-rooms-'));
  return { dir, file: (name) => join(dir, name), remove: () => rmSync(dir, { recursive: true, force: true }) };
};
