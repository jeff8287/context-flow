// Where the tiles stand and how a line is led round them: tried with made-up sessions, without a page.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../../core/src/model.ts";
import { GG, GX, H, W, ZP, ZX, ZY, layout, placeZones, planZones, zoneOrder, type Frame, type Spot, type Zone } from "../src/place.ts";
import { behind, drawn, field, restsOn, rounded, route, sampled, type Rect } from "../src/route.ts";
import type { Flow, Share } from "../src/state.ts";

const session = (id: string, projectId = "p", more: Partial<Session> = {}): Session => ({
  id, client: "codex", projectId, cwd: "/work/app", title: id, model: null, startedAt: 1000, updatedAt: 1000, origin: "user", parentId: null,
  activity: "idle", nowFile: null, recordPath: null, counts: { prompts: 1, answers: 1, changes: 0 }, ...more,
});
const flow = (from: string, to: string, at = 1): Flow => ({ from, to, links: [{ id: from + ">" + to, grade: "recorded", kind: "transfer", from: { sessionId: from, at }, to: { sessionId: to, at } }], waiting: [], at });
const rect = (spot: Spot): Rect => ({ x: spot.x, y: spot.y, r: spot.x + W, b: spot.y + H });
const meet = (a: Frame, b: Frame) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const apartAll = (spots: Map<string, Spot>) => [...spots.values()].every((a, i, all) => all.every((b, j) => i === j || !meet({ x: a.x, y: a.y, w: W, h: H }, { x: b.x, y: b.y, w: W, h: H })));

test("groups of tied sessions stand side by side while there is room, and under one another when there is not", () => {
  const sessions = ["a", "b", "c", "d", "e"].map((id) => session(id));
  const flows = [flow("a", "b"), flow("c", "d")];
  const wide = layout(sessions, flows, [], 2000);
  assert.deepEqual([wide.get("a"), wide.get("b")], [{ x: 0, y: 0 }, { x: W + GX, y: 0 }]);
  assert.deepEqual([wide.get("c"), wide.get("d")], [{ x: 2 * W + GX + GG, y: 0 }, { x: 3 * W + 2 * GX + GG, y: 0 }]); // beside the first group
  assert.deepEqual(wide.get("e"), { x: 0, y: H + 40 }); // what nothing ties, under them
  const narrow = layout(sessions, flows, [], 2 * W + GX);
  assert.deepEqual([narrow.get("c"), narrow.get("d")], [{ x: 0, y: H + 40 }, { x: W + GX, y: H + 40 }]); // under the first group
  assert.deepEqual(narrow.get("e"), { x: 0, y: 2 * (H + 40) });
  assert.ok(apartAll(wide) && apartAll(narrow));
  // beside a tall group (one session that three came out of), the short groups go one under another
  const more = [...sessions, ...["f", "g", "h", "i", "j", "k"].map((id) => session(id))];
  const fan = [flow("f", "g"), flow("f", "h"), flow("f", "i"), flow("a", "b"), flow("c", "d"), flow("j", "k")];
  const packed = layout(more.map((one) => (one.id === "f" ? { ...one, activity: "running" as const } : one)), fan, [], 2000);
  const high = 3 * H + 2 * 24;
  assert.deepEqual([packed.get("f"), packed.get("g"), packed.get("i")], [{ x: 0, y: (high - H) / 2 }, { x: W + GX, y: 0 }, { x: W + GX, y: 2 * (H + 24) }]);
  const beside = 2 * W + GX + GG;
  assert.deepEqual(["a", "c", "j"].map((id) => packed.get(id)), [{ x: beside, y: 0 }, { x: beside, y: H + 40 }, { x: 2 * beside, y: 0 }]); // two fit under one another beside it; the third begins the next stack
  assert.deepEqual(packed.get("e"), { x: 0, y: high + 40 });
  assert.ok(apartAll(packed));
});

test("the parts of several projects never overlap, wherever a tile is put by hand: a part that grows pushes the next along", () => {
  const zones: Zone[] = [{ id: "p", sessions: ["a", "b", "c"].map((id) => session(id, "p")) }, { id: "q", sessions: ["x", "y"].map((id) => session(id, "q")) }, { id: "r", sessions: [session("z", "r")] }];
  const flows = [flow("a", "b")];
  const plan = { each: 2 * W + 14, rows: [["p", "q"], ["r"]] };
  const plain = placeZones(zones, flows, [], plan);
  const frames = (set: { frames: Map<string, Frame> }) => ["p", "q", "r"].map((id) => set.frames.get(id)!);
  const disjoint = (all: Frame[]) => all.every((one, i) => all.every((other, j) => i === j || !meet(one, other)));
  assert.ok(disjoint(frames(plain)));
  assert.deepEqual(plain.frames.get("p"), { x: -ZP, y: -ZP, w: 2 * W + GX + 2 * ZP, h: 2 * H + 40 + 2 * ZP });
  assert.equal(plain.spots.get("x")!.x, 2 * W + GX + ZX); // the second part begins a frame's breadth past the first
  // a tile of the first part dragged far to the right and down: its part grows, the second part is pushed along, the row below goes down
  const far = placeZones(zones, flows, [], plan, new Map([["c", { x: 900, y: 400 }]]));
  assert.ok(disjoint(frames(far)));
  assert.deepEqual(far.spots.get("c"), { x: 900, y: 400 });
  assert.equal(far.spots.get("x")!.x, 900 + W + ZX);
  assert.equal(far.spots.get("z")!.y, 400 + H + ZY);
  // dragged up and to the left of the rest: the part keeps its corner, and the rest of it moves instead
  const back = placeZones(zones, flows, [], plan, new Map([["c", { x: -300, y: -200 }]]));
  assert.ok(disjoint(frames(back)));
  assert.deepEqual([back.spots.get("c"), back.spots.get("a"), back.shift.get("p")], [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: 300, y: 200 }]);
  assert.deepEqual(back.frames.get("p")!.x, -ZP);
  // a tile put where another project's part is does not land in it: that part moves away
  const into = placeZones(zones, flows, [], plan, new Map([["a", plain.spots.get("x")!]]));
  assert.ok(disjoint(frames(into)) && apartAll(into.spots));
  // every place is the part's own place and how far the part lies from the map
  for (const [id, spot] of far.spots) {
    const zone = zones.find((one) => one.sessions.some((each) => each.id === id))!.id;
    const local = id === "c" ? { x: 900, y: 400 } : layout(zones.find((one) => one.id === zone)!.sessions, zone === "p" ? flows : [], [], plan.each).get(id)!;
    assert.deepEqual(spot, { x: local.x + far.shift.get(zone)!.x, y: local.y + far.shift.get(zone)!.y });
  }
});

test("the parts are set out to fill the window: side by side in a wide one, under one another in a tall one; a project that gave context stands first", () => {
  const many = (prefix: string, project: string, count: number) => Array.from({ length: count }, (_, at) => session(prefix + at, project, { updatedAt: 1000 - at }));
  const zones: Zone[] = [{ id: "p", sessions: many("a", "p", 8) }, { id: "q", sessions: many("b", "q", 8) }];
  const size = (plan: ReturnType<typeof planZones>) => {
    const all = [...placeZones(zones, [], [], plan).frames.values()];
    return { w: Math.max(...all.map((one) => one.x + one.w)) - Math.min(...all.map((one) => one.x)), h: Math.max(...all.map((one) => one.y + one.h)) - Math.min(...all.map((one) => one.y)) };
  };
  const wide = planZones(zones, [], [], { w: 1600, h: 500 });
  assert.deepEqual(wide.rows, [["p", "q"]]);
  assert.ok(size(wide).w <= 1600 && size(wide).h <= 500);
  const tall = planZones(zones, [], [], { w: 620, h: 1200 });
  assert.deepEqual(tall.rows, [["p"], ["q"]]);
  assert.ok(size(tall).w <= 620 && size(tall).h <= 1200);
  // too much for the window either way: whichever comes out larger on the screen
  const small = planZones(zones, [], [], { w: 500, h: 300 });
  const drawnAt = (plan: ReturnType<typeof planZones>) => Math.min(500 / size(plan).w, 300 / size(plan).h);
  for (const rows of [[["p", "q"]], [["p"], ["q"]]]) for (const columns of [2, 3, 4, 5, 6]) assert.ok(drawnAt(small) >= drawnAt({ each: columns * W + (columns - 1) * 14, rows }) - 1e-9);
  // one project: the same, for how wide it lays itself out
  const one = planZones([{ id: "", sessions: many("a", "p", 12) }], [], [], { w: 1000, h: 700 });
  assert.deepEqual(one.rows, [[""]]);
  const spots = layout(many("a", "p", 12), [], [], one.each);
  assert.ok(Math.max(...[...spots.values()].map((spot) => spot.x)) + W <= 1000);
  assert.deepEqual(zoneOrder(zones, [flow("b1", "a1"), flow("b2", "a3"), flow("a0", "b0")]).map((zone) => zone.id), ["q", "p"]);
  assert.deepEqual(zoneOrder([...zones, { id: "none", sessions: [] }], []).map((zone) => zone.id), ["p", "q"]);
});

test("a line that would run behind a tile is led round it; lines along the same stretch are set apart", () => {
  // three tiles in a row: from the first to the third, the second stands in the way
  const [a, mid, b] = [0, 1, 2].map((at) => rect({ x: at * (W + GX), y: 0 }));
  const tiles = [a, mid, b];
  const straight = [[a.r + 2, 38, a.r + 60, 38, b.x - 60, 38, b.x - 10, 38]];
  assert.equal(drawn(straight), "M174 38 C232 38 460 38 510 38");
  assert.ok(behind(sampled(straight), tiles, a, b));
  assert.ok(!behind(sampled([[a.r + 2, 38, a.r + 30, 38, mid.x - 30, 38, mid.x - 10, 38]]), tiles, a, mid)); // to its neighbour: nothing in the way
  const made = field(tiles, [a.x + W / 2, b.x + W / 2], [38]);
  const way = route(made, a, b, { head: true })!;
  assert.ok(way);
  assert.deepEqual([way.points[0], way.points.at(-1), way.into], [[a.r + 2, 38], [b.x - 10, 38], "left"]);
  const corners = (points: [number, number][]) => points.flatMap((p, at) => (at ? [[points[at - 1][0], points[at - 1][1], p[0], p[1]]] : []));
  assert.ok(!behind(sampled(corners(way.points)), tiles, a, b));
  assert.ok(way.points.every((p, at) => !at || p[0] === way.points[at - 1][0] || p[1] === way.points[at - 1][1])); // at right angles
  assert.equal(way.points.length, 6); // out, up or down past the tile in the way, along, back, in
  const pass = way.points[2][1];
  assert.ok(pass === mid.y - 16 || pass === mid.b + 16);
  assert.match(rounded(way.points), /^M174 38 L[\d. ]+ Q[\d. -]+ L/);
  const rest = restsOn(way.points)[0];
  assert.deepEqual(rest, [(way.points[2][0] + way.points[3][0]) / 2, pass]); // its label, on the long stretch past the tile
  // a second line the same way keeps off the first where they run together
  const again = route(made, a, b, { head: true })!;
  assert.ok(again && !behind(sampled(corners(again.points)), tiles, a, b));
  const lanes = [way, again].map((one) => one.points[2][1]);
  assert.ok(Math.abs(lanes[0] - lanes[1]) >= 6);
  // with several projects on the map: a line keeps out of the part of a project that neither of its ends is in
  {
    // a on the left, b on the right, and between them another project's part: four tiles, with a gap right where the line would go
    const [from, to] = [rect({ x: 0, y: 138 }), rect({ x: 1200, y: 138 })];
    const others = [rect({ x: 400, y: 60 }), rect({ x: 400, y: 216 }), rect({ x: 400 + W + GX, y: 60 }), rect({ x: 400 + W + GX, y: 216 })];
    const all = [from, to, ...others];
    const part = { x: 392, y: 52, r: 400 + 2 * W + GX + 8, b: 216 + H + 8 };
    const ends: [number[], number[]] = [[W / 2, 1200 + W / 2], [138 + H / 2]];
    const through = route(field(all, ...ends), from, to, { head: true })!;
    const round = route(field(all, ...ends, [{ x: 0, y: 0, r: 0, b: 0 }, part]), from, to, { head: true, home: [0] })!;
    const inside = (way: typeof through) => way.points.some((p, at) => at > 0 && [0.25, 0.5, 0.75].some((t) => { const x = way.points[at - 1][0] + (p[0] - way.points[at - 1][0]) * t; const y = way.points[at - 1][1] + (p[1] - way.points[at - 1][1]) * t; return x > part.x && x < part.r && y > part.y && y < part.b; }));
    assert.ok(inside(through) && !inside(round)); // left to itself it takes the gap between the tiles; told whose part that is, it goes round
    assert.ok(!behind(sampled(corners(round.points)), all, from, to));
    const own = route(field(all, ...ends, [{ x: 0, y: 0, r: 0, b: 0 }, part]), from, to, { head: true, home: [0, 1] })!;
    assert.ok(inside(own)); // through a part that is one of its ends', as before
  }
  // a tile walled in on every side: no way, and the line is left as it was
  const walls = [rect({ x: 0, y: 0 }), rect({ x: 0, y: -H - 8 }), rect({ x: 0, y: H + 8 }), rect({ x: -W - 8, y: 0 }), rect({ x: W + 8, y: 0 }), rect({ x: 900, y: 0 })];
  assert.equal(route(field(walls, [W / 2, 900 + W / 2], [38]), walls[0], walls[5]), null);
});

test("whatever is on the map, no line is left behind a tile when there is a way round", () => {
  // a made-up map: thirty tiles on a loose grid, some moved off it, and lines between tiles far apart
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const tiles: Rect[] = [];
  for (let at = 0; at < 30; at += 1) tiles.push(rect({ x: (at % 6) * (W + (at % 2 ? GX : 14)) + Math.round(random() * 3) * 22, y: Math.floor(at / 6) * (H + 24) + (random() < 0.2 ? 44 : 0) }));
  const clear = tiles.filter((tile, i) => tiles.every((other, j) => i === j || !meet({ x: tile.x - 6, y: tile.y - 6, w: W + 12, h: H + 12 }, { x: other.x, y: other.y, w: W, h: H })));
  const pairs: [Rect, Rect][] = [];
  for (let at = 0; at < 40; at += 1) {
    const a = clear[Math.floor(random() * clear.length)];
    const b = clear[Math.floor(random() * clear.length)];
    if (a !== b) pairs.push([a, b]);
  }
  const made = field(clear, pairs.flatMap(([a, b]) => [a.x + W / 2, b.x + W / 2]), pairs.flatMap(([a, b]) => [a.y + H / 2, b.y + H / 2]));
  let found = 0;
  for (const [a, b] of pairs) {
    const way = route(made, a, b, { head: true });
    if (!way) continue;
    found += 1;
    const stretches = way.points.flatMap((p, at) => (at ? [[way.points[at - 1][0], way.points[at - 1][1], p[0], p[1]]] : []));
    assert.ok(!behind(sampled(stretches), clear, a, b), "a way runs behind a tile");
    assert.ok(way.points.every((p, at) => !at || Math.abs(p[0] - way.points[at - 1][0]) < 0.01 || Math.abs(p[1] - way.points[at - 1][1]) < 0.01));
  }
  assert.ok(found >= pairs.length - 2, "ways found: " + found + " of " + pairs.length);
});
