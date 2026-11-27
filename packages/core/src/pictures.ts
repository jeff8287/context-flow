// The pictures that went with a request are in the clients' own records, and only there: a snapshot says how many
// came with a request (Item.images), never what they are. They are read from the record when one is asked for.
//   Claude Code: the request's own record holds them (image blocks, in base64).
//   Codex: what was sent to the model in that turn holds them (input_image, as data: addresses). The request's own
//          item names a picture by where its file lay, which may be gone by now; a picture pasted in the app is in
//          the item itself.
// A record can be very long and a picture is asked for by itself. So where the lines with pictures lie is found
// once (and again only for what was added since), and a picture is then read from its own line.
import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import type { Client } from "./model.ts";
import { uploadedFile } from "./store.ts";

export interface Picture { type: string; bytes: Buffer }

/** The kinds a picture may be of to be handed to a page as a picture. */
export const SHOWN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BY_END: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A line of a record: where it begins and how long it is. */
interface Spot { at: number; length: number }
/** What was found in a record so far. sent: the lines of what went to the model, by turn. said: the lines of the
 *  requests themselves, by turn (Codex) or by the id of the record (Claude Code). size: how far the record was read. */
interface Found { size: number; sent: Map<string, Spot[]>; said: Map<string, Spot[]> }
const found = new Map<string, Found>();
const looking = new Map<string, Promise<Found | null>>();

/** Forget what was found (for the tests, which write one record after another at the same place). */
export function forgetPictures(): void {
  found.clear();
}

const has = (line: Buffer, text: string) => line.includes(text);
const put = (into: Map<string, Spot[]>, key: unknown, spot: Spot) => {
  if (typeof key !== "string" || !key) return;
  const list = into.get(key) ?? [];
  list.push(spot);
  into.set(key, list);
};

/** Note a line if it holds pictures of a request. Most lines are told apart without being read as JSON. */
function note(client: Client, line: Buffer, spot: Spot, known: Found): void {
  try {
    if (client === "claude") {
      // a picture a tool gave back is in a record of the same kind, inside the tool's result: that is not a request
      if (!has(line, '"type":"image"') || has(line, '"tool_result"')) return;
      const record = JSON.parse(line.toString("utf8"));
      if (record?.type === "user" && Array.isArray(record.message?.content) && record.message.content.some((block: any) => block?.type === "image")) put(known.said, record.uuid, spot);
      return;
    }
    if (has(line, '"input_image"') && has(line, '"response_item"')) {
      const payload = JSON.parse(line.toString("utf8"))?.payload;
      if (payload?.type === "message" && payload.role === "user") put(known.sent, payload.internal_chat_message_metadata_passthrough?.turn_id, spot);
    } else if (has(line, '"UserMessage"') && has(line, '"item_completed"') && (has(line, '"local_image"') || has(line, '"image_url"'))) {
      const payload = JSON.parse(line.toString("utf8"))?.payload;
      if (payload?.type === "item_completed" && payload.item?.type === "UserMessage") put(known.said, payload.turn_id, spot);
    }
  } catch { /* a line that is not whole */ }
}

/** Find where the lines with pictures lie in a record: from where it was read to last time, to its end. */
async function look(client: Client, path: string): Promise<Found | null> {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  let known = found.get(path);
  if (!known || known.size > size) known = { size: 0, sent: new Map(), said: new Map() }; // a record that is shorter than it was is another record
  if (known.size === size) return known;
  const file = await open(path, "r");
  try {
    const room = Buffer.allocUnsafe(1 << 22);
    let at = known.size; // where the next stretch is read from
    let lineAt = known.size; // where the line being gathered begins
    let parts: Buffer[] = [];
    for (;;) {
      const { bytesRead } = await file.read(room, 0, room.length, at);
      if (!bytesRead) break;
      let from = 0;
      for (;;) {
        const end = room.indexOf(10, from);
        if (end === -1 || end >= bytesRead) break;
        const piece = room.subarray(from, end);
        const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
        note(client, line, { at: lineAt, length: line.length }, known);
        parts = [];
        lineAt = at + end + 1;
        from = end + 1;
      }
      if (from < bytesRead) parts.push(Buffer.from(room.subarray(from, bytesRead))); // a copy: the room is read into again
      at += bytesRead;
    }
    known.size = lineAt; // a line that is still being written is read the next time
  } finally {
    await file.close();
  }
  found.set(path, known);
  return known;
}

async function lineAt(path: string, spot: Spot): Promise<any> {
  const file = await open(path, "r");
  try {
    const room = Buffer.allocUnsafe(spot.length);
    await file.read(room, 0, spot.length, spot.at);
    return JSON.parse(room.toString("utf8"));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

/** A picture given as a data: address. */
function fromAddress(address: unknown): Picture | null {
  const parts = typeof address === "string" ? /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(address.slice(0, 80)) : null;
  return parts ? { type: parts[1].toLowerCase(), bytes: Buffer.from((address as string).slice(parts[0].length), "base64") } : null;
}

/** The pictures that went with what was said in a turn, in the order they were given. turn: for Codex the turn (the
 *  pictures of all its requests, one after another); for Claude Code the id of the request's own record. Empty when
 *  the record holds none, or cannot be read. */
export async function picturesOf(client: Client, path: string, turn: string): Promise<Picture[]> {
  // one reading of a record at a time: a second asker waits for the first to finish, and then finds it read
  const before = looking.get(path);
  if (before) await before.catch(() => null);
  const reading = look(client, path);
  looking.set(path, reading);
  let known: Found | null;
  try {
    known = await reading;
  } catch {
    known = null;
  } finally {
    if (looking.get(path) === reading) looking.delete(path);
  }
  if (!known) return [];
  const out: Picture[] = [];
  if (client === "claude") {
    for (const spot of (known.said.get(turn) ?? []).slice(0, 1)) {
      for (const block of (await lineAt(path, spot))?.message?.content ?? []) {
        if (block?.type !== "image" || block.source?.type !== "base64" || typeof block.source.data !== "string") continue;
        out.push({ type: String(block.source.media_type ?? "").toLowerCase(), bytes: Buffer.from(block.source.data, "base64") });
      }
    }
    return out;
  }
  for (const spot of known.sent.get(turn) ?? []) {
    for (const part of (await lineAt(path, spot))?.payload?.content ?? []) {
      const picture = part?.type === "input_image" ? fromAddress(part.image_url) : null;
      if (picture) out.push(picture);
    }
  }
  if (out.length) return out;
  // Nothing of what went to the model is there (a record of another make): what the request itself says, then. A
  // picture named by its file is read only if it is one this tool kept, and is still there.
  for (const spot of known.said.get(turn) ?? []) {
    for (const part of (await lineAt(path, spot))?.payload?.item?.content ?? []) {
      if (part?.type === "image") {
        const picture = fromAddress(part.image_url);
        if (picture) out.push(picture);
      } else if (part?.type === "local_image" && typeof part.path === "string") {
        const kept = uploadedFile(part.path);
        const type = BY_END[part.path.split(".").pop()?.toLowerCase() ?? ""];
        if (kept && type && existsSync(kept)) out.push({ type, bytes: readFileSync(kept) });
      }
    }
  }
  return out;
}
