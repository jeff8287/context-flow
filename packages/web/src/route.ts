// A way for a line round the tiles. A line from one session to another is drawn as one curve where nothing stands
// in between; where a tile does, the line is led round it here: along the edges of the tiles, at right angles, by
// the shortest way with the fewest turns. Lines that would run along the same stretch are set a little apart. With
// several projects on the map, a line keeps out of the part of a project it has nothing to do with, unless the way
// round is much longer.
// Nothing of the page in here, so that it can be tried without one.

export interface Rect { x: number; y: number; r: number; b: number }
export type Side = "left" | "right" | "top" | "bottom";
/** points: the corners of the way, from the edge of the tile it leaves to just before the tile it enters. into: by which side it enters. */
export interface Way { points: [number, number][]; into: Side }

const CLEAR = 5; // a line keeps this far from a tile it passes
const TRACK = 16; // where a line runs along a tile: this far off its edge
const BEND = 26; // what a turn costs, as so many pixels of way
const APART = 6; // between two lines that run along the same stretch
const FOREIGN = 3; // a stretch through a part of the map that is neither end's counts as so many times its length
const PAST = 8; // a line that runs past such a part keeps this far off it
const DX = [1, 0, -1, 0]; // right, down, left, up
const DY = [0, 1, 0, -1];
const OUT: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };
const SIDES: Side[] = ["right", "bottom", "left", "top"];
const OPPOSITE: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** The tiles, and the lines along which a way may run past them. */
export interface Field {
  tiles: Rect[];
  xs: number[];
  ys: number[];
  /** right[j * nx + i]: nothing stands between (xs[i], ys[j]) and (xs[i + 1], ys[j]). down: the same, to (xs[i], ys[j + 1]). */
  right: Uint8Array;
  down: Uint8Array;
  /** How many ways already run along each stretch. */
  usedRight: Uint8Array;
  usedDown: Uint8Array;
  /** Which part of the map (which of the areas given) each stretch lies in; -1 where it lies in none. */
  areaRight: Int8Array;
  areaDown: Int8Array;
  /** The straight stretches of the ways found so far, as they are drawn. */
  laid: { across: boolean; at: number; from: number; to: number }[];
  /** Kept between one search and the next. */
  cost: Float64Array;
  came: Int32Array;
  done: Uint8Array;
}

const half = (value: number) => Math.round(value * 2) / 2;
const same = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.r === b.r && a.b === b.b;

/** alsoX, alsoY: where the lines leave and enter their tiles (the middle of a side, or a little off it), so that a way can begin and end there.
 *  areas: the parts of the map that belong to one project each (they do not overlap). */
export function field(tiles: Rect[], alsoX: number[] = [], alsoY: number[] = [], areas: Rect[] = []): Field {
  const xs = new Set<number>(alsoX.map(half));
  const ys = new Set<number>(alsoY.map(half));
  // just outside each project's part: where a line that has nothing to do with it runs past
  for (const area of areas) {
    xs.add(half(area.x - PAST)).add(half(area.r + PAST));
    ys.add(half(area.y - PAST)).add(half(area.b + PAST));
  }
  for (const tile of tiles) {
    xs.add(half(tile.x - TRACK)).add(half(tile.r + TRACK));
    ys.add(half(tile.y - TRACK)).add(half(tile.b + TRACK));
    // between two tiles that stand close, the only way is down the middle
    for (const other of tiles) {
      const across = other.x - tile.r;
      const along = other.y - tile.b;
      if (across >= 2 * CLEAR + 2 && across < 2 * TRACK) xs.add(half((tile.r + other.x) / 2));
      if (along >= 2 * CLEAR + 2 && along < 2 * TRACK) ys.add(half((tile.b + other.y) / 2));
    }
  }
  const sortedX = [...xs].sort((a, b) => a - b);
  const sortedY = [...ys].sort((a, b) => a - b);
  const nx = sortedX.length;
  const ny = sortedY.length;
  const right = new Uint8Array(nx * ny);
  const down = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j += 1) {
    const y = sortedY[j];
    const inRow = tiles.filter((tile) => y > tile.y - CLEAR && y < tile.b + CLEAR);
    for (let i = 0; i + 1 < nx; i += 1) right[j * nx + i] = inRow.some((tile) => sortedX[i] < tile.r + CLEAR && sortedX[i + 1] > tile.x - CLEAR) ? 0 : 1;
  }
  for (let i = 0; i < nx; i += 1) {
    const x = sortedX[i];
    const inColumn = tiles.filter((tile) => x > tile.x - CLEAR && x < tile.r + CLEAR);
    for (let j = 0; j + 1 < ny; j += 1) down[j * nx + i] = inColumn.some((tile) => sortedY[j] < tile.b + CLEAR && sortedY[j + 1] > tile.y - CLEAR) ? 0 : 1;
  }
  const areaRight = new Int8Array(nx * ny).fill(-1);
  const areaDown = new Int8Array(nx * ny).fill(-1);
  const within = (x: number, y: number) => areas.findIndex((area) => x > area.x && x < area.r && y > area.y && y < area.b);
  if (areas.length) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        if (i + 1 < nx) areaRight[j * nx + i] = within((sortedX[i] + sortedX[i + 1]) / 2, sortedY[j]);
        if (j + 1 < ny) areaDown[j * nx + i] = within(sortedX[i], (sortedY[j] + sortedY[j + 1]) / 2);
      }
    }
  }
  const states = nx * ny * 4 + 1;
  return { tiles, xs: sortedX, ys: sortedY, right, down, usedRight: new Uint8Array(nx * ny), usedDown: new Uint8Array(nx * ny), areaRight, areaDown, laid: [], cost: new Float64Array(states), came: new Int32Array(states), done: new Uint8Array(states) };
}

/** node: where on the lines the way begins (or ends). gone: how far that is past the tile's edge. edge: where the line meets the tile. */
interface Port { side: Side; node: number; cost: number; gone: number; edge: [number, number] }

/** Where a way can leave (or enter) a tile by each of its sides: the first line far enough past the edge, if nothing stands before it. */
function ports(made: Field, tile: Rect, lift: number, least: number, favour: (side: Side) => number): Port[] {
  const { xs, ys, tiles } = made;
  const nx = xs.length;
  const cx = half((tile.x + tile.r) / 2 + lift);
  const cy = half((tile.y + tile.b) / 2 + lift);
  const others = tiles.filter((other) => !same(other, tile));
  const out: Port[] = [];
  for (const side of SIDES) {
    const level = side === "left" || side === "right";
    const fixed = level ? ys.indexOf(cy) : xs.indexOf(cx);
    if (fixed < 0) continue;
    const line = level ? xs : ys;
    const edge = side === "right" ? tile.r : side === "left" ? tile.x : side === "bottom" ? tile.b : tile.y;
    const sign = side === "right" || side === "bottom" ? 1 : -1;
    const reach = (far: number) => {
      for (let step = 0; step < line.length; step += 1) {
        const at = sign > 0 ? step : line.length - 1 - step;
        const gone = (line[at] - edge) * sign;
        if (gone < far) continue;
        const lo = Math.min(edge, line[at]);
        const hi = Math.max(edge, line[at]);
        const shut = others.some((other) => (level
          ? cy > other.y - CLEAR && cy < other.b + CLEAR && lo < other.r + CLEAR && hi > other.x - CLEAR
          : cx > other.x - CLEAR && cx < other.r + CLEAR && lo < other.b + CLEAR && hi > other.y - CLEAR));
        return shut ? null : { at, gone };
      }
      return null;
    };
    const found = reach(least) ?? (least > CLEAR + 1 ? reach(CLEAR + 1) : null);
    if (!found) continue;
    const node = level ? fixed * nx + found.at : found.at * nx + fixed;
    out.push({ side, node, cost: found.gone + favour(side), gone: found.gone, edge: level ? [edge, cy] : [cx, edge] });
  }
  return out;
}

/** The side a line would leave a by, going to b, if nothing stood in its way; and the side it would enter b by. */
function natural(a: Rect, b: Rect): [Side, Side] {
  if (b.x >= a.r) return ["right", "left"];
  if (b.r <= a.x) return ["left", "right"];
  return b.y >= a.y ? ["bottom", "top"] : ["top", "bottom"];
}

/** A way from a to b round every tile, or null when there is none. lift: how far off the middle of the side the line
 *  leaves and enters (two lines between the same tiles keep apart). head: the line ends in an arrowhead, which needs room.
 *  home: the areas the two ends are in; the way keeps out of the others where it can. */
export function route(made: Field, a: Rect, b: Rect, options: { lift?: number; head?: boolean; home?: number[] } = {}): Way | null {
  const { xs, ys, right, down, usedRight, usedDown, areaRight, areaDown, cost, came, done } = made;
  const home = options.home ?? [];
  const nx = xs.length;
  const ny = ys.length;
  const lift = options.lift ?? 0;
  const [leave, enter] = natural(a, b);
  const favour = (best: Side) => (side: Side) => (side === best ? 0 : side === OPPOSITE[best] ? 24 : 10);
  const starts = ports(made, a, lift, CLEAR + 1, favour(leave));
  const goals = ports(made, b, lift, options.head ? 14 : CLEAR + 1, favour(enter));
  if (!starts.length || !goals.length) return null;
  const goalAt = new Map<number, Port[]>();
  for (const goal of goals) goalAt.set(goal.node, [...(goalAt.get(goal.node) ?? []), goal]);
  const guess = (node: number) => {
    const x = xs[node % nx];
    const y = ys[Math.floor(node / nx)];
    let least = Infinity;
    for (const goal of goals) least = Math.min(least, Math.abs(xs[goal.node % nx] - x) + Math.abs(ys[Math.floor(goal.node / nx)] - y));
    return least;
  };
  // a state is a place on the lines and the direction it was come to by; the last one of all stands for "arrived"
  const size = nx * ny * 4;
  cost.fill(Infinity);
  came.fill(-1);
  done.fill(0);
  let arrived: Port | null = null;
  const heap: number[] = []; // pairs: what the way would cost in all, the state
  const push = (total: number, state: number) => {
    let at = heap.length;
    heap.push(total, state);
    while (at > 0) {
      const up = ((at / 2 - 1) >> 1) * 2;
      if (heap[up] <= heap[at]) break;
      [heap[up], heap[at], heap[up + 1], heap[at + 1]] = [heap[at], heap[up], heap[at + 1], heap[up + 1]];
      at = up;
    }
  };
  const pop = (): number => {
    const state = heap[1];
    const lastState = heap.pop()!;
    const lastTotal = heap.pop()!;
    if (heap.length) {
      heap[0] = lastTotal;
      heap[1] = lastState;
      let at = 0;
      for (;;) {
        const one = at * 2 + 2;
        const two = one + 2;
        let least = at;
        if (one < heap.length && heap[one] < heap[least]) least = one;
        if (two < heap.length && heap[two] < heap[least]) least = two;
        if (least === at) break;
        [heap[least], heap[at], heap[least + 1], heap[at + 1]] = [heap[at], heap[least], heap[at + 1], heap[least + 1]];
        at = least;
      }
    }
    return state;
  };
  for (const start of starts) {
    const state = start.node * 4 + OUT[start.side];
    if (start.cost < cost[state]) {
      cost[state] = start.cost;
      push(start.cost + guess(start.node), state);
    }
  }
  while (heap.length) {
    const state = pop();
    if (done[state]) continue;
    done[state] = 1;
    if (state === size) break;
    const node = state >> 2;
    const dir = state & 3;
    for (const goal of goalAt.get(node) ?? []) {
      // into the tile: straight on if the way came the right way, else one more turn
      const total = cost[state] + goal.cost + (dir === (OUT[goal.side] + 2) % 4 ? 0 : BEND);
      if (total < cost[size]) {
        cost[size] = total;
        came[size] = state;
        arrived = goal;
        push(total, size);
      }
    }
    const i = node % nx;
    const j = Math.floor(node / nx);
    for (let next = 0; next < 4; next += 1) {
      if (next === (dir + 2) % 4) continue; // no turning back
      const ni = i + DX[next];
      const nj = j + DY[next];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const level = next === 0 || next === 2;
      const stretch = next === 0 ? j * nx + i : next === 2 ? j * nx + ni : next === 1 ? j * nx + i : nj * nx + i;
      if (!(level ? right : down)[stretch]) continue;
      const long = level ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
      const area = (level ? areaRight : areaDown)[stretch];
      const total = cost[state] + long * (1 + 0.6 * (level ? usedRight : usedDown)[stretch]) * (area >= 0 && !home.includes(area) ? FOREIGN : 1) + (next === dir ? 0 : BEND);
      const to = (nj * nx + ni) * 4 + next;
      if (total < cost[to]) {
        cost[to] = total;
        came[to] = state;
        push(total + guess(nj * nx + ni), to);
      }
    }
  }
  if (!arrived || came[size] < 0) return null;
  const nodes: number[] = [];
  let first = came[size];
  for (let state = came[size]; state >= 0; state = came[state]) {
    nodes.unshift(state >> 2);
    first = state;
  }
  // which side it left by: the one whose own state the way begins with
  const begin = starts.find((start) => start.node * 4 + OUT[start.side] === first) ?? starts.find((start) => start.node === nodes[0])!;
  for (let at = 0; at + 1 < nodes.length; at += 1) {
    const from = Math.min(nodes[at], nodes[at + 1]);
    if (Math.abs(nodes[at] - nodes[at + 1]) === 1) usedRight[from] += 1;
    else usedDown[from] += 1;
  }
  const stop = Math.max(1, Math.min(options.head ? 10 : 3, arrived.gone - 2)); // short of the tile: where the arrowhead begins
  const end: [number, number] = arrived.side === "left" ? [b.x - stop, arrived.edge[1]] : arrived.side === "right" ? [b.r + stop, arrived.edge[1]] : arrived.side === "top" ? [arrived.edge[0], b.y - stop] : [arrived.edge[0], b.b + stop];
  const open: [number, number] = begin.side === "left" ? [a.x - 2, begin.edge[1]] : begin.side === "right" ? [a.r + 2, begin.edge[1]] : begin.side === "top" ? [begin.edge[0], a.y - 2] : [begin.edge[0], a.b + 2];
  const points = straighten([open, ...nodes.map((node): [number, number] => [xs[node % nx], ys[Math.floor(node / nx)]]), end]);
  apart(made, points);
  return { points, into: arrived.side };
}

/** The corners only: a point that lies on the straight line between its neighbours says nothing. */
function straighten(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - point[0]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01) continue;
    const before = out[out.length - 2];
    if (before && last && ((Math.abs(before[0] - last[0]) < 0.01 && Math.abs(last[0] - point[0]) < 0.01) || (Math.abs(before[1] - last[1]) < 0.01 && Math.abs(last[1] - point[1]) < 0.01))) out[out.length - 1] = [point[0], point[1]];
    else out.push([point[0], point[1]]);
  }
  return out;
}

/** Set the stretches of a way a little apart from the ways already laid along the same stretch, where there is room; then count them as laid. */
function apart(made: Field, points: [number, number][]) {
  const near = (across: boolean, at: number, from: number, to: number) => made.laid.some((one) => one.across === across && Math.abs(one.at - at) < APART - 1 && Math.min(one.to, to) - Math.max(one.from, from) > 8);
  const free = (across: boolean, at: number, from: number, to: number) => !made.tiles.some((tile) => (across
    ? at > tile.y - CLEAR + 1 && at < tile.b + CLEAR - 1 && from < tile.r + CLEAR - 1 && to > tile.x - CLEAR + 1
    : at > tile.x - CLEAR + 1 && at < tile.r + CLEAR - 1 && from < tile.b + CLEAR - 1 && to > tile.y - CLEAR + 1));
  // not the first stretch nor the last: those are where the line leaves its tile and enters the other
  for (let at = 1; at + 2 < points.length; at += 1) {
    const p = points[at];
    const q = points[at + 1];
    const across = Math.abs(p[1] - q[1]) < 0.01;
    const axis = across ? 1 : 0; // what a stretch that runs across is moved along: up or down
    const from = Math.min(p[1 - axis], q[1 - axis]);
    const to = Math.max(p[1 - axis], q[1 - axis]);
    if (!near(across, p[axis], from, to)) continue;
    const before = points[at - 1];
    const after = points[at + 2];
    for (const by of [APART, -APART, 2 * APART, -2 * APART]) {
      // moving it shortens the stretch before or the one after: neither may be turned round
      const shortens = [before[axis] - p[axis], after[axis] - q[axis]].filter((gap) => gap * by > 0).map(Math.abs);
      if (shortens.some((gap) => gap < Math.abs(by) + 4)) continue;
      if (near(across, p[axis] + by, from, to) || !free(across, p[axis] + by, from, to)) continue;
      p[axis] += by;
      q[axis] += by;
      break;
    }
  }
  for (let at = 0; at + 1 < points.length; at += 1) {
    const p = points[at];
    const q = points[at + 1];
    const across = Math.abs(p[1] - q[1]) < 0.01;
    made.laid.push({ across, at: across ? p[1] : p[0], from: Math.min(across ? p[0] : p[1], across ? q[0] : q[1]), to: Math.max(across ? p[0] : p[1], across ? q[0] : q[1]) });
  }
}

/** The way as a path: straight stretches, each corner rounded off. */
export function rounded(points: [number, number][], radius = 12): string {
  let d = "M" + points[0][0] + " " + points[0][1];
  for (let at = 1; at + 1 < points.length; at += 1) {
    const [px, py] = points[at - 1];
    const [x, y] = points[at];
    const [nx, ny] = points[at + 1];
    const into = Math.hypot(x - px, y - py);
    const out = Math.hypot(nx - x, ny - y);
    const r = Math.min(radius, into / 2, out / 2);
    if (r < 1) { d += " L" + x + " " + y; continue; }
    d += " L" + (x - ((x - px) / into) * r) + " " + (y - ((y - py) / into) * r) + " Q" + x + " " + y + " " + (x + ((nx - x) / out) * r) + " " + (y + ((ny - y) / out) * r);
  }
  const last = points[points.length - 1];
  return d + " L" + last[0] + " " + last[1];
}

/** Where a label may sit on a way, the best first: the middles of its longest stretches, then elsewhere on the longest. */
export function restsOn(points: [number, number][]): [number, number][] {
  const stretches = points.slice(0, -1).map((p, at) => ({ p, q: points[at + 1], long: Math.hypot(points[at + 1][0] - p[0], points[at + 1][1] - p[1]) })).sort((a, b) => b.long - a.long);
  const on = (one: { p: [number, number]; q: [number, number] }, t: number): [number, number] => [one.p[0] + (one.q[0] - one.p[0]) * t, one.p[1] + (one.q[1] - one.p[1]) * t];
  return [...stretches.slice(0, 4).map((one) => on(one, 0.5)), on(stretches[0], 0.3), on(stretches[0], 0.7)];
}

/** A line as it is drawn when nothing stands in its way: curves one after another, each a cubic (8 numbers: where it
 *  begins, the two points that pull it, where it ends) or a straight stretch (4 numbers). */
export function drawn(curves: number[][]): string {
  let d = "M" + curves[0][0] + " " + curves[0][1];
  for (const one of curves) d += one.length === 8 ? " C" + one[2] + " " + one[3] + " " + one[4] + " " + one[5] + " " + one[6] + " " + one[7] : " L" + one[2] + " " + one[3];
  return d;
}

/** Points along such a line, close enough together that no tile fits between two of them. */
export function sampled(curves: number[][]): [number, number][] {
  const out: [number, number][] = [];
  for (const one of curves) {
    const [x0, y0] = one;
    const [x3, y3] = one.slice(-2);
    const [x1, y1, x2, y2] = one.length === 8 ? one.slice(2, 6) : [x0, y0, x3, y3];
    const reach = Math.abs(x1 - x0) + Math.abs(y1 - y0) + Math.abs(x2 - x1) + Math.abs(y2 - y1) + Math.abs(x3 - x2) + Math.abs(y3 - y2);
    const steps = Math.max(2, Math.ceil(reach / 10));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      out.push([u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
    }
  }
  return out;
}

/** Whether a line through these points would run behind a tile. The two tiles it joins count only where it runs right into them. */
export function behind(points: [number, number][], tiles: Rect[], a: Rect, b: Rect): boolean {
  return points.some(([x, y]) => tiles.some((tile) => {
    const pad = same(tile, a) || same(tile, b) ? -3 : 3;
    return x > tile.x - pad && x < tile.r + pad && y > tile.y - pad && y < tile.b + pad;
  }));
}
