// What every part of the screen shares: the snapshot, which sessions are on the map, and small helpers.
import { answer, type Bundle } from "../../core/src/bundle.ts";
import type { Client, HookState, ItemKind, Link, LinkKind, Piece, Place, Project, Session, Snapshot, TraceStep, Waiting } from "../../core/src/model.ts";

export const KIND = { prompt: "지시", answer: "답변", change: "변경" } as const;
export const CLIENT = { codex: "Codex", claude: "Claude Code" } as const;
export const STATUS = { running: "작업 중", waiting: "답 기다림", idle: "쉬는 중", archived: "보관됨" } as const;
/** A session's state in a word: what it is at or, while it is at work, what it waits on the person for. */
export const stateWord = (session: Session) => (session.activity === "running" && session.needs ? (session.needs === "approval" ? "허용 기다림" : "입력 기다림") : STATUS[session.activity]);
/** For how many minutes a session at work has written nothing: a long command, or a wait nobody has noticed. */
export const quietFor = (session: Session, now: number) => (session.activity === "running" ? Math.max(0, Math.floor((now - session.updatedAt) / 60_000)) : 0);
/** A link's kind in a word, for the label on its line. */
export const LINK: Record<LinkKind, string> = { fork: "갈라짐", spawn: "새로 만듦", subagent: "서브에이전트", side: "곁가지", import: "가져옴", transfer: "전달", paste: "붙여넣기" };
/** The colours a session on the map can take. Each is dark enough for white text on it. */
export const PALETTE = ["#4F5BD5", "#08857A", "#C2570C", "#C2357A", "#1A73E8", "#2B8A3E", "#8B46D6", "#9A6700", "#0E7C9B", "#D0453F"];
export const MINUTE = 60_000;

/** Context that moved from one session to another: every recorded link between the two, in that direction. One line on the map.
 *  waiting: pieces set to go that way with the next thing said to the receiving session. A flow may be nothing but those. */
export interface Flow { from: string; to: string; links: Link[]; waiting: Waiting[]; at: number }
/** A piece kept in the basket, to be sent along with a message. where (of Piece): the session it came from, said in
 *  full, so that it can be shown and sent while another project is on the screen. */
export interface Held extends Piece {
  id: string;
  text: string;
  kind: ItemKind;
  at: number;
  /** Cut from what its session said and then left behind: the session has it no more, and can be sent it like any other. */
  left?: boolean;
}
/** Two sessions that changed the same files. Not a flow: it does not say context moved. */
export interface Share { a: string; b: string; files: string[] }
export interface Graph {
  flows: Flow[];
  shares: Share[];
  /** Subagents and side talks, by the session they hang off. */
  kids: Map<string, Session[]>;
  /** For each session, the sessions a flow joins it to. */
  near: Map<string, Set<string>>;
}

/** A stretch of an item's text to be marked on the page; parts: the several stretches of it that count (the grounds of a paste). */
export interface Span { start: number; end: number; parts?: [number, number][] }
/** A piece being followed: where it came from and where it went. shown: the pane shows the way now, not a talk. */
/** left: the stops of the way that lie in what a session said and then left behind: what each is, and when it was said. */
export interface Trace { piece: Piece; text: string; steps: TraceStep[]; shown: boolean; left?: Record<string, { kind: ItemKind; at: number }> }

/** A place in a session's talk where the words being looked for were said. */
export interface Hit { id: string; sessionId: string; kind: "prompt" | "answer"; at: number; before: string; match: string; after: string }

export const state = {
  snap: null as Snapshot | null,
  /** Every project there is to choose from, whether or not it is on the map. */
  projects: [] as Project[],
  /** Which clients the server can start: one that is not on this computer is not offered for a new session. */
  clients: { codex: true, claude: true } as Record<Client, boolean>,
  sessions: new Map<string, Session>(),
  graph: { flows: [], shares: [], kids: new Map(), near: new Map() } as Graph,
  /** The sessions switched on in the sidebar: the ones the map shows. */
  on: new Set<string>(),
  colors: new Map<string, string>(),
  /** The session whose talk is open. */
  open: null as string | null,
  query: "",
  /** Where the words being looked for were said, and for which words that was asked. */
  hits: [] as Hit[],
  hitsFor: "",
  archived: false,
  lanes: false,
  /** The pieces picked from talks and not yet thrown away, and the ones among them that go with the next message. */
  basket: [] as Held[],
  attached: new Set<string>(),
  /** Which side of a session the pane shows, and the line of the map it shows instead of a session. */
  tab: "talk" as "talk" | "context",
  edge: null as { from: string; to: string } | null,
  trace: null as Trace | null,
  /** The exported record being read, if the screen is not reading the clients' own records. Nothing is sent from it. */
  bundle: null as Bundle | null,
  /** The screen has no server behind it: it is an exported page, and the bundle is all there is. */
  alone: false,
  /** A session about to be begun from here: the pane shows where its first request is written. */
  /** The new session being begun. away: its folder is being chosen from the disk ('다른 폴더…'), and may lie outside the projects on the map. */
  fresh: null as { client: Client; cwd?: string; like?: string; away?: boolean } | null,
  /** Until when a tile under the pointer keeps its card to itself: a piece has just been let go there. */
  calm: 0,
  /** The server tells this screen when the records change: it need not ask as often to find out. */
  live: false,
};

/** What one part asks of the others. main.ts fills these in. */
export const act = {
  render: () => {},
  /** Open a session's talk; at an item of it; with a stretch of that item marked. */
  openChat: (_id: string, _item?: string, _span?: Span) => {},
  hover: (_id: string | null) => {},
  /** Read the project's records again, keeping what is on and what is open. */
  refresh: async () => {},
  /** A first session was begun in a folder from the empty screen: open the map of its project, and its talk, once its record is read. */
  began: (_session: string, _cwd: string) => {},
  /** Show what went along a line of the map; with no other end, a session's own context. */
  openEdge: (_from: string, _to: string | null) => {},
  /** Follow a piece both ways and show the way; text: the piece, or the beginning of it, to head the way with. */
  openTrace: (_piece: Piece, _text: string) => {},
  /** Open the pane in which a new session is begun, with the pieces now attached. */
  openNew: () => {},
  /** Open a session of another project: that project is put on the map beside what is there (so that what went
   *  between them is a line), and the session's talk opened; at an item of it; with a stretch of that item marked. */
  openElsewhere: (_project: string, _session: string, _item?: string, _span?: Span) => {},
  /** Put another project on the map beside what is there. False when there is no such project to put there. */
  addProject: async (_project: string) => false,
};

/** The projects on the map: one, as a rule. */
export const projectsOn = (): Project[] => state.snap?.projects ?? (state.snap ? [state.snap.project] : []);
/** Whether more than one project is on the map: only then is a session said to be of one. */
export const many = () => (state.snap?.projects?.length ?? 0) > 1;
/** The project a session is in, of the ones on the map. */
export function projectOf(sessionId: string): Project | undefined {
  const session = state.sessions.get(sessionId);
  if (!session || !state.snap) return undefined;
  return (state.snap.projects ?? []).find((one) => one.id === session.projectId) ?? state.snap.project;
}
/** A project's name, told from another of the same name by the folder it lies in. */
export function projName(project: Project): string {
  const all = [...state.projects, ...projectsOn()];
  if (!all.some((one) => one.id !== project.id && one.name === project.name)) return project.name;
  const above = (project.roots[0] ?? "").split("/").filter(Boolean).slice(-2, -1)[0];
  return above ? project.name + " (" + above + ")" : project.name;
}

/** Whether the server answered the last thing asked of it; main.ts says so on the screen when it did not. */
export const net = { down: false, changed: () => {} };
async function reach(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    if (!net.down) { net.down = true; net.changed(); }
    throw new Error("서버에 닿지 않습니다");
  }
  if (net.down) { net.down = false; net.changed(); }
  return response;
}

/** What a line between two sessions says: how the one came out of the other, and how many pieces were sent along. */
export function flowLabel(flow: Flow): string {
  const ways = [...new Set(flow.links.filter((link) => link.kind !== "transfer" && link.kind !== "paste").map((link) => LINK[link.kind]))];
  const pieces = flow.links.filter((link) => link.kind === "transfer").length;
  const pastes = flow.links.filter((link) => link.kind === "paste").length;
  return [...ways, pieces ? "조각 " + pieces : "", pastes ? "붙여넣기 " + pastes : "", flow.waiting.length ? "대기 " + flow.waiting.length : ""].filter(Boolean).join(" · ");
}

/** Why a piece set to wait for a session will not go, or did not go, in a line. Empty when nothing stands in its way. */
export function hookTrouble(client: Client, hook: HookState, missed: boolean): string {
  if (hook === "absent") return CLIENT[client] + "에 context-flow 플러그인이 없어 조각이 실리지 않습니다. 설치해 주세요.";
  if (hook === "untrusted") return "Codex에서 context-flow 훅을 아직 승인하지 않아 조각이 실리지 않습니다. 터미널에서 codex를 열어 훅을 승인해 주세요.";
  if (missed) return "걸어 둔 뒤에 이 세션에 말을 했는데 조각이 실리지 않았습니다. 훅을 승인하기 전부터 열려 있던 세션이면 " + CLIENT[client] + "를 다시 켜 주세요.";
  return "";
}

// The basket is one for the whole tool and is kept by the server, so that a piece picked in one project can be given
// to a session of another, and so that it is the same basket in whatever browser the screen is opened. (An exported
// record has no server: its basket stays in the browser, as it was.)
const basketKey = () => "cf-basket:" + (state.snap?.project.id ?? "");
let saving = 0;
export function keepBasket() {
  if (!state.bundle) {
    clearTimeout(saving);
    saving = window.setTimeout(() => { saving = 0; void post("/api/basket", { pieces: state.basket }).catch(() => {}); }, 120);
    return;
  }
  try {
    localStorage.setItem(basketKey(), JSON.stringify(state.basket));
  } catch { /* storage may be shut off; the basket then lasts for this page only */ }
}
export async function loadBasket(project: string) {
  state.attached = new Set();
  if (state.bundle) {
    try {
      const kept = JSON.parse(localStorage.getItem("cf-basket:" + project) ?? "[]");
      state.basket = Array.isArray(kept) ? kept : [];
    } catch {
      state.basket = [];
    }
    return;
  }
  const kept = await call<{ pieces: Held[] }>("/api/basket").catch(() => null);
  state.basket = kept && Array.isArray(kept.pieces) ? kept.pieces : [];
  if (!kept) return; // the server did not answer: what this browser still keeps stays where it is
  // What this browser kept before the basket moved to the server is brought over once. Which project each was kept
  // in is known from where it was kept; the rest of where it came from is filled in when that project is on the screen.
  try {
    let moved = false;
    for (const key of Object.keys(localStorage).filter((name) => name.startsWith("cf-basket:"))) {
      const kept = JSON.parse(localStorage.getItem(key) ?? "[]");
      for (const piece of Array.isArray(kept) ? (kept as Held[]) : []) {
        if (state.basket.some((one) => one.itemId === piece.itemId && one.start === piece.start && one.end === piece.end)) continue;
        state.basket.push(piece.where ? piece : { ...piece, where: { project: key.slice("cf-basket:".length), projectName: "", title: "", client: "codex" } });
        moved = true;
      }
      localStorage.removeItem(key);
    }
    if (moved) keepBasket();
  } catch { /* storage may be shut off: nothing was kept in it then */ }
}
/** The basket as the server has it now, when it is not what this page has: another window of the screen changed it. */
export async function syncBasket() {
  if (state.bundle || saving) return;
  const kept = await call<{ pieces: Held[] }>("/api/basket").catch(() => null);
  if (!kept || !Array.isArray(kept.pieces) || JSON.stringify(kept.pieces) === JSON.stringify(state.basket)) return;
  state.basket = kept.pieces;
  for (const id of [...state.attached]) if (!state.basket.some((piece) => piece.id === id)) state.attached.delete(id);
}
/** What a session on the screen is, said in full (its own project, of the ones on the map): kept with a piece, for when another project is on the screen. */
export function placeOf(sessionId: string): Place | undefined {
  const session = state.sessions.get(sessionId);
  const project = projectOf(sessionId);
  return session && project ? { project: project.id, projectName: project.name, title: session.title, client: session.client } : undefined;
}
/** Fill in where the kept pieces of this project came from, for the ones that do not say (kept before they had to). */
export function labelBasket() {
  let changed = false;
  for (const piece of state.basket) {
    const place = piece.where?.title ? undefined : placeOf(piece.sessionId);
    if (!place) continue;
    piece.where = place;
    changed = true;
  }
  if (changed) keepBasket();
}
/** Whether a kept piece came from a session of another project than the one on the screen. */
export const afar = (piece: { sessionId: string }) => !state.sessions.has(piece.sessionId);
/** The name of the session a kept piece came from, whichever project that is in. */
export const whose = (piece: { sessionId: string; where?: Place }) => state.sessions.get(piece.sessionId)?.title ?? (piece.where?.title || "다른 프로젝트의 세션");

export const ICON = {
  clip: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 9.2 9.4 14.4a2.9 2.9 0 0 1-4.1-4.1l5.9-5.9a1.9 1.9 0 0 1 2.7 2.7l-5.8 5.8a.9.9 0 0 1-1.3-1.3l5-5"/></svg>',
  install: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="10" rx="2"/><path d="M6.5 16.5h7"/><path d="M10 5.8v4.6M8 8.6l2 2 2-2"/></svg>',
  bell: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 14v-4.5a4.5 4.5 0 0 1 9 0V14"/><path d="M3.8 14h12.4"/><path d="M8.4 16.6a1.7 1.7 0 0 0 3.2 0"/></svg>',
  bellOn: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 14v-4.5a4.5 4.5 0 0 1 6.2-4.2"/><path d="M14.5 10.6V14"/><path d="M3.8 14h12.4"/><path d="M8.4 16.6a1.7 1.7 0 0 0 3.2 0"/><circle cx="14.6" cy="5.6" r="2.3" fill="currentColor" stroke="none"/></svg>',
  bellOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 14v-4.5a4.5 4.5 0 0 1 .5-2"/><path d="M8.3 5.5a4.5 4.5 0 0 1 6.2 4v2"/><path d="M3.8 14h10.4"/><path d="M8.4 16.6a1.7 1.7 0 0 0 3.2 0"/><path d="M3.5 3.5l13 13"/></svg>',
  side: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="3.5" width="15" height="13" rx="3"/><path d="M7.5 3.5v13"/></svg>',
  fit: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4"/></svg>',
  refresh: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 10a6 6 0 1 1-1.8-4.3"/><path d="M16.2 3.6v3.2H13"/></svg>',
  theme: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 0 0 13z" fill="currentColor"/></svg>',
  chat: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v5A2.5 2.5 0 0 1 13.5 13H9l-3.5 3v-3A2.5 2.5 0 0 1 4 10.5z"/></svg>',
  close: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="5.5" y="5.5" width="9" height="9" rx="2" fill="currentColor"/></svg>',
  send: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.5v-11M5.5 9L10 4.5 14.5 9"/></svg>',
  back: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 5.4h5.9a3.1 3.1 0 0 1 0 6.2H5.2"/><path d="M5.1 2.9 2.6 5.4l2.5 2.5"/></svg>',
  branch: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.5" cy="3" r="1.6"/><circle cx="3.5" cy="11" r="1.6"/><circle cx="10.5" cy="5" r="1.6"/><path d="M3.5 4.6v4.8M10.5 6.6c0 2.2-3 1.6-5.6 2.9"/></svg>',
  link: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 8a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 8 2.5l-.8.8M8 6a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 6 11.5l.8-.8"/></svg>',
  file: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3.5 1.8h4.2l2.8 2.8v7.6h-7z"/><path d="M7.7 1.8v2.8h2.8"/></svg>',
  io: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3v9M6.5 6.5L10 3l3.5 3.5"/><path d="M4 11.5v3A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5v-3"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 5v10M5 10h10"/></svg>',
  minus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 10h10"/></svg>',
  tidy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="3.5" width="5" height="5" rx="1.3"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.3"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.3"/><rect x="11.5" y="11.5" width="5" height="5" rx="1.3"/></svg>',
  fresh: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5H6A2.5 2.5 0 0 0 3.5 6v8A2.5 2.5 0 0 0 6 16.5h8a2.5 2.5 0 0 0 2.5-2.5v-4"/><path d="M14.5 3v5M12 5.5h5"/></svg>',
  time: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 6h9M3 10h14M3 14h6"/><circle cx="14.5" cy="6" r="1.4"/><circle cx="11.5" cy="14" r="1.4"/></svg>',
};

export const el = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (cls) made.className = cls;
  if (text !== undefined) made.textContent = text;
  return made;
}
export async function call<T>(path: string): Promise<T> {
  if (state.bundle) return answer(state.bundle, path) as T; // a bundle answers for itself, the way the server would
  const response = await reach(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body as T;
}

export async function post<T>(path: string, payload: unknown): Promise<T> {
  if (state.bundle) throw new Error("내보낸 기록은 읽기만 할 수 있습니다");
  const response = await reach(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body as T;
}

export const top = (session: Session) => session.origin !== "subagent" && session.origin !== "side";
/** A session in which nothing was ever said is not listed. */
export const empty = (session: Session) => session.counts.prompts + session.counts.answers + session.counts.changes === 0;
export const tops = () => state.snap!.sessions.filter((session) => top(session) && !empty(session));
/** The session a subagent or side talk hangs off, however deep. */
export function owner(id: string): Session | undefined {
  let session = state.sessions.get(id);
  for (let guard = 0; session && !top(session) && session.parentId && guard < 8; guard += 1) session = state.sessions.get(session.parentId);
  return session;
}

/** A session's colour: given the first time it is asked for, the one least used among the sessions now on, and kept. */
export function colorOf(id: string): string {
  let color = state.colors.get(id);
  if (!color) {
    const used = new Map<string, number>();
    for (const other of state.on) {
      const taken = state.colors.get(other);
      if (taken) used.set(taken, (used.get(taken) ?? 0) + 1);
    }
    color = [...PALETTE].sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0))[0];
    state.colors.set(id, color);
  }
  return color;
}

const two = (value: number) => String(value).padStart(2, "0");
export const clock = (at: number) => { const date = new Date(at); return two(date.getHours()) + ":" + two(date.getMinutes()); };
export const day = (at: number) => { const date = new Date(at); return two(date.getMonth() + 1) + "-" + two(date.getDate()); };
/** How long ago, the way a sidebar says it. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE));
  if (minutes < 1) return "방금";
  if (minutes < 60) return minutes + "분";
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "시간";
  const days = Math.round(hours / 24);
  if (days < 14) return days + "일";
  if (days < 60) return Math.round(days / 7) + "주";
  return Math.round(days / 30) + "달";
}
const wide = (text: string, px: number) => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) < 128 ? 0.56 : 1) * px, 0);
/** As much of a name as fits in room pixels at px, keeping a closing "(2)" so that a fork is told from its parent. */
export function fit(text: string, px: number, room: number): string {
  if (wide(text, px) <= room) return text;
  const tail = /\s?\(\d+\)$/.exec(text)?.[0] ?? "";
  let head = text.slice(0, text.length - tail.length);
  while (head && wide(head + "…" + tail, px) > room) head = head.slice(0, -1);
  return head.trimEnd() + "…" + tail;
}

/** What ties the project's sessions, worked out once for a snapshot. */
export function buildGraph(snap: Snapshot): Graph {
  const lines = new Map<string, Flow>();
  const near = new Map<string, Set<string>>();
  const listed = new Set(snap.sessions.filter((session) => top(session) && !empty(session)).map((session) => session.id));
  for (const link of snap.links) {
    // what a subagent or a side talk said belongs, on the map, to the session it hangs off
    const from = owner(link.from.sessionId)?.id ?? link.from.sessionId;
    const to = owner(link.to.sessionId)?.id ?? link.to.sessionId;
    if (from === to || !listed.has(from) || !listed.has(to)) continue;
    const line = lines.get(from + " " + to) ?? { from, to, links: [], waiting: [], at: link.to.at };
    line.links.push(link);
    lines.set(from + " " + to, line);
    near.set(from, (near.get(from) ?? new Set()).add(to));
    near.set(to, (near.get(to) ?? new Set()).add(from));
  }
  for (const piece of snap.waiting ?? []) {
    const from = piece.from.sessionId;
    const to = piece.to.sessionId;
    if (from === to || !listed.has(from) || !listed.has(to)) continue;
    const line = lines.get(from + " " + to) ?? { from, to, links: [], waiting: [], at: piece.at };
    line.waiting.push(piece);
    lines.set(from + " " + to, line);
    near.set(from, (near.get(from) ?? new Set()).add(to));
    near.set(to, (near.get(to) ?? new Set()).add(from));
  }
  const flows = [...lines.values()];
  const pairs = new Map<string, Share>();
  for (const overlap of snap.overlaps) {
    const ids: string[] = [];
    for (const touch of overlap.touches) {
      const id = owner(touch.sessionId)?.id;
      if (id && listed.has(id) && !ids.includes(id)) ids.push(id);
    }
    const name = overlap.path.split("/").pop()!;
    for (let one = 0; one < ids.length; one += 1) {
      for (let other = one + 1; other < ids.length; other += 1) {
        const [a, b] = ids[one] < ids[other] ? [ids[one], ids[other]] : [ids[other], ids[one]];
        const pair = pairs.get(a + " " + b) ?? { a, b, files: [] };
        if (!pair.files.includes(name)) pair.files.push(name);
        pairs.set(a + " " + b, pair);
      }
    }
  }
  const kids = new Map<string, Session[]>();
  for (const session of snap.sessions) {
    if (top(session)) continue;
    const id = owner(session.id)?.id;
    if (id && id !== session.id) kids.set(id, [...(kids.get(id) ?? []), session]);
  }
  return { flows, shares: [...pairs.values()], kids, near };
}
