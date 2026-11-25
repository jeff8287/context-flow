// What ties sessions together, from what the records say outright, and the pieces this tool itself sent.
// (Pastes found by matching text come later.)
import type { FarLink, Item, Link, LinkKind, Origin, Overlap, Project, Session, Transfer } from "./model.ts";

/** What says, in the text a session was given, which piece this is. */
export const PIECE_MARK = '<context-piece id="';
import { scratch, under } from "./util.ts";

const attr = (text: string) => text.replace(/["<>\n]/g, " ").trim();

/** The message that goes to the receiving session: what the person typed, then each piece between marks that say
 *  which piece it is and where it came from. The mark is how the piece is found again in the session's record. */
export function withPieces(text: string, pieces: { id: string; from: string; kind: string; text: string }[]): string {
  return withBlocks(text, pieces.map(pieceBlock));
}

const NOTE = "(아래는 다른 세션에서 골라 온 맥락입니다.)";

/** The same, for pieces already between their marks (the ones that were set to wait). */
export function withBlocks(text: string, blocks: string[]): string {
  if (!blocks.length) return text;
  return (text ? text + "\n\n" : "") + NOTE + "\n\n" + blocks.join("\n\n");
}

/** What the person typed in a message, without the pieces that went along with it: a session is named after that, not after a piece. */
export function withoutPieces(text: string): string {
  const at = text.indexOf(PIECE_MARK);
  if (at === -1) return text;
  const before = text.slice(0, at).trimEnd();
  return before.endsWith(NOTE) ? before.slice(0, -NOTE.length).trimEnd() : before;
}

/** One piece between its marks. */
export function pieceBlock(piece: { id: string; from: string; kind: string; text: string }): string {
  return PIECE_MARK + piece.id + '" from="' + attr(piece.from) + '" kind="' + attr(piece.kind) + '">\n' + piece.text + "\n</context-piece>";
}

/** A link for each piece that was sent and can be found in the receiving session's record. */
export function transferLinks(transfers: Transfer[], items: Item[]): Link[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const prompts = new Map<string, Item[]>();
  for (const item of items) if (item.kind === "prompt") prompts.set(item.sessionId, [...(prompts.get(item.sessionId) ?? []), item]);
  const links: Link[] = [];
  for (const transfer of transfers) {
    // The mark is in what was typed (sent from this screen) or in what a hook put with it (set to wait, then taken).
    const mark = PIECE_MARK + transfer.id + '"';
    const got = (prompts.get(transfer.to.sessionId) ?? []).find((item) => item.text.includes(mark) || item.added?.includes(mark));
    if (!got) continue; // the message never reached the session's record: nothing to draw
    links.push({
      id: "transfer:" + transfer.id,
      grade: "recorded",
      kind: "transfer",
      from: { ...transfer.from, at: byId.get(transfer.from.itemId)?.at ?? transfer.at },
      to: { sessionId: transfer.to.sessionId, at: got.at, itemId: got.id },
      chars: transfer.text.length,
      excerpt: transfer.text.slice(0, 600),
    });
  }
  return links;
}

/** The pieces that went between a session of this project and one of another: only those that say where their other
 *  end is (a piece whose other end is simply gone is nothing to show). One that came in counts once this project's
 *  record holds its mark; one that went out is listed as sent. */
export function farLinks(transfers: Transfer[], sessions: Session[], items: Item[]): FarLink[] {
  const here = new Set(sessions.map((session) => session.id));
  const out: FarLink[] = [];
  for (const transfer of transfers) {
    const from = here.has(transfer.from.sessionId);
    const to = here.has(transfer.to.sessionId);
    if (from === to) continue;
    const told = { id: "far:" + transfer.id, chars: transfer.text.length, excerpt: transfer.text.slice(0, 600) };
    if (to && transfer.from.where) {
      const mark = PIECE_MARK + transfer.id + '"';
      const got = items.find((item) => item.kind === "prompt" && item.sessionId === transfer.to.sessionId && (item.text.includes(mark) || item.added?.includes(mark)));
      if (!got) continue;
      const { where, ...cut } = transfer.from;
      out.push({ ...told, dir: "in", sessionId: got.sessionId, itemId: got.id, at: got.at, other: { ...where, ...cut } });
    } else if (from && transfer.to.where) {
      out.push({ ...told, dir: "out", sessionId: transfer.from.sessionId, itemId: transfer.from.itemId, start: transfer.from.start, end: transfer.from.end, at: transfer.at, other: { ...transfer.to.where, sessionId: transfer.to.sessionId } });
    }
  }
  return out;
}

const KIND: Record<Origin, LinkKind | null> = { user: null, fork: "fork", spawned: "spawn", subagent: "subagent", side: "side", imported: "import" };

/** A link from each session's recorded parent to it, at the moment the child began. */
export function recordedLinks(sessions: Session[]): { links: Link[]; outside: number } {
  const known = new Set(sessions.map((session) => session.id));
  const links: Link[] = [];
  let outside = 0;
  for (const session of sessions) {
    if (!session.parentId) continue;
    if (!known.has(session.parentId)) {
      outside += 1;
      continue;
    }
    const kind = KIND[session.origin] ?? "spawn";
    links.push({
      id: kind + ":" + session.parentId + ">" + session.id,
      grade: "recorded",
      kind,
      from: { sessionId: session.parentId, at: session.startedAt },
      to: { sessionId: session.id, at: session.startedAt },
    });
  }
  return { links, outside };
}

/** Files that more than one session changed. A session's changes to a file within half an hour count as one touch. */
export function overlaps(items: Item[], project: Project): Overlap[] {
  const byPath = new Map<string, Item[]>();
  for (const item of items) {
    if (item.kind !== "change" || !item.path || scratch(item.path)) continue;
    const list = byPath.get(item.path) ?? [];
    list.push(item);
    byPath.set(item.path, list);
  }
  const out: Overlap[] = [];
  for (const [path, list] of byPath) {
    if (new Set(list.map((item) => item.sessionId)).size < 2) continue;
    list.sort((a, b) => a.at - b.at);
    const touches: Overlap["touches"] = [];
    const lastOf = new Map<string, number>();
    for (const item of list) {
      const before = lastOf.get(item.sessionId);
      if (before === undefined || item.at - before > 30 * 60 * 1000) touches.push({ sessionId: item.sessionId, at: item.at, itemId: item.id });
      lastOf.set(item.sessionId, item.at);
    }
    const root = project.roots.find((candidate) => under(path, candidate));
    out.push({ path: root ? path.slice(root.length + 1) : path, touches });
  }
  out.sort((a, b) => new Set(b.touches.map((touch) => touch.sessionId)).size - new Set(a.touches.map((touch) => touch.sessionId)).size || a.path.localeCompare(b.path));
  return out;
}
