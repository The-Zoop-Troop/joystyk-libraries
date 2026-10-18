import * as z from 'zod/mini';
// Rematch and end-match by offer and accept (section 3.10, D-61): any seated player offers,
// the others accept or decline, the proposer may withdraw, and computer seats accept on their
// own. A rematch starts once every seated player has accepted; an offer to end a match ends it
// with no result once every other connected player accepts, or after a minute with nobody
// declining. Time is the harness's fake clock.
import { describe, expect, it } from 'vitest';
import { Harness, coreFor, effectsOf, hashOf, nim, pass, policy, type NimState } from './__tests__/fixtures.ts';
import { RejectionCode, ServerMessageSchema } from './protocol/index.ts';
import type { RoomPolicy } from './types.ts';

const startedNim = (overrides: Partial<RoomPolicy> = {}) => {
  const h = Harness.create(coreFor(nim, 'nim'), policy({ absent: 'wait', ...overrides }), { heap: 10 });
  h.join('c-ana', 'Ana', hashOf('ana'));
  h.join('c-ben', 'Ben');
  h.control('c-ana', { kind: 'ready', ready: true });
  h.control('c-ben', { kind: 'ready', ready: true });
  h.control('c-ana', { kind: 'start' });
  return h;
};

/** A two-player Nim room whose first match is over. */
const finishedNim = () => {
  const h = startedNim();
  h.control('c-ben', { kind: 'resign' });
  expect(h.record.phase).toBe('finished');
  return h;
};

const offerId = (h: Harness): number => {
  const offer = h.record.offer;
  if (offer == null) throw new Error('no offer');
  return offer.id;
};

describe('a rematch by offer and accept', () => {
  it('persists a validated engine-derived config and isolates malformed or throwing hooks', () => {
    for (const broken of [false, 'invalid', 'throws'] as const) {
      const engine = {
        ...nim,
        schemas: { ...nim.schemas, config: z.object({ heap: z.int().check(z.minimum(1)) }) },
        rematch: ((config, finished) => {
          if (broken === 'throws') throw Error('bad hook');
          return broken === 'invalid' ? { heap: -1 } : { ...config, heap: finished.heap + 3 };
        }) as NonNullable<typeof nim.rematch>,
      };
      const h = Harness.create(coreFor(engine, 'nim'), policy({ absent: 'wait' }), { heap: 10 });
      h.join('c-ana', 'Ana', hashOf('ana'));
      h.join('c-ben', 'Ben');
      h.control('c-ana', { kind: 'ready', ready: true });
      h.control('c-ben', { kind: 'ready', ready: true });
      h.control('c-ana', { kind: 'start' });
      h.control('c-ben', { kind: 'resign' });
      const previous = h.record.match;
      h.control('c-ben', { kind: 'offer', offer: 'rematch' });
      h.control('c-ana', { kind: 'accept', offer: offerId(h) });
      if (broken) {
        expect(h.record.match).toEqual(previous);
        expect(h.lastReceipt('c-ana')).toMatchObject({ status: 'rejected' });
        expect(h.record.config).toEqual({ heap: 10 });
      } else {
        expect(h.record.config).toEqual({ heap: 13 });
        expect(h.record.match?.config).toEqual({ heap: 13 });
        expect(h.record.match?.state).toMatchObject({ heap: 13 });
        expect(h.messages('c-ben', 'snapshot').at(-1)?.view).toMatchObject({ heap: 13 });
      }
    }
  });

  it('lets any player offer, shows the offer to everyone, and starts once the others accept', () => {
    const h = finishedNim();
    const revision = h.record.revision;
    // Ben is not the host; he may offer all the same.
    h.control('c-ben', { kind: 'offer', offer: 'rematch' });
    expect(h.lastReceipt('c-ben')).toEqual({ status: 'accepted', revision: revision + 1 });
    expect(h.record.match?.number).toBe(1);
    const shown = h.messages('c-ana', 'update').at(-1)!;
    expect(shown.offer).toEqual({
      id: revision + 1,
      kind: 'rematch',
      by: 1,
      status: 'open',
      accepted: [1],
      declinedBy: null,
      endsAt: null,
    });
    expect(ServerMessageSchema.safeParse(shown).success).toBe(true);
    h.control('c-ana', { kind: 'accept', offer: offerId(h) });
    expect(h.record.match?.number).toBe(2);
    expect(h.record.phase).toBe('playing');
    expect(h.record.offer).toBeNull();
    expect(h.messages('c-ben', 'snapshot').at(-1)?.offer).toBeNull();
  });

  it('treats an offer of what is already on the table as an accept', () => {
    const h = finishedNim();
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    h.control('c-ben', { kind: 'offer', offer: 'rematch' });
    expect(h.record.match?.number).toBe(2);
  });

  it('closes on a decline, which every player sees, and a new offer may follow', () => {
    const h = finishedNim();
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    const first = offerId(h);
    h.control('c-ana', { kind: 'decline', offer: first });
    expect(h.lastReceipt('c-ana')).toMatchObject({ status: 'rejected', code: RejectionCode.notAllowed });
    h.control('c-ben', { kind: 'decline', offer: first });
    expect(h.record.offer).toMatchObject({ status: 'declined', declinedBy: 1 });
    expect(h.messages('c-ana', 'update').at(-1)?.offer).toMatchObject({ status: 'declined', declinedBy: 1 });
    // A late accept of the declined offer changes nothing.
    h.control('c-ben', { kind: 'accept', offer: first });
    expect(h.lastReceipt('c-ben')).toMatchObject({ status: 'rejected', code: RejectionCode.notAllowed });
    expect(h.record.match?.number).toBe(1);
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    expect(offerId(h)).not.toBe(first);
    h.control('c-ben', { kind: 'accept', offer: offerId(h) });
    expect(h.record.match?.number).toBe(2);
  });

  it('lets only the proposer withdraw, and an accept sent after the withdrawal is refused', () => {
    const h = finishedNim();
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    const id = offerId(h);
    h.control('c-ben', { kind: 'withdraw', offer: id });
    expect(h.lastReceipt('c-ben')).toMatchObject({ status: 'rejected', code: RejectionCode.notAllowed });
    h.control('c-ana', { kind: 'withdraw', offer: id });
    expect(h.record.offer).toMatchObject({ status: 'withdrawn', declinedBy: null });
    const record = h.record;
    h.control('c-ben', { kind: 'accept', offer: id });
    expect(h.lastReceipt('c-ben')).toMatchObject({
      status: 'rejected',
      code: RejectionCode.notAllowed,
      message: 'That offer is no longer open.',
    });
    expect(h.record).toBe(record);
  });

  it('answers a resent accept with its first receipt, and refuses spectators and offers out of phase', () => {
    const h = startedNim();
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    expect(h.lastReceipt('c-ana')).toMatchObject({ status: 'rejected', code: RejectionCode.wrongPhase });
    h.control('c-ben', { kind: 'resign' });
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    expect(h.lastReceipt('c-ana')).toMatchObject({ status: 'rejected', code: RejectionCode.wrongPhase });
    h.join('c-spec', 'Cy', null, true);
    h.control('c-spec', { kind: 'offer', offer: 'rematch' });
    expect(h.lastReceipt('c-spec')).toMatchObject({ status: 'rejected', code: RejectionCode.spectator });

    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    const [rev, id] = [h.record.revision, offerId(h)];
    h.control('c-ben', { kind: 'accept', offer: id }, rev, 'ben-accept-01');
    expect(h.record.match?.number).toBe(2);
    const receipt = h.lastReceipt('c-ben');
    expect(receipt).toEqual({ status: 'accepted', revision: rev + 1 });
    // The same accept again (a resend after a lost receipt) gets the first receipt and writes nothing.
    const writes = h.record.writes;
    h.control('c-ben', { kind: 'accept', offer: id }, rev, 'ben-accept-01');
    expect(h.lastReceipt('c-ben')).toEqual(receipt);
    expect(h.record.writes).toBe(writes);
    expect(h.record.match?.number).toBe(2);
  });

  it('counts computer seats as accepting: alone with the computer, an offer starts the rematch at once', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy({ start: 'immediate' }), { heap: 9 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.control('c-ana', { kind: 'resign' });
    expect(h.record.phase).toBe('finished');
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    expect(h.record.match?.number).toBe(2);
    expect(h.record.phase).toBe('playing');
  });

  it('lists computer seats among those who accepted, and waits for every player', () => {
    const h = Harness.create(coreFor(pass, 'pass'), policy({ seats: { min: 2, max: 3 }, absent: 'wait' }), {
      rounds: 3,
    });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Ben');
    h.control('c-ana', { kind: 'fill-with-ai', seat: 2 });
    h.control('c-ana', { kind: 'ready', ready: true });
    h.control('c-ben', { kind: 'ready', ready: true });
    h.control('c-ana', { kind: 'start' });
    h.control('c-ana', { kind: 'resign' });
    expect(h.record.phase).toBe('finished');
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    expect(h.record.match?.number).toBe(1);
    expect(h.messages('c-ben', 'update').at(-1)?.offer?.accepted).toEqual([0, 2]);
    // Ben is away: the rematch waits for him.
    h.step({ type: 'leave', conn: 'c-ben' });
    expect(h.record.match?.number).toBe(1);
    h.join('c-ben-2', 'Ben', hashOf('Ben'));
    h.control('c-ben-2', { kind: 'accept', offer: offerId(h) });
    expect(h.record.match?.number).toBe(2);
  });

  it('starts when the only player it waited for leaves the room, and lapses when the proposer leaves', () => {
    const h = Harness.create(coreFor(pass, 'pass'), policy({ seats: { min: 2, max: 3 }, absent: 'wait' }), {
      rounds: 3,
    });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Ben');
    h.join('c-cy', 'Cy');
    for (const conn of ['c-ana', 'c-ben', 'c-cy']) h.control(conn, { kind: 'ready', ready: true });
    h.control('c-ana', { kind: 'start' });
    h.control('c-ana', { kind: 'resign' });
    h.control('c-ben', { kind: 'offer', offer: 'rematch' });
    h.control('c-ben', { kind: 'leave-seat' });
    expect(h.record.offer).toMatchObject({ status: 'withdrawn', by: 1 });
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    h.control('c-cy', { kind: 'leave-seat' });
    expect(h.record.match?.number).toBe(2);
  });
});

describe('ending a stalled match by offer (D-61)', () => {
  it('ends the match with no result once every other connected player accepts', () => {
    const h = startedNim({ decisionMs: 10_000 });
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    expect(h.record.offer).toMatchObject({ kind: 'end', by: 0, status: 'open', endsAt: h.now + 60_000 });
    expect(h.record.phase).toBe('playing');
    h.control('c-ben', { kind: 'accept', offer: offerId(h) });
    expect(h.record.phase).toBe('finished');
    expect(h.record.offer).toBeNull();
    expect(h.record.match?.clocks).toEqual([]);
    expect(h.record.match?.outcome).toMatchObject({
      result: 'abandoned',
      placements: [],
      summary: 'The players agreed to end the match early.',
    });
    expect(h.messages('c-ben', 'update').at(-1)).toMatchObject({
      phase: 'finished',
      outcome: { result: 'abandoned' },
      offer: null,
    });
    // Nothing was played to end it: the engine's state is as it was.
    expect((h.state as NimState).heap).toBe(10);
  });

  it('ends after a minute with nobody declining, so a silent player can’t block it', () => {
    const h = startedNim();
    const t0 = h.now;
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    expect(effectsOf(h.last!, 'alarm').at(-1)?.at).toBe(t0 + 60_000);
    h.step({ type: 'timer-fired' }, t0 + 59_999);
    expect(h.record.phase).toBe('playing');
    // A move made meanwhile doesn't stop it.
    h.act((h.state as NimState).turn === 0 ? 'c-ana' : 'c-ben', { take: 1 });
    h.step({ type: 'timer-fired' }, t0 + 60_000);
    expect(h.record.phase).toBe('finished');
    expect(h.record.match?.outcome).toMatchObject({
      result: 'abandoned',
      summary: 'The match ended early: nobody declined the offer to end it.',
    });
  });

  it('keeps the match going after a decline', () => {
    const h = startedNim();
    const t0 = h.now;
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    h.control('c-ben', { kind: 'decline', offer: offerId(h) });
    expect(h.record.offer).toMatchObject({ status: 'declined', declinedBy: 1 });
    h.step({ type: 'timer-fired' }, t0 + 120_000);
    expect(h.record.phase).toBe('playing');
  });

  it('ends at once when no other player is connected', () => {
    const h = startedNim();
    h.step({ type: 'leave', conn: 'c-ben' });
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    expect(h.record.phase).toBe('finished');
    expect(h.record.match?.outcome?.result).toBe('abandoned');
  });

  it('holds its minute while the table is paused', () => {
    const h = startedNim();
    const t0 = h.now;
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    h.step({ type: 'leave', conn: 'c-ana' }, t0 + 10_000);
    h.step({ type: 'leave', conn: 'c-ben' }, t0 + 10_000);
    h.step({ type: 'timer-fired' }, t0 + 300_000);
    expect(h.record.phase).toBe('playing');
    h.now = t0 + 500_000;
    h.join('c-ben-2', 'Ben', hashOf('Ben'));
    // Fifty seconds were left; Ben sees the new deadline and may still decline.
    expect(h.record.offer?.endsAt).toBe(t0 + 550_000);
    expect(h.messages('c-ben-2', 'snapshot').at(-1)?.offer?.endsAt).toBe(t0 + 550_000);
    h.step({ type: 'timer-fired' }, t0 + 549_999);
    expect(h.record.phase).toBe('playing');
    h.step({ type: 'timer-fired' }, t0 + 550_000);
    expect(h.record.phase).toBe('finished');
  });

  it('closes an open offer when the match ends on its own', () => {
    const h = startedNim();
    h.control('c-ana', { kind: 'offer', offer: 'end' });
    h.control('c-ben', { kind: 'resign' });
    expect(h.record.phase).toBe('finished');
    expect(h.record.offer).toBeNull();
    expect(h.record.match?.outcome?.result).toBe('won');
  });
});
