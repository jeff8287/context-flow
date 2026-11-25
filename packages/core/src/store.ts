// What this tool itself keeps. Everything else is read from the clients' own records.
//   transfers.jsonl                 the pieces that were sent from one session to another: one line a piece, only ever added to
//   pending/<session id>/<id>.json  the pieces set to go with the next thing said to that session; the hook of the
//                                   session's client (plugin/context-flow/hooks/along.mjs) takes them from here
//   node                            the node this tool runs on, for the hook to run on too
//   basket.json                     the pieces picked on the screen and kept: one basket, whatever project or
//                                   browser the screen is opened in
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Piece, Place, Transfer } from "./model.ts";
import { HOME } from "./home.ts";

const home = () => process.env.CONTEXT_FLOW_HOME ?? join(HOME, ".context-flow");
const file = () => join(home(), "transfers.jsonl");
const pending = () => join(home(), "pending");

/** The pieces kept on the screen, as the screen gave them. */
export function readBasket(): unknown[] {
  try {
    const kept = JSON.parse(readFileSync(join(home(), "basket.json"), "utf8"));
    return Array.isArray(kept) ? kept : [];
  } catch {
    return []; // nothing was ever kept
  }
}

export function writeBasket(pieces: unknown[]): void {
  mkdirSync(home(), { recursive: true });
  const part = join(home(), ".basket.part"); // written whole or not at all
  writeFileSync(part, JSON.stringify(pieces));
  renameSync(part, join(home(), "basket.json"));
}

export function readTransfers(): Transfer[] {
  if (!existsSync(file())) return [];
  const out: Transfer[] = [];
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.id && row.from?.itemId && row.to?.sessionId) out.push(row);
    } catch { /* a line cut short by a crash: the rest still counts */ }
  }
  return out;
}

export function appendTransfers(rows: Transfer[]): void {
  if (!rows.length) return;
  mkdirSync(home(), { recursive: true });
  appendFileSync(file(), rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

/** A piece waiting for its session to be spoken to. block: the piece between its marks, as the session will be given it. */
export interface Pending {
  id: string;
  at: number;
  from: Piece;
  to: { sessionId: string; where?: Place };
  text: string;
  block: string;
}

/** A session id is used as a folder name: only the letters the clients make ids of. */
const plain = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);

/** Set pieces to wait. Each is a file of its own, so that the hook taking some and this adding others never meet. */
export function queuePieces(rows: Pending[]): void {
  for (const row of rows) {
    if (!plain(row.to.sessionId) || !plain(row.id)) throw new Error("이 세션에는 걸어 둘 수 없습니다");
    const dir = join(pending(), row.to.sessionId);
    mkdirSync(dir, { recursive: true });
    const part = join(dir, "." + row.id + ".part"); // the hook reads only names ending in .json: it never sees a file half written
    writeFileSync(part, JSON.stringify(row));
    renameSync(part, join(dir, row.id + ".json"));
  }
  if (rows.length) writeFileSync(join(home(), "node"), process.execPath);
}

export function readPending(): Pending[] {
  const out: Pending[] = [];
  let sessions: string[] = [];
  try {
    sessions = readdirSync(pending());
  } catch {
    return out;
  }
  for (const session of sessions) {
    let names: string[] = [];
    try {
      names = readdirSync(join(pending(), session));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const row = JSON.parse(readFileSync(join(pending(), session, name), "utf8"));
        if (row?.id && row.from?.itemId && row.to?.sessionId === session && typeof row.text === "string") out.push(row);
      } catch { /* taken by the hook between the listing and the reading */ }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Take a waiting piece back. False when it is no longer there: the hook was quicker. */
export function dropPending(sessionId: string, id: string): boolean {
  if (!plain(sessionId) || !plain(id)) return false;
  const dir = join(pending(), sessionId);
  try {
    unlinkSync(join(dir, id + ".json"));
  } catch {
    return false;
  }
  try {
    rmdirSync(dir); // only when nothing else waits for the session
  } catch { /* still in use */ }
  return true;
}

/** Clear away what was left behind by something that stopped half way. The server does this when it starts, and
 *  now and then after.
 *  A piece that was taken and never let go (by a hook that died, or by a server that did, in the middle of handing
 *  it over) waits again; unless it was written down as gone, and then the session's record says whether it arrived.
 *  Only what has lain for ten minutes is touched: a piece being handed over right now is left alone.
 *  Files half written, and the whole texts kept for long pieces (pieces/<id>.txt) once they are two weeks old, go. */
export function tidyStore(now = Date.now()): { back: number; gone: number } {
  const done = { back: 0, gone: 0 };
  const stale = 10 * 60_000;
  const age = (path: string) => { try { return now - statSync(path).mtimeMs; } catch { return 0; } };
  const drop = (path: string) => { try { unlinkSync(path); done.gone += 1; } catch { /* gone already */ } };
  const list = (dir: string) => { try { return readdirSync(dir); } catch { return [] as string[]; } };
  const sent = new Set(readTransfers().map((row) => row.id));
  for (const session of list(pending())) {
    const dir = join(pending(), session);
    for (const name of list(dir)) {
      const path = join(dir, name);
      if (age(path) < stale) continue;
      const taken = /^(.+\.json)\.(?:sending|\d+\.taken)$/.exec(name);
      if (taken) {
        let id = "";
        try { id = String(JSON.parse(readFileSync(path, "utf8"))?.id ?? ""); } catch { /* not a piece */ }
        const wait = join(dir, taken[1]);
        if (id && !sent.has(id) && !existsSync(wait)) {
          try { renameSync(path, wait); done.back += 1; } catch { /* taken by something else meanwhile */ }
        } else drop(path);
      } else if (name.startsWith(".") && name.endsWith(".part")) drop(path);
    }
    try { rmdirSync(dir); } catch { /* something waits there */ }
  }
  for (const name of list(join(home(), "pieces"))) if (name.endsWith(".txt") && age(join(home(), "pieces", name)) > 14 * 24 * 3600_000) drop(join(home(), "pieces", name));
  if (age(join(home(), ".basket.part")) > stale) drop(join(home(), ".basket.part"));
  return done;
}

/** Take the pieces that wait for a session, to send them along with a message from this tool. Taken the way the hook
 *  takes them (by renaming), so that the client's hook, called for the same message, finds nothing to add a second
 *  time. done: they went. back: the session did not take the message; they wait again. */
export function takePending(sessionId: string): { rows: Pending[]; done(): void; back(): void } {
  const held: { row: Pending; taken: string; name: string }[] = [];
  const dir = join(pending(), sessionId);
  let names: string[] = [];
  if (plain(sessionId)) {
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch { /* nothing waits for it */ }
  }
  for (const name of names) {
    const taken = join(dir, name + ".sending");
    try {
      renameSync(join(dir, name), taken);
    } catch {
      continue; // the hook, or a cancel, was quicker
    }
    try {
      const row = JSON.parse(readFileSync(taken, "utf8"));
      if (row?.id && row.from?.itemId && row.to?.sessionId === sessionId && typeof row.text === "string" && typeof row.block === "string") {
        held.push({ row, taken, name: join(dir, name) });
        continue;
      }
    } catch { /* not a piece */ }
    try { unlinkSync(taken); } catch { /* gone already */ }
  }
  held.sort((a, b) => a.row.at - b.row.at);
  return {
    rows: held.map((one) => one.row),
    done() {
      for (const one of held) try { unlinkSync(one.taken); } catch { /* gone already */ }
      try { rmdirSync(dir); } catch { /* more were set meanwhile, or there was nothing */ }
    },
    back() {
      for (const one of held) try { renameSync(one.taken, one.name); } catch { /* leave it */ }
    },
  };
}
