/**
 * What the co-editing protocol needs to know about a kind of document. The
 * room and the client only order, transform and replay ops; everything about
 * what an op does lives behind this adapter (the spreadsheet engine for
 * WeldSheets, the document model for WeldDocs).
 *
 * `State` is the live, mutable document an op is applied to. `Snapshot` is
 * its plain-JSON form, sent to clients that load or resync. `Presence` is
 * where a person is in the document, broadcast to everyone else.
 */
export interface OtAdapter<State, Op, Snapshot, Presence> {
  /** A fresh editable state built from a snapshot. */
  load(snapshot: Snapshot): State;
  snapshot(state: State): Snapshot;
  /** Applies one op to `state` in place and returns its inverse. May throw on an op `validate` let through (a bug). */
  apply(state: State, op: Op): Op;
  /**
   * `a` rewritten to apply after `b`, where both were made against the same
   * state. `aWins` breaks ties: the room passes true for the op it is
   * committing now, false for the one it committed earlier.
   */
  transform(a: Op, b: Op, aWins: boolean): Op;
  /** The canonical form of an op (flattened batches, empty parts dropped). */
  normalize(op: Op): Op;
  /** One atomic op made of `ops`, in order. */
  batch(ops: Op[]): Op;
  /** The ops of a batch in order; any other op is `[op]`. The room applies them one by one so it can undo a batch that fails halfway. */
  unbatch(op: Op): Op[];
  /** Shape check of untrusted JSON: every field `normalize`, `transform` and `apply` read has the type they expect. */
  isWellFormedOp(v: unknown): v is Op;
  /** Checks a well-formed op against the state (the things it refers to exist, sizes in range). Null when it may be applied, else why not. */
  validate(state: State, op: Op): string | null;
  /** Shape check of an untrusted presence. */
  isPresence(v: unknown): v is Presence;
}
