// How much is shown goes by how far in the map is zoomed. From far off: the sessions by name and state, and the lines
// between them. In between: what each line is (its label), and each session's state in words. Close up: what was
// last asked of a session, and the pieces that went along a line. Letters keep their size on the screen whatever the
// zoom, so that what is shown can be read; it is the room around them that grows.
// The map: the sessions that are switched on, as tiles, and what ties them. Context that moved is a coloured line
// with beads running the way it went; a paste that was only found by matching text is a dashed line; pieces set to
// go and not yet gone are a dotted line with a hollow head; files two sessions both changed are a grey dotted line.
// A tile can be dragged to another place; it stays there (kept for the project) until the map is tidied again.
// With several projects on the map, each has a part of it to itself, framed and named; what went between two
// projects is then a line from one frame into another. Where the tiles stand is worked out in place.ts; a line that
// would run behind a tile is led round the tiles (route.ts).
import * as d3 from "d3";
import type { Session } from "../../core/src/model.ts";
import { GX, GY, H, W, layout, placeZones, planZones, zoneOrder, type Frame, type Plan, type Spot, type Zone } from "./place.ts";
import { behind, drawn, field, restsOn, rounded, route, sampled, type Field, type Rect, type Way } from "./route.ts";
import { act, ago, CLIENT, colorOf, el, flowLabel, h, ICON, many, owner, projectOf, projectsOn, projName, quietFor, state, stateWord, type Flow } from "./state.ts";

/** Where the person put a tile, by session: it overrides the place the layout gives. Kept for each set of projects.
 *  With one project on the map it is a place on the map. With several, a place within the tile's own project's part
 *  of the map: that part can then grow and push the others along, and no two parts ever overlap. */
let pins = new Map<string, Spot>();
let pinsOf: string | null = null;
/** With several projects on the map: which part each session is in, and how far that part's own places lie from the map's. */
let zoneOf = new Map<string, string>();
let shifts = new Map<string, Spot>();
const shiftOf = (id: string): Spot => shifts.get(zoneOf.get(id) ?? "") ?? { x: 0, y: 0 };
/** Whether a tile is the only one of its project on a map of several: its part of the map is then the tile itself,
 *  and there is nowhere within it to move the tile to. A press on it moves the map, as a press beside it would. */
const lone = (id: string) => shifts.size > 0 && [...zoneOf.values()].filter((zone) => zone === zoneOf.get(id)).length === 1;
/** How the picture is set out, and for what it was worked out: it is worked out again when what is on the map or the window changes, not while a tile is dragged. */
let planned: { key: string; plan: Plan } | null = null;
/** The whole picture as last drawn, on the map. */
let pictured: Frame = { x: 0, y: 0, w: 0, h: 0 };
/** Whether the whole picture lies in the window as the map now stands. */
function inView(): boolean {
  const host = el<HTMLElement>("map");
  const box = host.getBoundingClientRect();
  const view = d3.zoomTransform(host);
  return view.applyX(pictured.x) >= -2 && view.applyY(pictured.y) >= -2 && view.applyX(pictured.x + pictured.w) <= box.width + 2 && view.applyY(pictured.y + pictured.h) <= box.height + 2;
}
/** The tile being dragged, and when one was last let go (the press that moved a tile does not also open its talk). */
let moving: string | null = null;
let movedAt = 0;
const SNAP = 11; // half the board's dot grid
/** Where each tile now on the map stands, as last drawn. */
let placed = new Map<string, Spot>();

/** A tile let go on top of another is moved to the nearest place where it lies on none. */
function settle(id: string) {
  const spot = pins.get(id);
  if (!spot) return;
  // (with several projects on the map: among the tiles of its own project, by their places within that project's part)
  const off = shiftOf(id);
  const others = [...placed].filter(([other]) => other !== id && zoneOf.get(other) === zoneOf.get(id)).map(([, at]) => ({ x: at.x - off.x, y: at.y - off.y }));
  const hits = (x: number, y: number) => others.some((at) => x < at.x + W + 10 && at.x < x + W + 10 && y < at.y + H + 10 && at.y < y + H + 10);
  if (!hits(spot.x, spot.y)) return;
  let best: Spot | null = null;
  let least = Infinity;
  for (let dx = -30; dx <= 30; dx += 1) {
    for (let dy = -30; dy <= 30; dy += 1) {
      const far = Math.hypot(dx, dy);
      if (far >= least) continue;
      const x = spot.x + dx * SNAP * 2;
      const y = spot.y + dy * SNAP * 2;
      if (!hits(x, y)) { best = { x, y }; least = far; }
    }
  }
  if (best) pins.set(id, best);
}

function readPins(project: string) {
  pinsOf = project;
  pins = new Map();
  let kept: unknown = null;
  try {
    kept = JSON.parse(localStorage.getItem("cf-spots:" + project) ?? "null");
  } catch { /* storage may be shut off; the places then last for this page only */ }
  // an exported record opens with its tiles where the person who exported it had put them, until they are moved here
  if (!Array.isArray(kept)) kept = state.bundle?.view.spots ?? [];
  for (const [id, x, y] of kept as unknown[][]) if (typeof id === "string" && Number.isFinite(x) && Number.isFinite(y)) pins.set(id, { x: x as number, y: y as number });
}
/** Where these sessions' tiles were put by hand: [id, x, y] for each that was moved. */
export function spotsOf(ids: string[]): [string, number, number][] {
  return ids.filter((id) => pins.has(id)).map((id) => [id, pins.get(id)!.x, pins.get(id)!.y]);
}
function keepPins() {
  try {
    localStorage.setItem("cf-spots:" + (pinsOf ?? ""), JSON.stringify([...pins].map(([id, spot]) => [id, spot.x, spot.y])));
  } catch { /* as above */ }
}
/** Put every tile back where the layout would have it. */
export function tidyMap() {
  pins.clear();
  keepPins();
  shown = ""; // and fit the picture again
  drawMap();
}

let zoom: d3.ZoomBehavior<HTMLElement, unknown> | null = null;
let fitted = d3.zoomIdentity;
let shown = "";
let again = 0;

/** Light up one session, the lines that touch it and the sessions at their other ends; the rest steps back. */
export function focusMap(id: string | null) {
  const world = el<HTMLElement>("world");
  world.querySelectorAll(".lit").forEach((node) => node.classList.remove("lit"));
  world.classList.remove("focus");
  if (id === null || !state.on.has(id)) return;
  const lit = new Set([id]);
  world.querySelectorAll<HTMLElement>("[data-a]").forEach((node) => {
    const a = node.dataset.a!;
    const others = node.dataset.b!.split(" ");
    if (a !== id && !others.includes(id)) return;
    node.classList.add("lit");
    if (!node.classList.contains("pill")) lit.add(a).add(others[0]); // a label can stand for several lines; the lines say which sessions
  });
  world.querySelectorAll<HTMLElement>(".tile").forEach((node) => node.classList.toggle("lit", lit.has(node.dataset.id!)));
  world.classList.toggle("focus", lit.size > 1); // a session nothing ties has nothing to point at: leave the rest as it is
}

let resting = 0;
function hidePeek() {
  clearTimeout(resting);
  el<HTMLElement>("peek").hidden = true;
}
/** When the pointer rests on a tile: what was last asked of the session, what it is at, and what ties it. The tile itself stays short. */
function peek(session: Session, tile: HTMLElement) {
  clearTimeout(resting);
  resting = window.setTimeout(() => {
    const card = el<HTMLElement>("peek");
    const stage = el<HTMLElement>("stage").getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    card.textContent = "";
    card.style.setProperty("--c", colorOf(session.id));
    card.append(h("b", "peek-title", session.title));
    const items = state.snap!.items;
    let asked = "";
    for (let at = items.length - 1; at >= 0 && !asked; at -= 1) if (items[at].sessionId === session.id && items[at].kind === "prompt") asked = items[at].label;
    if (asked) {
      const row = h("div", "peek-row");
      row.append(h("i", "", "마지막 요청"), asked);
      card.append(row);
    }
    if (session.activity === "running" && (session.needs || quietFor(session, state.snap!.madeAt) >= 2)) {
      const row = h("div", "peek-row");
      const quiet = quietFor(session, state.snap!.madeAt);
      row.append(h("i", "", "지금"), session.needs === "approval" ? "허용을 기다리고 있습니다. 그 세션의 창에서 답해 주세요" + (quiet >= 2 ? " (" + quiet + "분째)" : "") : session.needs ? "질문에 답하기를 기다리고 있습니다" : "작업 중인데 " + quiet + "분째 기록이 없습니다. 오래 걸리는 명령이거나, 허용을 기다리는 중일 수 있습니다");
      card.append(row);
    }
    if (session.activity === "running" && session.nowFile) {
      const row = h("div", "peek-row");
      row.append(h("i", "", "지금 고치는 파일"), session.nowFile.split("/").slice(-2).join("/"));
      card.append(row);
    }
    const name = (id: string) => state.sessions.get(id)?.title ?? "";
    for (const flow of state.graph.flows) {
      if (flow.to !== session.id && flow.from !== session.id) continue;
      const row = h("div", "peek-row");
      row.append(h("i", "", (flow.to === session.id ? "← " : "→ ") + flowLabel(flow)), name(flow.to === session.id ? flow.from : flow.to));
      card.append(row);
    }
    const shares = state.graph.shares.filter((share) => share.a === session.id || share.b === session.id);
    for (const share of shares.slice(0, 3)) {
      const row = h("div", "peek-row");
      row.append(h("i", "", "≈ " + share.files.slice(0, 2).join(", ") + (share.files.length > 2 ? " 외 " + (share.files.length - 2) : "")), name(share.a === session.id ? share.b : share.a));
      card.append(row);
    }
    const kids = state.graph.kids.get(session.id)?.length ?? 0;
    const of = many() ? projectOf(session.id) : undefined;
    card.append(h("div", "peek-foot", [of ? "프로젝트 " + projName(of) : "", session.client === "codex" ? "Codex" : "Claude Code", session.model, "요청 " + session.counts.prompts, "변경 " + session.counts.changes, kids ? "서브에이전트·곁가지 " + kids : ""].filter(Boolean).join(" · ")));
    card.hidden = false;
    // beside the tile where there is room, else under it; never off the map
    const wide = card.offsetWidth;
    const tall = card.offsetHeight;
    let x = box.right - stage.left + 10;
    let y = box.top - stage.top;
    if (x + wide > stage.width - 8) x = box.left - stage.left - wide - 10;
    if (x < 8) {
      // no room at either side: under the tile, or over it when the map ends below
      x = Math.max(8, Math.min(stage.width - wide - 8, box.left - stage.left));
      y = box.bottom - stage.top + 8;
      if (y + tall > stage.height - 8) y = box.top - stage.top - tall - 8;
    }
    card.style.left = x + "px";
    card.style.top = Math.max(8, Math.min(stage.height - tall - 8, y)) + "px";
  }, 380);
}

export function fitMap() {
  if (zoom) d3.select(el<HTMLElement>("map")).transition().duration(220).call(zoom.transform, fitted);
}

/** Below FAR only names and lines are shown; from NEAR on, what was asked and what went along the lines. */
const FAR = 0.75;
const NEAR = 1.35;
/** How wide the list in a label may be, close up: it must fit in the room between two columns. */
const MORE = 64;
const levelOf = (k: number) => (k < FAR ? "far" : k < NEAR ? "mid" : "near");

/** One step in or out: to the middle of the next level, about the middle of the window. */
export function stepZoom(dir: 1 | -1) {
  if (!zoom) return;
  const host = el<HTMLElement>("map");
  const k = d3.zoomTransform(host).k;
  const stops = [0.55, 1, 1.6];
  const next = dir > 0 ? stops.find((stop) => stop > k + 0.02) ?? 2 : [...stops].reverse().find((stop) => stop < k - 0.02) ?? 0.35;
  d3.select(host).transition().duration(240).call(zoom.scaleTo, next);
}

export function drawMap() {
  const host = el<HTMLElement>("map");
  const world = el<HTMLElement>("world");
  const svg = d3.select<SVGSVGElement, unknown>("#links");
  const sessions = [...state.on].map((id) => state.sessions.get(id)).filter((session): session is Session => Boolean(session));
  el<HTMLElement>("empty").hidden = sessions.length > 0;
  world.querySelectorAll(".tile, .pill, .zone, .zone-name").forEach((node) => node.remove());
  world.classList.remove("focus"); // the tile the pointer was on is gone with the rest, and with it the reason to dim
  hidePeek();
  svg.selectAll("*").remove();
  if (!zoom) {
    zoom = d3.zoom<HTMLElement, unknown>().scaleExtent([0.35, 2]).on("zoom", (event) => {
      hidePeek();
      world.style.transform = "translate(" + event.transform.x + "px," + event.transform.y + "px) scale(" + event.transform.k + ")";
      world.style.setProperty("--k", String(event.transform.k)); // letters are sized against it, to stay the same on the screen
      const level = levelOf(event.transform.k);
      if (world.dataset.level === level) return;
      const first = !world.dataset.level;
      world.dataset.level = level;
      // labels are other sizes at another level, so where they go is worked out again
      if (!first) { cancelAnimationFrame(again); again = requestAnimationFrame(() => { if (shown) drawMap(); }); }
    });
    // a press on a tile moves that tile, not the map (the wheel still zooms over it)
    zoom.filter((event) => {
      if ((event.ctrlKey && event.type !== "wheel") || event.button) return false;
      const tile = event.type === "wheel" ? null : (event.target as Element).closest?.<HTMLElement>(".tile");
      return !tile || lone(tile.dataset.id ?? "");
    });
    d3.select(host).call(zoom).on("dblclick.zoom", null);
  }
  if (!sessions.length) { shown = ""; return; }
  const ids = new Set(sessions.map((session) => session.id));
  const flows = state.graph.flows.filter((flow) => ids.has(flow.from) && ids.has(flow.to));
  const shares = state.graph.shares.filter((share) => ids.has(share.a) && ids.has(share.b));
  const box = host.getBoundingClientRect();
  const above = 54;
  const below = 46;
  const zones = many();
  const project = (state.snap?.project.id ?? "").split(",").sort().join(","); // the same projects are the same map, in whatever order they were put on it
  if (pinsOf !== project) readPins(project);
  const key = [...ids].sort().join(",") + "|" + flows.map((flow) => flow.from + ">" + flow.to).sort().join(",") + "|" + shares.length + "|" + Math.round(box.width) + "x" + Math.round(box.height);
  // Each project's part of the map, in the order they stand; with one project, the whole map is the one part.
  const known = new Set(projectsOn().map((one) => one.id));
  const partOf = (session: Session) => (!zones ? "" : session.projectId && known.has(session.projectId) ? session.projectId : projectsOn()[0].id);
  const parts: Zone[] = zones ? zoneOrder(projectsOn().map((one) => ({ id: one.id, sessions: sessions.filter((session) => partOf(session) === one.id) })), flows) : [{ id: "", sessions }];
  if (planned?.key !== key) planned = { key, plan: planZones(parts, flows, shares, { w: box.width - 48, h: box.height - above - below - 14 }) };
  let spots: Map<string, Spot>;
  let frames = new Map<string, Frame>();
  zoneOf = new Map(sessions.map((session) => [session.id, partOf(session)]));
  if (zones) {
    const set = placeZones(parts, flows, shares, planned.plan, pins);
    spots = set.spots;
    frames = set.frames;
    shifts = set.shift;
  } else {
    spots = layout(sessions, flows, shares, planned.plan.each);
    for (const [id, spot] of pins) if (spots.has(id)) spots.set(id, spot);
    shifts = new Map();
  }
  placed = spots;
  el<HTMLElement>("tidy").hidden = ![...pins.keys()].some((id) => ids.has(id));
  // Fit the whole picture in the window; it is set again only when the sessions shown, what ties them, or the window
  // changed, so that a refresh does not undo where the user moved to. (Worked out before the lines are drawn: how
  // wide a label is on the map goes by the zoom.)
  const all = [...spots.values()].map((spot): Frame => ({ x: spot.x, y: spot.y, w: W, h: H })); // a tile may have been dragged up or to the left of where the layout begins
  const bounds = zones ? [...frames.values()].map((frame): Frame => ({ x: frame.x - 4, y: frame.y - 10, w: frame.w + 8, h: frame.h + 14 })) : all; // the frames of the projects, and their names, are part of the picture
  const left = Math.min(...bounds.map((one) => one.x));
  const top = Math.min(...bounds.map((one) => one.y));
  const wide = Math.max(...bounds.map((one) => one.x + one.w)) - left;
  const tall = Math.max(...bounds.map((one) => one.y + one.h)) - top;
  pictured = { x: left, y: top, w: wide, h: tall };
  const fit = Math.max(0.45, Math.min(1, (box.width - 40) / wide, (box.height - above - below) / tall)); // from far off only names are shown, in letters that can still be read at this
  const free = box.height - above - below - tall * fit;
  fitted = d3.zoomIdentity.translate(Math.max(20, (box.width - wide * fit) / 2) - left * fit, above + Math.max(0, free) * 0.35 - top * fit).scale(fit);
  const scale = key !== shown ? fit : d3.zoomTransform(host).k;
  const level = levelOf(scale);
  const zoomed = Math.max(FAR, scale); // labels are not shown below FAR
  const name = (id: string) => state.sessions.get(id)?.title ?? "";
  const at = (id: string) => { const spot = spots.get(id)!; return { x: spot.x, y: spot.y, r: spot.x + W, b: spot.y + H, cx: spot.x + W / 2, cy: spot.y + H / 2 }; };
  const short = (text: string, room: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > room ? one.slice(0, room - 1) + "…" : one; };
  /** more: what a label says besides, close up (the pieces that went along a line, the files two sessions both changed).
   *  brief: there is no room for the label where it belongs, and it has come down to this mark (a number, or nothing
   *  but a dot or its icon); the label itself shows while the pointer is on it or on a session at one of its ends. */
  const pill = (x: number, y: number, cls: string, color: string, label: string, tip: string, a: string, b: string, icon = "", press?: () => void, more: string[] = [], brief?: string) => {
    const made = h("span", "pill " + cls + (press ? " press" : "") + (brief !== undefined ? " small" : ""));
    if (press) made.onclick = press;
    if (brief !== undefined) {
      const mark = h("span", "pill-short");
      if (icon) mark.innerHTML = icon;
      mark.append(brief);
      made.append(mark);
    }
    const head = h("span", "pill-head");
    if (icon) head.innerHTML = icon;
    head.append(label);
    made.append(head);
    if (more.length) {
      const list = h("span", "pill-more");
      for (const line of more.slice(0, 3)) list.append(h("span", "", line));
      if (more.length > 3) list.append(h("span", "", "외 " + (more.length - 3)));
      made.append(list);
    }
    made.style.left = x + "px";
    made.style.top = y + "px";
    made.style.setProperty("--c", color);
    made.title = tip;
    made.dataset.a = a;
    made.dataset.b = b;
    world.append(made);
  };

  // Labels must not sit on one another. Where each is put is kept, and a label that has more than one place to go
  // takes the first that is free. The labels of shared files have one place only, so they are placed first.
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  /** How much room a label takes on the map: its letters keep their size on the screen, and close up it lists what went along. */
  const size = (label: string, lines = 0, icon = false) => {
    const listed = level === "near" ? Math.min(lines, 3) + (lines > 3 ? 1 : 0) : 0;
    const w = ([...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 6 : 10.5), 0) + 19 + (icon ? 12 : 0)) / zoomed;
    return { w: listed ? Math.max(w, MORE + 18 / zoomed) : w, h: (20 + (listed ? listed * 13.5 + 7 : 0)) / zoomed };
  };
  /** The room of a label that has come down to a mark. */
  const tiny = (brief: string, icon = false) => ({ w: (Math.max(brief.length * 6.5 + (icon ? 11 : 0), 4) + 9) / zoomed, h: 16 / zoomed });
  /** A place on a curve: t runs from 0 at its beginning to 1 at its end. */
  const onCurve = (curve: number[], t: number): [number, number] => {
    const u = 1 - t;
    const weigh = (p0: number, p1: number, p2: number, p3: number) => u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    return [weigh(curve[0], curve[2], curve[4], curve[6]), weigh(curve[1], curve[3], curve[5], curve[7])];
  };
  const open = (x: number, y: number, room: { w: number; h: number }) => !taken.some((box) => Math.abs(box.x - x) < (box.w + room.w) / 2 + 4 && Math.abs(box.y - y) < (box.h + room.h) / 2 + 1);
  const tiles = sessions.map((session) => at(session.id));
  // each project's part of the map: what its frame holds
  const areas = [...frames].map(([id, frame]) => ({ id, rect: { x: frame.x, y: frame.y, r: frame.x + frame.w, b: frame.y + frame.h } }));
  // where context went both ways between two sessions, the two lines keep apart
  const both = new Set(flows.map((flow) => flow.from + " " + flow.to));
  const liftOf = (flow: Flow) => (both.has(flow.to + " " + flow.from) ? (flow.from < flow.to ? -11 : 11) : 0);
  // The lines along which a line can be led round the tiles: worked out only when some line needs to be.
  let made: Field | null = null;
  const grid = () => {
    if (!made) {
      const xs: number[] = [];
      const ys: number[] = [];
      const through = (id: string, lift: number) => { const tile = at(id); xs.push(tile.cx + lift); ys.push(tile.cy + lift); };
      for (const flow of flows) { through(flow.from, liftOf(flow)); through(flow.to, liftOf(flow)); }
      for (const share of shares) { through(share.a, 0); through(share.b, 0); }
      made = field(tiles, xs, ys, areas.map((area) => area.rect));
    }
    return made;
  };
  /** The parts of the map the two ends of a line are in: the line keeps out of the others where it can. */
  const homeOf = (one: string, other: string) => areas.flatMap((area, at) => (area.id === zoneOf.get(one) || area.id === zoneOf.get(other) ? [at] : []));
  /** Whether a line drawn through these points must be led another way: it would run behind a tile, or through the part of a project that neither of its ends is in. */
  const astray = (points: [number, number][], one: string, other: string) => {
    if (behind(points, tiles, at(one), at(other))) return true;
    const home = homeOf(one, other);
    return areas.some((area, index) => !home.includes(index) && points.some(([x, y]) => x > area.rect.x && x < area.rect.r && y > area.rect.y && y < area.rect.b));
  };
  const headOf = (way: Way, into: Rect) => {
    const [x, y] = way.points[way.points.length - 1];
    return way.into === "left" ? "M" + (into.x - 1) + " " + y + " l-10 -6 v12 z" : way.into === "right" ? "M" + (into.r + 1) + " " + y + " l10 -6 v12 z"
      : way.into === "top" ? "M" + x + " " + (into.y - 1) + " l-6 -10 h12 z" : "M" + x + " " + (into.b + 1) + " l-6 10 h12 z";
  };
  /** Whether a label put there would keep off every tile. */
  const clear = (x: number, y: number, room: { w: number; h: number }) => !tiles.some((tile) => x + room.w / 2 > tile.x + 1 && x - room.w / 2 < tile.r - 1 && y + room.h / 2 > tile.y + 1 && y - room.h / 2 < tile.b - 1);
  /** Whether another tile stands between two that are one over the other. */
  const blocked = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => tiles.some((tile) => tile.cy > Math.min(a.b, b.b) && tile.cy < Math.max(a.y, b.y) && tile.r > Math.min(a.x, b.x) && tile.x < Math.max(a.r, b.r));
  /** One over the other (their widths overlap), with this much room between them from top to bottom. */
  const stacked = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => a.x < b.r + 12 && b.x < a.r + 12;
  const gap = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => Math.max(b.y - a.b, a.y - b.b);
  // files two sessions both changed: a dotted line without a head, since it does not say context moved
  const ties = shares.map((share) => {
    let a = at(share.a);
    let b = at(share.b);
    let curve: number[]; // the line when nothing stands in its way
    let mx: number;
    if (stacked(a, b)) {
      if (a.y > b.y) [a, b] = [b, a];
      if (b.y - a.b > 0 && !blocked(a, b)) {
        const mid = (a.b + b.y) / 2;
        curve = [a.cx, a.b + 3, a.cx, mid, b.cx, mid, b.cx, b.y - 3];
        mx = (a.cx + b.cx) / 2;
      } else {
        const out = a.r + 40;
        curve = [a.r + 3, a.cy, out, a.cy, out, b.cy, b.r + 3, b.cy];
        mx = (a.r + 3) / 4 + out * 0.75;
      }
    } else {
      if (a.x > b.x) [a, b] = [b, a];
      const x1 = a.r + 3;
      const x2 = b.x - 3;
      const pull = Math.max(26, (x2 - x1) / 2);
      curve = [x1, a.cy, x1 + pull, a.cy, x2 - pull, b.cy, x2, b.cy];
      mx = (x1 + x2) / 2;
    }
    const label = share.files.length === 1 ? share.files[0] : "파일 " + share.files.length;
    let my = stacked(a, b) && b.y - a.b > 0 && !blocked(a, b) ? (a.b + b.y) / 2 : (a.cy + b.cy) / 2;
    let d = drawn([curve]);
    let rests: [number, number][] = [[mx, my], ...[0.35, 0.65, 0.25, 0.75].map((t) => onCurve(curve, t))]; // where its label may sit, the best first
    if (astray(sampled([curve]), share.a, share.b)) {
      // it would run behind a tile: round the tiles instead
      const way = route(grid(), a, b, { home: homeOf(share.a, share.b) });
      if (way) {
        d = rounded(way.points);
        rests = restsOn(way.points);
      }
    }
    // The label keeps off the tiles and the labels before it; where the whole of it has no room, its icon stands for it.
    const full = size(label, share.files.length > 1 ? share.files.length : 0, true);
    const brief = share.files.length > 1 ? String(share.files.length) : "";
    const small = tiny(brief, true);
    const fits = (room: { w: number; h: number }) => rests.find(([x, y]) => open(x, y, room) && clear(x, y, room));
    let room = full;
    let spot = fits(full);
    if (!spot) { room = small; spot = fits(small) ?? rests.find(([x, y]) => open(x, y, small)) ?? rests[0]; }
    [mx, my] = spot;
    taken.push({ x: mx, y: my, ...room });
    return { share, d, mx, my, label, brief: room === small ? brief : undefined };
  });

  // Context that moved: a line in the colour of the session it came from, an arrowhead where it arrived. The line and
  // its label can be pressed: they open the list of what went along it.
  const fan = d3.group(flows, (flow) => flow.from + " " + flowLabel(flow));
  const said = new Set<string>();
  for (const flow of flows) {
    const a = at(flow.from);
    const b = at(flow.to);
    const color = colorOf(flow.from);
    const label = flowLabel(flow);
    const waits = !flow.links.length; // nothing has gone along it yet
    const found = !waits && flow.links.every((link) => link.grade === "paste"); // nothing recorded: only text that matches
    const look = waits ? " wait" : found ? " found" : "";
    const tip = "‘" + name(flow.from) + "’ → ‘" + name(flow.to) + "’ · " + label + (waits ? " · 받는 세션에 다음 말을 치면 함께 갑니다" : found ? " · 기록에는 없고 글자를 견줘 찾았습니다 · 누르면 근거를 봅니다" : " · 누르면 넘어간 것을 봅니다");
    const lift = liftOf(flow);
    const y1 = a.cy + lift;
    const y2 = b.cy + lift;
    let d: string;
    let head: string;
    let mx: number;
    let places: [number, number][] = []; // where the label may go, the best first
    let bend: number[] = []; // the line when it is one curve: its two ends and the two points that pull it
    let curves: number[][] = []; // the line when it is more than one
    // A line that passes over columns in between must not run behind the tiles there: it takes the nearest gap
    // between their rows, and its label sits in that gap.
    const between = sessions.map((session) => at(session.id)).filter((spot) => spot.x > Math.min(a.x, b.x) + 1 && spot.x < Math.max(a.x, b.x) - 1);
    const hidden = between.some((spot) => spot.y - 8 < Math.max(y1, y2) && spot.b + 8 > Math.min(y1, y2));
    const lane = hidden
      ? between.flatMap((spot) => [spot.y - GY / 2, spot.b + GY / 2]).filter((y) => !between.some((spot) => y > spot.y - 9 && y < spot.b + 9))
          .sort((p, q) => Math.abs(p - y1) + Math.abs(p - y2) - Math.abs(q - y1) - Math.abs(q - y2))[0]
      : undefined;
    const over = stacked(a, b);
    if (over && gap(a, b) >= 40 && !blocked(a, b)) {
      // one over the other with room between them (a tile was moved there): straight down, or up, from the one into the other
      const turn = b.y >= a.b ? 1 : -1;
      const xa = a.cx + lift;
      const xb = b.cx + lift;
      const ya = turn > 0 ? a.b + 2 : a.y - 2;
      const yb = turn > 0 ? b.y - 10 : b.b + 10;
      const pull = Math.max(16, Math.abs(yb - ya) / 2);
      d = "M" + xa + " " + ya + " C" + xa + " " + (ya + turn * pull) + " " + xb + " " + (yb - turn * pull) + " " + xb + " " + yb;
      bend = [xa, ya, xa, ya + turn * pull, xb, yb - turn * pull, xb, yb];
      head = "M" + xb + " " + (turn > 0 ? b.y - 1 : b.b + 1) + " l-6 " + -turn * 10 + " h12 z";
      mx = (xa + xb) / 2;
    } else if (!over && b.x > a.x) {
      const x1 = a.r + 2;
      const x2 = b.x - 10;
      const pull = Math.max(26, (x2 - x1) / 2);
      d = "M" + x1 + " " + y1 + " C" + (x1 + pull) + " " + y1 + " " + (x2 - pull) + " " + y2 + " " + x2 + " " + y2;
      bend = [x1, y1, x1 + pull, y1, x2 - pull, y2, x2, y2];
      if (lane !== undefined) {
        const turn = GX - 4; // each bend stays inside the room between two columns
        curves = [[x1, y1, x1 + turn * 0.6, y1, x1 + turn * 0.4, lane, x1 + turn, lane], [x1 + turn, lane, x2 - turn, lane], [x2 - turn, lane, x2 - turn * 0.4, lane, x2 - turn * 0.6, y2, x2, y2]];
        d = drawn(curves);
        places = [[(x1 + x2) / 2, lane], [x2 - turn / 2, (lane + y2) / 2], [x1 + turn / 2, (y1 + lane) / 2]];
      }
      head = "M" + (b.x - 1) + " " + y2 + " l-10 -6 v12 z";
      mx = (x1 + x2) / 2;
    } else if (!over && b.x < a.x) {
      // back to the left: out of the left side, in at the right side
      const x1 = a.x - 2;
      const x2 = b.r + 10;
      const pull = Math.max(26, (x1 - x2) / 2);
      d = "M" + x1 + " " + y1 + " C" + (x1 - pull) + " " + y1 + " " + (x2 + pull) + " " + y2 + " " + x2 + " " + y2;
      bend = [x1, y1, x1 - pull, y1, x2 + pull, y2, x2, y2];
      if (lane !== undefined) {
        const turn = GX - 4;
        curves = [[x1, y1, x1 - turn * 0.6, y1, x1 - turn * 0.4, lane, x1 - turn, lane], [x1 - turn, lane, x2 + turn, lane], [x2 + turn, lane, x2 + turn * 0.4, lane, x2 + turn * 0.6, y2, x2, y2]];
        d = drawn(curves);
        places = [[(x1 + x2) / 2, lane], [x2 + turn / 2, (lane + y2) / 2], [x1 - turn / 2, (y1 + lane) / 2]];
      }
      head = "M" + (b.r + 1) + " " + y2 + " l10 -6 v12 z";
      mx = (x1 + x2) / 2;
    } else {
      // The same column, or one over the other with no room between: out to one side and in again. To the right,
      // unless tiles stand close on that side and none on the left: beside a column of tiles is where the lines
      // and the labels between the columns are.
      const upper = Math.min(a.y, b.y);
      const lower = Math.max(a.b, b.b);
      const beside = (from: number, to: number) => tiles.filter((tile) => tile.b > upper && tile.y < lower && tile.r > from && tile.x < to).length;
      const rightmost = Math.max(a.r, b.r);
      const leftmost = Math.min(a.x, b.x);
      if (beside(leftmost - 100, leftmost - 1) < beside(rightmost + 1, rightmost + 100)) {
        const x1 = a.x - 2;
        const x2 = b.x - 10;
        const out = leftmost - 56;
        bend = [x1, y1, out, y1, out, y2, x2, y2];
        head = "M" + (b.x - 1) + " " + y2 + " l-10 -6 v12 z";
        mx = (x1 + x2) / 8 + out * 0.75;
      } else {
        const x1 = a.r + 2;
        const x2 = b.r + 10;
        const out = rightmost + 56;
        bend = [x1, y1, out, y1, out, y2, x2, y2];
        head = "M" + (b.r + 1) + " " + y2 + " l10 -6 v12 z";
        mx = (x1 + x2) / 8 + out * 0.75;
      }
      d = drawn([bend]);
    }
    // Drawn so, the line may still run behind a tile (a tile that was moved; a session of another project; a row that
    // has no gap where the line needs one), or through the part of a project it has nothing to do with. It is then
    // led round the tiles, at right angles, and its label sits on it.
    if (astray(sampled(curves.length ? curves : [bend]), flow.from, flow.to)) {
      const way = route(grid(), a, b, { lift, head: true, home: homeOf(flow.from, flow.to) });
      if (way) {
        d = rounded(way.points);
        head = headOf(way, b);
        places = restsOn(way.points);
      }
    }
    if (!places.length) places = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78].map((t) => onCurve(bend, t)); // along the curve: its middle first, then further and further towards either end
    const group = svg.append("g").attr("class", "link" + look).attr("data-a", flow.from).attr("data-b", flow.to).style("--c", color);
    group.append("path").attr("class", "pipe").attr("d", d);
    if (!look) group.append("path").attr("class", "beads").attr("d", d);
    group.append("path").attr("class", "head").attr("d", head);
    group.append("path").attr("class", "press").attr("d", d).on("click", () => act.openEdge(flow.from, flow.to)).append("title").text(tip);
    // Several sessions that came out of the same one the same way share one label, where the lines leave it.
    const together = fan.get(flow.from + " " + label)!;
    const plain = together.every((one) => !one.waiting.length && one.links.every((link) => link.kind !== "transfer" && link.kind !== "paste") && at(one.to).x > a.x + 1);
    if (together.length > 1 && plain) {
      if (said.has(flow.from + " " + label)) continue;
      said.add(flow.from + " " + label);
      taken.push({ x: a.r + 36, y: a.cy, ...size(label) });
      pill(a.r + 36, a.cy, "flow", color, label, "‘" + name(flow.from) + "’에서 " + together.length + "개 세션으로 · " + label, flow.from, together.map((one) => one.to).join(" "), "", () => act.openEdge(flow.from, null));
    } else {
      const went = [...flow.links.filter((link) => link.kind === "transfer" || link.kind === "paste").map((link) => link.excerpt ?? ""), ...flow.waiting.map((piece) => piece.excerpt)].filter(Boolean);
      // A label stays on its own line (off it, nobody could tell whose it is) and keeps off the other labels and off
      // the tiles. Where there is no room for that, what it lists gives way first; then the label comes down to a
      // mark (how many pieces went, or a bare dot) that says the rest when the pointer is on it. Only a mark may
      // touch a tile, and it is put on another label only when its line has no free place at all.
      const full = size(label, went.length);
      const bare = size(label, 0);
      const count = flow.links.filter((link) => link.kind === "transfer" || link.kind === "paste").length + flow.waiting.length;
      const brief = count ? String(count) : "";
      const small = tiny(brief);
      const fits = (room: { w: number; h: number }, strict: boolean) => places.find(([x, y]) => open(x, y, room) && (!strict || clear(x, y, room)));
      let room = full;
      let spot = fits(full, true);
      if (!spot) { room = bare; spot = fits(bare, true); }
      if (!spot) { room = small; spot = fits(small, true) ?? fits(small, false) ?? places[0]; }
      const [px, py] = spot;
      taken.push({ x: px, y: py, ...room });
      pill(px, py, "flow" + look, color, label, tip, flow.from, flow.to, "", () => act.openEdge(flow.from, flow.to), room === full ? went.map((text) => "“" + short(text, 24) + "”") : [], room === small ? brief : undefined);
    }
  }
  for (const tie of ties) {
    svg.append("path").attr("class", "link tieline").attr("data-a", tie.share.a).attr("data-b", tie.share.b).attr("d", tie.d);
    pill(tie.mx, tie.my, "share", "", tie.label, "둘 다 고친 파일: " + tie.share.files.join(", "), tie.share.a, tie.share.b, ICON.file, undefined, tie.share.files.length > 1 && tie.brief === undefined ? tie.share.files : [], tie.brief);
  }

  // each project's frame, around wherever its tiles stand, with its name on its upper edge (over any line that crosses there)
  for (const one of zones ? projectsOn() : []) {
    const frame = frames.get(one.id);
    if (!frame) continue;
    const zone = h("div", "zone");
    zone.style.left = frame.x + "px";
    zone.style.top = frame.y + "px";
    zone.style.width = frame.w + "px";
    zone.style.height = frame.h + "px";
    const name = h("span", "zone-name", projName(one));
    name.style.left = frame.x + 16 + "px";
    name.style.top = frame.y + "px";
    world.append(zone, name);
  }

  const now = state.snap!.madeAt;
  const asked = new Map<string, string>(); // what was last asked of each session: shown on its tile close up
  for (const item of state.snap!.items) if (item.kind === "prompt") asked.set(item.sessionId, item.label);
  for (const session of sessions) {
    const spot = spots.get(session.id)!;
    const tile = h("button", "tile " + session.activity + (state.open === session.id ? " open" : ""));
    tile.dataset.id = session.id;
    tile.style.left = spot.x + "px";
    tile.style.top = spot.y + "px";
    tile.style.setProperty("--c", colorOf(session.id));
    tile.append(h("span", "tile-title", session.title));
    const ask = asked.get(session.id);
    if (ask && ask.slice(0, 30) !== session.title.slice(0, 30)) tile.append(h("span", "tile-ask", ask)); // a session asked one thing is named after it already
    const meta = h("span", "tile-meta");
    const status = h("span", "tile-status");
    const quiet = quietFor(session, now);
    if (session.activity === "running" && session.needs) {
      // it has stopped to be allowed something, or to be answered: the one state that will not pass by itself
      tile.classList.add("needs");
      status.append(h("i", "bang", "!"), h("span", "", stateWord(session) + (quiet >= 2 ? " · " + quiet + "분째" : "")));
    } else if (session.activity === "running") status.append(h("i", "pulse"), h("span", "", "작업 중" + (quiet >= 2 ? " · " + quiet + "분째 조용" : session.nowFile ? " · " + session.nowFile.split("/").pop() : "")));
    else if (session.activity === "waiting") status.append(h("span", "", "답 기다림"));
    else status.append(h("span", "", ago(session.updatedAt, now) + " 전"));
    meta.append(status);
    // The small marks share one pill, and say how many only when there are more than one (the number is in their tip).
    const marks = h("span", "tile-marks");
    const kids = state.graph.kids.get(session.id)?.length ?? 0;
    if (kids) {
      const chip = h("span", "chipx");
      chip.innerHTML = ICON.branch;
      if (kids > 1) chip.append(String(kids));
      chip.title = "이 세션이 부린 서브에이전트와 곁가지 대화 " + kids + "개";
      marks.append(chip);
    }
    const far = (state.snap!.far ?? []).filter((one) => (owner(one.sessionId)?.id ?? one.sessionId) === session.id);
    if (far.length) {
      // pieces that went between this session and sessions of other projects: no line can show them here
      const chip = h("span", "chipx reach");
      chip.append("⇄" + (far.length > 1 ? " " + far.length : ""));
      chip.title = "다른 프로젝트의 세션과 주고받은 조각 " + far.length + "개 (" + [...new Set(far.map((one) => one.other.projectName))].join(", ") + "). 누르면 봅니다.";
      chip.onclick = (event) => { event.stopPropagation(); act.openEdge(session.id, null); };
      marks.append(chip);
    }
    const off = [...(state.graph.near.get(session.id) ?? [])].filter((id) => !state.on.has(id));
    if (off.length) {
      const chip = h("span", "chipx reach");
      chip.innerHTML = ICON.link;
      chip.append("+" + off.length);
      chip.title = "이어진 세션 " + off.length + "개가 꺼져 있습니다. 누르면 켭니다.";
      chip.onclick = (event) => { event.stopPropagation(); off.forEach((id) => state.on.add(id)); act.render(); };
      marks.append(chip);
    }
    if (marks.childElementCount) meta.append(marks);
    meta.append(h("span", "tile-counts", "요청 " + session.counts.prompts + (session.counts.changes ? " · 변경 " + session.counts.changes : "")));
    // which client: a shape, as at the head of a talk (a circle for Codex, a square for Claude Code)
    const client = h("i", "tile-client client-mark " + session.client);
    client.title = CLIENT[session.client];
    client.setAttribute("role", "img");
    client.setAttribute("aria-label", CLIENT[session.client]);
    meta.append(client);
    tile.append(meta);
    if (moving === session.id) tile.classList.add("moving");
    tile.onpointerdown = (event) => grab(event, session.id, spot);
    tile.onclick = () => { if (Date.now() - movedAt < 350) return; hidePeek(); act.openChat(session.id); };
    tile.onpointerenter = () => { if (moving) return; act.hover(session.id); if (Date.now() > state.calm) peek(session, tile); };
    tile.onpointerleave = () => { if (moving) return; act.hover(null); hidePeek(); };
    world.append(tile);
  }

  if (key !== shown) {
    d3.select(host).call(zoom.transform, fitted);
    shown = key;
  }
  markTrace();
  if (moving) focusMap(moving); // the tile under the hand, and its lines, stay lit while everything is drawn again
}

/** A press on a tile that may turn into moving it: it does once the pointer has gone a little way. The tile follows
 *  the pointer, its lines with it, and stays where it is let go. */
function grab(event: PointerEvent, id: string, spot: Spot) {
  if (event.button !== 0 || lone(id)) return;
  const host = el<HTMLElement>("map");
  const x0 = event.clientX;
  const y0 = event.clientY;
  let frame = 0;
  // With several projects on the map the tile's place is one within its project's part. That part keeps its upper
  // left corner: a tile dragged past the corner pushes the rest of the part, and the parts after it, along instead.
  // The view goes with what is pushed, so that the tile stays under the hand and its neighbours stay where they were.
  const off = shiftOf(id);
  const home = { x: spot.x - off.x, y: spot.y - off.y };
  const pushed = { x: 0, y: 0 };
  const whole = inView(); // the whole picture could be seen when the tile was taken up
  const follow = () => {
    const now = shiftOf(id);
    const dx = now.x - off.x - pushed.x;
    const dy = now.y - off.y - pushed.y;
    if (!zoom || (!dx && !dy)) return;
    pushed.x += dx;
    pushed.y += dy;
    d3.select(host).call(zoom.translateBy, -dx, -dy);
  };
  const move = (now: PointerEvent) => {
    const dx = now.clientX - x0;
    const dy = now.clientY - y0;
    if (!moving) {
      if (Math.hypot(dx, dy) < 5) return;
      moving = id;
      hidePeek();
      document.body.classList.add("moving");
    }
    const k = d3.zoomTransform(host).k;
    pins.set(id, { x: Math.round((home.x + dx / k) / SNAP) * SNAP, y: Math.round((home.y + dy / k) / SNAP) * SNAP });
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawMap(); follow(); });
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    if (!moving) return;
    moving = null;
    movedAt = Date.now();
    state.calm = movedAt + 1500; // the pointer rests on the tile it has just put down: no card pops up for that
    document.body.classList.remove("moving");
    cancelAnimationFrame(frame);
    settle(id);
    keepPins();
    drawMap();
    follow();
    // a part of the map that grew has pushed others along, perhaps out of the window: what could be seen whole before is fitted in again
    if (shifts.size && whole && !inView()) fitMap();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** While a piece is being followed, the sessions and lines on its way stay lit and the rest steps back. */
function markTrace() {
  const world = el<HTMLElement>("world");
  const trace = state.trace;
  world.classList.toggle("tracing", Boolean(trace));
  world.querySelectorAll(".on-path").forEach((node) => node.classList.remove("on-path"));
  if (!trace) return;
  const top = (id: string) => owner(id)?.id ?? id;
  const ids = new Set([top(trace.piece.sessionId)]);
  const pairs = new Set<string>();
  for (const step of trace.steps) {
    const from = top(step.link.from.sessionId);
    const to = top(step.link.to.sessionId);
    ids.add(from).add(to);
    pairs.add(from + " " + to);
  }
  world.querySelectorAll<HTMLElement>(".tile").forEach((node) => node.classList.toggle("on-path", ids.has(node.dataset.id!)));
  world.querySelectorAll<HTMLElement>("[data-a]").forEach((node) => {
    if (node.classList.contains("tieline") || node.classList.contains("share")) return; // files both changed are not a way a piece went
    node.classList.toggle("on-path", node.dataset.b!.split(" ").some((other) => pairs.has(node.dataset.a + " " + other)));
  });
}
