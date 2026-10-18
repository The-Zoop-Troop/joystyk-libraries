// The room host: live rooms in memory, `dispatch` (room-server.md section 4.2) and the code
// that carries out each effect. It knows nothing about HTTP or `ws`; a connection is anything
// that can send text and close.
import type { JobOutcome } from '@joystyk/contracts';
import { CloseCode, encodeFor, RejectionCode, PROTOCOL_VERSION, type ServerMessage } from '../protocol/index.ts';
import type { ConnId, DropReason, LiveRoom, RoomCode, RoomCommand, RoomCore, RoomEffect, Step } from '../types.ts';
import type { JobPool } from './jobs.ts';
import type { EngineRegistry } from './registry.ts';
import { expiresAt, type RoomStore } from './store.ts';
import type { Clock, Logger } from './support.ts';

export interface Connection {
  readonly id: ConnId;
  /** The wire version this connection joined with. */
  protocol: number;
  /** The fresh token generated for this connection's join; revealed only if the core issues a seat. */
  pendingToken: string | null;
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code: number, reason: string): void;
}

type Live = {
  room: LiveRoom;
  core: RoomCore;
  timer: { cancel(): void } | null;
  readonly conns: Map<ConnId, Connection>;
  idleSince: number;
  /** Commands whose persist failed and that must not be lost: retried before the next timer. */
  retry: RoomCommand[];
};

export type HostOptions = {
  readonly store: RoomStore;
  readonly registry: EngineRegistry;
  readonly clock: Clock;
  readonly pool: JobPool;
  readonly log: Logger;
  readonly maxRooms: number;
  readonly outgoingBufferBytes: number;
  readonly persistRetryMs: number;
  /** How long a heavy AI may choose (ROOMS_AI_TIMEOUT_MS). */
  readonly aiTimeoutMs: number;
  readonly draining: () => boolean;
};

const DROP_CODES: Record<DropReason, number> = {
  replaced: CloseCode.replaced,
  'left-room': CloseCode.leftRoom,
  'room-closed': CloseCode.noSuchRoom,
  'room-full': CloseCode.policy,
};

export type LoadResult = { readonly live: Live } | { readonly problem: 'missing' | 'busy' | 'engine-missing' };

export class RoomHost {
  readonly rooms = new Map<RoomCode, Live>();
  private readonly o: HostOptions;

  constructor(options: HostOptions) {
    this.o = options;
  }

  private log(
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: { readonly [k: string]: string | number | boolean | null } = {},
  ): void {
    this.o.log.write(level, event, fields);
  }

  /** The live room, loading it from storage (and resuming it) on first use. */
  load(code: RoomCode): LoadResult {
    const existing = this.rooms.get(code);
    if (existing !== undefined) return { live: existing };
    if (this.rooms.size >= this.o.maxRooms) return { problem: 'busy' };
    const record = this.o.store.load(code);
    if (record === null || record.phase === 'closed') return { problem: 'missing' };
    const pin = record.match?.game ?? record.game;
    const core =
      this.o.registry.core(pin.id, pin.rulesVersion) ??
      (record.match === null ? (this.o.registry.current(pin.id)?.core ?? null) : null);
    if (core === null) {
      this.log('error', 'engine_missing', { room: code, game: pin.id, rules: pin.rulesVersion });
      return { problem: 'engine-missing' };
    }
    if (record.match !== null) {
      const checked = core.engine.schemas.state['~standard'].validate(record.match.state);
      if (checked instanceof Promise || checked.issues !== undefined) {
        this.o.store.quarantine(code, 'state');
        return { problem: 'missing' };
      }
    }
    const live: Live = {
      room: core.load(record),
      core,
      timer: null,
      conns: new Map(),
      idleSince: this.o.clock.now(),
      retry: [],
    };
    this.rooms.set(code, live);
    this.log('info', 'room_loaded', { room: code, game: pin.id, rules: pin.rulesVersion });
    this.dispatch(code, { type: 'resume' });
    return { live };
  }

  /** Steps one command and carries out its effects: persist first, then everything else. */
  dispatch(code: RoomCode, command: RoomCommand): void {
    const live = this.rooms.get(code);
    if (live === undefined) return;
    let core = live.core;
    const before = live.room;
    const now = this.o.clock.now();
    let step: Step | null = null;
    const newest = this.o.registry.current(before.record.game.id)?.core;
    if (command.type === 'control' && before.record.phase !== 'playing' && newest !== undefined && newest !== core) {
      // A new match runs on the newest engine: a start, or the answer that completes a rematch
      // offer, is the upgrade point (section 6.1). Steps are pure, so a step on the newest core
      // that starts no match is dropped and the room's own core takes the command.
      const upgraded = newest.step(before, command, now);
      if (upgraded.room.record.match?.number !== before.record.match?.number) {
        core = newest;
        step = upgraded;
      }
    }
    step ??= core.step(before, command, now);
    const first = step.effects[0];
    if (first?.type === 'persist') {
      let saved: 'saved' | 'conflict';
      try {
        saved = this.o.store.save(first.record, first.inputs, before.record.writes);
      } catch (error) {
        this.log('error', 'persist_failed', { room: code, revision: first.record.revision, error: String(error) });
        this.storageUnavailable(live, command);
        this.armRetry(code, live);
        return;
      }
      if (saved === 'conflict') {
        this.log('error', 'write_conflict', { room: code });
        this.unload(code, 'conflict');
        return;
      }
    }
    live.room = step.room;
    if (step.room.record.match?.number !== before.record.match?.number) live.core = core;
    for (const effect of step.effects) if (effect.type !== 'persist') this.perform(code, live, effect);
  }

  /** The old state stays; tell whoever asked, and keep what must not be lost for the retry. */
  private storageUnavailable(live: Live, command: RoomCommand): void {
    switch (command.type) {
      case 'act':
      case 'control': {
        const message: ServerMessage = {
          v: PROTOCOL_VERSION,
          t: 'receipt',
          id: command.id,
          result: {
            status: 'rejected',
            code: RejectionCode.storageUnavailable,
            message: 'The table could not be saved. Try again.',
            revision: live.room.record.revision,
          },
        };
        this.sendTo(live, [command.conn], message);
        break;
      }
      case 'join': {
        const conn = live.conns.get(command.conn);
        live.conns.delete(command.conn);
        conn?.close(CloseCode.tryAgainLater, 'storage unavailable');
        break;
      }
      case 'leave':
      case 'ai-chosen':
      case 'resume':
      case 'job-completed':
        live.retry.push(command);
        break;
      default:
        break;
    }
  }

  private armRetry(code: RoomCode, live: Live): void {
    live.timer?.cancel();
    live.timer = this.o.clock.setTimer(this.o.clock.now() + this.o.persistRetryMs, () => {
      live.timer = null;
      const queued = live.retry.splice(0);
      for (const command of queued) this.dispatch(code, command);
      this.dispatch(code, { type: 'timer-fired' });
    });
    // The core will ask for its alarm again once a step succeeds.
    live.room = { ...live.room, alarmAt: null };
  }

  private sendTo(live: Live, to: readonly ConnId[], message: ServerMessage): void {
    const encoded = new Map<number, string>();
    for (const id of to) {
      const conn = live.conns.get(id);
      if (conn === undefined) continue;
      if (conn.bufferedAmount > this.o.outgoingBufferBytes) {
        conn.close(CloseCode.tryAgainLater, 'connection too slow');
        continue;
      }
      let text = encoded.get(conn.protocol);
      if (text === undefined) {
        text = JSON.stringify(encodeFor(message, conn.protocol));
        encoded.set(conn.protocol, text);
      }
      conn.send(text);
    }
  }

  private perform(code: RoomCode, live: Live, effect: RoomEffect): void {
    switch (effect.type) {
      case 'persist':
        return;
      case 'welcome': {
        const conn = live.conns.get(effect.conn);
        if (conn === undefined) return;
        const token = effect.issueToken ? conn.pendingToken : null;
        conn.pendingToken = null;
        this.sendTo(live, [effect.conn], token === null ? effect.message : { ...effect.message, token });
        return;
      }
      case 'send':
        this.sendTo(live, effect.to, effect.message);
        return;
      case 'drop': {
        const conn = live.conns.get(effect.conn);
        live.conns.delete(effect.conn);
        conn?.close(DROP_CODES[effect.reason], effect.reason);
        if (live.conns.size === 0) live.idleSince = this.o.clock.now();
        return;
      }
      case 'alarm':
        if (live.retry.length > 0) {
          this.armRetry(code, live);
          return;
        }
        live.timer?.cancel();
        live.timer =
          effect.at === null
            ? null
            : this.o.clock.setTimer(effect.at, () => this.dispatch(code, { type: 'timer-fired' }));
        return;
      case 'start-job':
        this.startJob(code, live, effect);
        return;
      case 'start-ai':
        this.startAi(code, live, effect);
        return;
      case 'log':
        this.o.log.write(effect.level, effect.event, {
          ...effect.fields,
          game: live.core.pin.id,
          rules: live.core.pin.rulesVersion,
        });
        return;
    }
  }

  private startJob(code: RoomCode, live: Live, effect: Extract<RoomEffect, { type: 'start-job' }>): void {
    // While draining, unstarted jobs stay in match.jobs and re-run after the restart.
    if (this.o.draining()) return;
    const started = this.o.clock.now();
    const spec = live.core.engine.jobs?.[effect.kind];
    void this.o.pool
      .run({
        room: code,
        jobId: effect.jobId,
        gameId: live.core.pin.id,
        rulesVersion: live.core.pin.rulesVersion,
        kind: effect.kind,
        payload: effect.payload,
        timeoutMs: effect.timeoutMs,
      })
      .then((outcome): JobOutcome => {
        // An engine sees only the contract's two failures.
        if (!outcome.ok) return { ok: false, reason: outcome.reason === 'timeout' ? 'timeout' : 'failed' };
        if (spec === undefined) return outcome;
        const checked = spec.result['~standard'].validate(outcome.value);
        if (checked instanceof Promise || checked.issues !== undefined) return { ok: false, reason: 'failed' };
        return outcome;
      })
      .then((outcome) => {
        this.log('info', 'job_finished', {
          room: code,
          kind: effect.kind,
          ok: outcome.ok,
          ms: this.o.clock.now() - started,
        });
        if (this.rooms.get(code) === live) this.dispatch(code, { type: 'job-completed', jobId: effect.jobId, outcome });
      });
  }

  /** Heavy AI on the pool, through the game's `jobs/ai.worker.ts`; a failure answers null and says why. */
  private startAi(code: RoomCode, live: Live, effect: Extract<RoomEffect, { type: 'start-ai' }>): void {
    if (this.o.draining()) return;
    const started = this.o.clock.now();
    void this.o.pool
      .run({
        room: code,
        jobId: `ai-${effect.seat}-${effect.decisionRevision}`,
        gameId: live.core.pin.id,
        rulesVersion: live.core.pin.rulesVersion,
        kind: 'ai',
        payload: { view: effect.view, seat: effect.seat, level: effect.level, rng: effect.rng },
        timeoutMs: this.o.aiTimeoutMs,
        answer: 'value',
      })
      .then((outcome) => {
        this.log('info', 'ai_finished', {
          room: code,
          seat: effect.seat,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { failure: outcome.reason }),
          ms: this.o.clock.now() - started,
        });
        if (this.rooms.get(code) !== live) return;
        const { seat, decisionRevision } = effect;
        this.dispatch(
          code,
          outcome.ok
            ? { type: 'ai-chosen', seat, decisionRevision, command: outcome.value }
            : { type: 'ai-chosen', seat, decisionRevision, command: null, failure: outcome.reason },
        );
      });
  }

  /** Forgets a room: no further callback may write it (the core marks it closed). */
  unload(code: RoomCode, reason: 'idle' | 'conflict' | 'drain' | 'expired'): void {
    const live = this.rooms.get(code);
    if (live === undefined) return;
    live.timer?.cancel();
    live.timer = null;
    live.room = live.core.step(live.room, { type: 'close', reason: 'unload' }, this.o.clock.now()).room;
    this.rooms.delete(code);
    if (reason === 'conflict')
      for (const conn of live.conns.values()) conn.close(CloseCode.tryAgainLater, 'room moved');
    this.log('info', 'room_unloaded', { room: code, reason });
  }

  /** Unloads idle rooms and closes expired ones. */
  sweep(idleMs: number): void {
    const now = this.o.clock.now();
    for (const [code, live] of [...this.rooms]) {
      if (now >= expiresAt(live.room.record) && live.room.record.phase !== 'closed') {
        this.dispatch(code, { type: 'close', reason: 'expired' });
        this.unload(code, 'expired');
      } else if (live.conns.size === 0 && now - live.idleSince >= idleMs) {
        this.unload(code, 'idle');
      }
    }
  }
}
