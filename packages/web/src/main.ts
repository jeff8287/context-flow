// The screen, laid out like a chat app: sessions in a sidebar, switched on and off there; the ones that are on drawn
// on a map with what ties them; a session's talk opened from the map.
import { readBundle, type Bundle } from "../../core/src/bundle.ts";
import type { Piece, Project, Session, Snapshot, TraceStep } from "../../core/src/model.ts";
import { closeChat, drawChat, drawEdge, drawNew, drawTrace } from "./chat.ts";
import { drawLanes } from "./lanes.ts";
import { drawMap, fitMap, focusMap, spotsOf, stepZoom, tidyMap } from "./map.ts";
import { noticeLine, noticesOf, type Notice } from "./notice.ts";
import { act, ago, buildGraph, call, CLIENT, colorOf, el, h, ICON, labelBasket, loadBasket, many, net, owner, projectOf, projectsOn, projName, state, syncBasket, tops, type Span } from "./state.ts";
import "./style.css";

const GROUPS: [string, Session["activity"]][] = [["작업 중", "running"], ["답 기다림", "waiting"], ["이전", "idle"], ["보관됨", "archived"]];
const FIRST = 8; // how many sessions are on to begin with, at most
/** What is asked of the server: the ids of the projects on the map, with commas between; or the id an exported record goes by. */
let project = "";
/** The projects on the map, in the order they were put there. */
let chosen: string[] = [];
/** The exported records opened in this screen, by the id of the project each stands for. */
const bundles = new Map<string, Bundle>();
const two = (value: number) => String(value).padStart(2, "0");
const stamp = (at: number) => { const date = new Date(at); return two(date.getMonth() + 1) + "-" + two(date.getDate()) + " " + two(date.getHours()) + ":" + two(date.getMinutes()); };

/** What is on to begin with: the sessions at work, the ones tied to them, then the ones waiting for an answer, newest first. */
function defaults(): string[] {
  const live = tops().filter((session) => session.activity !== "archived");
  const picks = new Set(live.filter((session) => session.activity === "running").map((session) => session.id));
  const alive = new Set(live.map((session) => session.id));
  const near = new Set<string>();
  for (const flow of state.graph.flows) {
    if (picks.has(flow.from)) near.add(flow.to);
    if (picks.has(flow.to)) near.add(flow.from);
  }
  for (const share of state.graph.shares) {
    if (picks.has(share.a)) near.add(share.b);
    if (picks.has(share.b)) near.add(share.a);
  }
  for (const id of near) if (picks.size < FIRST && alive.has(id)) picks.add(id);
  const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const session of recent) if (picks.size < FIRST && session.activity === "waiting") picks.add(session.id);
  for (const session of recent) if (picks.size < 3) picks.add(session.id);
  // with several projects on the map, each is seen on it: one that has fewer than three sessions on shows the ones it was last in
  if (many()) for (const one of projectsOn()) {
    const mine = recent.filter((session) => session.projectId === one.id);
    let on = mine.filter((session) => picks.has(session.id)).length;
    for (const session of mine) {
      if (on >= 3) break;
      if (picks.has(session.id)) continue;
      picks.add(session.id);
      on += 1;
    }
  }
  return [...picks];
}

function toggle(id: string) {
  if (state.on.has(id)) state.on.delete(id);
  else state.on.add(id);
  render();
}

function row(session: Session, now: number): HTMLElement {
  const on = state.on.has(session.id);
  const made = h("div", "row " + session.activity + (on ? " on" : "") + (state.open === session.id ? " open" : ""));
  made.dataset.id = session.id;
  made.tabIndex = 0;
  made.setAttribute("role", "checkbox");
  made.setAttribute("aria-checked", String(on));
  made.title = session.title + " · " + CLIENT[session.client] + (on ? " · 누르면 지도에서 뺍니다" : " · 누르면 지도에 올립니다");
  if (on) made.style.setProperty("--c", colorOf(session.id));
  made.append(h("span", "sw " + session.client), h("span", "row-title", session.title));
  const of = many() ? projectOf(session.id) : undefined;
  if (of) made.title = "프로젝트 " + projName(of) + " · " + made.title;
  if (session.activity === "running") made.append(session.needs ? h("span", "row-bang", "!") : h("span", "row-live"));
  if (session.activity === "running" && session.needs) made.title += session.needs === "approval" ? " · 허용을 기다리는 중" : " · 답을 기다리는 중";
  made.append(h("span", "row-age", ago(session.updatedAt, now)));
  const chat = h("button", "row-chat icon");
  chat.innerHTML = ICON.chat;
  chat.title = "대화 열기";
  chat.onclick = (event) => { event.stopPropagation(); act.openChat(session.id); };
  made.append(chat);
  made.onclick = () => toggle(session.id);
  made.onkeydown = (event) => {
    if (event.target !== made || (event.key !== " " && event.key !== "Enter")) return;
    event.preventDefault();
    toggle(session.id);
  };
  made.onpointerenter = () => act.hover(session.id);
  made.onpointerleave = () => act.hover(null);
  return made;
}

function drawSide() {
  const list = el<HTMLElement>("list");
  const keep = list.scrollTop;
  list.textContent = "";
  const now = state.snap!.madeAt;
  const query = state.query.trim().toLowerCase();
  const all = tops().filter((session) => !query || session.title.toLowerCase().includes(query));
  for (const [label, activity] of GROUPS) {
    const mine = all.filter((session) => session.activity === activity).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!mine.length) continue;
    const fold = activity === "archived" && !query;
    const head = h("div", "group" + (fold ? " fold" : ""));
    head.append(label + (state.bundle && activity === "running" ? " · 내보낼 때" : ""), h("b", "", String(mine.length)));
    if (fold) {
      head.append(h("span", "caret", state.archived ? "접기" : "펴기"));
      head.onclick = () => { state.archived = !state.archived; drawSide(); };
    }
    list.append(head);
    if (fold && !state.archived) continue;
    if (!many()) {
      for (const session of mine) list.append(row(session, now));
      continue;
    }
    // with several projects on the map: the sessions of each together, under its name
    for (const one of projectsOn()) {
      const theirs = mine.filter((session) => session.projectId === one.id);
      if (!theirs.length) continue;
      list.append(h("div", "subgroup", projName(one)));
      for (const session of theirs) list.append(row(session, now));
    }
  }
  // where the words were said, under the sessions whose names hold them
  const listed = new Set(tops().map((session) => session.id));
  const hits = state.hitsFor === query ? state.hits.filter((hit) => listed.has(hit.sessionId)) : [];
  if (hits.length) {
    const head = h("div", "group");
    head.append("대화에서 찾은 곳", h("b", "", String(hits.length)));
    list.append(head);
    for (const hit of hits) {
      const made = h("div", "hit");
      made.dataset.id = hit.sessionId;
      const words = h("span", "hit-words");
      words.append(hit.before, h("mark", "", hit.match), hit.after);
      made.append(h("span", "hit-where", (hit.kind === "prompt" ? "요청 · " : "답 · ") + (state.sessions.get(hit.sessionId)?.title ?? "")), words);
      made.title = "이 대화의 그 자리 열기";
      made.onclick = () => act.openChat(hit.sessionId, hit.id);
      made.onpointerenter = () => act.hover(hit.sessionId);
      made.onpointerleave = () => act.hover(null);
      list.append(made);
    }
  }
  if (!all.length && !hits.length) list.append(h("div", "none", query ? "찾는 세션이 없습니다" : "이 프로젝트에는 아직 세션이 없습니다"));
  list.scrollTop = keep;
  const count = tops().length;
  el<HTMLElement>("foot").textContent = "";
  const sum = h("span", "", "세션 " + count + "개 중 " + [...state.on].filter((id) => state.sessions.has(id)).length + "개 켬");
  const notes = state.snap!.notes;
  el<HTMLElement>("foot").append(sum);
  if (notes.length) {
    const note = h("span", "note", "알아둘 것 " + notes.length);
    note.title = notes.join("\n");
    el<HTMLElement>("foot").append(note);
  }
}

/** What the lines mean. The line for pieces that wait is explained only while there is one. */
function drawLegend() {
  el<HTMLElement>("legend").innerHTML =
    '<span><svg width="30" height="10"><path d="M1 5 H22" stroke="currentColor" stroke-width="3"/><path d="M29 5 l-8 -4.5 v9 z" fill="currentColor"/></svg>맥락이 넘어감</span>' +
    (state.graph.flows.some((flow) => flow.waiting.length)
      ? '<span><svg width="30" height="10"><path d="M1 5 H20" stroke="currentColor" stroke-width="2.4" stroke-dasharray="2 5" stroke-linecap="round"/><path d="M28.5 5 l-7 -4 v8 z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>다음 말을 기다림</span>'
      : "") +
    (state.graph.flows.some((flow) => flow.links.some((link) => link.grade === "paste"))
      ? '<span><svg width="30" height="10"><path d="M1 5 H22" stroke="currentColor" stroke-width="2.4" stroke-dasharray="6 4"/><path d="M29 5 l-8 -4.5 v9 z" fill="currentColor"/></svg>붙여넣은 흔적</span>'
      : "") +
    '<span><svg width="24" height="10"><path d="M1 5 H23" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 5" stroke-linecap="round"/></svg>같은 파일을 고침</span>';
}

/** What is to be exported, and whether it can be: the sessions now on the map, of a project read from the clients' own records. */
function drawIo() {
  const ids = [...state.on].filter((id) => state.sessions.has(id));
  const can = !state.bundle && ids.length > 0;
  el<HTMLElement>("io-what").textContent = state.bundle ? "내보낸 기록을 보는 중입니다" : ids.length ? "지도에 켠 세션 " + ids.length + "개를 내보냅니다" : "내보낼 세션을 지도에 켜 주세요";
  el<HTMLButtonElement>("export-html").disabled = !can;
  el<HTMLButtonElement>("export-json").disabled = !can;
  el<HTMLElement>("mask-row").hidden = Boolean(state.bundle);
  el<HTMLElement>("mask-words").hidden = Boolean(state.bundle) || !el<HTMLInputElement>("mask").checked;
  // a record that was exported says so, and when: nothing in it moves, and nothing can be sent
  const frozen = el<HTMLElement>("frozen");
  frozen.hidden = !state.bundle;
  if (state.bundle) frozen.textContent = "내보낸 기록 · " + stamp(state.bundle.madeAt) + " · 읽기 전용";
  el<HTMLElement>("refresh").hidden = Boolean(state.bundle);
  el<HTMLElement>("notify").hidden = Boolean(state.bundle); // nothing in an exported record comes to an end
  el<HTMLElement>("app").classList.toggle("frozen", Boolean(state.bundle));
}

function exportAs(kind: "html" | "json") {
  const ids = [...state.on].filter((id) => state.sessions.has(id));
  if (state.bundle || !ids.length) return;
  const link = h("a");
  // the tiles that were put somewhere by hand go where they were put, for whoever opens the file
  const spots = spotsOf(ids).map(([id, x, y]) => id + ":" + x + ":" + y).join(",");
  const words = el<HTMLInputElement>("mask-words").value.trim();
  link.href = "/api/export?project=" + encodeURIComponent(project) + "&sessions=" + ids.join(",") + "&as=" + kind + "&theme=" + (document.documentElement.dataset.theme ?? "light")
    + (spots ? "&spots=" + encodeURIComponent(spots) : "") + (el<HTMLInputElement>("mask").checked ? "&mask=1" + (words ? "&words=" + encodeURIComponent(words) : "") : "");
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  el<HTMLElement>("io-menu").hidden = true;
}

function render() {
  drawSide();
  drawIo();
  drawLegend();
  el<HTMLElement>("drawer").hidden = !state.lanes;
  el<HTMLElement>("lanes-toggle").classList.toggle("on", state.lanes);
  if (state.lanes) drawLanes();
  drawMap(); // last: it fits itself to the room the sidebar, the drawer and the talk leave
}

function hover(id: string | null) {
  document.querySelectorAll(".hot").forEach((node) => node.classList.remove("hot"));
  if (id) document.querySelectorAll('[data-id="' + CSS.escape(id) + '"]').forEach((node) => node.classList.add("hot"));
  focusMap(id);
}

function openChat(id: string, item?: string, span?: Span) {
  if (!state.sessions.has(id)) return;
  if (state.trace) state.trace.shown = false; // the way stays on the map; the pane goes to the talk
  state.on.add(owner(id)?.id ?? id); // a subagent's own talk can be opened (a paste may come out of it), but on the map it is its owner's tile
  state.open = id;
  state.edge = null;
  state.fresh = null;
  state.tab = "talk";
  el<HTMLElement>("chat").hidden = false; // before the map is drawn, so that the map fits the room the talk leaves it
  render();
  void drawChat(id, item, false, span);
}

/** A line of the map was pressed: show what went along it. With no other end, the session's own context. */
function openEdge(from: string, to: string | null) {
  if (!state.sessions.has(from)) return;
  state.trace = null;
  state.fresh = null;
  el<HTMLElement>("chat").hidden = false;
  if (to === null) {
    state.on.add(from);
    state.open = from;
    state.edge = null;
    state.tab = "context";
    render();
    void drawChat(from);
    return;
  }
  state.open = null;
  state.edge = { from, to };
  render();
  drawEdge();
}

/** Follow a piece back to where it first appeared and onward to where it went, and show the way. */
async function openTrace(piece: Piece, text: string) {
  const query = "project=" + encodeURIComponent(project) + "&item=" + encodeURIComponent(piece.itemId) + "&start=" + piece.start + "&end=" + piece.end;
  const { steps } = await call<{ steps: TraceStep[] }>("/api/trace?" + query).catch(() => ({ steps: [] as TraceStep[] }));
  state.trace = { piece, text, steps, shown: true };
  state.fresh = null;
  // every session on the way goes on the map, so that the way can be seen there
  for (const id of [piece.sessionId, ...steps.flatMap((step) => [step.link.from.sessionId, step.link.to.sessionId])]) {
    const top = owner(id)?.id;
    if (top && tops().some((session) => session.id === top)) state.on.add(top);
  }
  el<HTMLElement>("chat").hidden = false;
  render();
  drawTrace();
}

/** Open a session of another project: the project is put on the map beside what is there, so that what went between
 *  them is a line, and the session's talk is opened. */
async function openElsewhere(id: string, session: string, item?: string, span?: Span) {
  if (!state.sessions.has(session) && !(await withProject(id, true))) return;
  openChat(session, item, span);
}

const CARET = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>';
/** A folder, short enough for a list: the home folder as ~, and of a long way only the end. */
function shortPath(path: string): string {
  const home = path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  return home.length > 34 ? "…" + home.slice(-33) : home;
}
/** The address follows what is on the map, so that loading the page again comes back to it. */
const address = () => history.replaceState(null, "", "?project=" + chosen.map(encodeURIComponent).join(","));

/** The button that says which projects are on the map, and the list they are chosen from. A press on a name shows
 *  that project alone; a press on the box before it puts it on the map beside what is there, or takes it off. */
function drawPicker() {
  const button = el<HTMLButtonElement>("project");
  const on = state.bundle ? [state.bundle.snapshot.project] : chosen.map((id) => state.projects.find((one) => one.id === id)).filter((one): one is Project => Boolean(one));
  button.textContent = "";
  button.append(h("span", "proj-name", on.map((one) => (state.bundle ? one.name : projName(one))).join(" + ") || "프로젝트"));
  if (on.length > 1) button.append(h("b", "proj-count", String(on.length)));
  if (!state.alone) {
    const caret = h("span", "proj-caret");
    caret.innerHTML = CARET;
    button.append(caret);
  }
  button.title = on.map((one) => one.name + " · " + one.roots.join(", ")).join("\n");
  button.disabled = state.alone; // the record in the page is all there is
  const menu = el<HTMLElement>("project-menu");
  menu.textContent = "";
  if (state.alone) return;
  menu.append(h("div", "proj-hint", "이름을 누르면 그 프로젝트만 봅니다. 앞의 네모를 누르면 지금 지도에 함께 올립니다."));
  // the ones on the map first, in the order they were put there; then the rest, as the Codex sidebar has them
  const listed = state.bundle ? state.projects : [...on, ...state.projects.filter((one) => !chosen.includes(one.id))];
  for (const one of listed) {
    const here = !state.bundle && chosen.includes(one.id);
    const row = h("div", "proj-row" + (here ? " on" : ""));
    const box = h("button", "proj-with");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(here));
    box.setAttribute("aria-label", one.name + (here ? " 지도에서 내리기" : " 지도에 함께 올리기"));
    box.title = here ? (chosen.length > 1 ? "지도에서 내리기" : "지금 보는 프로젝트입니다") : "지도에 함께 올리기";
    box.disabled = here && chosen.length < 2;
    box.onclick = () => void (state.bundle ? show([one.id]) : withProject(one.id, !here));
    const only = h("button", "proj-only");
    only.append(h("span", "proj-title", one.name), h("span", "proj-path", shortPath(one.roots[0] ?? "")));
    only.title = one.roots.join("\n");
    only.onclick = () => void show([one.id]);
    row.append(box, only);
    menu.append(row);
  }
  if (bundles.size) menu.append(h("div", "proj-sep", "내보낸 기록"));
  for (const [id, bundle] of bundles) {
    const row = h("div", "proj-row" + (state.bundle === bundle ? " on" : ""));
    const only = h("button", "proj-only");
    only.append(h("span", "proj-title", bundle.snapshot.project.name), h("span", "proj-path", stamp(bundle.madeAt) + "에 내보냄 · 읽기 전용"));
    only.onclick = () => void showBundle(id);
    row.append(only);
    menu.append(row);
  }
}

/** Show these projects and nothing else, as when the screen is opened on them. */
async function show(ids: string[]) {
  el<HTMLElement>("project-menu").hidden = true;
  const before = { bundle: state.bundle, chosen };
  state.bundle = null;
  chosen = ids;
  address();
  drawPicker();
  try {
    await load(ids.join(","));
  } catch {
    // they could not be read (the server does not answer): what was on the screen stays, and is still what is named
    state.bundle = before.bundle;
    chosen = before.chosen;
    address();
    drawPicker();
  }
}

/** Show an exported record that was opened here. */
async function showBundle(id: string) {
  const bundle = bundles.get(id);
  if (!bundle) return;
  el<HTMLElement>("project-menu").hidden = true;
  state.bundle = bundle;
  drawPicker();
  await load(id); // answered by the bundle itself: no server is asked
}

/** Put a project on the map beside what is there, or take it off: what is on, and what is open, stays as it is.
 *  False when it cannot be done (no such project; an exported record is being read). */
async function withProject(id: string, on: boolean): Promise<boolean> {
  if (state.bundle || !state.projects.some((one) => one.id === id)) return false;
  const next = on ? (chosen.includes(id) ? chosen : [...chosen, id]) : chosen.filter((one) => one !== id);
  if (!next.length) return false;
  if (next.length === chosen.length) return true; // it is there already
  const before = chosen;
  chosen = next;
  address();
  drawPicker();
  try {
    await load(next.join(","), "widen", on ? id : undefined);
  } catch {
    chosen = before; // it could not be read: the map stays as it was
    address();
    drawPicker();
    return false;
  }
  return true;
}

/** After a project came on the map or went off it: what is gone with a project is let go, and of a project that
 *  came, the sessions worth seeing first are switched on. */
function widen(added?: string) {
  const has = (id: string) => state.sessions.has(id);
  for (const id of [...state.on]) if (!has(id)) state.on.delete(id);
  if (state.open && !has(state.open)) state.open = null;
  if (state.edge && (!has(state.edge.from) || !has(state.edge.to))) state.edge = null;
  if (state.trace && !has(state.trace.piece.sessionId)) state.trace = null;
  if (!state.open && !state.edge && !state.trace?.shown && !state.fresh) el<HTMLElement>("chat").hidden = true;
  labelBasket();
  if (!added) return;
  const fresh = tops().filter((session) => session.projectId === added && session.activity !== "archived");
  const mine = new Set(fresh.map((session) => session.id));
  const picks = new Set(fresh.filter((session) => session.activity === "running").map((session) => session.id));
  // what went between the project that came and the ones that were there is what it was put here to show: both ends go on
  for (const flow of state.graph.flows.filter((flow) => mine.has(flow.from) !== mine.has(flow.to)).sort((a, b) => b.at - a.at).slice(0, 6)) picks.add(flow.from).add(flow.to);
  for (const session of [...fresh].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if ([...picks].filter((id) => mine.has(id)).length >= 3) break;
    picks.add(session.id);
  }
  for (const id of picks) { colorOf(id); state.on.add(id); }
}

/** The pane in which a new session is begun. Which client it was begun with last is kept. */
function openNew() {
  if (state.bundle) return; // nothing is begun from an exported record
  let client: "codex" | "claude" = "codex";
  try {
    if (localStorage.getItem("cf-new-client") === "claude") client = "claude";
  } catch { /* storage may be shut off */ }
  if (state.trace) state.trace.shown = false;
  state.open = null;
  state.edge = null;
  state.fresh = state.fresh ?? { client };
  el<HTMLElement>("chat").hidden = false;
  render();
  drawNew();
}

/** Read the records of what is on the map and draw. again: a refresh of the same, which keeps what is on and what
 *  is open. widen: a project came on the map (added) or went off it; the rest stays as it is. */
let asked = 0; // counts the projects asked for: the answer for one asked for earlier may come later, and is then dropped
async function load(id: string, how: "fresh" | "again" | "widen" = "fresh", added?: string) {
  const again = how === "again";
  const turn = again ? asked : ++asked;
  // a project read for the first time can take some seconds: the button that names the projects says it is being read
  const button = el<HTMLElement>("project");
  if (!again) button.classList.add("busy");
  let snap: Snapshot;
  try {
    snap = await call<Snapshot>("/api/snapshot?project=" + encodeURIComponent(id));
  } finally {
    if (!again && turn === asked) button.classList.remove("busy");
  }
  if (how === "fresh") await loadBasket(snap.project.id);
  else await syncBasket();
  if (turn !== asked || (again && id !== project)) return; // another project was chosen meanwhile
  // what the same sessions were doing at the last reading, set beside what they are doing now
  const news = again && state.snap && !state.bundle && state.snap.project.id === snap.project.id ? noticesOf(state.snap, snap) : [];
  project = id;
  state.snap = snap;
  state.sessions = new Map(snap.sessions.map((session) => [session.id, session]));
  state.graph = buildGraph(snap);
  if (how === "widen") widen(added);
  if (how === "fresh") {
    state.on = new Set();
    state.colors = new Map();
    state.open = null;
    state.edge = null;
    state.trace = null;
    state.fresh = null;
    state.tab = "talk";
    labelBasket();
    state.query = "";
    state.hits = [];
    state.hitsFor = "";
    el<HTMLInputElement>("find").value = "";
    el<HTMLElement>("chat").hidden = true;
    // an exported record opens the way it was when it was exported, the same for everyone who opens it
    const set = (state.bundle?.view.on ?? []).filter((one) => state.sessions.has(one));
    for (const one of set.length ? set : defaults()) { colorOf(one); state.on.add(one); }
  }
  render();
  if (state.trace?.shown) drawTrace();
  else if (state.edge) drawEdge();
  else if (state.open) void drawChat(state.open, undefined, true);
  announce(news);
  listen();
}
// ---------- kept up to date, and telling the person ----------

// The server says when the records change (it watches them), and the screen then reads them again at once, whether
// or not it is in view: a screen nobody looks at is the one that has something to tell. With an older server, or
// where the records cannot be watched, nothing is said and the screen asks at its own pace (the timer at the end).
let source: EventSource | null = null;
let sourceFor = "";
let readAt = 0; // when the records were last read because the server said they had changed
let owed = 0; // the timer of a reading that is owed
let hands = false; // a pointer is held down: something is being dragged, and is not drawn again under the hand

function soon() {
  const wait = readAt + (document.visibilityState === "visible" ? 1500 : 4000) - Date.now();
  if (wait <= 0 && !hands) {
    window.clearTimeout(owed);
    owed = 0;
    readAt = Date.now();
    void load(project, "again").catch(() => {});
  } else if (!owed) owed = window.setTimeout(() => { owed = 0; soon(); }, Math.max(wait, 300));
}

function listen() {
  if (state.bundle || state.alone || typeof EventSource === "undefined") {
    source?.close();
    source = null;
    state.live = false;
    return;
  }
  if (source && sourceFor === project && source.readyState !== EventSource.CLOSED) return;
  source?.close();
  sourceFor = project;
  const made = new EventSource("/api/events?project=" + encodeURIComponent(project));
  source = made;
  made.onmessage = (message) => {
    if (source !== made) return;
    let event: { t?: string; watching?: boolean };
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    if (event.t === "hello") state.live = Boolean(event.watching);
    else if (event.t === "changed") soon();
  };
  // The server went away (the browser asks for it again by itself), or it knows nothing of this (asked again at the next reading).
  made.onerror = () => { if (source === made) state.live = false; };
}

/** How the person is told that a session stopped or waits for them. page: a card on the map. system: a notice of
 *  the system's as well, while this window is not the one being looked at. */
const tells = { page: true, system: false };
let unseen = 0;
let plainTitle = "";
const away = () => document.visibilityState !== "visible" || !document.hasFocus();
const allowed = () => typeof Notification !== "undefined" && Notification.permission === "granted";

/** A card over the map, newest on top. It goes by itself after a while of being seen; pressed, it does what it is for. */
function card(title: string, line: string, more: { tone?: string; color?: string; open?: () => void } = {}) {
  const box = el<HTMLElement>("toasts");
  const made = h("div", "toast" + (more.tone ? " " + more.tone : ""));
  if (more.color) made.style.setProperty("--c", more.color);
  const close = h("button", "", "×");
  close.title = "닫기";
  close.onclick = (event) => { event.stopPropagation(); made.remove(); };
  made.append(h("b", "", title), h("span", "", line), close);
  const open = more.open;
  if (open) {
    made.classList.add("go");
    made.title = "누르면 이 세션의 대화를 엽니다";
    made.onclick = () => { made.remove(); open(); };
  }
  box.prepend(made);
  while (box.children.length > 4) box.lastElementChild?.remove();
  if (away()) made.dataset.kept = "1"; // nobody is looking: it waits to be seen before its time begins
  else window.setTimeout(() => made.remove(), 12_000);
}

function announce(list: Notice[]) {
  if (!tells.page && !tells.system) return;
  const gone = away();
  for (const notice of list) {
    if (!gone && state.open === notice.sessionId) continue; // the person is looking at that very talk
    const open = () => act.openChat(notice.sessionId);
    if (tells.page) card(notice.title, noticeLine(notice), { tone: notice.kind, color: state.colors.get(notice.sessionId), open });
    if (!gone) continue;
    unseen += 1;
    if (!tells.system || !allowed()) continue;
    try {
      const made = new Notification(notice.title, { body: noticeLine(notice), tag: "context-flow:" + notice.sessionId });
      made.onclick = () => { window.focus(); made.close(); open(); };
    } catch { /* this browser shows none: the card and the title say it */ }
  }
  if (!unseen) return;
  if (!plainTitle) plainTitle = document.title;
  document.title = "(" + unseen + ") " + plainTitle;
}

/** The person is looking again: the count in the title has done its work, and the cards kept for them begin their time. */
function seen() {
  if (away()) return;
  if (unseen) {
    unseen = 0;
    document.title = plainTitle;
    plainTitle = "";
  }
  document.querySelectorAll<HTMLElement>("#toasts .toast[data-kept]").forEach((made) => {
    delete made.dataset.kept;
    window.setTimeout(() => made.remove(), 12_000);
  });
}

function drawBell() {
  const bell = el<HTMLElement>("notify");
  const system = tells.system && allowed();
  bell.innerHTML = !tells.page && !tells.system ? ICON.bellOff : system ? ICON.bellOn : ICON.bell;
  bell.setAttribute("aria-label", "알림: " + (!tells.page && !tells.system ? "끔" : system ? "시스템 알림까지" : "화면 안에서"));
  el<HTMLInputElement>("notify-page").checked = tells.page;
  el<HTMLInputElement>("notify-system").checked = tells.system;
  const blocked = typeof Notification === "undefined" ? "이 브라우저에는 시스템 알림이 없습니다." : Notification.permission === "denied" ? "브라우저가 이 주소의 알림을 막고 있습니다. 주소창의 사이트 설정에서 허용해 주세요." : "";
  const why = el<HTMLElement>("notify-why");
  why.textContent = tells.system && blocked ? blocked : "작업 중이던 세션이 끝나거나, 허용이나 답을 기다리기 시작하면 알립니다.";
  why.classList.toggle("warn", Boolean(tells.system && blocked));
}

function wireBell() {
  tells.page = localStorage.getItem("cf-notify-page") !== "0";
  tells.system = localStorage.getItem("cf-notify-system") === "1";
  el<HTMLInputElement>("notify-page").onchange = (event) => {
    tells.page = (event.target as HTMLInputElement).checked;
    localStorage.setItem("cf-notify-page", tells.page ? "1" : "0");
    drawBell();
  };
  el<HTMLInputElement>("notify-system").onchange = async (event) => {
    tells.system = (event.target as HTMLInputElement).checked;
    localStorage.setItem("cf-notify-system", tells.system ? "1" : "0");
    // the browser asks the person once; this is the press of a button it wants to see before it does
    if (tells.system && typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
    drawBell();
  };
  document.addEventListener("visibilitychange", seen);
  window.addEventListener("focus", seen);
  window.addEventListener("pointerdown", () => { hands = true; }, true);
  for (const end of ["pointerup", "pointercancel"]) window.addEventListener(end, () => { hands = false; }, true);
  drawBell();
}

function theme(next?: "light" | "dark") {
  let wanted = next;
  try {
    if (next) localStorage.setItem("cf-theme", next);
    else wanted = (localStorage.getItem("cf-theme") as "light" | "dark" | null) ?? undefined;
  } catch { /* storage may be shut off; the choice then lasts for this page only */ }
  document.documentElement.dataset.theme = wanted ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

(async function start() {
  theme();
  // in a very narrow window the list of sessions would leave the map no room: it starts folded away, behind its button
  if (window.innerWidth < 600) el<HTMLElement>("app").classList.add("side-off");
  act.render = render;
  act.hover = hover;
  act.openChat = openChat;
  act.openEdge = openEdge;
  act.openTrace = (piece, text) => void openTrace(piece, text);
  act.openNew = openNew;
  act.openElsewhere = (id, session, item, span) => void openElsewhere(id, session, item, span);
  act.addProject = (id) => withProject(id, true);
  act.refresh = () => load(project, "again").catch(() => {});
  // when the server stops answering, the screen says so and keeps trying; what was read stays on it meanwhile
  net.changed = () => { el<HTMLElement>("offline").hidden = !net.down; };
  el<HTMLElement>("retry").onclick = () => { if (project) void load(project, "again").catch(() => {}); };
  const icon = (id: string, svg: string) => { el<HTMLElement>(id).innerHTML = svg; };
  icon("side-toggle", ICON.side);
  icon("io", ICON.io);
  icon("refresh", ICON.refresh);
  icon("new-float", ICON.fresh);
  el<HTMLElement>("new-session").innerHTML = ICON.fresh + "<span>새 세션</span>";
  el<HTMLElement>("new-session").onclick = openNew;
  el<HTMLElement>("new-float").onclick = openNew;

  // An exported record in the page itself (a screen that was exported), or named in the address (?bundle=file.json,
  // beside the page): the screen then reads from it alone and asks no server anything.
  const inPage = document.getElementById("cf-bundle");
  const named = new URLSearchParams(location.search).get("bundle");
  if (inPage || named) {
    state.bundle = readBundle(inPage ? JSON.parse(inPage.textContent ?? "") : await (await fetch(named!)).json());
    state.alone = true;
    bundles.set(state.bundle.snapshot.project.id, state.bundle);
    document.documentElement.dataset.theme = state.bundle.view.theme; // everyone starts from the same look; it can still be changed
    document.title = "맥락 흐름 · " + state.bundle.snapshot.project.name;
    el<HTMLElement>("io").hidden = true;
  }
  icon("theme", ICON.theme);
  icon("fit", ICON.fit);
  icon("zoom-in", ICON.plus);
  icon("zoom-out", ICON.minus);
  el<HTMLElement>("lanes-toggle").innerHTML = ICON.time + "<span>시간 흐름</span>";
  el<HTMLElement>("tidy").innerHTML = ICON.tidy + "<span>자동 배치</span>";
  el<HTMLElement>("tidy").onclick = tidyMap;

  // which projects are on the map
  const picker = el<HTMLElement>("project-menu");
  el<HTMLElement>("project").onclick = (event) => {
    event.stopPropagation();
    picker.hidden = !picker.hidden;
    el<HTMLElement>("project").setAttribute("aria-expanded", String(!picker.hidden));
    if (!picker.hidden) picker.scrollTop = 0;
  };
  picker.onclick = (event) => event.stopPropagation();

  // exporting, and opening what was exported
  const menu = el<HTMLElement>("io-menu");
  const bells = el<HTMLElement>("notify-menu");
  el<HTMLElement>("io").onclick = (event) => { event.stopPropagation(); picker.hidden = true; bells.hidden = true; menu.hidden = !menu.hidden; };
  el<HTMLElement>("notify").onclick = (event) => { event.stopPropagation(); picker.hidden = true; menu.hidden = true; bells.hidden = !bells.hidden; };
  bells.onclick = (event) => event.stopPropagation();
  wireBell();
  menu.onclick = (event) => event.stopPropagation();
  document.addEventListener("click", () => { menu.hidden = true; picker.hidden = true; bells.hidden = true; });
  // whether the name of this machine's user is covered in what is exported, and which words besides: kept for the next time
  const mask = el<HTMLInputElement>("mask");
  const words = el<HTMLInputElement>("mask-words");
  try {
    mask.checked = localStorage.getItem("cf-mask") === "1";
    words.value = localStorage.getItem("cf-mask-words") ?? "";
  } catch { /* storage may be shut off; the choice then lasts for this page only */ }
  const keepMask = () => {
    words.hidden = !mask.checked;
    try {
      localStorage.setItem("cf-mask", mask.checked ? "1" : "");
      localStorage.setItem("cf-mask-words", words.value);
    } catch { /* as above */ }
  };
  mask.onchange = keepMask;
  words.onchange = keepMask;
  el<HTMLElement>("export-html").onclick = () => exportAs("html");
  el<HTMLElement>("export-json").onclick = () => exportAs("json");
  const file = el<HTMLInputElement>("bundle-file");
  el<HTMLElement>("import").onclick = () => file.click();
  file.onchange = async () => {
    const picked = file.files?.[0];
    file.value = ""; // so that the same file can be opened again
    if (!picked) return;
    menu.hidden = true;
    try {
      const bundle = readBundle(JSON.parse(await picked.text()));
      bundles.set(bundle.snapshot.project.id, bundle);
      await showBundle(bundle.snapshot.project.id);
    } catch (error) {
      window.alert("묶음 파일을 열지 못했습니다: " + (error instanceof SyntaxError ? "JSON이 아닙니다" : (error as Error).message));
    }
  };

  let finding = 0;
  el<HTMLInputElement>("find").oninput = (event) => {
    state.query = (event.target as HTMLInputElement).value;
    drawSide();
    // names are matched at once; what was said is asked of the server a moment after the typing stops
    clearTimeout(finding);
    const query = state.query.trim().toLowerCase();
    if (query.length < 2) return;
    finding = window.setTimeout(async () => {
      const { hits } = await call<{ hits: typeof state.hits }>("/api/find?project=" + encodeURIComponent(project) + "&q=" + encodeURIComponent(query)).catch(() => ({ hits: [] }));
      if (state.query.trim().toLowerCase() !== query) return;
      state.hits = hits;
      state.hitsFor = query;
      drawSide();
    }, 250);
  };
  el<HTMLElement>("only-active").onclick = () => { state.on = new Set(defaults()); render(); };
  el<HTMLElement>("all-off").onclick = () => { state.on = new Set(); render(); };
  el<HTMLElement>("side-toggle").onclick = () => { el<HTMLElement>("app").classList.toggle("side-off"); window.setTimeout(render, 0); };
  el<HTMLElement>("lanes-toggle").onclick = () => { state.lanes = !state.lanes; render(); };
  el<HTMLElement>("fit").onclick = fitMap;
  el<HTMLElement>("zoom-in").onclick = () => stepZoom(1);
  el<HTMLElement>("zoom-out").onclick = () => stepZoom(-1);
  el<HTMLElement>("refresh").onclick = () => void load(project, "again").catch(() => {});
  el<HTMLElement>("theme").onclick = () => theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

  // What there is to choose from, and what the address asks for: a project (its id, its name or a folder of it), or
  // several with commas between. Should the server not answer yet, this is tried again until it does.
  const open = async () => {
    const { projects } = await call<{ projects: Project[] }>("/api/projects");
    state.projects = projects;
    const wanted = new URLSearchParams(location.search).get("project") ?? "";
    const named = (name: string) => projects.find((one) => one.id === name || one.name === name || one.roots.includes(name));
    const whole = named(wanted);
    const asked = whole ? [whole] : [...new Set(wanted.split(",").map((part) => named(part.trim())).filter((one): one is Project => Boolean(one)))];
    const first = asked.length ? asked : projects.slice(0, 1);
    if (!first.length) throw new Error("Codex에 프로젝트가 하나도 없습니다");
    chosen = first.map((one) => one.id);
    drawPicker();
    await load(chosen.join(","));
  };
  for (;;) {
    try {
      await open();
      break;
    } catch (error) {
      if (state.alone || !net.down) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 4000));
    }
  }
  let timer = 0;
  window.addEventListener("resize", () => { clearTimeout(timer); timer = window.setTimeout(render, 120); });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!menu.hidden || !picker.hidden || !bells.hidden) { menu.hidden = true; picker.hidden = true; bells.hidden = true; }
    else if (state.open || state.edge || state.trace || state.fresh) closeChat();
  });
  // What is at work changes while the page is open. The server says when the records change (listen, above); what no
  // record says (a client that died, a turn gone quiet) is found by reading them again every half minute while the
  // page is in view. When the server says nothing, the page asks oftener: every twelve seconds while some session
  // is at work, so that one that stops to be allowed something is seen soon; every six seconds while a piece waits,
  // so that its line is drawn soon after its session is spoken to elsewhere.
  let beat = 0;
  window.setInterval(() => {
    beat += 1;
    if (state.bundle) return; // an exported record does not change
    const busy = state.snap?.sessions.some((session) => session.activity === "running");
    // (and at every beat while the server does not answer, so that the screen is itself again soon after the server is)
    if (net.down || (document.visibilityState === "visible" && (beat % 5 === 0 || (!state.live && (state.snap?.waiting?.length || (busy && beat % 2 === 0)))))) void load(project, "again").catch(() => {});
  }, 6_000);
})().catch((error) => { document.body.append("기록을 읽지 못했습니다: " + error.message); });
