// Where the tiles stand. Nothing of the page in here, so that it can be tried without one.
// One project: the sessions that are tied stand in columns that follow the way context went, group beside group as
// far as the room goes (a short group under another, beside a tall one); the sessions nothing ties stand in a grid.
// Several projects: each has a part of the map to itself (a zone), laid out as it would be alone. The zones are set
// in rows so that the whole picture fills the window as well as it can, and they never overlap: a tile that was put
// somewhere by hand is kept as a place within its own zone, so a zone that grows pushes the next one along.
import type { Session } from "../../core/src/model.ts";
import type { Flow, Share } from "./state.ts";

export const W = 172; // a tile
export const H = 76;
export const GX = 88; // between columns of tied sessions: room for the line and its label
export const GY = 24;
export const GAP = 14; // between sessions nothing ties
export const GG = 112; // between two groups of tied sessions that stand side by side
export const ZP = 26; // between a project's frame and its tiles: room for a line to run along the tiles, inside the frame
export const ZX = 2 * ZP + 60; // between the tiles of two projects side by side: their frames, and room for a line and its label
export const ZY = 2 * ZP + 30;

export interface Spot { x: number; y: number }
export interface Frame { x: number; y: number; w: number; h: number }

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Where each session's tile goes, from the upper left corner on. room: how wide the picture may be before a row is begun. */
export function layout(sessions: Session[], flows: Flow[], shares: Share[], room: number): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  const root = new Map(sessions.map((session) => [session.id, session.id]));
  const find = (id: string): string => { let at = id; while (root.get(at) !== at) at = root.get(at)!; return at; };
  for (const flow of flows) root.set(find(flow.from), find(flow.to));
  for (const share of shares) root.set(find(share.a), find(share.b));
  const rank = (session: Session) => (session.activity === "running" ? 0 : session.activity === "waiting" ? 1 : 2);
  const first = (group: Session[]) => Math.min(...group.map(rank));
  const latest = (group: Session[]) => Math.max(...group.map((session) => session.updatedAt));
  const byRoot = new Map<string, Session[]>();
  for (const session of sessions) byRoot.set(find(session.id), [...(byRoot.get(find(session.id)) ?? []), session]);
  const groups = [...byRoot.values()];
  const tied = groups.filter((group) => group.length > 1).sort((a, b) => first(a) - first(b) || latest(b) - latest(a));
  const alone = groups.filter((group) => group.length === 1).map((group) => group[0]).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  let y = 0;
  const grid = (reach: number) => {
    const per = Math.max(1, Math.floor((Math.max(room, reach) + GAP) / (W + GAP)));
    alone.forEach((session, at) => spots.set(session.id, { x: (at % per) * (W + GAP), y: y + Math.floor(at / per) * (H + GAP) }));
    if (alone.length) y += Math.ceil(alone.length / per) * (H + GAP) - GAP + 40;
  };
  // What is at work goes on top: the untied sessions first when one of them is running and no tied group has a running one.
  const aloneFirst = alone.some((session) => session.activity === "running") && !tied.some((group) => first(group) === 0);
  if (aloneFirst) grid(0);
  // The groups of tied sessions stand side by side while there is room; then a new row is begun. A group that is
  // not as tall as its row goes under an earlier group of the row when there is room for it there, so that a tall
  // group does not leave the row beside it empty.
  let across = 0; // where the next group that stands beside the others would begin
  let tall = 0; // the tallest group of the row
  let stacks: { x: number; w: number; used: number }[] = []; // the row, as stacks of groups one under another
  for (const group of tied) {
    const ids = new Set(group.map((session) => session.id));
    const mine = flows.filter((flow) => ids.has(flow.from) && ids.has(flow.to));
    // Context may have gone both ways between sessions, or round in a ring. The columns follow the flows in the order
    // they happened (what only waits comes last); one that leads back to where context came from is drawn against
    // the grain instead of pushing the columns apart.
    const onward: Flow[] = [];
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      seen.add(from);
      return onward.some((flow) => flow.from === from && !seen.has(flow.to) && reaches(flow.to, to, seen));
    };
    for (const flow of [...mine].sort((p, q) => Number(!p.links.length) - Number(!q.links.length) || p.at - q.at)) if (!reaches(flow.to, flow.from)) onward.push(flow);
    // a session stands one column to the right of the furthest session it took context from
    const depth = new Map(group.map((session) => [session.id, 0]));
    for (let pass = 0; pass < group.length; pass += 1) {
      let moved = false;
      for (const flow of onward) {
        if (depth.get(flow.to)! < depth.get(flow.from)! + 1) { depth.set(flow.to, depth.get(flow.from)! + 1); moved = true; }
      }
      if (!moved) break;
    }
    // a session tied only by a shared file goes right under the session it shares with
    const inFlow = new Set(mine.flatMap((flow) => [flow.from, flow.to]));
    const under = new Map<string, string>();
    for (const share of shares) {
      if (!ids.has(share.a) || !ids.has(share.b)) continue;
      if (!inFlow.has(share.a) && inFlow.has(share.b) && !under.has(share.a)) under.set(share.a, share.b);
      if (!inFlow.has(share.b) && inFlow.has(share.a) && !under.has(share.b)) under.set(share.b, share.a);
    }
    const columns = new Map<number, string[]>();
    for (const session of [...group].sort((a, b) => a.startedAt - b.startedAt)) {
      if (under.has(session.id)) continue;
      const at = depth.get(session.id)!;
      columns.set(at, [...(columns.get(at) ?? []), session.id]);
    }
    const depths = [...columns.keys()].sort((a, b) => a - b);
    const row = new Map<string, number>();
    for (const at of depths) {
      const column = columns.get(at)!;
      const pull = (id: string) => {
        const from = onward.filter((flow) => flow.to === id).map((flow) => row.get(flow.from)).filter((value): value is number => value !== undefined);
        return from.length ? mean(from) : Infinity;
      };
      if (at > 0) column.sort((a, b) => pull(a) - pull(b));
      column.forEach((id, place) => row.set(id, place));
    }
    for (const [id, other] of under) {
      const column = columns.get(depth.get(other)!)!;
      column.splice(column.indexOf(other) + 1, 0, id);
    }
    const tallest = Math.max(...depths.map((at) => columns.get(at)!.length));
    const height = tallest * H + (tallest - 1) * GY;
    const width = depths.length * W + (depths.length - 1) * GX;
    // under an earlier group of the row: the last stack may grow wider for it, the others may not (the next stands right beside them)
    let stack = stacks.find((one, at) => one.used + 40 + height <= tall && (at === stacks.length - 1 ? one.x + Math.max(one.w, width) <= room : width <= one.w));
    let top = y;
    if (stack) {
      top = y + stack.used + 40;
      stack.used += 40 + height;
      stack.w = Math.max(stack.w, width);
    } else {
      if (across > 0 && across + width > room) { // no room beside the last group either: a new row
        y += tall + 40;
        top = y;
        across = 0;
        tall = 0;
        stacks = [];
      }
      stack = { x: across, w: width, used: height };
      stacks.push(stack);
      tall = Math.max(tall, height);
    }
    const from = stack.x;
    depths.forEach((at, place) => {
      const column = columns.get(at)!;
      const own = column.length * H + (column.length - 1) * GY;
      column.forEach((id, line) => spots.set(id, { x: from + place * (W + GX), y: top + (height - own) / 2 + line * (H + GY) }));
    });
    across = Math.max(across, stack.x + stack.w + GG);
  }
  if (tied.length) y += tall + 40;
  if (!aloneFirst) grid(spots.size ? Math.max(...[...spots.values()].map((spot) => spot.x)) + W : 0);
  return spots;
}

/** A project's part of the map: the sessions of it that are on. */
export interface Zone { id: string; sessions: Session[] }
/** How the zones are set out: how wide each may lay itself out, and which stand in which row. */
export interface Plan { each: number; rows: string[][] }
export interface Placed {
  spots: Map<string, Spot>;
  /** For each zone: its frame, and how far its own places (the layout's, and the ones tiles were put at by hand) lie from the map's. */
  frames: Map<string, Frame>;
  shift: Map<string, Spot>;
}

/** The zones in the order they stand: a project that context left for another stands before it, so that what went
 *  between projects runs the way everything else on the map does, from left to right. */
export function zoneOrder(zones: Zone[], flows: Flow[]): Zone[] {
  const of = new Map(zones.flatMap((zone) => zone.sessions.map((session) => [session.id, zone.id] as const)));
  const gave = new Map<string, number>(); // what left the zone for another, less what came into it from another
  for (const flow of flows) {
    const from = of.get(flow.from);
    const to = of.get(flow.to);
    if (!from || !to || from === to) continue;
    gave.set(from, (gave.get(from) ?? 0) + 1);
    gave.set(to, (gave.get(to) ?? 0) - 1);
  }
  return zones.map((zone, at) => ({ zone, at })).filter(({ zone }) => zone.sessions.length).sort((a, b) => (gave.get(b.zone.id) ?? 0) - (gave.get(a.zone.id) ?? 0) || a.at - b.at).map(({ zone }) => zone);
}

/** The zones set out by a plan. pins: where tiles were put by hand, each a place within its own zone. */
export function placeZones(zones: Zone[], flows: Flow[], shares: Share[], plan: Plan, pins: Map<string, Spot> = new Map(), laid?: Map<string, Map<string, Spot>>): Placed {
  const byId = new Map(zones.map((zone) => [zone.id, zone]));
  const spots = new Map<string, Spot>();
  const frames = new Map<string, Frame>();
  const shift = new Map<string, Spot>();
  let y = 0;
  for (const row of plan.rows) {
    let x = 0;
    let tall = 0;
    for (const id of row) {
      const zone = byId.get(id);
      if (!zone?.sessions.length) continue;
      const ids = new Set(zone.sessions.map((session) => session.id));
      const local = laid?.get(id) ?? layout(zone.sessions, flows.filter((flow) => ids.has(flow.from) && ids.has(flow.to)), shares.filter((share) => ids.has(share.a) && ids.has(share.b)), plan.each);
      const at = (session: string) => pins.get(session) ?? local.get(session)!;
      const all = [...ids].map(at);
      const left = Math.min(...all.map((spot) => spot.x));
      const top = Math.min(...all.map((spot) => spot.y));
      const wide = Math.max(...all.map((spot) => spot.x)) + W - left;
      const high = Math.max(...all.map((spot) => spot.y)) + H - top;
      // the zone's upper left corner stays where its row puts it: what was moved up or to the left of the rest pushes the rest
      const off = { x: x - left, y: y - top };
      for (const session of ids) spots.set(session, { x: at(session).x + off.x, y: at(session).y + off.y });
      shift.set(id, off);
      frames.set(id, { x: x - ZP, y: y - ZP, w: wide + 2 * ZP, h: high + 2 * ZP });
      x += wide + ZX;
      tall = Math.max(tall, high);
    }
    if (tall) y += tall + ZY;
  }
  return { spots, frames, shift };
}

/** How to set out the zones so that the picture is drawn as large as it can be in the window (and no larger than
 *  life): tried for several widths of a zone and every way of breaking the zones into rows. Of the ways that come
 *  out the same size, the one with the fewest rows, and then the widest. view: the room the picture has.
 *  With one zone this settles how wide a single project lays itself out. */
export function planZones(zones: Zone[], flows: Flow[], shares: Share[], view: { w: number; h: number }): Plan {
  const ids = zones.filter((zone) => zone.sessions.length).map((zone) => zone.id);
  let best: { plan: Plan; size: number } | null = null;
  // every way of breaking the zones into rows, in their order; with many zones, only the even ways
  const ways: string[][][] = [];
  if (ids.length <= 6) {
    for (let mask = 0; mask < 1 << Math.max(0, ids.length - 1); mask += 1) {
      const rows: string[][] = [[]];
      ids.forEach((id, at) => {
        rows[rows.length - 1].push(id);
        if (at < ids.length - 1 && mask & (1 << at)) rows.push([]);
      });
      ways.push(rows);
    }
  } else {
    for (let per = 1; per <= ids.length; per += 1) {
      const rows: string[][] = [];
      for (let at = 0; at < ids.length; at += per) rows.push(ids.slice(at, at + per));
      ways.push(rows);
    }
  }
  for (let columns = 2; columns <= 9; columns += 1) {
    const each = columns * W + (columns - 1) * GAP;
    const laid = new Map<string, Map<string, Spot>>();
    for (const zone of zones) {
      if (!zone.sessions.length) continue;
      const mine = new Set(zone.sessions.map((session) => session.id));
      laid.set(zone.id, layout(zone.sessions, flows.filter((flow) => mine.has(flow.from) && mine.has(flow.to)), shares.filter((share) => mine.has(share.a) && mine.has(share.b)), each));
    }
    for (const rows of ways) {
      const frames = [...placeZones(zones, flows, shares, { each, rows }, undefined, laid).frames.values()];
      if (!frames.length) continue;
      const wide = Math.max(...frames.map((frame) => frame.x + frame.w)) - Math.min(...frames.map((frame) => frame.x));
      const high = Math.max(...frames.map((frame) => frame.y + frame.h)) - Math.min(...frames.map((frame) => frame.y));
      const size = Math.min(1, view.w / wide, view.h / high); // how large the picture would be drawn
      const better = !best || size > best.size + 1e-9 || (size > best.size - 1e-9 && (rows.length < best.plan.rows.length || (rows.length === best.plan.rows.length && each > best.plan.each)));
      if (better) best = { plan: { each, rows }, size };
    }
  }
  return best?.plan ?? { each: 2 * W + GAP, rows: [ids] };
}
