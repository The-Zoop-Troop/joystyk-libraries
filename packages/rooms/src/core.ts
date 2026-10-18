// The room core: `step(room, command, now) → { room', effects }` (room-server.md section 3).
// Pure: it reads no clock, randomness, storage or network. The adapter supplies `now`, fresh
// seeds and token hashes, and carries out the effects.
import {
  err,
  ok,
  type EngineInput,
  type Json,
  type JobOutcome,
  type Outcome,
  type Result,
  type Rng,
  type RngState,
  type SeatClock,
  type SeatId,
  type SeatInfo,
  type Transition,
} from '@joystyk/contracts';
import { forkRng, restoreRng, SFC32 } from '@joystyk/kit';
import { canonicalJson, fingerprint } from './canonical.ts';
import { admitName, nameReplacedMessage } from './names.ts';
import { policyProblem } from './policy.ts';
import { PROTOCOL_VERSION, RejectionCode, gameRejection } from './protocol/index.ts';
import type {
  Presence,
  PublicSeat,
  RoomControl,
  RoomOffer,
  RoomSettings,
  ServerMessage,
  SnapshotMessage,
  UpdateMessage,
  WelcomeMessage,
} from './protocol/index.ts';
import {
  DEFAULT_LIMITS,
  type AiRetry,
  type ConnId,
  type CoreLimits,
  type CreateParams,
  type DecisionClock,
  type DropReason,
  type LiveRoom,
  type LoggedInput,
  type MatchRecord,
  type MatchSeeds,
  type Member,
  type OfferRecord,
  type RoomCommand,
  type RoomCore,
  type RoomCoreOptions,
  type RoomEffect,
  type RoomError,
  type RoomRecord,
  type SeatRecord,
  type Step,
} from './types.ts';

type Rejection = { readonly code: string; readonly message: string };
type Viewer = SeatId | null;
type LogLevel = 'info' | 'warn' | 'error';

/** Binds the core to one engine at one rules version. */
export const createRoomCore = (options: RoomCoreOptions): RoomCore => {
  const { engine, pin } = options;
  const limits: CoreLimits = { ...DEFAULT_LIMITS, ...options.limits };
  if (pin.rulesVersion !== engine.rulesVersion) {
    throw new Error(`The pin's rules version ${pin.rulesVersion} differs from the engine's ${engine.rulesVersion}.`);
  }
  const defaultLevel = (): string | null => engine.ai?.levels[0] ?? null;

  const displayName = (seat: SeatRecord): string =>
    seat.claim?.name ?? (seat.controller === 'ai' ? `Bot ${seat.id + 1}` : `Seat ${seat.id + 1}`);

  const seatInfo = (seat: SeatRecord): SeatInfo =>
    seat.controller === 'ai' && seat.aiLevel !== null
      ? { id: seat.id, name: displayName(seat), controller: 'ai', aiLevel: seat.aiLevel }
      : { id: seat.id, name: displayName(seat), controller: seat.controller };

  const publicSeat = (seat: SeatRecord): PublicSeat => ({
    id: seat.id,
    name: displayName(seat),
    controller: seat.controller,
    aiLevel: seat.controller === 'ai' ? seat.aiLevel : null,
    claimed: seat.claim !== null,
    ready: seat.ready,
  });

  const keysOf = (state: Json, seats: number): string[] =>
    Array.from({ length: seats }, (_, seat) =>
      canonicalJson(engine.decisionKey ? engine.decisionKey(state, seat) : engine.viewFor(state, seat)),
    );

  const settingsOf = (record: RoomRecord): RoomSettings => ({
    decisionMs: record.policy.decisionMs,
    bank: record.policy.bank ?? null,
    aiLevel: record.aiLevel,
  });

  /** The offer as clients see it: for a rematch, every computer seat has accepted too. */
  const publicOffer = (record: RoomRecord): RoomOffer | null => {
    const offer = record.offer ?? null;
    if (offer === null) return null;
    const computers =
      offer.kind === 'rematch'
        ? record.seats.filter((s) => s.controller === 'ai' && !offer.accepted.includes(s.id)).map((s) => s.id)
        : [];
    return { ...offer, accepted: [...offer.accepted, ...computers] };
  };

  // ── The AI's stream (game-contract.md, "The AI's stream"; rule 7) ─────────────────────
  // Forks are always the kit's SFC32; any other saved algorithm goes to the engine's factory.
  const restoreAi = (state: RngState): Rng => (state.algorithm === SFC32 ? restoreRng(state) : options.rng(state));
  /** The child stream for one decision of `seat`: fork number `seat` of the AI stream. */
  const aiDecisionSeed = (state: RngState, seat: SeatId): RngState => {
    const parent = restoreAi(state);
    for (let i = 0; i < seat; i += 1) forkRng(parent);
    return forkRng(parent).save();
  };
  /** The AI stream after an accepted AI move: one fork per seat, past every child it handed out. */
  const advanceAi = (state: RngState, seats: number): RngState => {
    const parent = restoreAi(state);
    for (let i = 0; i < seats; i += 1) forkRng(parent);
    return parent.save();
  };

  /** A new match on `seats`, or the engine's reason it can't start. */
  const newMatch = (
    record: RoomRecord,
    seats: readonly SeatRecord[],
    seeds: MatchSeeds,
    revision: number,
    now: number,
  ): Result<MatchRecord> => {
    const infos = seats.map(seatInfo);
    const rng = options.rng(seeds.engine);
    const init = engine.init(record.config, infos, rng);
    if (!init.ok) return init;
    const state = init.value;
    return ok({
      number: (record.match?.number ?? 0) + 1,
      game: pin,
      config: record.config,
      seats: infos,
      seed: seeds.engine,
      state,
      rng: rng.save(),
      aiRng: seeds.ai,
      decisionRevision: seats.map(() => revision),
      clocks: [],
      ...(record.policy.bank ? { banks: seats.map(() => record.policy.bank?.initialMs ?? 0) } : {}),
      jobs: [],
      presentation: null,
      log: [],
      outcome: engine.outcome(state),
      startedAt: now,
    });
  };

  const create = (params: CreateParams, now: number): Result<RoomRecord, RoomError> => {
    const problem = policyProblem(params.policy);
    if (problem !== null) return err({ code: 'bad-policy', message: problem });
    const immediate = params.policy.start === 'immediate';
    const creator = admitName(params.creator.name, { room: params.code, epoch: 0, revision: 0, seat: 0 }).name;
    const seats: SeatRecord[] = Array.from({ length: params.policy.seats.max }, (_, id) => {
      if (id === 0)
        return {
          id,
          claim: { tokenHash: params.creator.tokenHash, name: creator },
          controller: 'human',
          aiLevel: null,
          ready: false,
        };
      return immediate
        ? { id, claim: null, controller: 'ai', aiLevel: defaultLevel(), ready: false }
        : { id, claim: null, controller: 'human', aiLevel: null, ready: false };
    });
    const record: RoomRecord = {
      format: 1,
      code: params.code,
      epoch: 0,
      writes: 0,
      policy: params.policy,
      phase: 'lobby',
      revision: 0,
      game: pin,
      config: params.config,
      aiLevel: defaultLevel(),
      seats,
      host: 0,
      match: null,
      receipts: [],
      createdAt: now,
      updatedAt: now,
    };
    if (!immediate) return ok(record);
    const initFailed = (error: string): Result<RoomRecord, RoomError> => {
      const reference = `init-${params.code}-${now}`;
      return err({
        code: 'init-failed',
        message: `The game could not start. Reference: ${reference}.`,
        diagnostic: { reference, error },
      });
    };
    let match: Result<MatchRecord>;
    try {
      match = newMatch(record, seats, params.seeds, 1, now);
    } catch (error) {
      return initFailed(String(error));
    }
    if (!match.ok) return initFailed(match.error.message);
    return ok({
      ...record,
      revision: 1,
      match: match.value,
      phase: match.value.outcome === null ? 'playing' : 'finished',
    });
  };

  const load = (record: RoomRecord): LiveRoom => ({
    record,
    members: new Map(),
    absentSince: new Map(),
    jobStartedAt: new Map(),
    aiInFlight: new Map(),
    aiRetry: new Map(),
    alarmAt: null,
    closed: false,
  });

  /** One step's working state. Everything here is local to a single `step` call. */
  class Tx {
    record: RoomRecord;
    readonly members: Map<ConnId, Member>;
    readonly absentSince: Map<SeatId, number>;
    readonly jobStartedAt: Map<string, number>;
    readonly aiInFlight: Map<SeatId, number>;
    readonly aiRetry: Map<SeatId, AiRetry>;
    /** The seat whose own command produced the input being applied (bank increments). */
    endedBy: SeatId | null = null;
    readonly now: number;
    readonly start: LiveRoom;
    dirty = false;
    closed: boolean;
    readonly inputs: LoggedInput[] = [];
    readonly beats: { readonly event: Json; readonly state?: Json }[] = [];
    presentationChanged = false;
    holdUntil: number;
    membershipChanged = false;
    snapshotAll = false;
    readonly snapshotTo = new Set<ConnId>();
    readonly early: RoomEffect[] = [];
    readonly receipts: RoomEffect[] = [];
    readonly jobs: RoomEffect[] = [];
    readonly logs: RoomEffect[] = [];
    autoInputs = 0;
    aiLoopLogged = false;
    private keys: string[] | null = null;

    constructor(room: LiveRoom, now: number) {
      this.start = room;
      this.record = room.record;
      this.members = new Map(room.members);
      this.absentSince = new Map(room.absentSince);
      this.jobStartedAt = new Map(room.jobStartedAt);
      this.aiInFlight = new Map(room.aiInFlight);
      this.aiRetry = new Map(room.aiRetry);
      this.closed = room.closed;
      this.now = now;
      this.holdUntil = now;
    }

    log(level: LogLevel, event: string, fields: { readonly [k: string]: Json } = {}): void {
      this.logs.push({ type: 'log', level, event, fields: { room: this.record.code, ...fields } });
    }

    set(record: RoomRecord): void {
      this.record = record;
      this.dirty = true;
    }

    setMatch(match: MatchRecord): void {
      this.set({ ...this.record, match });
    }

    bump(): void {
      this.set({ ...this.record, revision: this.record.revision + 1 });
    }

    setSeat(seat: SeatRecord): void {
      this.set({ ...this.record, seats: this.record.seats.map((s) => (s.id === seat.id ? seat : s)) });
    }

    seat(id: SeatId): SeatRecord | undefined {
      return this.record.seats[id];
    }

    hasMember(seat: SeatId): boolean {
      for (const member of this.members.values()) if (member.seat === seat) return true;
      return false;
    }

    connsOf(seat: SeatId): ConnId[] {
      return [...this.members].filter(([, m]) => m.seat === seat).map(([conn]) => conn);
    }

    /** No human seat has a connection: the table is paused, so no AI move, clock or offer runs (section 3.5 rule 8, D-58). */
    frozen(): boolean {
      for (const member of this.members.values()) {
        if (member.seat !== null && this.seat(member.seat)?.controller === 'human') return false;
      }
      return true;
    }

    playing(): boolean {
      return this.record.phase === 'playing' && this.record.match !== null;
    }

    send(to: readonly ConnId[], message: ServerMessage, bucket: RoomEffect[] = this.early): void {
      if (to.length > 0) bucket.push({ type: 'send', to, message });
    }

    drop(conn: ConnId, reason: DropReason): void {
      this.members.delete(conn);
      this.snapshotTo.delete(conn);
      this.early.push({ type: 'drop', conn, reason });
      this.membershipChanged = true;
    }

    receipt(
      conn: ConnId,
      id: string,
      result: { status: 'accepted'; revision: number } | ({ status: 'rejected' } & Rejection),
    ): void {
      const message: ServerMessage =
        result.status === 'accepted'
          ? { v: PROTOCOL_VERSION, t: 'receipt', id, result }
          : { v: PROTOCOL_VERSION, t: 'receipt', id, result: { ...result, revision: this.record.revision } };
      this.send([conn], message, this.receipts);
    }

    reject(conn: ConnId, id: string, rejection: Rejection, seat: Viewer): void {
      this.receipt(conn, id, { status: 'rejected', ...rejection });
      if (rejection.code === RejectionCode.stale) {
        this.snapshotTo.add(conn);
        this.log('info', 'stale_action', { seat });
      } else {
        this.log('info', 'action_rejected', { code: rejection.code, seat });
      }
    }

    // ── Engine inputs ─────────────────────────────────────────────────────────────────

    /** Each seat's decision key for the current state, cached until the state changes. */
    decisionKeys(): string[] {
      if (this.keys !== null) return this.keys;
      const match = this.record.match;
      if (match === null) return [];
      this.keys = keysOf(match.state, match.seats.length);
      return this.keys;
    }

    /** Applies one engine input. On success the revision rises by one and the input is logged. */
    apply(input: EngineInput<Json>): Result<Transition<Json, Json>, Rejection> {
      const match = this.record.match;
      if (match === null || this.record.phase !== 'playing')
        return err({ code: RejectionCode.wrongPhase, message: 'No match is in progress.' });
      const before = this.decisionKeys();
      const rng = options.rng(match.rng);
      let result: Result<Transition<Json, Json>>;
      try {
        result = engine.apply(match.state, input, rng);
      } catch (error) {
        this.log('error', 'engine_error', { input: input.kind, error: String(error) });
        return err({ code: RejectionCode.engineError, message: 'The game hit an error and ignored that move.' });
      }
      if (!result.ok) return err({ code: gameRejection(result.error.code), message: result.error.message });
      const transition = result.value;
      const revision = this.record.revision + 1;
      const state = transition.state;
      const after = keysOf(state, match.seats.length);
      this.keys = after;
      const decisionRevision = match.decisionRevision.map((r, seat) => (before[seat] === after[seat] ? r : revision));
      const events = transition.beats.map((beat) => beat.event);
      const log = [...match.log, ...events].slice(-limits.logEvents);
      const requested = (transition.jobs ?? []).map((request) => ({ request, revision }));
      for (const { request } of requested) {
        const spec = engine.jobs?.[request.kind];
        this.jobStartedAt.set(request.id, this.now);
        this.jobs.push({
          type: 'start-job',
          jobId: request.id,
          kind: request.kind,
          payload: request.payload,
          timeoutMs: spec?.timeoutMs ?? 0,
        });
        this.log('info', 'job_started', { kind: request.kind, job: request.id });
      }
      let outcome: Outcome | null = engine.outcome(state);
      if (outcome !== null) outcome = { ...outcome, elapsedMs: Math.max(0, this.now - match.startedAt) };
      this.set({
        ...this.record,
        revision,
        phase: outcome === null ? 'playing' : 'finished',
        match: {
          ...match,
          state,
          rng: rng.save(),
          decisionRevision,
          log,
          jobs: [...match.jobs, ...requested],
          outcome,
        },
      });
      this.beats.push(...transition.beats);
      const logged: EngineInput<Json> =
        input.kind === 'job' && input.outcome.ok
          ? { kind: 'job', jobId: input.jobId, outcome: { ok: true, value: input.outcome.value } }
          : input;
      this.inputs.push({ match: match.number, revision, at: this.now, input: logged });
      const hold = engine.holdMs ? engine.holdMs(transition, match.presentation) : 0;
      this.holdUntil = this.now + Math.max(0, hold);
      if (outcome !== null)
        this.log('info', 'match_finished', { result: outcome.result, match: match.number, ms: outcome.elapsedMs ?? 0 });
      this.endedBy = input.kind === 'command' ? input.seat : null;
      this.recomputeClocks();
      this.endedBy = null;
      return ok(transition);
    }

    /** Hands a seat to the AI or back to a human, telling the engine through a `seat` input. */
    setController(id: SeatId, controller: 'human' | 'ai'): void {
      const seat = this.seat(id);
      if (seat === undefined || seat.controller === controller) return;
      const next: SeatRecord = {
        ...seat,
        controller,
        aiLevel: controller === 'ai' ? (seat.aiLevel ?? this.record.aiLevel ?? defaultLevel()) : seat.aiLevel,
      };
      this.setSeat(next);
      const before = this.record.revision;
      if (this.playing()) {
        const change =
          controller === 'ai' && next.aiLevel !== null
            ? { type: 'controller' as const, controller, name: displayName(next), aiLevel: next.aiLevel }
            : { type: 'controller' as const, controller, name: displayName(next) };
        const result = this.apply({ kind: 'seat', seat: id, change });
        if (!result.ok) this.log('warn', 'seat_input_rejected', { seat: id, code: result.error.code });
      }
      if (this.record.revision === before) this.bump();
      this.log('info', 'seat_handover', { seat: id, to: controller });
    }

    // ── Clocks and deadlines ──────────────────────────────────────────────────────────

    /**
     * Ends the clocks whose decision is over and starts clocks for new decisions (section
     * 3.7). In bank mode an ended clock charges the seat's bank for the time it ran, and adds
     * the increment when the seat's own command ended it.
     */
    recomputeClocks(): void {
      // A pause that just began or ended settles first, so a new clock never moves with an old pause.
      this.syncPause();
      const match = this.record.match;
      if (match === null) return;
      const bank = this.record.policy.bank ?? null;
      const frozen = this.frozen();
      const next: DecisionClock[] = [];
      if (this.record.phase === 'playing') {
        for (const seat of new Set(engine.pending(match.state))) {
          if (this.seat(seat)?.controller !== 'human') continue;
          const decisionRevision = match.decisionRevision[seat] ?? 0;
          const existing = match.clocks.find((c) => c.seat === seat && c.decisionRevision === decisionRevision);
          if (existing !== undefined) {
            next.push(existing);
            continue;
          }
          if (frozen) continue;
          const startsAt = Math.max(this.now, this.holdUntil);
          if (bank !== null) {
            const remaining = match.banks?.[seat] ?? bank.initialMs;
            const ms = engine.decisionMs ? engine.decisionMs(match.state, seat, remaining) : remaining;
            if (ms === null) continue;
            next.push({ seat, at: startsAt + ms, decisionRevision, startsAt, onBank: ms === remaining });
          } else {
            const ms = engine.decisionMs
              ? engine.decisionMs(match.state, seat, this.record.policy.decisionMs)
              : this.record.policy.decisionMs;
            if (ms === null) continue;
            next.push({ seat, at: startsAt + ms, decisionRevision });
          }
        }
      }
      let banks = match.banks;
      if (bank !== null && banks !== undefined) {
        const charged = [...banks];
        // A paused table's clocks stopped when the pause began: only live time is charged.
        const until = match.pausedAt ?? this.now;
        for (const ended of match.clocks) {
          if (next.includes(ended) || ended.onBank !== true) continue;
          const ran = Math.max(0, until - (ended.startsAt ?? until));
          charged[ended.seat] =
            Math.max(0, (charged[ended.seat] ?? 0) - ran) + (this.endedBy === ended.seat ? bank.incrementMs : 0);
        }
        banks = charged;
      }
      const clocksChanged = canonicalJson(next) !== canonicalJson(match.clocks);
      const banksChanged = banks !== match.banks && canonicalJson(banks ?? []) !== canonicalJson(match.banks ?? []);
      if (clocksChanged || banksChanged)
        this.setMatch({ ...match, clocks: next, ...(banks === undefined ? {} : { banks }) });
    }

    /** A timed-out bank clock empties the bank before its timeout input applies. */
    emptyBank(clock: DecisionClock): void {
      const match = this.record.match;
      if (match?.banks === undefined || clock.onBank !== true) return;
      this.setMatch({ ...match, banks: match.banks.map((b, seat) => (seat === clock.seat ? 0 : b)) });
    }

    /**
     * Starts or ends the table's pause to match who is connected (D-58). While no player is
     * connected nothing runs; when one returns, every clock's deadline, a bank clock's start and
     * an end offer's deadline move on by the length of the pause, so nobody is charged for it.
     */
    syncPause(): void {
      const match = this.record.match;
      if (match === null) return;
      if (this.frozen()) {
        if (match.pausedAt !== undefined || this.record.phase !== 'playing') return;
        this.setMatch({ ...match, pausedAt: this.now });
        this.log('info', 'table_paused', {});
        return;
      }
      if (match.pausedAt === undefined) return;
      const { pausedAt, ...rest } = match;
      const shift = Math.max(0, this.now - pausedAt);
      const clocks = match.clocks.map((c) =>
        c.startsAt === undefined
          ? { ...c, at: c.at + shift }
          : { ...c, at: c.at + shift, startsAt: c.startsAt + shift },
      );
      this.setMatch({ ...rest, clocks });
      const offer = this.record.offer ?? null;
      if (offer?.status === 'open' && offer.endsAt !== null)
        this.set({ ...this.record, offer: { ...offer, endsAt: offer.endsAt + shift } });
      // Grace periods stood still too: an absent player's seat isn't handed on for the pause.
      for (const [seat, since] of this.absentSince) this.absentSince.set(seat, since + shift);
      this.log('info', 'table_resumed', { pausedMs: shift });
    }

    /** Ends the match early with no result, as an offer to end it asked (D-61). */
    endMatch(how: 'agreed' | 'unopposed'): void {
      const match = this.record.match;
      if (match === null || this.record.phase !== 'playing') return;
      for (const job of match.jobs) this.jobStartedAt.delete(job.request.id);
      this.aiInFlight.clear();
      this.aiRetry.clear();
      const summary =
        how === 'agreed'
          ? 'The players agreed to end the match early.'
          : 'The match ended early: nobody declined the offer to end it.';
      const outcome: Outcome = {
        result: 'abandoned',
        placements: [],
        summary,
        elapsedMs: Math.max(0, this.now - match.startedAt),
      };
      this.set({
        ...this.record,
        revision: this.record.revision + 1,
        phase: 'finished',
        offer: null,
        match: { ...match, jobs: [], outcome },
      });
      this.log('info', 'match_ended_early', { how, match: match.number });
      this.recomputeClocks();
    }

    /** After a restart: at least `resumeGraceMs` for every clock; a bank clock's start moves too, so the wait isn't charged. */
    extendClocks(): void {
      const match = this.record.match;
      if (match === null) return;
      const floor = this.now + limits.resumeGraceMs;
      if (!match.clocks.some((c) => c.at < floor)) return;
      const clocks = match.clocks.map((c) => {
        if (c.at >= floor) return c;
        const shift = floor - c.at;
        return c.startsAt === undefined ? { ...c, at: floor } : { ...c, at: floor, startsAt: c.startsAt + shift };
      });
      this.setMatch({ ...match, clocks });
    }

    budgetLeft(): boolean {
      if (this.autoInputs < limits.aiInputsPerStep) return true;
      if (!this.aiLoopLogged) {
        this.aiLoopLogged = true;
        this.log('error', 'ai_loop', { inputs: this.autoInputs });
      }
      return false;
    }

    completeJob(jobId: string, outcome: JobOutcome): void {
      const match = this.record.match;
      if (match === null) return;
      this.jobStartedAt.delete(jobId);
      const presentation = outcome.ok && outcome.presentation !== undefined ? outcome.presentation : match.presentation;
      if (presentation !== match.presentation) this.presentationChanged = true;
      this.setMatch({ ...match, jobs: match.jobs.filter((j) => j.request.id !== jobId), presentation });
      const stripped: JobOutcome = outcome.ok ? { ok: true, value: outcome.value } : outcome;
      this.log('info', 'job_finished', { job: jobId, ok: outcome.ok });
      const result = this.apply({ kind: 'job', jobId, outcome: stripped });
      if (!result.ok) this.log('error', 'job_input_rejected', { job: jobId, code: result.error.code });
    }

    /** Absence deadlines for seats, or null when the seat has none. */
    absentDue(seat: SeatRecord): number | null {
      if (seat.controller !== 'human' || this.hasMember(seat.id)) return null;
      const since = this.absentSince.get(seat.id);
      if (since !== undefined) return since + this.record.policy.graceMs;
      // A human seat nobody holds (its player left) is overdue at once.
      return seat.claim === null ? Number.NEGATIVE_INFINITY : null;
    }

    hostDue(): number | null {
      const host = this.record.host;
      if (host === null || this.hasMember(host)) return null;
      if (this.hostCandidate() === null) return null;
      return (this.absentSince.get(host) ?? Number.NEGATIVE_INFINITY) + this.record.policy.graceMs;
    }

    /** The connected human in the lowest-numbered seat, other than the host. */
    hostCandidate(exclude: SeatId | null = this.record.host): SeatId | null {
      for (const seat of this.record.seats) {
        if (seat.id !== exclude && seat.claim !== null && seat.controller === 'human' && this.hasMember(seat.id))
          return seat.id;
      }
      return null;
    }

    /** Applies the first due deadline. True when something happened. */
    applyOneDue(): boolean {
      const match = this.record.match;
      const now = this.now;
      if (match !== null && this.record.phase === 'playing') {
        for (const job of match.jobs) {
          const started = this.jobStartedAt.get(job.request.id);
          const spec = engine.jobs?.[job.request.kind];
          if (started !== undefined && spec !== undefined && started + spec.timeoutMs <= now) {
            this.log('warn', 'job_timeout', { job: job.request.id });
            this.completeJob(job.request.id, { ok: false, reason: 'timeout' });
            return true;
          }
        }
        if (!this.frozen()) {
          const due = [...match.clocks].filter((c) => c.at <= now).sort((a, b) => a.at - b.at || a.seat - b.seat)[0];
          if (due !== undefined) {
            this.autoInputs += 1;
            this.emptyBank(due);
            const result = this.apply({ kind: 'timeout', seat: due.seat });
            if (!result.ok) {
              // A refused timeout must not refire at once: drop this clock; a fresh one starts.
              this.log('error', 'timeout_rejected', { seat: due.seat, code: result.error.code });
              const current = this.record.match;
              if (current !== null) this.setMatch({ ...current, clocks: current.clocks.filter((c) => c !== due) });
              this.recomputeClocks();
            }
            return true;
          }
          const offer = this.record.offer ?? null;
          if (offer?.status === 'open' && offer.endsAt !== null && offer.endsAt <= now) {
            this.autoInputs += 1;
            this.endMatch('unopposed');
            return true;
          }
          const pending = new Set(engine.pending(match.state));
          for (const seat of this.record.seats) {
            const at = this.absentDue(seat);
            if (at === null || at > now) continue;
            if (this.record.policy.absent === 'ai' && seat.claim !== null) {
              this.autoInputs += 1;
              this.setController(seat.id, 'ai');
              return true;
            }
            if (this.record.policy.absent === 'timeout' && pending.has(seat.id)) {
              this.autoInputs += 1;
              const result = this.apply({ kind: 'timeout', seat: seat.id });
              if (!result.ok) {
                this.log('error', 'timeout_rejected', { seat: seat.id, code: result.error.code });
                return false;
              }
              return true;
            }
          }
        }
      }
      const hostAt = this.hostDue();
      if (hostAt !== null && hostAt <= now) {
        const next = this.hostCandidate();
        if (next !== null) {
          this.set({ ...this.record, host: next, revision: this.record.revision + 1 });
          this.log('info', 'host_transferred', { seat: next });
          return true;
        }
      }
      return false;
    }

    /**
     * Plays one runner-driven AI move (rule 7). True when something happened. A heavy AI
     * never chooses here: the core asks the pool with `start-ai`, once per decision.
     */
    playOneAi(): boolean {
      const match = this.record.match;
      const ai = engine.ai;
      if (ai === undefined || match === null || !this.playing() || match.jobs.length > 0 || this.frozen()) return false;
      const seats = engine.pending(match.state).filter((s) => this.seat(s)?.controller === 'ai');
      if (options.heavyAi === true) {
        for (const seat of seats) {
          const decisionRevision = match.decisionRevision[seat] ?? 0;
          if (this.aiInFlight.get(seat) === decisionRevision) continue;
          const retry = this.aiRetry.get(seat);
          if (retry?.decisionRevision === decisionRevision && retry.at > this.now) continue;
          this.aiInFlight.set(seat, decisionRevision);
          const level = this.seat(seat)?.aiLevel ?? ai.levels[0] ?? '';
          this.jobs.push({
            type: 'start-ai',
            seat,
            decisionRevision,
            view: engine.viewFor(match.state, seat),
            level,
            rng: aiDecisionSeed(match.aiRng, seat),
          });
          this.log('info', 'ai_started', { seat });
        }
        return false;
      }
      const seat = seats[0];
      if (seat === undefined) return false;
      const level = this.seat(seat)?.aiLevel ?? ai.levels[0] ?? '';
      const child = restoreRng(aiDecisionSeed(match.aiRng, seat));
      this.autoInputs += 1;
      let command: Json;
      try {
        command = ai.choose(engine.viewFor(match.state, seat), seat, level, child);
      } catch (error) {
        this.log('error', 'engine_error', { seat, input: 'ai', error: String(error) });
        return this.aiFallback(seat);
      }
      return this.applyAi(seat, command);
    }

    /** Applies an AI's command; the AI stream moves on only when it is accepted. */
    applyAi(seat: SeatId, command: Json): boolean {
      const result = this.apply({ kind: 'command', seat, command });
      if (result.ok) {
        const match = this.record.match;
        if (match !== null) this.setMatch({ ...match, aiRng: advanceAi(match.aiRng, match.seats.length) });
        return true;
      }
      this.log('error', 'ai_illegal_move', { seat, code: result.error.code });
      return this.aiFallback(seat);
    }

    aiFallback(seat: SeatId): boolean {
      const result = this.apply({ kind: 'timeout', seat });
      if (result.ok) return true;
      this.log('error', 'timeout_rejected', { seat, code: result.error.code });
      return false;
    }

    /** Deadlines, then AI moves, until nothing more is due or the loop bound is reached. */
    settle(): void {
      for (;;) {
        if (!this.budgetLeft()) return;
        if (this.applyOneDue()) continue;
        if (!this.budgetLeft()) return;
        if (this.playOneAi()) continue;
        return;
      }
    }

    alarm(): number | null {
      const candidates: number[] = [];
      const match = this.record.match;
      if (match !== null && this.record.phase === 'playing') {
        for (const job of match.jobs) {
          const started = this.jobStartedAt.get(job.request.id);
          const spec = engine.jobs?.[job.request.kind];
          if (started !== undefined && spec !== undefined) candidates.push(started + spec.timeoutMs);
        }
        if (!this.frozen()) {
          for (const clock of match.clocks) candidates.push(clock.at);
          const offer = this.record.offer ?? null;
          if (offer?.status === 'open' && offer.endsAt !== null) candidates.push(offer.endsAt);
          const pending = new Set(engine.pending(match.state));
          for (const [seat, retry] of this.aiRetry) {
            const due = pending.has(seat) && this.seat(seat)?.controller === 'ai' && match.jobs.length === 0;
            if (due && (match.decisionRevision[seat] ?? 0) === retry.decisionRevision) candidates.push(retry.at);
          }
          for (const seat of this.record.seats) {
            const at = this.absentDue(seat);
            if (at === null || !Number.isFinite(at)) continue;
            if (this.record.policy.absent === 'ai' && seat.claim !== null) candidates.push(at);
            if (this.record.policy.absent === 'timeout' && pending.has(seat.id)) candidates.push(at);
          }
        }
      }
      const hostAt = this.hostDue();
      if (hostAt !== null && Number.isFinite(hostAt)) candidates.push(hostAt);
      if (candidates.length === 0) return null;
      const at = Math.min(...candidates);
      // Something due that couldn't be applied (the loop bound, a refused input): look again soon.
      return at <= this.now ? this.now + 1_000 : at;
    }

    // ── Messages ──────────────────────────────────────────────────────────────────────

    presence(): Presence {
      let spectators = 0;
      for (const m of this.members.values()) if (m.seat === null) spectators += 1;
      return {
        connected: this.record.seats.map((s) => this.hasMember(s.id)),
        clocks: this.seatClocks(),
        paused: this.record.phase === 'playing' && this.frozen(),
        spectators,
      };
    }

    /**
     * Clocks as clients show them: running per-move clocks, or every seat's bank. On a paused
     * table (D-58) each clock reads as it stood when the pause began, and says it is paused.
     */
    seatClocks(): SeatClock[] {
      const match = this.record.match;
      if (match === null || this.record.phase !== 'playing') return [];
      const frozen = this.frozen();
      const at = frozen ? (match.pausedAt ?? this.now) : this.now;
      const paused = frozen ? { paused: true } : {};
      const bank = this.record.policy.bank ?? null;
      if (bank === null)
        return match.clocks.map((c) => ({
          seat: c.seat,
          remainingMs: Math.max(0, c.at - at),
          running: !frozen,
          ...paused,
        }));
      return match.seats.map(({ id: seat }) => {
        const left = match.banks?.[seat] ?? bank.initialMs;
        const clock = match.clocks.find((c) => c.seat === seat);
        if (clock === undefined) return { seat, remainingMs: left, running: false };
        const startsAt = clock.startsAt ?? at;
        const remainingMs =
          clock.onBank === true ? Math.max(0, left - Math.max(0, at - startsAt)) : Math.max(0, clock.at - at);
        return { seat, remainingMs, running: !frozen && at >= startsAt, ...paused };
      });
    }

    private readonly views = new Map<Viewer, Json | null>();

    view(viewer: Viewer): Json | null {
      if (this.views.has(viewer)) return this.views.get(viewer) ?? null;
      const match = this.record.match;
      const view = match === null ? null : engine.viewFor(match.state, viewer);
      this.views.set(viewer, view);
      return view;
    }

    snapshot(viewer: Viewer, presence: Presence): SnapshotMessage {
      const match = this.record.match;
      const history: Json[] = [];
      for (const event of match?.log ?? []) {
        const redacted = engine.eventFor(event, viewer);
        if (redacted !== null) history.push(redacted);
      }
      return {
        v: PROTOCOL_VERSION,
        t: 'snapshot',
        epoch: this.record.epoch,
        revision: this.record.revision,
        phase: this.record.phase,
        seat: viewer,
        seats: this.record.seats.map(publicSeat),
        host: this.record.host,
        game: this.record.game,
        settings: settingsOf(this.record),
        view: this.view(viewer),
        history,
        pending: match !== null && this.record.phase === 'playing' ? engine.pending(match.state) : [],
        outcome: match?.outcome ?? null,
        presentation: match?.presentation ?? null,
        offer: publicOffer(this.record),
        presence,
        serverTime: this.now,
      };
    }

    welcome(conn: ConnId, seat: Viewer, issueToken: boolean): void {
      const message: WelcomeMessage = {
        v: PROTOCOL_VERSION,
        t: 'welcome',
        room: this.record.code,
        seat,
        host: this.record.host,
        game: this.record.game,
        protocol: PROTOCOL_VERSION,
      };
      this.early.push({ type: 'welcome', conn, message, issueToken });
    }

    finish(): Step {
      const start = this.start.record;
      const effects: RoomEffect[] = [];
      let record = this.record;
      if (this.dirty) {
        record = { ...record, writes: start.writes + 1, updatedAt: this.now };
        this.record = record;
        effects.push({ type: 'persist', record, inputs: this.inputs });
      }
      effects.push(...this.early);
      const presence = this.presence();
      const changed = record.revision !== start.revision;
      const groups = new Map<Viewer, ConnId[]>();
      for (const [conn, member] of this.members) {
        if (this.snapshotAll || this.snapshotTo.has(conn)) continue;
        const list = groups.get(member.seat) ?? [];
        list.push(conn);
        groups.set(member.seat, list);
      }
      if (changed) {
        const seats = record.seats.map(publicSeat);
        const seatsChanged = canonicalJson(seats) !== canonicalJson(start.seats.map(publicSeat));
        const settings = settingsOf(record);
        const settingsChanged = canonicalJson(settings) !== canonicalJson(settingsOf(start));
        const match = record.match;
        const pending = match !== null && record.phase === 'playing' ? engine.pending(match.state) : [];
        for (const [viewer, conns] of groups) {
          const beats = [];
          for (const beat of this.beats) {
            const event = engine.eventFor(beat.event, viewer);
            if (event === null) continue;
            beats.push(beat.state === undefined ? { event } : { event, view: engine.viewFor(beat.state, viewer) });
          }
          const update: UpdateMessage = {
            v: PROTOCOL_VERSION,
            t: 'update',
            epoch: record.epoch,
            revision: record.revision,
            from: start.revision,
            phase: record.phase,
            host: record.host,
            ...(seatsChanged ? { seats } : {}),
            ...(settingsChanged ? { settings } : {}),
            beats,
            view: this.view(viewer),
            pending,
            outcome: match?.outcome ?? null,
            ...(this.presentationChanged ? { presentation: match?.presentation ?? null } : {}),
            offer: publicOffer(record),
            presence,
            serverTime: this.now,
          };
          effects.push({ type: 'send', to: conns, message: update });
        }
      }
      for (const [conn, member] of this.members) {
        if (this.snapshotAll || this.snapshotTo.has(conn))
          effects.push({ type: 'send', to: [conn], message: this.snapshot(member.seat, presence) });
      }
      effects.push(...this.receipts);
      const clocksChanged = canonicalJson(record.match?.clocks ?? []) !== canonicalJson(start.match?.clocks ?? []);
      if (!changed && (this.membershipChanged || clocksChanged)) {
        const others = [...groups.values()].flat();
        this.send(others, { v: PROTOCOL_VERSION, t: 'presence', presence, serverTime: this.now }, effects);
      }
      const alarmAt = this.closed ? null : this.alarm();
      if (alarmAt !== this.start.alarmAt) effects.push({ type: 'alarm', at: alarmAt });
      effects.push(...this.jobs, ...this.logs);
      return {
        room: {
          record,
          members: this.members,
          absentSince: this.absentSince,
          jobStartedAt: this.jobStartedAt,
          aiInFlight: this.aiInFlight,
          aiRetry: this.aiRetry,
          alarmAt,
          closed: this.closed,
        },
        effects,
      };
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────

  const uniqueName = (tx: Tx, name: string): string => {
    // Names differ ignoring case, so "Ana" and "ana" never sit at one table.
    const used = new Set(tx.record.seats.flatMap((s) => (s.claim === null ? [] : [s.claim.name.toLowerCase()])));
    if (!used.has(name.toLowerCase())) return name;
    const base = name.slice(0, 21);
    let n = 2;
    while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
    return `${base} ${n}`;
  };

  const join = (tx: Tx, command: Extract<RoomCommand, { type: 'join' }>): void => {
    if (tx.members.has(command.conn)) return;
    const wasFrozen = tx.frozen();
    const member = (seat: Viewer): Member => ({ seat, protocol: command.protocol, joinedAt: tx.now });
    const claimed =
      command.presentedTokenHash === null
        ? undefined
        : tx.record.seats.find((s) => s.claim?.tokenHash === command.presentedTokenHash);
    if (claimed !== undefined && !command.watch) {
      for (const conn of tx.connsOf(claimed.id)) {
        tx.send([conn], { v: PROTOCOL_VERSION, t: 'replaced' });
        tx.drop(conn, 'replaced');
        tx.log('info', 'replaced', { seat: claimed.id });
      }
      tx.members.set(command.conn, member(claimed.id));
      tx.absentSince.delete(claimed.id);
      if (claimed.controller === 'ai') tx.setController(claimed.id, 'human');
      tx.welcome(command.conn, claimed.id, false);
    } else {
      const free = command.watch ? undefined : freeSeat(tx);
      if (free !== undefined) {
        const { code: room, epoch, revision } = tx.record;
        const admitted = admitName(command.name, { room, epoch, revision, seat: free.id });
        const name = uniqueName(tx, admitted.name);
        const wasAi = free.controller === 'ai';
        tx.setSeat({ ...free, claim: { tokenHash: command.freshTokenHash, name }, ready: false });
        tx.members.set(command.conn, member(free.id));
        tx.absentSince.delete(free.id);
        if (wasAi) tx.setController(free.id, 'human');
        else tx.bump();
        if (tx.record.host === null) tx.set({ ...tx.record, host: free.id });
        tx.log('info', 'seat_claimed', { seat: free.id });
        tx.welcome(command.conn, free.id, true);
        if (admitted.rejection !== null) {
          tx.send([command.conn], {
            v: PROTOCOL_VERSION,
            t: 'notice',
            code: 'name-replaced',
            message: nameReplacedMessage(admitted.rejection, name),
          });
          tx.log('info', 'name_replaced', { seat: free.id, reason: admitted.rejection.code });
        }
      } else {
        let spectators = 0;
        for (const m of tx.members.values()) if (m.seat === null) spectators += 1;
        if (spectators >= tx.record.policy.maxSpectators) {
          tx.send([command.conn], {
            v: PROTOCOL_VERSION,
            t: 'notice',
            code: 'room-full',
            message: 'This room is full.',
          });
          tx.early.push({ type: 'drop', conn: command.conn, reason: 'room-full' });
          return;
        }
        tx.members.set(command.conn, member(null));
        tx.welcome(command.conn, null, false);
      }
    }
    tx.membershipChanged = true;
    tx.snapshotTo.add(command.conn);
    // A player is back at a paused table: its clocks run on from where they stopped (D-58).
    if (wasFrozen && !tx.frozen()) tx.syncPause();
  };

  const freeSeat = (tx: Tx): SeatRecord | undefined => {
    if (tx.record.phase === 'lobby') return tx.record.seats.find((s) => s.claim === null && s.controller === 'human');
    if (tx.record.policy.lateJoin === 'take-ai-seat' && tx.record.phase !== 'closed')
      return tx.record.seats.find((s) => s.claim === null && s.controller === 'ai');
    return undefined;
  };

  const leave = (tx: Tx, conn: ConnId): void => {
    const member = tx.members.get(conn);
    if (member === undefined) return;
    tx.members.delete(conn);
    tx.membershipChanged = true;
    if (member.seat === null || tx.hasMember(member.seat)) return;
    if (tx.seat(member.seat)?.claim) tx.absentSince.set(member.seat, tx.now);
  };

  /** The receipt and revision checks shared by `act` and `control` (section 3.8). True: proceed. */
  const admit = (
    tx: Tx,
    conn: ConnId,
    id: string,
    seat: SeatId,
    expectedRevision: number,
    print: string,
    judgeStale: boolean,
  ): boolean => {
    const receipt = tx.record.receipts.find((r) => r.seat === seat && r.id === id);
    if (receipt !== undefined) {
      if (receipt.fingerprint === print) {
        tx.receipt(conn, id, { status: 'accepted', revision: receipt.revision });
        tx.log('info', 'duplicate_action', { seat });
      } else {
        tx.reject(
          conn,
          id,
          { code: RejectionCode.actionIdReused, message: 'That action ID was already used for a different action.' },
          seat,
        );
      }
      return false;
    }
    if (expectedRevision > tx.record.revision) {
      tx.reject(
        conn,
        id,
        { code: RejectionCode.badRevision, message: 'Your table is ahead of the server. Reloading it.' },
        seat,
      );
      tx.snapshotTo.add(conn);
      return false;
    }
    const decided = tx.record.match?.decisionRevision[seat] ?? 0;
    if (judgeStale && expectedRevision < decided) {
      tx.reject(conn, id, { code: RejectionCode.stale, message: 'The table changed. Review it and try again.' }, seat);
      return false;
    }
    return true;
  };

  const accept = (tx: Tx, conn: ConnId, id: string, seat: SeatId, print: string, revision: number): void => {
    const mine = tx.record.receipts.filter((r) => r.seat === seat);
    const others = tx.record.receipts.filter((r) => r.seat !== seat);
    const kept = mine.slice(Math.max(0, mine.length - (limits.receiptsPerSeat - 1)));
    tx.set({ ...tx.record, receipts: [...others, ...kept, { seat, id, fingerprint: print, revision }] });
    tx.receipt(conn, id, { status: 'accepted', revision });
  };

  const act = (tx: Tx, command: Extract<RoomCommand, { type: 'act' }>): void => {
    const member = tx.members.get(command.conn);
    if (member === undefined) return void tx.log('warn', 'unknown_connection', {});
    if (member.seat === null) {
      return tx.reject(
        command.conn,
        command.id,
        { code: RejectionCode.spectator, message: 'Spectators can watch but not play.' },
        null,
      );
    }
    const seat = member.seat;
    const print = fingerprint({ expectedRevision: command.expectedRevision, command: command.command });
    if (!admit(tx, command.conn, command.id, seat, command.expectedRevision, print, true)) return;
    if (!tx.playing())
      return tx.reject(
        command.conn,
        command.id,
        { code: RejectionCode.wrongPhase, message: 'No match is in progress.' },
        seat,
      );
    const result = tx.apply({ kind: 'command', seat, command: command.command });
    if (!result.ok) return tx.reject(command.conn, command.id, result.error, seat);
    accept(tx, command.conn, command.id, seat, print, tx.record.revision);
  };

  const notHost: Rejection = { code: RejectionCode.notHost, message: 'Only the host can do that.' };
  const wrongPhase = (message: string): Rejection => ({ code: RejectionCode.wrongPhase, message });
  const notAllowed = (message: string): Rejection => ({ code: RejectionCode.notAllowed, message });

  /** Rebuilds the seat list for a new match; members, absences and the host follow their seats. */
  const startMatch = (tx: Tx, seeds: MatchSeeds, compact: boolean): Rejection | null => {
    const filled = compact ? tx.record.seats.filter((s) => s.claim !== null || s.controller === 'ai') : tx.record.seats;
    const remap = new Map(filled.map((s, i) => [s.id, i]));
    const seats = filled.map((s, i) => ({ ...s, id: i, ready: false }));
    const revision = tx.record.revision + 1;
    let match: Result<MatchRecord>;
    let config = tx.record.config;
    try {
      const finished = tx.record.match;
      if (finished !== null && finished.outcome !== null && engine.rematch !== undefined) {
        const state = engine.schemas.state['~standard'].validate(finished.state);
        if (!(state instanceof Promise) && state.issues === undefined)
          config = engine.rematch(finished.config, state.value);
      }
      const parsed = engine.schemas.config['~standard'].validate(config);
      if (parsed instanceof Promise || parsed.issues !== undefined)
        return { code: RejectionCode.engineError, message: 'The rematch settings could not be prepared.' };
      config = parsed.value;
      match = newMatch({ ...tx.record, seats, config }, seats, seeds, revision, tx.now);
    } catch (error) {
      tx.log('error', 'engine_error', { input: 'init', error: String(error) });
      return { code: RejectionCode.engineError, message: 'The game could not start.' };
    }
    if (!match.ok) return { code: gameRejection(match.error.code), message: match.error.message };
    for (const [conn, member] of tx.members) {
      if (member.seat === null) continue;
      const next = remap.get(member.seat);
      if (next === undefined) tx.drop(conn, 'left-room');
      else tx.members.set(conn, { ...member, seat: next });
    }
    const absent = [...tx.absentSince].flatMap(([seat, since]) => {
      const next = remap.get(seat);
      return next === undefined ? [] : [[next, since] as const];
    });
    tx.absentSince.clear();
    for (const [seat, since] of absent) tx.absentSince.set(seat, since);
    const host = tx.record.host === null ? null : (remap.get(tx.record.host) ?? null);
    // Receipts follow their seats, so a retried lobby action still finds its receipt.
    const receipts = tx.record.receipts.flatMap((r) => {
      const next = remap.get(r.seat);
      return next === undefined ? [] : [{ ...r, seat: next }];
    });
    const value = match.value;
    tx.set({
      ...tx.record,
      seats,
      host,
      receipts,
      revision,
      config,
      game: pin,
      match: value,
      offer: null,
      phase: value.outcome === null ? 'playing' : 'finished',
    });
    tx.snapshotAll = true;
    tx.log('info', value.number === 1 ? 'match_started' : 'rematch', {
      match: value.number,
      game: pin.id,
      rules: pin.rulesVersion,
    });
    tx.recomputeClocks();
    return null;
  };

  // ── Offers: rematch and end-match by offer and accept (section 3.10, D-61) ──────────────

  /** Seats whose yes a rematch needs: every seat a player holds. Computer seats accept on their own. */
  const rematchVoters = (tx: Tx): SeatId[] =>
    tx.record.seats.filter((s) => s.claim !== null && s.controller === 'human').map((s) => s.id);

  /** Seats whose yes ends a match early: every other connected player. */
  const endVoters = (tx: Tx, by: SeatId): SeatId[] =>
    tx.record.seats
      .filter((s) => s.id !== by && s.claim !== null && s.controller === 'human' && tx.hasMember(s.id))
      .map((s) => s.id);

  const setOffer = (tx: Tx, offer: OfferRecord | null): void => tx.set({ ...tx.record, offer });

  /**
   * Acts on the offer once it has every yes it needs: a rematch starts (when this step carries
   * seeds), or the match ends. An offer outlives neither its match nor its proposer's seat.
   */
  const resolveOffer = (tx: Tx, seeds: MatchSeeds | null): Rejection | null => {
    const offer = tx.record.offer ?? null;
    if (offer === null) return null;
    const phase = tx.record.phase;
    if ((offer.kind === 'rematch' && phase !== 'finished') || (offer.kind === 'end' && phase !== 'playing')) {
      setOffer(tx, null);
      return null;
    }
    if (offer.status !== 'open') return null;
    const proposer = tx.seat(offer.by);
    if (proposer?.claim == null || proposer.controller !== 'human') {
      setOffer(tx, { ...offer, status: 'withdrawn' });
      tx.log('info', 'offer_withdrawn', { kind: offer.kind, seat: offer.by, why: 'seat' });
      return null;
    }
    if (offer.kind === 'rematch') {
      if (seeds === null || !rematchVoters(tx).every((s) => offer.accepted.includes(s))) return null;
      return startMatch(tx, seeds, false);
    }
    if (!tx.frozen() && endVoters(tx, offer.by).every((s) => offer.accepted.includes(s))) tx.endMatch('agreed');
    return null;
  };

  const OFFER_LOG = { accept: 'offer_accepted', decline: 'offer_declined', withdraw: 'offer_withdrawn' } as const;

  /** Makes an offer, or answers the open one. */
  const offerControl = (
    tx: Tx,
    seat: SeatId,
    ctl: Extract<RoomControl, { kind: 'offer' | 'accept' | 'decline' | 'withdraw' }>,
    seeds: MatchSeeds,
  ): Rejection | null => {
    const offer = tx.record.offer ?? null;
    const open = offer?.status === 'open' ? offer : null;
    if (ctl.kind === 'offer') {
      if (ctl.offer === 'rematch' && tx.record.phase !== 'finished')
        return wrongPhase('A rematch can be offered once the match is over.');
      if (ctl.offer === 'end' && tx.record.phase !== 'playing')
        return wrongPhase('Only a match in progress can be ended.');
      if (open !== null) {
        // Offering what is already on the table accepts it.
        if (open.accepted.includes(seat)) return notAllowed('You have already agreed to that.');
        setOffer(tx, { ...open, accepted: [...open.accepted, seat] });
        tx.log('info', OFFER_LOG.accept, { kind: open.kind, seat });
      } else {
        const endsAt = ctl.offer === 'end' ? tx.now + limits.endOfferMs : null;
        setOffer(tx, {
          id: tx.record.revision + 1,
          kind: ctl.offer,
          by: seat,
          status: 'open',
          accepted: [seat],
          declinedBy: null,
          endsAt,
        });
        tx.log('info', 'offer_made', { kind: ctl.offer, seat });
      }
      return resolveOffer(tx, seeds);
    }
    if (open === null || open.id !== ctl.offer) return notAllowed('That offer is no longer open.');
    if (ctl.kind === 'withdraw') {
      if (open.by !== seat) return notAllowed('Only the player who made the offer can withdraw it.');
      setOffer(tx, { ...open, status: 'withdrawn' });
    } else if (open.by === seat) {
      return notAllowed('You made this offer.');
    } else if (ctl.kind === 'decline') {
      setOffer(tx, { ...open, status: 'declined', declinedBy: seat });
    } else {
      if (open.accepted.includes(seat)) return notAllowed('You have already accepted.');
      setOffer(tx, { ...open, accepted: [...open.accepted, seat] });
    }
    tx.log('info', OFFER_LOG[ctl.kind], { kind: open.kind, seat });
    return ctl.kind === 'accept' ? resolveOffer(tx, seeds) : null;
  };

  const passHost = (tx: Tx, leaving: SeatId): void => {
    if (tx.record.host !== leaving) return;
    const connected = tx.hostCandidate(leaving);
    const claimed = tx.record.seats.find((s) => s.id !== leaving && s.claim !== null)?.id ?? null;
    tx.set({ ...tx.record, host: connected ?? claimed });
    tx.log('info', 'host_transferred', { seat: connected ?? claimed });
  };

  const control = (tx: Tx, command: Extract<RoomCommand, { type: 'control' }>): void => {
    const member = tx.members.get(command.conn);
    if (member === undefined) return void tx.log('warn', 'unknown_connection', {});
    const { conn, id } = command;
    if (member.seat === null)
      return tx.reject(
        conn,
        id,
        { code: RejectionCode.spectator, message: 'Spectators can watch but not play.' },
        null,
      );
    const seat = member.seat;
    const print = fingerprint({ expectedRevision: command.expectedRevision, control: command.control });
    if (!admit(tx, conn, id, seat, command.expectedRevision, print, false)) return;
    const [record, dirty, logs] = [tx.record, tx.dirty, tx.logs.length];
    const problem = applyControl(tx, seat, command.control, command.seeds);
    if (problem !== null) {
      // A rejection changes nothing durable, even after a change (an accept whose rematch the engine refused).
      tx.record = record;
      tx.dirty = dirty;
      tx.logs.length = logs;
      return tx.reject(conn, id, problem, seat);
    }
    // Starting a match can renumber seats; the receipt belongs to the seat as it is now.
    accept(tx, conn, id, tx.members.get(conn)?.seat ?? seat, print, tx.record.revision);
  };

  const applyControl = (tx: Tx, seat: SeatId, ctl: RoomControl, seeds: MatchSeeds): Rejection | null => {
    const phase = tx.record.phase;
    const isHost = tx.record.host === seat;
    const before = tx.record.revision;
    switch (ctl.kind) {
      case 'ready': {
        if (phase !== 'lobby') return wrongPhase('Readiness is set in the lobby.');
        const current = tx.seat(seat);
        if (current === undefined) return notAllowed('You have no seat.');
        tx.setSeat({ ...current, ready: ctl.ready });
        break;
      }
      case 'settings': {
        if (!isHost) return notHost;
        if (phase !== 'lobby') return wrongPhase('Settings change in the lobby only.');
        if (ctl.aiLevel !== undefined && engine.ai !== undefined && !engine.ai.levels.includes(ctl.aiLevel)) {
          return { code: RejectionCode.badCommand, message: 'That AI level does not exist.' };
        }
        const aiLevel = ctl.aiLevel ?? tx.record.aiLevel;
        // A per-move clock and a bank exclude each other: setting one turns the other off.
        let policy = tx.record.policy;
        if (ctl.decisionMs !== undefined)
          policy = { ...policy, decisionMs: ctl.decisionMs, ...(ctl.decisionMs === null ? {} : { bank: null }) };
        if (ctl.bank !== undefined)
          policy = { ...policy, bank: ctl.bank, ...(ctl.bank === null ? {} : { decisionMs: null }) };
        tx.set({
          ...tx.record,
          policy,
          config: ctl.config ?? tx.record.config,
          aiLevel,
          seats:
            ctl.aiLevel === undefined
              ? tx.record.seats
              : tx.record.seats.map((s) => (s.controller === 'ai' ? { ...s, aiLevel } : s)),
        });
        break;
      }
      case 'fill-with-ai': {
        if (!isHost) return notHost;
        const target = tx.seat(ctl.seat);
        if (target === undefined) return notAllowed('There is no such seat.');
        if (phase === 'lobby') {
          if (target.claim !== null || target.controller !== 'human')
            return notAllowed('Only an open seat can be filled with the AI.');
          tx.setSeat({ ...target, controller: 'ai', aiLevel: tx.record.aiLevel ?? defaultLevel() });
        } else if (phase === 'playing') {
          if (target.controller !== 'human' || tx.hasMember(target.id))
            return notAllowed('Only an absent player’s seat can be handed to the AI.');
          tx.setController(target.id, 'ai');
        } else {
          return wrongPhase('The match is over.');
        }
        break;
      }
      case 'remove-seat': {
        if (!isHost) return notHost;
        if (phase !== 'lobby') return wrongPhase('Seats are removed in the lobby only.');
        const target = tx.seat(ctl.seat);
        if (target === undefined || ctl.seat === seat) return notAllowed('You can’t remove that seat.');
        for (const c of tx.connsOf(target.id)) tx.drop(c, 'left-room');
        tx.absentSince.delete(target.id);
        tx.setSeat({ id: target.id, claim: null, controller: 'human', aiLevel: null, ready: false });
        break;
      }
      case 'start': {
        if (!isHost) return notHost;
        if (phase !== 'lobby') return wrongPhase('The match has already started.');
        const filled = tx.record.seats.filter((s) => s.claim !== null || s.controller === 'ai');
        if (filled.length < tx.record.policy.seats.min)
          return notAllowed(`At least ${tx.record.policy.seats.min} seats must be filled.`);
        const waiting = filled.some((s) => s.controller === 'human' && (!s.ready || !tx.hasMember(s.id)));
        if (waiting) return notAllowed('Everyone must be connected and ready.');
        const problem = startMatch(tx, seeds, true);
        if (problem !== null) return problem;
        break;
      }
      case 'offer':
      case 'accept':
      case 'decline':
      case 'withdraw': {
        const problem = offerControl(tx, seat, ctl, seeds);
        if (problem !== null) return problem;
        break;
      }
      case 'leave-seat': {
        const current = tx.seat(seat);
        if (current === undefined) return notAllowed('You have no seat.');
        if (phase === 'playing') {
          const result = tx.apply({ kind: 'seat', seat, change: { type: 'left' } });
          if (!result.ok) tx.log('warn', 'seat_input_rejected', { seat, code: result.error.code });
        }
        const afterLeft = tx.seat(seat) ?? current;
        tx.setSeat({
          ...afterLeft,
          claim: null,
          ready: false,
          ...(phase === 'lobby' ? { controller: 'human' as const, aiLevel: null } : {}),
        });
        for (const c of tx.connsOf(seat)) tx.drop(c, 'left-room');
        if (phase === 'playing') {
          if (tx.record.policy.absent === 'ai') tx.setController(seat, 'ai');
          else tx.absentSince.set(seat, tx.now - tx.record.policy.graceMs);
        } else {
          tx.absentSince.delete(seat);
        }
        passHost(tx, seat);
        // A rematch may have waited only for this player; an offer of theirs goes with them.
        const problem = resolveOffer(tx, seeds);
        if (problem !== null) tx.log('warn', 'rematch_refused', { code: problem.code });
        break;
      }
      case 'resign': {
        if (phase !== 'playing') return wrongPhase('No match is in progress.');
        const result = tx.apply({ kind: 'resign', seat });
        if (!result.ok) return result.error;
        break;
      }
    }
    if (tx.record.revision === before) tx.bump();
    return null;
  };

  /** A heavy AI's answer (rule 7): applied only if that seat still waits on the same decision. */
  const aiChosen = (tx: Tx, command: Extract<RoomCommand, { type: 'ai-chosen' }>): void => {
    const { seat, decisionRevision } = command;
    if (tx.aiInFlight.get(seat) === decisionRevision) tx.aiInFlight.delete(seat);
    const match = tx.record.match;
    const current =
      match !== null &&
      tx.playing() &&
      tx.seat(seat)?.controller === 'ai' &&
      engine.pending(match.state).includes(seat) &&
      (match.decisionRevision[seat] ?? 0) === decisionRevision;
    if (!current) return void tx.log('info', 'ai_superseded', { seat });
    // A frozen room plays no AI; the same child stream asks again once a player returns.
    if (tx.frozen()) return void tx.log('info', 'ai_deferred', { seat });
    if ('failure' in command) {
      // The pool failing is not the AI breaking the rules: ask again, and give up only when this
      // decision itself keeps timing out or crashing its worker, or the AI's module threw.
      const prior = tx.aiRetry.get(seat);
      const same = prior?.decisionRevision === decisionRevision ? prior : undefined;
      const failures = (same?.failures ?? 0) + 1;
      const faults = (same?.faults ?? 0) + (command.failure === 'timeout' || command.failure === 'crashed' ? 1 : 0);
      if (command.failure !== 'failed' && faults < limits.aiAttempts) {
        const at = tx.now + Math.min(limits.aiRetryMaxMs, limits.aiRetryMs * 2 ** (failures - 1));
        tx.aiRetry.set(seat, { decisionRevision, at, failures, faults });
        tx.log('warn', 'ai_retry', { seat, failure: command.failure, failures, at });
        return;
      }
      tx.aiRetry.delete(seat);
      tx.autoInputs += 1;
      tx.log('warn', 'ai_failed', { seat, failure: command.failure, failures });
      tx.aiFallback(seat);
      return;
    }
    tx.aiRetry.delete(seat);
    tx.autoInputs += 1;
    const parsed = engine.schemas.command['~standard'].validate(command.command);
    if (parsed instanceof Promise || parsed.issues !== undefined) {
      tx.log('error', 'ai_illegal_move', { seat, code: RejectionCode.badCommand });
      tx.aiFallback(seat);
      return;
    }
    tx.applyAi(seat, parsed.value);
  };

  const resume = (tx: Tx): void => {
    for (const seat of tx.record.seats) if (seat.claim !== null) tx.absentSince.set(seat.id, tx.now);
    // A table that was live when the server stopped lost the downtime: every clock gets at least
    // `resumeGraceMs`, and the pause begins now. A table already paused keeps its clocks as they stood.
    if (tx.record.match?.pausedAt === undefined) tx.extendClocks();
    for (const job of tx.record.match?.jobs ?? []) {
      const spec = engine.jobs?.[job.request.kind];
      tx.jobStartedAt.set(job.request.id, tx.now);
      tx.jobs.push({
        type: 'start-job',
        jobId: job.request.id,
        kind: job.request.kind,
        payload: job.request.payload,
        timeoutMs: spec?.timeoutMs ?? 0,
      });
      tx.log('info', 'job_started', { kind: job.request.kind, job: job.request.id, resumed: true });
    }
  };

  const close = (tx: Tx, reason: 'expired' | 'unload'): void => {
    tx.closed = true;
    if (reason === 'unload') return;
    tx.set({ ...tx.record, phase: 'closed', revision: tx.record.revision + 1 });
    for (const conn of [...tx.members.keys()]) {
      tx.send([conn], { v: PROTOCOL_VERSION, t: 'closing', reason: 'expired', retryAfterMs: null });
      tx.drop(conn, 'room-closed');
    }
    tx.log('info', 'room_expired', {});
  };

  const closedStep = (room: LiveRoom, command: RoomCommand): Step => {
    if (command.type !== 'join' && command.type !== 'act' && command.type !== 'control' && command.type !== 'resync')
      return { room, effects: [] };
    return {
      room,
      effects: [
        {
          type: 'send',
          to: [command.conn],
          message: { v: PROTOCOL_VERSION, t: 'closing', reason: 'closed', retryAfterMs: null },
        },
        { type: 'drop', conn: command.conn, reason: 'room-closed' },
      ],
    };
  };

  const step = (room: LiveRoom, command: RoomCommand, now: number): Step => {
    if (room.closed || room.record.phase === 'closed') return closedStep(room, command);
    const tx = new Tx(room, now);
    try {
      // The clock wins ties: whatever is due at `now` applies before the command (rule 4).
      if (command.type !== 'resume' && command.type !== 'close') tx.settle();
      switch (command.type) {
        case 'join':
          join(tx, command);
          break;
        case 'leave':
          leave(tx, command.conn);
          break;
        case 'act':
          act(tx, command);
          break;
        case 'control':
          control(tx, command);
          break;
        case 'resync':
          if (tx.members.has(command.conn)) tx.snapshotTo.add(command.conn);
          break;
        case 'timer-fired':
          break;
        case 'ai-chosen':
          aiChosen(tx, command);
          break;
        case 'job-completed':
          if (tx.record.match?.jobs.some((j) => j.request.id === command.jobId) !== true) {
            tx.log('info', 'job_superseded', { job: command.jobId });
          } else {
            tx.completeJob(command.jobId, command.outcome);
          }
          break;
        case 'resume':
          resume(tx);
          break;
        case 'close':
          close(tx, command.reason);
          break;
      }
      if (!tx.closed) {
        resolveOffer(tx, null);
        tx.settle();
        tx.recomputeClocks();
        resolveOffer(tx, null);
        tx.syncPause();
        // An offer that changed on its own (a moved deadline, a proposer gone) is news to every client.
        if (
          tx.record.revision === room.record.revision &&
          canonicalJson(publicOffer(tx.record)) !== canonicalJson(publicOffer(room.record))
        )
          tx.bump();
      }
      return tx.finish();
    } catch (error) {
      // An engine that throws outside `apply` (pending, viewFor, ai…) is a bug: keep the old state.
      const effects: RoomEffect[] = [
        {
          type: 'log',
          level: 'error',
          event: 'engine_error',
          fields: { room: room.record.code, command: command.type, error: String(error) },
        },
      ];
      if (command.type === 'act' || command.type === 'control') {
        effects.unshift({
          type: 'send',
          to: [command.conn],
          message: {
            v: PROTOCOL_VERSION,
            t: 'receipt',
            id: command.id,
            result: {
              status: 'rejected',
              code: RejectionCode.engineError,
              message: 'The game hit an error and ignored that move.',
              revision: room.record.revision,
            },
          },
        });
      }
      return { room, effects };
    }
  };

  return { engine, pin, create, load, step };
};
