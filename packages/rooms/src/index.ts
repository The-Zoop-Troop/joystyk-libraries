// @joystyk/rooms: the pure room core (room-server.md section 3). It reads no clock,
// randomness, storage or network; adapters such as @joystyk/rooms/node supply them.
export { createRoomCore } from './core.ts';
export { canonicalJson, fingerprint, hashText } from './canonical.ts';
export { admitName, nameReplacedMessage, type AdmittedName, type NameSeed } from './names.ts';
export {
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_SPECTATORS,
  DEFAULT_RETAIN_MS,
  MAX_ROOM_AGE_MS,
  policyFromManifest,
  policyProblem,
} from './policy.ts';
export { decodeRecord, RECORD_FORMAT, RoomRecordSchema, type DecodeError } from './record.ts';
export {
  DEFAULT_LIMITS,
  type ActionId,
  type AiFailure,
  type AiRetry,
  type ConnId,
  type CoreLimits,
  type CreateParams,
  type DecisionClock,
  type DropReason,
  type GamePin,
  type LiveRoom,
  type LoggedInput,
  type MatchRecord,
  type MatchSeeds,
  type Member,
  type OfferKind,
  type OfferRecord,
  type PendingJob,
  type Receipt,
  type RoomCode,
  type RoomCommand,
  type RoomControl,
  type RoomCore,
  type RoomCoreOptions,
  type RoomEffect,
  type RoomError,
  type RoomOffer,
  type RoomPhase,
  type RoomPolicy,
  type RoomRecord,
  type SeatClaim,
  type SeatRecord,
  type Step,
} from './types.ts';
