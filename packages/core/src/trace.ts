// Following a piece: back to where its text first appeared, and onward to the sessions it went to. Only what moved
// is followed: pieces that were sent, pastes that were found, and forks (a fork takes everything said so far with
// it). Files two sessions both changed are not followed: they do not say context moved.
// A session passes a piece on when something that left it afterwards holds the same text; that is checked by the
// letters, the way pastes are found.
import type { FarLink, Item, Link, Piece, Session, TraceStep } from "./model.ts";
import { flat, K } from "./paste.ts";

const DEEP = 6;

/** Whether two texts hold the same run of letters: a window of the one found in the other. */
function shares(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < K) return short.length >= 12 && long.includes(short);
  for (let at = 0; at + K <= short.length; at += 1) {
    if (at && short.charCodeAt(at - 1) !== 32) continue;
    if (long.includes(short.substr(at, K))) return true;
  }
  return false;
}

/** far: the pieces that went between these sessions and sessions of projects that are not on the map. The way is
 *  followed as far as such a piece, and the step says what its other end is. */
/** left: what the sessions said and then left behind (a request of theirs was said again, or their talk was taken
 *  back). A piece cut from there went where it was sent and nowhere else: its session has it no more, so nothing the
 *  session said later, and no fork of it, is taken to carry it on. */
export function tracePiece(piece: Piece, links: Link[], bodies: Map<string, Item>, sessions: Session[], far: FarLink[] = [], left: Map<string, Item> = new Map()): TraceStep[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const topOf = (id: string): string => {
    let session = byId.get(id);
    for (let guard = 0; session && (session.origin === "subagent" || session.origin === "side") && session.parentId && guard < 8; guard += 1) session = byId.get(session.parentId) ?? session;
    return session?.id ?? id;
  };
  const moved = links.filter((link) => link.kind === "transfer" || link.kind === "paste");
  const whole = links.filter((link) => link.kind === "fork" || link.kind === "import");
  const cut = (itemId: string | undefined, start?: number, end?: number) => {
    const item = itemId ? bodies.get(itemId) ?? left.get(itemId) : undefined;
    if (!item) return "";
    return flat(start !== undefined && end !== undefined ? item.text.slice(start, end) : item.text, item.kind).text;
  };
  /** The text a link carried, flattened. */
  const carried = (link: Link) => cut(link.from.itemId, link.from.start, link.from.end);
  /** A piece whose other end is off the map, as a link, and the text it carried (the beginning of it is all that is kept). */
  const beyond = (one: FarLink): Link => {
    const here = { sessionId: one.sessionId, at: one.at, itemId: one.itemId, start: one.start, end: one.end };
    const there = { sessionId: one.other.sessionId, at: one.at, itemId: one.other.itemId, start: one.other.start, end: one.other.end };
    return { id: one.id, grade: "recorded", kind: "transfer", from: one.dir === "in" ? there : here, to: one.dir === "in" ? here : there, chars: one.chars, excerpt: one.excerpt };
  };
  const place = (one: FarLink) => ({ project: one.other.project, projectName: one.other.projectName, title: one.other.title, client: one.other.client, sessionId: one.other.sessionId });
  const brought = (one: FarLink) => flat(one.excerpt, "answer").text;
  const steps: TraceStep[] = [];
  const start = bodies.get(piece.itemId) ?? left.get(piece.itemId);
  if (!start) return steps;
  const text = cut(piece.itemId, piece.start, piece.end);

  // back: something that came into this session before the piece was said, holding the same text
  const seenBack = new Set<string>();
  const back = (session: string, at: number, held: string, depth: number) => {
    if (depth > DEEP) return;
    for (const link of moved) {
      if (seenBack.has(link.id) || topOf(link.to.sessionId) !== session || link.to.at > at + 1000) continue;
      if (!shares(held, carried(link))) continue;
      seenBack.add(link.id);
      steps.push({ dir: "back", depth, link });
      back(topOf(link.from.sessionId), link.from.at, carried(link), depth + 1);
    }
    for (const one of far) {
      if (one.dir !== "in" || seenBack.has(one.id) || topOf(one.sessionId) !== session || one.at > at + 1000) continue;
      // the prompt being followed is the very one the piece came with (a hook may have put the piece beside it, not in it); or the text is the same
      if (!(depth === 1 && one.itemId === piece.itemId) && !shares(held, brought(one))) continue;
      seenBack.add(one.id);
      steps.push({ dir: "back", depth, link: beyond(one), far: place(one) });
    }
  };
  back(topOf(piece.sessionId), start.at, text, 1);

  // onward: what left this session, from the piece itself or from something said later that holds its text
  const seenOn = new Set<string>();
  // only: nothing but the piece itself is followed out of its session (it was left behind there)
  const onward = (session: string, at: number, held: string, depth: number, own?: Piece, only = false) => {
    if (depth > DEEP) return;
    for (const link of moved) {
      if (seenOn.has(link.id) || topOf(link.from.sessionId) !== session) continue;
      const same = own && link.from.itemId === own.itemId && (link.from.start ?? 0) < own.end && (link.from.end ?? Infinity) > own.start;
      if (!same && (only || link.from.at < at || link.from.itemId === own?.itemId || !shares(held, carried(link)))) continue;
      seenOn.add(link.id);
      steps.push({ dir: "onward", depth, link });
      // the piece now lies in the prompt that took it: anything cut from that prompt, or said after it, may carry it on
      const got = link.to.itemId ? bodies.get(link.to.itemId) : undefined;
      onward(topOf(link.to.sessionId), link.to.at, carried(link), depth + 1, got ? { sessionId: got.sessionId, itemId: got.id, start: 0, end: got.text.length } : undefined);
    }
    for (const one of far) {
      if (one.dir !== "out" || seenOn.has(one.id) || topOf(one.sessionId) !== session) continue;
      const same = own && one.itemId === own.itemId && (one.start ?? 0) < own.end && (one.end ?? Infinity) > own.start;
      if (!same && (only || one.at < at || one.itemId === own?.itemId || !shares(held, brought(one)))) continue;
      seenOn.add(one.id);
      steps.push({ dir: "onward", depth, link: beyond(one), far: place(one) });
    }
    if (only) return;
    for (const link of whole) {
      if (seenOn.has(link.id) || topOf(link.from.sessionId) !== session) continue;
      // A fork has what its parent had said before the request it was made before, however long after that it was
      // made (a request said again in other words is forked before that request). One that is not known to have
      // been made before a request has what was said until it began.
      const until = link.kind === "fork" && link.from.itemId ? bodies.get(link.from.itemId)?.at : undefined;
      if (until !== undefined ? at >= until : link.to.at < at) continue;
      seenOn.add(link.id);
      steps.push({ dir: "onward", depth, link });
      onward(topOf(link.to.sessionId), link.to.at, held, depth + 1);
    }
  };
  onward(topOf(piece.sessionId), start.at, text, 1, piece, left.has(piece.itemId));
  return steps;
}
