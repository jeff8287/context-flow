// What the screen asks about a set of items. The server answers from the clients' records and a bundle answers from
// itself, both through these, so that a bundle reads exactly as the live tool does. Nothing of Node in here.
import type { Gone, Item } from "./model.ts";

/** One session's items in the order they were said, for the talk pane. A very long text is cut; the item itself has the whole. */
export function talkOf(items: Iterable<Item>, sessionId: string, cap = 6000): (Item & { more?: number })[] {
  const out: (Item & { more?: number })[] = [];
  for (const item of items) {
    if (item.sessionId !== sessionId) continue;
    out.push(item.text.length > cap ? { ...item, text: item.text.slice(0, cap), more: item.text.length - cap } : item);
  }
  return out;
}

/** What was said in a session and then taken back, for the talk pane: each stretch with the request of the talk it
 *  is shown before, which is the first one made after the stretch began. The oldest stretch first. */
export function goneOf(items: Iterable<Item>, sessionId: string, stretches: Item[][] = [], cap = 6000): (Gone & { items: (Item & { more?: number })[] })[] {
  const said = stretches.filter((stretch) => stretch.length).sort((a, b) => a[0].at - b[0].at);
  if (!said.length) return [];
  const prompts: Item[] = [];
  for (const item of items) if (item.sessionId === sessionId && item.kind === "prompt") prompts.push(item);
  return said.map((stretch) => ({
    before: prompts.find((item) => item.at > stretch[0].at)?.id ?? null,
    items: stretch.map((item) => (item.text.length > cap ? { ...item, text: item.text.slice(0, cap), more: item.text.length - cap } : item)),
  }));
}

export interface Hit { id: string; sessionId: string; kind: string; at: number; before: string; match: string; after: string }

/** Where a word was said, in any session: a few places a session, the newest first. */
export function findIn(items: Iterable<Item>, query: string): Hit[] {
  const wanted = query.trim().toLowerCase();
  if (wanted.length < 2) return [];
  const hits: Hit[] = [];
  const per = new Map<string, number>();
  const flat = (text: string) => text.replace(/\s+/g, " ");
  for (const item of [...items].sort((a, b) => b.at - a.at)) {
    if (hits.length >= 40) break;
    if (item.kind === "change" || (per.get(item.sessionId) ?? 0) >= 3) continue;
    const at = item.text.toLowerCase().indexOf(wanted);
    if (at === -1) continue;
    per.set(item.sessionId, (per.get(item.sessionId) ?? 0) + 1);
    hits.push({ id: item.id, sessionId: item.sessionId, kind: item.kind, at: item.at, before: flat(item.text.slice(Math.max(0, at - 28), at)), match: item.text.slice(at, at + wanted.length), after: flat(item.text.slice(at + wanted.length, at + wanted.length + 70)) });
  }
  return hits;
}
