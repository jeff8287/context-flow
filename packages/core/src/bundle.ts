// A bundle: some sessions of a project as they stood at one moment, with everything said and changed in them and what
// ties them, in one file. It is what an experiment hands every participant: the same record, read the same way on
// any machine, with none of the clients' own records at hand. A bundle is only ever read: nothing is sent from it.
// Nothing of Node in here: the screen opens a bundle by itself, with no server.
import type { Item, Link, Session, Snapshot } from "./model.ts";
import { findIn, talkOf } from "./read.ts";
import { tracePiece } from "./trace.ts";

export interface Bundle {
  kind: "context-flow-bundle";
  version: 1;
  madeAt: number;
  snapshot: Snapshot;
  /** Every item of the sessions in it, with its text. */
  items: Item[];
  /** How the screen stands when the bundle is opened, so that everyone starts from the same view.
   *  on: the sessions on the map; none named means the screen's own choice (which the frozen record settles too).
   *  spots: the tiles the person had put somewhere by hand, each with its place on the map. */
  view: { on: string[]; theme: "light" | "dark"; spots?: Spot[] };
}

/** A session's tile and where it stands on the map: [session id, x, y]. */
export type Spot = [string, number, number];

export interface BundleOptions {
  /** The sessions to put in; their subagents and side talks come along. Left out: every session of the project. */
  sessions?: string[];
  /** The sessions on the map when the bundle is opened. Left out: the sessions named above. */
  on?: string[];
  theme?: "light" | "dark";
  name?: string;
  /** Where tiles were put by hand; the ones of sessions that are not on the map to begin with are left out. */
  spots?: Spot[];
}

const hangs = (session: Session) => session.origin === "subagent" || session.origin === "side";

export function makeBundle(snapshot: Snapshot, bodies: Map<string, Item>, options: BundleOptions = {}): Bundle {
  const all = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const picked = options.sessions?.filter((id) => all.has(id));
  const chosen = new Set(picked ?? all.keys());
  // what hangs off a chosen session is part of it
  for (let grew = true; grew; ) {
    grew = false;
    for (const session of snapshot.sessions) {
      if (!chosen.has(session.id) && hangs(session) && session.parentId && chosen.has(session.parentId)) { chosen.add(session.id); grew = true; }
    }
  }
  if (!chosen.size) throw new Error("내보낼 세션이 없습니다");
  // Taken from a map of several projects, the bundle keeps which project each session is of, for as many of them as
  // the chosen sessions are in; with one left, it is a bundle of that project.
  const within = snapshot.sessions.filter((session) => chosen.has(session.id));
  const parts = (snapshot.projects ?? []).filter((one) => within.some((session) => session.projectId === one.id));
  const many = parts.length > 1;
  const from = many || !parts.length ? snapshot.project : parts[0];
  const project = { id: "bundle:" + snapshot.madeAt.toString(36), name: options.name ?? (many ? parts.map((one) => one.name).join(" + ") : from.name), roots: many ? [...new Set(parts.flatMap((one) => one.roots))] : from.roots };
  const sessions = within.map((session) => ({ ...session, projectId: many ? session.projectId : project.id, recordPath: null }));
  const tops = sessions.filter((session) => !hangs(session) || !session.parentId || !chosen.has(session.parentId));
  const two = (value: number) => String(value).padStart(2, "0");
  const when = new Date(snapshot.madeAt);
  const notes = [
    two(when.getMonth() + 1) + "-" + two(when.getDate()) + " " + two(when.getHours()) + ":" + two(when.getMinutes()) + "에 내보낸 기록입니다. 세션 " + tops.length + "개" + (sessions.length > tops.length ? "(딸린 대화 " + (sessions.length - tops.length) + "개 포함)" : "") + "가 들어 있고, 여기서는 읽기만 합니다.",
    ...snapshot.notes.filter((note) => note.startsWith("점선 화살표")),
  ];
  // what was at work then is shown as it was; the record of it ends where it had got to
  const busy = tops.filter((session) => session.activity === "running");
  if (busy.length) notes.push("내보낼 때 작업 중이던 세션 " + busy.length + "개(" + busy.map((session) => "‘" + session.title.slice(0, 24) + "’").join(", ") + ")는 그때까지의 기록만 들어 있습니다.");
  const on = (options.on ?? picked ?? []).filter((id) => tops.some((session) => session.id === id));
  const spots = (options.spots ?? []).filter((spot) => tops.some((session) => session.id === spot[0]));
  return {
    kind: "context-flow-bundle",
    version: 1,
    madeAt: snapshot.madeAt,
    snapshot: {
      version: 1,
      madeAt: snapshot.madeAt,
      project,
      ...(many ? { projects: parts } : {}),
      sessions,
      items: snapshot.items.filter((item) => chosen.has(item.sessionId)),
      links: snapshot.links.filter((link: Link) => chosen.has(link.from.sessionId) && chosen.has(link.to.sessionId)),
      waiting: [], // nothing waits in a record that is only read
      hooks: { codex: "absent", claude: "absent" },
      overlaps: snapshot.overlaps
        .map((overlap) => ({ path: overlap.path, touches: overlap.touches.filter((touch) => chosen.has(touch.sessionId)) }))
        .filter((overlap) => new Set(overlap.touches.map((touch) => touch.sessionId)).size > 1),
      notes,
    },
    items: [...bodies.values()].filter((item) => chosen.has(item.sessionId)),
    view: { on, theme: options.theme === "dark" ? "dark" : "light", ...(spots.length ? { spots } : {}) },
  };
}

/** The fields of a bundle that hold what somebody wrote or where something lies: names, folders, texts. */
const WRITTEN = new Set(["title", "cwd", "nowFile", "name", "roots", "label", "path", "text", "added", "excerpt"]);

/** A bundle with some words covered wherever they stand in what was written: in what was said and changed, in the
 *  names of sessions and projects, in paths. A word is covered by as many marks as it has letters, so that every
 *  letter after it stays where it was: the ranges of links (which stretch of an answer a piece is) still point at
 *  the same letters. Capitals are not minded. Ids and the tool's own words are left as they are. */
export function maskBundle(bundle: Bundle, words: string[]): { bundle: Bundle; covered: number } {
  const wanted = [...new Set(words.map((word) => word.trim()).filter((word) => word.length >= 2))].sort((a, b) => b.length - a.length);
  if (!wanted.length) return { bundle, covered: 0 };
  const find = new RegExp(wanted.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let covered = 0;
  const cover = (text: string) => text.replace(find, (found) => { covered += 1; return "•".repeat(found.length); });
  const walk = (value: unknown, written: boolean): unknown => {
    if (typeof value === "string") return written ? cover(value) : value;
    if (Array.isArray(value)) return value.map((one) => walk(one, written));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, walk(one, WRITTEN.has(key))]));
    return value;
  };
  const snapshot = walk({ ...bundle.snapshot, notes: [] }, false) as Bundle["snapshot"];
  const items = walk(bundle.items, false) as Item[];
  if (!covered) return { bundle, covered };
  snapshot.notes = [...bundle.snapshot.notes, "낱말 " + wanted.length + "개(사용자 이름 등)를 " + covered + "곳에서 같은 글자 수의 ‘•’로 가렸습니다. 글자의 자리는 그대로여서 연결이 가리키는 구간은 바뀌지 않았습니다."];
  return { bundle: { ...bundle, snapshot, items }, covered };
}

/** Take what was read from a file for a bundle, or say why it is not one. */
export function readBundle(value: unknown): Bundle {
  const bundle = value as Bundle | null;
  if (!bundle || typeof bundle !== "object" || bundle.kind !== "context-flow-bundle") throw new Error("맥락 흐름에서 내보낸 묶음 파일이 아닙니다");
  if (bundle.version !== 1) throw new Error("이 도구가 읽지 못하는 판의 묶음 파일입니다 (판 " + String(bundle.version) + ")");
  const snapshot = bundle.snapshot;
  if (!snapshot || !Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.links) || !Array.isArray(bundle.items) || !snapshot.project?.id) throw new Error("묶음 파일이 온전하지 않습니다");
  return {
    ...bundle,
    snapshot: { ...snapshot, waiting: [], hooks: { codex: "absent", claude: "absent" }, overlaps: snapshot.overlaps ?? [], notes: snapshot.notes ?? [] },
    view: {
      on: Array.isArray(bundle.view?.on) ? bundle.view.on : [], theme: bundle.view?.theme === "dark" ? "dark" : "light",
      ...(Array.isArray(bundle.view?.spots) ? { spots: bundle.view.spots.filter((spot) => Array.isArray(spot) && typeof spot[0] === "string" && Number.isFinite(spot[1]) && Number.isFinite(spot[2])) } : {}),
    },
  };
}

const byId = new WeakMap<Bundle, Map<string, Item>>();
function bodiesOf(bundle: Bundle): Map<string, Item> {
  let map = byId.get(bundle);
  if (!map) byId.set(bundle, (map = new Map(bundle.items.map((item) => [item.id, item]))));
  return map;
}

/** What the server would answer to a GET, answered from the bundle. */
export function answer(bundle: Bundle, path: string): unknown {
  const url = new URL(path, "http://bundle");
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const bodies = bodiesOf(bundle);
  switch (url.pathname) {
    case "/api/projects":
      return { projects: [bundle.snapshot.project] };
    case "/api/snapshot":
      return bundle.snapshot;
    case "/api/item": {
      const item = bodies.get(param("id"));
      if (!item) throw new Error("그런 조각이 없습니다");
      return item;
    }
    case "/api/talk":
      if (!bundle.snapshot.sessions.some((session) => session.id === param("session"))) throw new Error("그런 세션이 없습니다");
      return { items: talkOf(bundle.items, param("session")) };
    case "/api/find":
      return { hits: findIn(bundle.items, param("q")) };
    case "/api/trace": {
      const item = bodies.get(param("item"));
      if (!item) throw new Error("그런 조각이 없습니다");
      const start = Math.max(0, Number(param("start")) || 0);
      const end = Math.min(item.text.length, Number(param("end") || item.text.length) || item.text.length);
      return { steps: tracePiece({ sessionId: item.sessionId, itemId: item.id, start, end }, bundle.snapshot.links, bodies, bundle.snapshot.sessions) };
    }
    case "/api/turn/active":
      return { turn: null };
    default:
      throw new Error("내보낸 기록에서는 할 수 없는 일입니다");
  }
}
