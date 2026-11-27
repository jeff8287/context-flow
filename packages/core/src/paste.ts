// Pastes, found by matching text: what a person typed into one session that an agent had said, or changed in a file,
// earlier in another. Nothing in the records says the text was carried over, so a paste is a finding and is drawn as
// one (grade "paste"), with the stretches that match as its grounds.
//
// How: text is first flattened (Markdown marks, list marks, the +/- of a diff and runs of blanks go, since text copied
// off a screen has lost them). A run of K letters starting at a word is a window. A prompt and an earlier item of
// another session that share a window are grown from it, letter by letter, into the whole stretch they share.
import { PIECE_MARK } from "./links.ts";
import type { Item, ItemKind, Link, Session } from "./model.ts";

/** The shortest run of letters that counts as the same text. */
export const K = 32;
/** How many letters a prompt must share with one item before it is called a paste. */
export const MIN = 80;
/** And how long one unbroken stretch of them must be: file names and short lines of code that two sessions both
 *  happen to mention add up to many letters without anything having been carried over. */
export const LONG = 64;
/** A window found in the items of this many sessions is something everybody says: not a sign of a paste. */
const COMMON = 5;
const PARTS = 8;

/** Text with what a screen does not show taken out, and for each letter left, where it stood. */
export function flat(text: string, kind: ItemKind): { text: string; raw: Uint32Array } {
  const out = new Uint16Array(text.length);
  const raw = new Uint32Array(text.length);
  let n = 0;
  let blank = true; // a blank is owed nothing at the very start, and only one is kept in a row
  let lineStart = true;
  for (let i = 0; i < text.length; i += 1) {
    let ch = text.charCodeAt(i);
    if (lineStart) {
      lineStart = false;
      if (kind === "change") {
        if (text.startsWith("+++", i) || text.startsWith("---", i) || text.startsWith("@@", i)) {
          const end = text.indexOf("\n", i);
          i = end === -1 ? text.length : end - 1; // the line's end is read next, as a blank
          continue;
        }
        if (ch === 43 || ch === 45 || ch === 32) ch = 32; // the mark a diff puts before each line
      } else {
        let j = i;
        while (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9) j += 1;
        const first = text.charCodeAt(j);
        let k = j;
        while (k - j < 3 && text.charCodeAt(k) >= 48 && text.charCodeAt(k) <= 57) k += 1;
        if ((first === 45 || first === 42 || first === 43 || first === 0x2022) && text.charCodeAt(j + 1) === 32) { i = j + 1; ch = 32; } // a list mark
        else if (k > j && text.charCodeAt(k) === 46 && text.charCodeAt(k + 1) === 32) { i = k + 1; ch = 32; } // "1. "
      }
    }
    if (ch === 10) { lineStart = true; ch = 32; }
    if (ch === 93 && text.charCodeAt(i + 1) === 40) {
      // "](where a link goes)": only its label is on the screen
      const close = text.indexOf(")", i + 2);
      if (close !== -1 && close - i < 400 && text.lastIndexOf("\n", close) < i) { i = close; continue; }
    }
    if (ch === 42 || ch === 95 || ch === 35 || ch === 62 || ch === 124 || ch === 126 || ch === 96 || ch === 91 || ch === 93) continue;
    if (ch === 32 || ch === 9 || ch === 13 || ch === 0xa0) {
      if (!blank) { out[n] = 32; raw[n] = i; n += 1; blank = true; }
      continue;
    }
    out[n] = ch; raw[n] = i; n += 1; blank = false;
  }
  if (n && out[n - 1] === 32) n -= 1;
  return { text: new TextDecoder("utf-16le").decode(out.subarray(0, n)), raw: raw.subarray(0, n) };
}

/** What the person typed: the pieces this tool put after it are recorded links already. */
function typedPart(text: string): string {
  const at = text.indexOf(PIECE_MARK);
  return at === -1 ? text : text.slice(0, at);
}

interface Seg { q0: number; q1: number; p0: number; p1: number }
const flats = new Map<string, { size: number; text: string }>();
/** What was found for each prompt, kept apart for each set of projects looked through: with another project on the
 *  map there is more that a prompt may have been pasted from. */
const keptIn = new Map<string, Map<string, { size: number; links: Link[] }>>();

function flatOf(item: Item): string {
  const have = flats.get(item.id);
  if (have && have.size === item.text.length) return have.text;
  const made = flat(item.kind === "prompt" ? typedPart(item.text) : item.text, item.kind).text;
  flats.set(item.id, { size: item.text.length, text: made });
  return made;
}

/** A link for each stretch of a prompt that was said or changed earlier in another session. What was found for a
 *  prompt is kept: records are only ever added to, so what came before a prompt does not change.
 *  before: for a fork, the request of its parent that it was made before, where that is known (links.ts). */
export function pasteLinks(items: Item[], sessions: Session[], scope = "", before: Map<string, string> = new Map()): Link[] {
  let kept = keptIn.get(scope);
  if (!kept) keptIn.set(scope, (kept = new Map()));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // a subagent or a side talk is part of the session it hangs off: text does not move by going between them
  const topOf = (id: string): string => {
    let session = byId.get(id);
    for (let guard = 0; session && (session.origin === "subagent" || session.origin === "side") && session.parentId && guard < 8; guard += 1) session = byId.get(session.parentId) ?? session;
    return session?.id ?? id;
  };
  // A fork began with what its parent had said up to where it was made: that is not pasted into it again. Where it
  // was made is the request it was made before, when the records tell (a request said again is forked before that
  // request, however long afterwards), and never later than when the fork itself began. What the parent said after
  // that, the fork was not given. For each session a fork has something from: until when what that session said is
  // the fork's own. (A copy of a session has all of it.)
  const whenOf = new Map(items.map((item) => [item.id, item.at]));
  const inherits = (id: string): Map<string, number> => {
    const out = new Map<string, number>();
    let session = byId.get(id);
    for (let guard = 0; session && (session.origin === "fork" || session.origin === "imported") && session.parentId && guard < 16; guard += 1) {
      const until = session.origin === "imported" ? Infinity : Math.min(whenOf.get(before.get(session.id) ?? "") ?? Infinity, session.startedAt + 1);
      const from = topOf(session.parentId);
      out.set(from, Math.max(out.get(from) ?? 0, until));
      session = byId.get(session.parentId);
    }
    return out;
  };
  // what a person typed: a prompt handed to a subagent was written by an agent, and is no sign of a paste either way
  const prompts = items.filter((item) => item.kind === "prompt" && topOf(item.sessionId) === item.sessionId);
  const fresh = new Set(prompts.filter((item) => kept.get(item.id)?.size !== item.text.length).map((item) => item.id));
  if (fresh.size) {
    // every window of every prompt, and which prompts hold it: a fresh prompt is matched through it, and any prompt
    // tells whether an agent was only saying back what a person had typed
    const index = new Map<string, number[]>(); // window -> [prompt, place, prompt, place, …]
    const texts = prompts.map(flatOf);
    texts.forEach((text, t) => {
      for (let q = 0; q + K <= text.length; q += 1) {
        if (q && text.charCodeAt(q - 1) !== 32) continue;
        const window = text.substr(q, K);
        const list = index.get(window);
        if (list) list.push(t, q);
        else index.set(window, [t, q]);
      }
    });
    const sources = items.filter((item) => item.kind !== "prompt");
    const hits: { s: number; p: number; window: string }[] = [];
    const spread = new Map<string, Set<string>>(); // for a window that is in some prompt: the sessions whose items hold it
    sources.forEach((source, s) => {
      const text = flatOf(source);
      for (let p = 0; p + K <= text.length; p += 1) {
        if (p && text.charCodeAt(p - 1) !== 32) continue;
        const window = text.substr(p, K);
        if (!index.has(window)) continue;
        hits.push({ s, p, window });
        const where = spread.get(window);
        if (where) where.add(topOf(source.sessionId));
        else spread.set(window, new Set([topOf(source.sessionId)]));
      }
    });
    const found = new Map<number, Map<number, Seg[]>>(); // prompt -> source -> the stretches they share
    const had = new Map<number, Set<number>>(); // prompt -> the sources its session was given when it was made
    const up = new Map<string, Map<string, number>>();
    for (const hit of hits) {
      if (spread.get(hit.window)!.size >= COMMON) continue;
      const source = sources[hit.s];
      const list = index.get(hit.window)!;
      // typed by a person before the agent said it: the agent was saying it back, and the words are the person's
      let echoed = false;
      for (let at = 0; at < list.length && !echoed; at += 2) echoed = prompts[list[at]].at < source.at;
      if (echoed) continue;
      const from = topOf(source.sessionId);
      for (let at = 0; at < list.length; at += 2) {
        const t = list[at];
        const q = list[at + 1];
        const prompt = prompts[t];
        if (!fresh.has(prompt.id) || source.at >= prompt.at || from === prompt.sessionId) continue;
        let above = up.get(prompt.sessionId);
        if (!above) up.set(prompt.sessionId, (above = inherits(prompt.sessionId)));
        // What the session was given is looked at like anything else, so that a stretch it accounts for is not
        // put down to a session that only said the same later; it is no paste, and is left out at the end.
        if (source.at < (above.get(from) ?? -Infinity)) {
          const given = had.get(t);
          if (given) given.add(hit.s);
          else had.set(t, new Set([hit.s]));
        }
        const per = found.get(t) ?? new Map<number, Seg[]>();
        found.set(t, per);
        const segs = per.get(hit.s) ?? [];
        per.set(hit.s, segs);
        if (segs.some((seg) => seg.p0 - seg.q0 === hit.p - q && q >= seg.q0 && q < seg.q1)) continue; // inside a stretch already grown
        const a = texts[t];
        const b = flatOf(source);
        let q0 = q;
        let p0 = hit.p;
        while (q0 > 0 && p0 > 0 && a.charCodeAt(q0 - 1) === b.charCodeAt(p0 - 1)) { q0 -= 1; p0 -= 1; }
        let q1 = q + K;
        let p1 = hit.p + K;
        while (q1 < a.length && p1 < b.length && a.charCodeAt(q1) === b.charCodeAt(p1)) { q1 += 1; p1 += 1; }
        if (a.charCodeAt(q0) === 32) { q0 += 1; p0 += 1; } // a blank at either end is the gap between words, not part of what was carried
        if (a.charCodeAt(q1 - 1) === 32) { q1 -= 1; p1 -= 1; }
        segs.push({ q0, q1, p0, p1 });
      }
    }
    const made = new Map<string, Link[]>();
    for (const [t, per] of found) {
      const prompt = prompts[t];
      const length = texts[t].length;
      const cover = (segs: Seg[], taken?: Uint8Array) => {
        let count = 0;
        const seen = new Uint8Array(length);
        for (const seg of segs) for (let q = seg.q0; q < seg.q1; q += 1) if (!seen[q]) { seen[q] = 1; if (!taken || !taken[q]) count += 1; }
        return count;
      };
      let left = [...per].map(([s, segs]) => ({ s, segs, all: cover(segs) })).filter((one) => one.all >= MIN && one.segs.some((seg) => seg.q1 - seg.q0 >= LONG));
      const taken = new Uint8Array(length);
      const links: Link[] = [];
      let promptFlat: ReturnType<typeof flat> | null = null;
      while (left.length) {
        // The most of the prompt that is not yet accounted for; among items that account for about as much, the one
        // that said it first: where the text first appeared, not a later copy of it.
        const scored = left.map((one) => ({ ...one, gain: cover(one.segs, taken) })).filter((one) => one.gain >= MIN);
        if (!scored.length) break;
        const most = Math.max(...scored.map((one) => one.gain));
        const near = scored.filter((one) => one.gain >= most * 0.9).sort((x, y) => sources[x.s].at - sources[y.s].at);
        const given = had.get(t);
        const pick = near.find((one) => given?.has(one.s)) ?? near[0];
        for (const seg of pick.segs) taken.fill(1, seg.q0, seg.q1);
        left = left.filter((one) => one.s !== pick.s);
        if (given?.has(pick.s)) continue; // the session had this from the start: nothing was carried into it
        const source = sources[pick.s];
        promptFlat ??= flat(typedPart(prompt.text), "prompt");
        const sourceFlat = flat(source.text, source.kind);
        const segs = [...pick.segs].sort((x, y) => y.q1 - y.q0 - (x.q1 - x.q0));
        const range = (map: Uint32Array, from: number, to: number): [number, number] => [map[from], map[to - 1] + 1];
        const parts = segs.slice(0, PARTS).map((seg) => ({ from: range(sourceFlat.raw, seg.p0, seg.p1), to: range(promptFlat!.raw, seg.q0, seg.q1) }));
        links.push({
          id: "paste:" + source.id + ">" + prompt.id,
          grade: "paste",
          kind: "paste",
          from: { sessionId: source.sessionId, itemId: source.id, at: source.at, start: Math.min(...parts.map((part) => part.from[0])), end: Math.max(...parts.map((part) => part.from[1])) },
          to: { sessionId: prompt.sessionId, itemId: prompt.id, at: prompt.at, start: Math.min(...parts.map((part) => part.to[0])), end: Math.max(...parts.map((part) => part.to[1])) },
          chars: pick.all,
          excerpt: prompt.text.slice(parts[0].to[0], parts[0].to[1]).replace(/^[\s.,;:!?)\]}"'`*_>-]+/, "").slice(0, 600),
          parts,
        });
      }
      made.set(prompt.id, links);
    }
    for (const item of prompts) if (fresh.has(item.id)) kept.set(item.id, { size: item.text.length, links: made.get(item.id) ?? [] });
  }
  const known = new Set(sessions.map((session) => session.id));
  return prompts.flatMap((item) => kept.get(item.id)?.links ?? []).filter((link) => known.has(link.from.sessionId) && known.has(link.to.sessionId));
}

/** Forget what was found: for tests, which make up records with the same ids again and again. */
export function forgetPastes(): void {
  flats.clear();
  keptIn.clear();
}
