// The pane on the right. For one session: its talk (what was asked on the right, what was answered on the left, the
// work in between folded), the box in which the talk is carried on, and its context (what it took from other
// sessions and what it gave). For a line of the map: the pieces that went along it.
// A piece is a stretch of something said: it is picked by selecting text, kept in a basket, and sent along with a
// message to another session, where it becomes a line on the map. It can also be set to wait: it then goes with the
// next thing said to that session, wherever that is typed (the hook of the session's client takes it).
// A piece can be carried: dragged onto a session of the map it is attached to what is said to that session next;
// dragged onto the empty map it begins a session (drag.ts). The pane also shows where a new session is begun.
import type { Client, FarLink, Item, Link, Session, TraceStep, TurnEvent, Waiting } from "../../core/src/model.ts";
import { freshPlan } from "../../core/src/fresh.ts";
import { filesIn, withoutPieces } from "../../core/src/links.ts";
import { carries, onLanding, press, type Spec } from "./drag.ts";
import { act, afar, call, CLIENT, clock, colorOf, day, el, flowLabel, h, hookTrouble, ICON, keepBasket, KIND, LINK, many, owner, placeOf, post, projectOf, projName, state, stateWord, top, whose, type Held, type Span } from "./state.ts";

type Said = Item & { more?: number };
const TICK = String.fromCharCode(96);
const FENCE = TICK + TICK + TICK;
const LAST = 120; // how many items are laid out at first; the rest wait behind a button
const STEP = { command: "명령", change: "변경", tool: "도구" } as const;
let have = { id: "", count: -1 };
/** The turn this screen is following: one it sent, or one it found under way when the talk was opened. */
let live: { session: string; turn: string; source: EventSource } | null = null;
/** Why the last turn sent from here did not finish, kept on show until the next one is sent. */
let trouble = { id: "", text: "" };
/** What was last sent from here, so that it can be put back in the box if the session did not take it. */
let sent = { session: "", text: "", pieces: [] as string[], files: [] as { file: File; url: string | null }[], taken: false };
/** Each item now on the page, by its id: a piece is cut from its text. */
const texts = new Map<string, Said>();
/** The stretch of text now selected, if it can be kept as a piece. */
let chosen: { itemId: string; start: number; end: number } | null = null;
let wired = false;

const pane = () => el<HTMLElement>("chat");
const part = <T extends HTMLElement = HTMLElement>(cls: string) => pane().querySelector<T>(":scope > ." + cls);
const flat = (text: string, room: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > room ? one.slice(0, room - 1) + "…" : one; };
const name = (id: string) => state.sessions.get(id)?.title ?? "";

// ---------- text that remembers where it came from ----------

/** A run of letters on the page that says where in its item's text it starts. A run that is not letter for letter
 *  what the item says (a list mark, a picture's name) says how many of the item's letters it stands for. */
function run(text: string, at: number, stands?: number): HTMLSpanElement {
  const made = h("span", "", text);
  made.dataset.o = String(at);
  if (stands !== undefined) made.dataset.n = String(stands);
  return made;
}
const INLINE = new RegExp("(" + TICK + "[^" + TICK + "\\n]+" + TICK + ")|(\\*\\*[^*\\n]+\\*\\*)|(!\\[[^\\]]*\\]\\([^)]*\\))|(\\[[^\\]]+\\]\\([^)]+\\))", "g");
function inline(parent: HTMLElement, text: string, base: number) {
  let last = 0;
  for (const found of text.matchAll(INLINE)) {
    const at = found.index ?? 0;
    const whole = found[0];
    if (at > last) parent.append(run(text.slice(last, at), base + last));
    if (found[1]) {
      const code = h("code");
      code.append(run(whole.slice(1, -1), base + at + 1));
      parent.append(code);
    } else if (found[2]) {
      const bold = h("b");
      bold.append(run(whole.slice(2, -2), base + at + 2));
      parent.append(bold);
    } else if (found[3]) parent.append(run("[그림: " + whole.slice(2, whole.indexOf("]")) + "]", base + at, whole.length));
    else parent.append(run(whole.slice(1, whole.indexOf("](")), base + at + 1));
    last = at + whole.length;
  }
  if (last < text.length) parent.append(run(text.slice(last), base + last));
}
/** The cells of a row of a table, each with where in the line it starts. A bar inside code, or after a backslash, is no cell's edge. */
function cells(line: string): { text: string; at: number }[] {
  const bars: number[] = [];
  let code = false;
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] === "\\") at += 1;
    else if (line[at] === TICK) code = !code;
    else if (line[at] === "|" && !code) bars.push(at);
  }
  const edges = [-1, ...bars, line.length];
  const out: { text: string; at: number }[] = [];
  for (let n = 0; n + 1 < edges.length; n += 1) {
    const raw = line.slice(edges[n] + 1, edges[n + 1]);
    if ((n === 0 || n === edges.length - 2) && !raw.trim()) continue; // what lies outside the bars at either end of a row
    out.push({ text: raw.trim(), at: edges[n] + 1 + raw.length - raw.trimStart().length });
  }
  return out;
}
/** The line under a table's head: nothing but bars, dashes and colons. */
const ruled = (line: string | undefined) => line !== undefined && /^[\s|:-]+$/.test(line) && line.includes("|") && line.includes("--");

/** Enough of Markdown for an answer to read the way it does in its own client: code, bold, headings, list marks, tables. */
function rich(parent: HTMLElement, text: string) {
  parent.textContent = "";
  let at = 0;
  text.split(FENCE).forEach((piece, index) => {
    if (index % 2) {
      const skip = /^[a-zA-Z0-9_+-]*\n/.exec(piece)?.[0].length ?? 0;
      const pre = h("pre");
      pre.append(run(piece.slice(skip).replace(/\n$/, ""), at + skip));
      parent.append(pre);
    } else {
      let lineAt = at;
      const lines = piece.split("\n");
      let table: { body: HTMLTableSectionElement; sides: string[] } | null = null;
      lines.forEach((line, n) => {
        // a table: a row with bars, then a ruled line, then rows as long as they have bars. Each cell keeps the place of its letters.
        if (!table && line.includes("|") && ruled(lines[n + 1])) {
          const wrap = h("div", "table-wrap");
          const made = h("table");
          const head = made.createTHead().insertRow();
          const sides = cells(lines[n + 1]).map((cell) => (cell.text.startsWith(":") && cell.text.endsWith(":") ? "center" : cell.text.endsWith(":") ? "right" : ""));
          cells(line).forEach((cell, column) => {
            const th = h("th");
            if (sides[column]) th.style.textAlign = sides[column];
            inline(th, cell.text, lineAt + cell.at);
            head.append(th);
          });
          table = { body: made.createTBody(), sides };
          wrap.append(made);
          parent.append(wrap);
          lineAt += line.length + 1;
          return;
        }
        if (table && line.includes("|") && line.trim()) {
          if (!ruled(line) || table.body.rows.length) {
            const row = table.body.insertRow();
            cells(line).forEach((cell, column) => {
              const td = row.insertCell();
              if (table!.sides[column]) td.style.textAlign = table!.sides[column];
              inline(td, cell.text, lineAt + cell.at);
            });
          }
          lineAt += line.length + 1;
          return;
        }
        table = null;
        const heading = /^#{1,4} +/.exec(line);
        const bullet = heading ? null : /^(\s*)[-*] +/.exec(line);
        const skip = heading?.[0].length ?? bullet?.[0].length ?? 0;
        let target = parent;
        if (heading) {
          target = h("b", "h");
          parent.append(target);
        } else if (bullet) parent.append(run(bullet[1] + "• ", lineAt, skip));
        inline(target, line.slice(skip), lineAt + skip);
        if (n < lines.length - 1) parent.append(run("\n", lineAt + line.length));
        lineAt += line.length + 1;
      });
    }
    at += piece.length + FENCE.length;
  });
}

/** The other way: the place on the page of a letter of the item's text. */
function pagePlace(holder: HTMLElement, at: number, end: boolean): [Node, number] | null {
  let found: [Node, number] | null = null;
  for (const one of holder.querySelectorAll<HTMLElement>("[data-o]")) {
    const from = Number(one.dataset.o);
    const text = one.firstChild;
    if (!text) continue;
    const long = one.dataset.n ? Number(one.dataset.n) : (text as Text).length;
    if (end ? at > from && at <= from + long : at >= from && at < from + long) return [text, one.dataset.n ? (end ? (text as Text).length : 0) : at - from];
    if (from <= at) found = [text, (text as Text).length]; // the letter itself is not on the page (a mark of Markdown): the nearest run before it
  }
  return found;
}
/** Mark a stretch of an item on the page, so that a piece is seen where it was said. */
function markSpan(holder: HTMLElement, span: Span) {
  const marks = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Mark = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!marks || !Mark) return;
  // a paste is marked stretch by stretch, so that what lies between the stretches is not taken for a match
  const ranges: Range[] = [];
  for (const [start, end] of span.parts?.length ? span.parts : [[span.start, span.end] as [number, number]]) {
    const from = pagePlace(holder, start, false);
    const to = pagePlace(holder, end, true);
    if (!from || !to) continue;
    const range = document.createRange();
    range.setStart(from[0], from[1]);
    range.setEnd(to[0], to[1]);
    ranges.push(range);
  }
  if (!ranges.length) return;
  marks.set("piece", new Mark(...ranges));
  const first = ranges.reduce((a, b) => (a.compareBoundaryPoints(Range.START_TO_START, b) <= 0 ? a : b));
  first.startContainer.parentElement?.scrollIntoView({ block: "center" });
}

/** Where in its item's text a place on the page is. */
function rawOffset(container: Node, offset: number, end: boolean): number | null {
  let node: Node | null = container;
  let inside = offset;
  if (container.nodeType !== Node.TEXT_NODE) {
    // the place is between elements: take the run of letters next to it
    node = (end ? container.childNodes[offset - 1] : container.childNodes[offset]) ?? null;
    while (node && node.nodeType !== Node.TEXT_NODE) node = end ? node.lastChild : node.firstChild;
    inside = node && end ? (node as Text).length : 0;
  }
  const holder = node?.parentElement?.closest<HTMLElement>("[data-o]");
  if (!holder) return null;
  const from = Number(holder.dataset.o);
  if (holder.dataset.n) return end ? from + Number(holder.dataset.n) : from;
  return from + inside;
}

// ---------- pieces: picking, keeping, showing ----------

/** What the person typed, apart from the pieces that were sent along with it. */
const typedPart = withoutPieces; // what was typed: without the pieces and the list of files that went along
const MARK = /<context-piece id="([^"]+)" from="([^"]*)" kind="([^"]*)">\n([\s\S]*?)\n<\/context-piece>/g;
/** A piece that went along with a message, folded under it. hooked: it was set to wait and came with a message typed somewhere else. */
function sentCards(text: string, hooked = false): HTMLElement[] {
  return [...text.matchAll(MARK)].map((found) => {
    const card = h("details", "sent-piece");
    if (hooked) card.title = "걸어 둔 조각이 이 말에 실려 왔습니다";
    const summary = h("summary", "");
    summary.innerHTML = ICON.link;
    summary.append(h("b", "", found[2]), found[3] + " · " + found[4].length.toLocaleString() + "자");
    card.append(summary, h("div", "sent-text", found[4]));
    return card;
  });
}

function drawBasket() {
  const row = pane().querySelector<HTMLElement>(".basket");
  if (!row) return;
  row.textContent = "";
  row.hidden = !state.basket.length;
  if (!state.basket.length) return;
  row.append(h("span", "basket-label", "담아 둔 조각"));
  row.scrollTop = 0; // a piece that has just been attached moves to the front: the row goes there with it
  // the pieces that go with the next message come first, so that they are in sight however many are kept
  for (const piece of [...state.basket].sort((a, b) => Number(state.attached.has(b.id)) - Number(state.attached.has(a.id)))) {
    const on = state.attached.has(piece.id);
    const chip = h("span", "piece" + (on ? " on" : ""));
    chip.style.setProperty("--c", colorOf(piece.sessionId));
    const body = h("button", "piece-body", flat(piece.text, 20));
    body.type = "button";
    body.title = "‘" + whose(piece) + "’의 " + KIND[piece.kind] + "에서" + (afar(piece) && piece.where?.projectName ? " (프로젝트 " + piece.where.projectName + ")" : "") + "\n" + piece.text.slice(0, 400) + "\n\n" + (on ? "누르면 이 말에서 뗍니다 · 끌면 붙인 조각이 모두 함께 갑니다" : "누르면 이 말에 붙여 보냅니다 · 끌어서 다른 세션에 놓을 수 있습니다");
    carries(body, () => together(piece));
    body.onclick = () => {
      if (on) state.attached.delete(piece.id);
      else state.attached.add(piece.id);
      drawBasket();
      tune();
    };
    const drop = h("button", "piece-drop", "×");
    drop.type = "button";
    drop.title = "바구니에서 빼기";
    drop.onclick = () => unhold(piece.id);
    chip.append(body, drop);
    row.append(chip);
  }
}

function unhold(id: string) {
  state.basket = state.basket.filter((one) => one.id !== id);
  state.attached.delete(id);
  keepBasket();
  drawBasket();
  tune();
  redrawContext();
}

/** A kept piece as the server is told of it: where it is, and in which project when that is not the one on the screen. */
const wire = (piece: Held) => ({ sessionId: piece.sessionId, itemId: piece.itemId, start: piece.start, end: piece.end, ...(afar(piece) && piece.where?.project ? { project: piece.where.project } : {}) });

/** What is carried when a kept piece is dragged: a piece that is attached takes the other attached pieces along. */
const together = (piece: Spec & { id: string }): Spec[] => (state.attached.has(piece.id) && state.attached.size > 1 ? state.basket.filter((one) => state.attached.has(one.id)) : [piece]);

/** A stretch of an item now on the page, as a piece to be kept or carried. Null when there is nothing in it. */
function specOf(itemId: string, start: number, end: number): Spec | null {
  const item = texts.get(itemId);
  const text = item?.text.slice(start, end) ?? "";
  return item && text.trim() ? { sessionId: item.sessionId, itemId, start, end, text, kind: item.kind, where: placeOf(item.sessionId) } : null;
}

/** Put a piece in the basket, once; the id it is kept under. */
function keep(spec: Spec): string {
  let held = state.basket.find((one) => one.itemId === spec.itemId && one.start === spec.start && one.end === spec.end);
  if (!held) {
    held = { ...spec, id: Math.random().toString(36).slice(2, 10), at: Date.now() };
    state.basket.push(held);
  }
  return held.id;
}

// A carried piece landed: it is kept, attached to what is said next, and the pane goes to where that is written:
// the talk of the session it landed on, or the beginning of a new session.
onLanding((drop, specs) => {
  // a session is not sent its own words back: of several pieces, the ones that came out of it stay behind
  const going = "fresh" in drop ? specs : specs.filter((spec) => home(spec.sessionId) !== drop.session);
  state.attached = new Set(going.map(keep));
  keepBasket();
  document.getSelection()?.removeAllRanges();
  el<HTMLElement>("pick").hidden = true;
  if ("fresh" in drop) act.openNew();
  else act.openChat(drop.session);
  // where the piece went: the basket over the box, marked for a moment, and the box ready to be written in
  const row = pane().querySelector<HTMLElement>(".basket");
  if (row) row.scrollTop = 0;
  row?.classList.remove("landed");
  void row?.offsetWidth;
  row?.classList.add("landed");
  const box = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
  if (box && !box.disabled) box.focus();
});

/** Keep a stretch of an item's text in the basket. */
function hold(itemId: string, start: number, end: number) {
  const spec = specOf(itemId, start, end);
  if (!spec) return;
  keep(spec);
  keepBasket();
  drawBasket();
  tune();
  redrawContext();
  const tab = pane().querySelector<HTMLElement>(".tab.t-context");
  tab?.classList.remove("bump");
  void tab?.offsetWidth; // so that the mark plays again
  tab?.classList.add("bump");
}

/** The button that follows the selection: shown only over text a piece can be cut from. */
function watchSelection() {
  const pick = el<HTMLElement>("pick");
  pick.onmousedown = (event) => event.preventDefault(); // pressing it must not drop the selection
  pick.onclick = (event) => {
    const went = chosen; // dropping the selection forgets what was chosen
    const trace = Boolean((event.target as HTMLElement).closest("#pick-trace"));
    document.getSelection()?.removeAllRanges();
    pick.hidden = true;
    const item = went ? texts.get(went.itemId) : undefined;
    if (!went || !item) return;
    if (trace) act.openTrace({ sessionId: item.sessionId, itemId: item.id, start: went.start, end: went.end }, item.text.slice(went.start, went.end).slice(0, 600));
    else hold(went.itemId, went.start, went.end);
  };
  // the selection can be carried by its button, or by the selected text itself
  const picked = () => { const spec = chosen ? specOf(chosen.itemId, chosen.start, chosen.end) : null; return spec ? [spec] : []; };
  carries(el<HTMLElement>("pick-hold"), picked);
  pane().addEventListener("mousedown", (event) => {
    const selection = document.getSelection();
    if (!chosen || state.bundle || event.button !== 0 || !selection || selection.isCollapsed || !selection.rangeCount) return;
    if ((event.target as HTMLElement).closest("button, summary, textarea, a")) return;
    const inside = [...selection.getRangeAt(0).getClientRects()].some((box) => event.clientX >= box.left - 1 && event.clientX <= box.right + 1 && event.clientY >= box.top - 1 && event.clientY <= box.bottom + 1);
    if (!inside) return;
    event.preventDefault(); // the selection stays, and the browser does not drag the text itself
    const went = picked();
    press(event, () => went, () => document.getSelection()?.removeAllRanges()); // a press that goes nowhere drops the selection, as a click does
  });
  document.addEventListener("selectionchange", () => {
    chosen = null;
    const selection = document.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const holder = (common.nodeType === Node.ELEMENT_NODE ? (common as Element) : common.parentElement)?.closest<HTMLElement>("[data-item]");
      const item = holder && pane().contains(holder) ? texts.get(holder.dataset.item ?? "") : undefined;
      const start = rawOffset(range.startContainer, range.startOffset, false);
      const end = rawOffset(range.endContainer, range.endOffset, true);
      if (item && start !== null && end !== null && end > start && item.text.slice(start, end).trim()) {
        chosen = { itemId: item.id, start, end: Math.min(end, item.text.length) };
        const box = range.getBoundingClientRect();
        pick.hidden = false;
        pick.style.left = Math.max(8, Math.min(window.innerWidth - pick.offsetWidth - 8, box.right - pick.offsetWidth)) + "px";
        pick.style.top = Math.min(window.innerHeight - pick.offsetHeight - 8, box.bottom + 6) + "px";
        return;
      }
    }
    pick.hidden = true;
  });
}

// ---------- the talk ----------

function leave() {
  live?.source.close();
  live = null;
}

export function closeChat() {
  leave();
  state.open = null;
  state.edge = null;
  state.trace = null;
  state.fresh = null;
  have = { id: "", count: -1 };
  pane().hidden = true;
  el<HTMLElement>("pick").hidden = true;
  act.render();
}

function chip(sign: string, kind: string, id: string): HTMLElement {
  const made = h("button", "tie-chip");
  made.append(sign + " " + kind, h("b", "", name(id)));
  made.title = "이 세션의 대화 열기";
  made.onclick = () => act.openChat(id);
  made.onpointerenter = () => act.hover(id);
  made.onpointerleave = () => act.hover(null);
  return made;
}

/** The sessions this one is tied to, as buttons that open them. */
function ties(session: Session): HTMLElement {
  const box = h("div", "ties");
  for (const flow of state.graph.flows) {
    if (flow.to === session.id) box.append(chip("←", flowLabel(flow), flow.from));
    if (flow.from === session.id) box.append(chip("→", flowLabel(flow), flow.to));
  }
  // sessions that changed the same files: one button that puts them on the map, where the tie is drawn
  const shares = state.graph.shares.filter((share) => share.a === session.id || share.b === session.id);
  if (shares.length) {
    const others = shares.map((share) => (share.a === session.id ? share.b : share.a));
    const made = h("button", "tie-chip");
    made.append("≈ 같은 파일을 고친 세션", h("b", "", String(shares.length)));
    made.title = "지도에 올립니다: " + others.map(name).join(", ");
    made.onclick = () => { others.forEach((id) => state.on.add(id)); act.render(); };
    box.append(made);
  }
  const kids = state.graph.kids.get(session.id)?.length ?? 0;
  if (kids) {
    const made = h("span", "tie-more");
    made.innerHTML = ICON.branch;
    made.append("서브에이전트·곁가지 " + kids);
    box.append(made);
  }
  box.hidden = !box.childElementCount;
  return box;
}

function bubble(item: Said, who: "user" | "agent"): HTMLElement {
  const made = h("div", "msg " + who);
  made.dataset.item = item.id;
  const text = h("div", "text");
  const put = (body: string) => {
    if (who === "agent") return rich(text, body);
    text.textContent = "";
    if (typedPart(body)) text.append(run(typedPart(body), 0));
  };
  put(item.text);
  made.append(text);
  if (who === "user") made.append(...fileCards(item.text, item.images), ...sentCards(item.text), ...sentCards(item.added ?? "", true));
  // the whole of what was said, kept as one piece
  const grab = h("button", "grab", "담기");
  grab.title = "누르면 이 말 전체를 조각으로 담습니다. 끌어서 지도의 세션에 놓을 수도 있습니다. 일부만 담으려면 글을 끌어서 고르세요";
  const whole = () => (who === "user" ? typedPart(texts.get(item.id)?.text ?? item.text).length : (texts.get(item.id)?.text ?? item.text).length);
  grab.onclick = () => hold(item.id, 0, whole());
  carries(grab, () => { const spec = specOf(item.id, 0, whole()); return spec ? [spec] : []; });
  made.append(grab);
  const long = who === "user" && typedPart(item.text).length > 600;
  if (long) text.classList.add("clip");
  if (item.more || long) {
    const more = h("button", "more", item.more ? "전체 보기 (" + (item.text.length + item.more).toLocaleString() + "자)" : "펼치기");
    more.onclick = async () => {
      if (item.more) {
        const whole = await call<Item>("/api/item?id=" + encodeURIComponent(item.id));
        texts.set(item.id, whole);
        put(whole.text);
      }
      text.classList.remove("clip");
      more.remove();
    };
    made.append(more);
  }
  return made;
}

/** What the agent did between a request and its answer: folded, and filled in only when opened. */
function work(items: Said[]): HTMLDetailsElement {
  const box = h("details", "work");
  box.dataset.items = items.map((item) => item.id).join(" ");
  const answers = items.filter((item) => item.kind === "answer").length;
  const files = [...new Set(items.filter((item) => item.kind === "change").map((item) => (item.path ?? "").split("/").pop()!))].filter(Boolean);
  const parts: string[] = [];
  if (files.length) parts.push("고친 파일 " + files.slice(0, 3).join(", ") + (files.length > 3 ? " 외 " + (files.length - 3) : ""));
  if (answers) parts.push("중간 말 " + answers);
  const summary = h("summary", "");
  summary.append(h("b", "", "작업 과정"), parts.join(" · "));
  box.append(summary);
  box.addEventListener("toggle", () => {
    if (!box.open || box.dataset.full) return;
    box.dataset.full = "1";
    for (const item of items) {
      const row = h("div", "work-item " + item.kind);
      row.dataset.item = item.id;
      if (item.kind === "change") row.append(h("div", "work-path", item.path ?? ""));
      const body = h("div", "");
      body.append(run(item.text, 0));
      if (item.more) body.append("\n… (" + item.more.toLocaleString() + "자 더 있음)");
      row.append(body);
      box.append(row);
    }
  });
  return box;
}

function fill(body: HTMLElement, session: Session, items: Said[], all: boolean, focus?: string, span?: Span) {
  body.textContent = "";
  texts.clear();
  for (const item of items) texts.set(item.id, item);
  let from = all || items.length <= LAST ? 0 : items.length - LAST;
  while (from > 0 && from < items.length && items[from].kind !== "prompt") from += 1; // start at a request, not in the middle of a turn
  if (focus && items.findIndex((item) => item.id === focus) < from) from = 0;
  if (from > 0) {
    const more = h("button", "more", "앞선 대화 더 보기");
    more.onclick = () => fill(body, session, items, true);
    body.append(more);
  }
  let pending: Said[] = [];
  let lastDay = "";
  const flush = () => {
    if (pending.length) body.append(work(pending));
    pending = [];
  };
  for (const item of items.slice(from)) {
    if (item.kind === "prompt") {
      flush();
      if (day(item.at) !== lastDay) body.append(h("div", "stamp", day(item.at) + " " + clock(item.at)));
      lastDay = day(item.at);
      body.append(bubble(item, "user"));
    } else if (item.kind === "answer" && item.final) {
      flush();
      body.append(bubble(item, "agent"));
    } else pending.push(item);
  }
  flush();
  if (session.activity === "running") {
    const busy = h("div", "live");
    if (session.needs) busy.append(h("i", "bang", "!"), session.needs === "approval" ? "허용을 기다리는 중입니다. 이 세션을 연 창에서 답해 주세요" : "질문에 답하기를 기다리는 중입니다");
    else busy.append(h("i", "pulse"), "작업 중");
    body.append(busy);
  }
  if (!items.length) body.append(h("div", "stamp none-yet", "아직 주고받은 말이 없습니다"));
  if (trouble.id === session.id) body.append(h("div", "turn-error", trouble.text));
  let target = focus ? body.querySelector<HTMLElement>('[data-item="' + CSS.escape(focus) + '"]') : null;
  if (focus && !target) {
    // the item is inside a folded stretch of work: open that stretch
    const fold = [...body.querySelectorAll<HTMLDetailsElement>("details.work")].find((one) => (one.dataset.items ?? "").split(" ").includes(focus));
    if (fold) {
      fold.open = true;
      fold.dispatchEvent(new Event("toggle"));
      target = fold.querySelector<HTMLElement>('[data-item="' + CSS.escape(focus) + '"]') ?? fold;
    }
  }
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete("piece");
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.classList.add("flash");
    if (span) {
      // a long request is shown cut short: the stretch to be marked may lie in the part that is folded away
      const folded = target.querySelector(".text.clip");
      if (folded) {
        folded.classList.remove("clip");
        [...target.querySelectorAll<HTMLElement>(":scope > .more")].find((button) => button.textContent === "펼치기")?.remove();
      }
      markSpan(target, span);
    }
  } else body.scrollTop = body.scrollHeight;
}

// ---------- carrying the talk on ----------

/** Set the box to what can be done now: write; stop the answer under way; or wait for work going on somewhere else. */
// ---------- what goes with a message besides pieces: pictures, other files, and another model ----------

/** A file picked to go with the next message. url: a picture's, to show it small. */
interface Picked { file: File; url: string | null }
let picked: Picked[] = [];
/** The model chosen for the open session's next message; "" is the session's own. */
let wantModel = "";
/** What each client offers to answer with, as the server found out: asked for once a client. */
const offered = new Map<Client, { id: string; name: string }[]>();
const PICTURE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ROOM = 10 * 1024 * 1024;
const MOST = 8;
const sizeOf = (bytes: number) => (bytes < 1024 ? bytes + "B" : bytes < 1024 * 1024 ? Math.round(bytes / 1024) + "KB" : (bytes / 1024 / 1024).toFixed(1) + "MB");

function dropPicked() {
  for (const one of picked) if (one.url) URL.revokeObjectURL(one.url);
  picked = [];
}

/** Take files to go with the next message: chosen, pasted, or dropped on the pane. */
function takeFiles(files: Iterable<File>) {
  if (!pane().querySelector(".composer") || pane().classList.contains("no-send")) return;
  let said = "";
  for (const file of files) {
    if (picked.length >= MOST) { said = "한 번에 " + MOST + "개까지 붙일 수 있습니다"; break; }
    if (picked.reduce((sum, one) => sum + one.file.size, 0) + file.size > ROOM) { said = "붙인 것이 모두 합쳐 10MB를 넘습니다"; break; }
    picked.push({ file, url: PICTURE.has(file.type) ? URL.createObjectURL(file) : null });
  }
  drawPicked(said);
  tune();
}

/** The files picked, in a row over the box; each can be taken off again. */
function drawPicked(said = "") {
  const row = pane().querySelector<HTMLElement>(".composer .files");
  if (!row) return;
  row.textContent = "";
  row.hidden = !picked.length && !said;
  for (const one of picked) {
    const name = one.file.name || "붙여넣은 그림";
    const chip = h("span", "file" + (one.url ? " pic" : ""));
    if (one.url) {
      const img = h("img");
      img.src = one.url;
      img.alt = "";
      chip.append(img);
    } else chip.insertAdjacentHTML("beforeend", ICON.file);
    chip.append(h("b", "", name), h("i", "", sizeOf(one.file.size)));
    chip.title = name + " · " + (one.url ? "그림으로 보냅니다" : "파일로 두고, 어디 있는지 에이전트에게 알려 줍니다");
    const off = h("button", "", "×");
    off.type = "button";
    off.title = "떼기";
    off.onclick = () => {
      if (one.url) URL.revokeObjectURL(one.url);
      picked = picked.filter((other) => other !== one);
      drawPicked();
      tune();
    };
    chip.append(off);
    row.append(chip);
  }
  if (said) row.append(h("span", "files-said", said));
}

/** The files as they are sent: their bytes in base64. */
async function wireFiles(list: Picked[]): Promise<{ name: string; type: string; data: string }[]> {
  const out: { name: string; type: string; data: string }[] = [];
  for (const one of list) {
    const bytes = new Uint8Array(await one.file.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    out.push({ name: one.file.name || "pasted." + (one.file.type.split("/")[1] ?? "png"), type: one.file.type, data: btoa(binary) });
  }
  return out;
}

/** What shows of the pictures in the message just sent. (The other files are named by the message itself.) */
function sentPictures(list: Picked[]): HTMLElement | null {
  const pictures = list.filter((one) => one.url);
  if (!pictures.length) return null;
  const row = h("div", "sent-files");
  for (const one of pictures) {
    const img = h("img");
    img.src = one.url!;
    img.alt = one.file.name;
    row.append(img);
  }
  return row;
}

/** The files a message says were sent along with it, by name; and how many pictures the record says came with it. */
function fileCards(text: string, images = 0): HTMLElement[] {
  const out = filesIn(text).map((path) => {
    const chip = h("span", "file");
    chip.insertAdjacentHTML("beforeend", ICON.file);
    chip.append(h("b", "", path.split("/").pop() ?? path));
    chip.title = path;
    return chip;
  });
  if (images) out.unshift(h("span", "file", "그림 " + images + "개"));
  if (!out.length) return [];
  const row = h("div", "sent-files");
  row.append(...out);
  return [row];
}

/** The button that opens the file chooser, the row the chosen files show in, and pasting files into the box. */
function attachParts(box: HTMLTextAreaElement): { clip: HTMLButtonElement; files: HTMLElement; input: HTMLInputElement } {
  const input = h("input", "");
  input.type = "file";
  input.multiple = true;
  input.hidden = true;
  input.onchange = () => { takeFiles(input.files ?? []); input.value = ""; };
  const clip = h("button", "clip");
  clip.type = "button";
  clip.innerHTML = ICON.clip;
  clip.title = "그림이나 파일 붙이기. 입력칸에 붙여넣거나 대화창에 끌어다 놓아도 됩니다";
  clip.setAttribute("aria-label", "그림이나 파일 붙이기");
  clip.onclick = () => input.click();
  const files = h("div", "files");
  files.hidden = true;
  box.addEventListener("paste", (event) => {
    const pasted = [...(event.clipboardData?.files ?? [])];
    if (!pasted.length) return; // words are pasted as words
    event.preventDefault();
    takeFiles(pasted);
  });
  return { clip, files, input };
}

/** Files of the system dropped on the pane go with the next message. (Pieces are carried another way: drag.ts.) */
function watchDrops() {
  const box = pane();
  const files = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files")) && Boolean(box.querySelector(".composer")) && !box.classList.contains("no-send");
  box.addEventListener("dragover", (event) => {
    if (!files(event)) return;
    event.preventDefault();
    box.classList.add("dropping");
  });
  box.addEventListener("dragleave", (event) => { if (!box.contains(event.relatedTarget as Node | null)) box.classList.remove("dropping"); });
  box.addEventListener("drop", (event) => {
    box.classList.remove("dropping");
    if (!files(event)) return;
    event.preventDefault();
    takeFiles(event.dataTransfer?.files ?? []);
  });
}

/** The models the open session's next message can be answered with: what its client offers, and what this client's
 *  sessions on the map were seen to run on. Drawn again only when the choices have changed, so that a list that is
 *  open is not shut under the hand. */
function drawModels(session: Session) {
  const foot = pane().querySelector<HTMLElement>(".composer .composer-foot");
  const select = foot?.querySelector<HTMLSelectElement>("select");
  if (!foot || !select) return;
  if (!offered.has(session.client)) {
    offered.set(session.client, []);
    void call<{ models: { id: string; name: string }[] }>("/api/models?client=" + session.client).then(({ models }) => {
      offered.set(session.client, models);
      const open = state.open ? state.sessions.get(state.open) : undefined;
      if (open?.client === session.client) drawModels(open);
    }).catch(() => {});
  }
  const names = new Map<string, string>();
  for (const one of offered.get(session.client) ?? []) names.set(one.id, one.name);
  for (const other of [...state.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)) if (other.client === session.client && other.model && !names.has(other.model)) names.set(other.model, other.model);
  if (session.model) names.delete(session.model);
  if (wantModel && !names.has(wantModel)) wantModel = "";
  const drawn = JSON.stringify([session.model, ...names]);
  if (select.dataset.drawn !== drawn) {
    select.dataset.drawn = drawn;
    select.textContent = "";
    const own = h("option", "", session.model ?? "기본 모델");
    own.value = "";
    select.append(own);
    for (const [id, name] of names) {
      const option = h("option", "", name === id ? id : name + " · " + id);
      option.value = id;
      select.append(option);
    }
  }
  select.value = wantModel;
  select.classList.toggle("set", Boolean(wantModel));
  foot.hidden = !names.size;
}

function tune() {
  if (state.fresh) return tuneNew();
  const box = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
  const go = pane().querySelector<HTMLButtonElement>(".composer .go");
  const session = state.open ? state.sessions.get(state.open) : undefined;
  if (!box || !go || !session) return;
  const busy = live?.session === session.id;
  const elsewhere = !busy && session.activity === "running";
  box.disabled = elsewhere;
  box.placeholder = elsewhere ? (state.attached.size ? "붙인 조각을 다음 말에 실을 수 있습니다" : "다른 곳에서 작업 중인 세션입니다. 끝나면 여기서 이어 쓸 수 있습니다") : busy ? "답하는 중입니다" : CLIENT[session.client] + " 세션에 이어서 쓰기";
  go.innerHTML = busy ? ICON.stop : ICON.send;
  go.title = busy ? "멈추기" : "보내기";
  go.classList.toggle("stop", busy);
  // pieces can go by themselves; pictures and files go with words that say what is wanted of them
  go.disabled = !busy && (elsewhere || !(box.value.trim() || (state.attached.size && !picked.length)));
  if (!elsewhere && !busy && picked.length && !box.value.trim()) box.placeholder = "붙인 것과 함께 보낼 말을 적어 주세요";
  const clip = pane().querySelector<HTMLButtonElement>(".composer .clip");
  if (clip) clip.disabled = elsewhere || busy;
  const later = pane().querySelector<HTMLButtonElement>(".composer .later");
  if (later) later.hidden = !state.attached.size; // setting pieces to wait starts no turn: it can be done whatever the session is at
}

/** The pieces that wait for this session's next prompt, in a line over the box; pressing it shows them. */
function drawWaitbar(session: Session) {
  const bar = pane().querySelector<HTMLButtonElement>(".composer .waitbar");
  if (!bar) return;
  const waiting = (state.snap?.waiting ?? []).filter((piece) => piece.to.sessionId === session.id);
  bar.hidden = !waiting.length;
  if (!waiting.length) return;
  const trouble = hookTrouble(session.client, state.snap!.hooks[session.client], waiting.some((piece) => piece.missed));
  bar.className = "waitbar" + (trouble ? " warn" : "");
  bar.textContent = "";
  const hook = state.snap!.hooks[session.client];
  bar.append(h("b", "", "대기 " + waiting.length), hook === "absent" ? "플러그인을 설치해야 실립니다" : hook === "untrusted" ? "훅을 승인해야 실립니다" : trouble ? "말을 했는데 실리지 않았습니다" : "이 세션에 다음 말을 치면 함께 갑니다", h("span", "", "보기"));
  bar.title = trouble || "Codex 앱이나 터미널에서 이 세션에 말을 쳐도, 여기서 보내도 함께 갑니다";
  bar.onclick = () => { state.tab = "context"; void drawChat(session.id); };
}

/** Set the attached pieces to wait for this session's next prompt, instead of sending them now. */
async function setToWait(id: string) {
  const along = state.basket.filter((piece) => state.attached.has(piece.id));
  if (!along.length) return;
  const body = part("talk");
  body?.querySelectorAll(":scope > .turn-error").forEach((node) => node.remove());
  try {
    await post("/api/queue", { project: state.snap!.project.id, session: id, pieces: along.map(wire) });
    state.attached.clear();
    for (const piece of along) state.on.add(piece.sessionId); // so that the line of what waits is on the map
    drawBasket();
    tune();
    await act.refresh();
  } catch (error) {
    body?.append(h("div", "turn-error", "걸어 두지 못했습니다: " + (error as Error).message));
    if (body) body.scrollTop = body.scrollHeight;
  }
}

function askCard(turn: string, event: Extract<TurnEvent, { t: "ask" }>): HTMLElement {
  const card = h("div", "ask");
  card.dataset.ask = event.id;
  card.append(h("b", "", event.title));
  if (event.detail) card.append(h("pre", "", event.detail));
  const row = h("div", "ask-row");
  const allow = h("button", "allow", "허용");
  const deny = h("button", "deny", "거절");
  const answer = async (ok: boolean) => {
    allow.disabled = deny.disabled = true;
    try {
      await post("/api/turn/answer", { turn, id: event.id, allow: ok });
    } catch {
      allow.disabled = deny.disabled = false;
    }
  };
  allow.onclick = () => void answer(true);
  deny.onclick = () => void answer(false);
  row.append(allow, deny);
  card.append(row);
  return card;
}

/** What was sent, as it shows before the record is read again. */
function sentBubble(text: string): HTMLElement {
  const mine = h("div", "msg user");
  const typed = typedPart(text);
  if (typed) mine.append(h("div", "text", typed));
  mine.append(...fileCards(text), ...sentCards(text));
  return mine;
}

/** Show a turn as it happens, from its first event: what was sent, the answer as it is written, what the agent does, what it asks leave for. */
function follow(id: string, turn: string) {
  leave();
  const body = part("talk");
  if (!body) return;
  body.querySelectorAll(".turn-live, .none-yet").forEach((node) => node.remove());
  const box = h("div", "turn-live");
  const wait = h("div", "live");
  const waitFor = h("span", "", "답하는 중");
  wait.append(h("i", "pulse"), waitFor);
  box.append(wait);
  body.append(box);
  const put = (node: HTMLElement) => box.insertBefore(node, wait);
  let words: HTMLElement | null = null; // the message being written
  let raw = "";
  let steps: HTMLElement | null = null;
  let frame = 0;
  const paint = () => {
    frame = 0;
    if (words) rich(words, raw);
  };
  const settle = () => { cancelAnimationFrame(frame); paint(); };
  const source = new EventSource("/api/turn/stream?turn=" + encodeURIComponent(turn));
  live = { session: id, turn, source };
  tune();
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as TurnEvent;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 160;
    if (event.t !== "prompt" && event.t !== "done" && sent.session === id) sent.taken = true;
    if (event.t === "prompt") {
      // The record may already hold this request (the talk was opened in the middle of the turn): show it once.
      const said = [...body.querySelectorAll<HTMLElement>(":scope > .msg.user[data-item]")].reverse().find((one) => texts.get(one.dataset.item ?? "")?.text === event.text);
      if (said) while (said.nextSibling && said.nextSibling !== box) said.nextSibling.remove();
      said?.remove();
      const mine = sentBubble(event.text);
      const shown = sent.session === id ? sentPictures(sent.files) : null; // the pictures just sent from here, while the record does not show them
      if (shown) mine.prepend(shown);
      put(mine);
    } else if (event.t === "break") {
      settle();
      words = null;
      raw = "";
    } else if (event.t === "text") {
      if (!words) {
        const made = h("div", "msg agent");
        words = h("div", "text");
        made.append(words);
        put(made);
        steps = null;
      }
      raw += event.d;
      if (!frame) frame = requestAnimationFrame(() => { paint(); if (stick) body.scrollTop = body.scrollHeight; });
    } else if (event.t === "step") {
      settle();
      words = null;
      raw = "";
      if (!steps) {
        steps = h("div", "steps");
        put(steps);
      }
      const line = h("div", "step");
      line.append(h("b", "", STEP[event.kind]), h("span", "", event.label));
      steps.append(line);
    } else if (event.t === "ask") {
      settle();
      words = null;
      raw = "";
      steps = null;
      put(askCard(turn, event));
      waitFor.textContent = "허용할지 기다리는 중";
      void act.refresh(); // the map says at once that this session waits to be allowed something
    } else if (event.t === "answered") {
      const card = box.querySelector<HTMLElement>('[data-ask="' + CSS.escape(event.id) + '"]');
      card?.querySelector(".ask-row")?.replaceChildren(event.allow ? "허용했습니다" : "거절했습니다");
      card?.classList.add("closed");
      if (!box.querySelector(".ask:not(.closed)")) waitFor.textContent = "답하는 중";
      void act.refresh();
    } else if (event.t === "done") {
      settle();
      source.close();
      wait.remove();
      if (!event.ok) {
        trouble = { id, text: event.error ?? "끝내지 못했습니다" };
        box.append(h("div", "turn-error", trouble.text));
        if (sent.session === id && !sent.taken && state.open === id) {
          // the session never took the message: back into the box it goes, with its pieces
          const input = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
          if (input && !input.value) input.value = sent.text;
          for (const piece of sent.pieces) if (state.basket.some((one) => one.id === piece)) state.attached.add(piece);
          box.querySelector(".msg.user")?.remove();
          drawBasket();
        }
      }
      if (live?.turn === turn) live = null;
      have = { id: have.id, count: -1 }; // the record has grown: read it again
      tune();
      void act.refresh();
      window.setTimeout(() => void act.refresh(), 3000); // once more, in case the client was still writing its record
    }
    if (stick) body.scrollTop = body.scrollHeight;
  };
  source.onerror = () => {
    if (live?.turn !== turn) return;
    leave();
    wait.remove();
    box.append(h("div", "turn-error", "화면과 서버 사이가 끊겼습니다. 답은 세션의 기록에 남습니다."));
    tune();
  };
  body.scrollTop = body.scrollHeight;
}

async function submit(id: string) {
  const box = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!box) return;
  if (live?.session === id) {
    // while an answer is under way the button stops it
    await post("/api/turn/stop", { turn: live.turn }).catch(() => {});
    return;
  }
  const text = box.value.trim();
  const along = state.basket.filter((piece) => state.attached.has(piece.id));
  const going = picked;
  if (!text && (going.length || !along.length)) return;
  box.value = "";
  box.style.height = "auto";
  trouble = { id: "", text: "" };
  const body = part("talk");
  body?.querySelectorAll(":scope > .turn-error").forEach((node) => node.remove());
  // What was typed shows at once; the server reads the records before it starts the turn, which takes a moment.
  const sending = h("div", "turn-live");
  const mine = h("div", "msg user");
  const shown = sentPictures(going);
  if (shown) mine.append(shown);
  if (text) mine.append(h("div", "text", text));
  const others = going.filter((one) => !one.url).length;
  if (along.length || others) mine.append(h("div", "sent-note", [along.length ? "조각 " + along.length + "개" : "", others ? "파일 " + others + "개" : ""].filter(Boolean).join(", ") + "와 함께"));
  const wait = h("div", "live");
  wait.append(h("i", "pulse"), "보내는 중");
  sending.append(mine, wait);
  body?.append(sending);
  if (body) body.scrollTop = body.scrollHeight;
  box.disabled = true;
  try {
    const pieces = along.map(wire);
    const files = await wireFiles(going);
    const { turn } = await post<{ turn: string }>("/api/send", { project: state.snap!.project.id, session: id, text, pieces, ...(files.length ? { files } : {}), ...(wantModel ? { model: wantModel } : {}) });
    sent = { session: id, text, pieces: along.map((piece) => piece.id), files: going, taken: false };
    picked = []; // they went: the pictures stay in sight in the message, so their addresses are kept
    wantModel = ""; // the session answers with that model from now on: it is its own
    drawPicked();
    for (const piece of along) state.on.add(owner(piece.sessionId)?.id ?? piece.sessionId); // so that the line of what was sent is on the map
    state.attached.clear();
    drawBasket();
    if (state.open === id) follow(id, turn);
    window.setTimeout(() => void act.refresh(), 2500); // by then the map shows the session as at work, and the line of what was sent
  } catch (error) {
    sending.remove();
    box.value = text;
    body?.append(h("div", "turn-error", "보내지 못했습니다: " + (error as Error).message));
    if (body) body.scrollTop = body.scrollHeight;
  }
  box.disabled = false;
  tune();
}

function composer(form: HTMLFormElement, id: string) {
  const waitbar = h("button", "waitbar");
  waitbar.type = "button";
  waitbar.hidden = true;
  const basket = h("div", "basket");
  const row = h("div", "composer-row");
  const box = h("textarea", "");
  box.rows = 1;
  const later = h("button", "later", "다음 말에 싣기");
  later.type = "button";
  later.hidden = true;
  later.title = "지금 보내지 않고 걸어 둡니다. 이 세션에 다음 말을 칠 때 붙인 조각이 함께 갑니다. Codex 앱이나 터미널에서 쳐도 됩니다";
  later.onclick = () => void setToWait(id);
  const go = h("button", "go");
  go.type = "submit";
  const { clip, files, input } = attachParts(box);
  const foot = h("div", "composer-foot");
  const label = h("label", "model");
  const select = h("select", "");
  select.title = "다음 말에 답할 모델. 바꾸면 이 세션은 그 뒤로도 그 모델로 답합니다";
  select.onchange = () => {
    wantModel = select.value;
    select.classList.toggle("set", Boolean(wantModel));
  };
  label.append(h("span", "", "모델"), select);
  foot.append(label);
  foot.hidden = true;
  row.append(clip, box, later, go);
  form.append(waitbar, basket, files, row, foot, input);
  box.oninput = () => {
    box.style.height = "auto";
    box.style.height = Math.min(140, box.scrollHeight) + "px";
    tune();
  };
  box.onkeydown = (event) => {
    // Enter sends, Shift+Enter breaks the line; an Enter that only settles a Hangul syllable does neither
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void submit(id);
  };
}

/** A turn this tool started in the session may still be under way (the page was reloaded, or the talk was closed): join it. */
async function rejoin(id: string) {
  try {
    const { turn } = await call<{ turn: string | null }>("/api/turn/active?session=" + encodeURIComponent(id));
    if (turn && state.open === id && live?.turn !== turn) follow(id, turn);
  } catch { /* nothing to join */ }
}

// ---------- context: what a session took and gave, and what went along a line ----------

const STANDS: Partial<Record<Link["kind"], string>> = { fork: "갈라져 나올 때까지의 대화 전체", spawn: "새 세션을 만들며 건넨 요청", import: "가져와 이어 쓴 대화 전체" };
/** Whether a link is of a piece of text (and not of a whole conversation). */
const ofText = (link: Link) => link.kind === "transfer" || link.kind === "paste";
const fromSpan = (link: Link): Span | undefined => (link.from.start !== undefined && link.from.end !== undefined ? { start: link.from.start, end: link.from.end, parts: link.parts?.map((part) => part.from) } : undefined);
const toSpan = (link: Link): Span | undefined => (link.to.start !== undefined && link.to.end !== undefined ? { start: link.to.start, end: link.to.end, parts: link.parts?.map((part) => part.to) } : undefined);
/** Follow the piece a link carried. */
const follow_ = (link: Link) => act.openTrace({ sessionId: link.from.sessionId, itemId: link.from.itemId!, start: link.from.start ?? 0, end: link.from.end ?? 1e9 }, link.excerpt ?? "");

/** One thing that went from a session to another, with the ways to where it was said and where it arrived. */
function linkCard(link: Link, facing: "from" | "to" | "both"): HTMLElement {
  const found = link.grade === "paste"; // not in any record: found by matching text
  const card = h("div", "ctx-card" + (found ? " found" : ""));
  card.style.setProperty("--c", colorOf(owner(link.from.sessionId)?.id ?? link.from.sessionId));
  const other = owner(facing === "to" ? link.to.sessionId : link.from.sessionId)?.id ?? link.from.sessionId;
  const head = h("div", "ctx-meta");
  const kind = LINK[link.kind] + (found ? " 흔적" : "");
  head.append(h("span", "", facing === "both" ? kind : (facing === "from" ? "← " : "→ ") + kind));
  if (facing !== "both") head.append(h("b", "", name(other)));
  head.append(h("span", "ctx-when", day(link.to.at) + " " + clock(link.to.at)));
  const body = h("div", "ctx-text" + (ofText(link) ? "" : " whole"), ofText(link) ? (link.excerpt ?? "") + ((link.chars ?? 0) > (link.excerpt?.length ?? 0) ? "…" : "") : STANDS[link.kind] ?? LINK[link.kind]);
  const row = h("div", "ctx-row");
  const jump = (label: string, session: string, item?: string, span?: Span) => {
    const made = h("button", "", label);
    made.onclick = () => act.openChat(session, item, span);
    row.append(made);
  };
  jump("나온 자리", link.from.sessionId, link.from.itemId, fromSpan(link));
  jump("받은 자리", link.to.sessionId, link.to.itemId, toSpan(link));
  if (ofText(link) && link.from.itemId) {
    const trace = h("button", "", "역추적");
    trace.title = "이 글이 처음 나온 곳까지 거슬러 가고, 그 뒤 어디로 퍼졌는지 봅니다";
    trace.onclick = () => follow_(link);
    row.append(trace);
  }
  if (link.chars) row.append(h("span", "", link.chars.toLocaleString() + (found ? "자 같음" : "자")));
  if (found) card.title = "기록에 남은 전달이 아닙니다. 이 요청에 친 글이, 다른 세션이 먼저 한 말이나 변경과 같아서 찾았습니다";
  card.append(head, body, row);
  card.onpointerenter = () => act.hover(other);
  card.onpointerleave = () => act.hover(null);
  return card;
}

/** A piece set to go and not yet gone, with the way to take it back. */
function waitCard(piece: Waiting, facing: "from" | "to" | "both"): HTMLElement {
  const card = h("div", "ctx-card wait");
  card.style.setProperty("--c", colorOf(piece.from.sessionId));
  const other = facing === "to" ? piece.to.sessionId : piece.from.sessionId;
  const there = state.sessions.has(other) ? undefined : facing === "to" ? piece.to.where : piece.from.where; // the other end, when it is in another project
  const head = h("div", "ctx-meta");
  head.append(h("span", "", facing === "both" ? "대기" : facing === "from" ? "← 대기" : "→ 대기"));
  if (facing !== "both") head.append(h("b", "", there ? there.title : name(other)));
  if (there) head.append(h("span", "ctx-far", "프로젝트 " + there.projectName));
  head.append(h("span", "ctx-when", day(piece.at) + " " + clock(piece.at)));
  const body = h("div", "ctx-text", piece.excerpt + (piece.chars > piece.excerpt.length ? "…" : ""));
  card.append(head, body);
  const to = state.sessions.get(piece.to.sessionId);
  const trouble = to ? hookTrouble(to.client, state.snap!.hooks[to.client], piece.missed) : "";
  if (trouble) card.append(h("div", "ctx-warn", trouble));
  const row = h("div", "ctx-row");
  const back = h("button", "", "대기 취소");
  back.title = "걸어 둔 것을 취소합니다. 다음 말에 실리지 않습니다. 조각은 바구니에 그대로 있습니다";
  back.onclick = async () => {
    back.disabled = true;
    await post("/api/queue/cancel", { session: piece.to.sessionId, id: piece.id }).catch(() => {});
    await act.refresh();
  };
  const see = h("button", "", "나온 자리");
  see.onclick = () => (state.sessions.has(piece.from.sessionId) || !piece.from.where ? act.openChat(piece.from.sessionId, piece.from.itemId, { start: piece.from.start, end: piece.from.end }) : act.openElsewhere(piece.from.where.project, piece.from.sessionId, piece.from.itemId, { start: piece.from.start, end: piece.from.end }));
  row.append(back, see, h("span", "", piece.chars.toLocaleString() + "자"));
  card.append(row);
  card.onpointerenter = () => act.hover(other);
  card.onpointerleave = () => act.hover(null);
  return card;
}

function section(box: HTMLElement, title: string, count: number, none: string, cards: HTMLElement[]) {
  const head = h("div", "ctx-head");
  head.append(title, h("b", "", String(count)));
  box.append(head);
  if (cards.length) box.append(...cards);
  else box.append(h("div", "ctx-none", none));
}

function drawContext(session: Session) {
  const box = part("ctx");
  if (!box) return;
  box.textContent = "";
  const held = state.basket.map((piece) => {
    const card = h("div", "ctx-card");
    card.style.setProperty("--c", colorOf(piece.sessionId));
    const head = h("div", "ctx-meta");
    const far = afar(piece); // from a session of another project: it can be sent from here, and seen there
    head.append(h("span", "", KIND[piece.kind] + "에서"), h("b", "", whose(piece)));
    if (far) head.append(h("span", "ctx-far", "프로젝트 " + (piece.where?.projectName || "다른 곳")));
    const body = h("div", "ctx-text", piece.text);
    const row = h("div", "ctx-row");
    const on = state.attached.has(piece.id);
    const attach = h("button", on ? "on" : "", on ? "붙임" : "이 세션에 보낼 말에 붙이기");
    attach.onclick = () => {
      if (on) state.attached.delete(piece.id);
      else state.attached.add(piece.id);
      drawBasket();
      tune();
      drawContext(session);
    };
    const see = h("button", "", "나온 자리");
    see.onclick = () => (far ? act.openElsewhere(piece.where?.project ?? "", piece.sessionId, piece.itemId, { start: piece.start, end: piece.end }) : act.openChat(piece.sessionId, piece.itemId, { start: piece.start, end: piece.end }));
    if (far) see.title = "그 프로젝트를 지도에 함께 올리고 이 조각이 나온 자리를 엽니다";
    const drop = h("button", "", "빼기");
    drop.onclick = () => unhold(piece.id);
    const trace = h("button", "", "역추적");
    trace.title = "이 글이 처음 나온 곳까지 거슬러 가고, 그 뒤 어디로 퍼졌는지 봅니다";
    trace.onclick = () => act.openTrace({ sessionId: piece.sessionId, itemId: piece.itemId, start: piece.start, end: piece.end }, piece.text.slice(0, 600));
    if (!state.bundle) row.append(attach); // nothing is sent from an exported record
    if (far && !piece.where?.project) see.hidden = true; // nothing says which project it is in
    if (far) trace.hidden = true; // followed in its own project, where its lines are
    row.append(see, trace, drop, h("span", "", piece.text.length.toLocaleString() + "자"));
    card.append(head, body, row);
    carries(card, () => together(piece));
    return card;
  });
  section(box, "담아 둔 조각", held.length, "대화에서 글을 끌어 고르고 ‘담기’를 누르면 여기에 모입니다. 조각은 끌어서 지도의 다른 세션에 놓거나, 그 세션의 입력칸에서 붙여 보낼 수 있습니다.", held);
  // what waits for this session's next prompt, and what this session has waiting for others': shown only while there is some
  // (taken from the snapshot itself, not from the lines of the map: a piece may wait for, or come from, a session of another project)
  const waiting = state.snap?.waiting ?? [];
  const coming = waiting.filter((piece) => piece.to.sessionId === session.id);
  const going = waiting.filter((piece) => home(piece.from.sessionId) === session.id && piece.to.sessionId !== session.id);
  if (coming.length + going.length) section(box, "다음 말을 기다리는 조각", coming.length + going.length, "", [...coming.map((piece) => waitCard(piece, "from")), ...going.map((piece) => waitCard(piece, "to"))]);
  const taken = state.graph.flows.filter((flow) => flow.to === session.id).flatMap((flow) => flow.links);
  const given = state.graph.flows.filter((flow) => flow.from === session.id).flatMap((flow) => flow.links);
  section(box, "이 세션이 받은 것", taken.length, "다른 세션에서 온 것이 없습니다.", taken.map((link) => linkCard(link, "from")));
  section(box, "이 세션이 준 것", given.length, "다른 세션으로 간 것이 없습니다.", given.map((link) => linkCard(link, "to")));
  // what went between this session and sessions of other projects: no line on this map, since the other end is not on it
  const far = farOf(session.id);
  if (far.length) section(box, "다른 프로젝트와 주고받은 것", far.length, "", far.map(farCard));
}

const farOf = (id: string) => (state.snap?.far ?? []).filter((one) => home(one.sessionId) === id);
/** A piece that came from, or went to, a session of another project: what it was, whose it is there, and the ways to both ends. */
function farCard(link: FarLink): HTMLElement {
  const card = h("div", "ctx-card far");
  card.style.setProperty("--c", colorOf(link.dir === "in" ? link.other.sessionId : home(link.sessionId)));
  const head = h("div", "ctx-meta");
  head.append(h("span", "", link.dir === "in" ? "← 받음" : "→ 보냄"), h("b", "", link.other.title || "다른 프로젝트의 세션"), h("span", "ctx-far", "프로젝트 " + (link.other.projectName || "다른 곳")), h("span", "ctx-when", day(link.at) + " " + clock(link.at)));
  const body = h("div", "ctx-text", link.excerpt + (link.chars > link.excerpt.length ? "…" : ""));
  const row = h("div", "ctx-row");
  const mine = h("button", "", link.dir === "in" ? "받은 자리" : "나온 자리");
  mine.onclick = () => act.openChat(link.sessionId, link.itemId, link.start !== undefined && link.end !== undefined ? { start: link.start, end: link.end } : undefined);
  const theirs = h("button", "", link.dir === "in" ? "그 프로젝트의 나온 자리" : "그 프로젝트의 받은 세션");
  theirs.title = "프로젝트 ‘" + link.other.projectName + "’를 지도에 함께 올리고 그 세션을 엽니다. 그러면 이 조각이 지도에 선으로 보입니다";
  theirs.onclick = () => act.openElsewhere(link.other.project, link.other.sessionId, link.other.itemId, link.other.start !== undefined && link.other.end !== undefined ? { start: link.other.start, end: link.other.end } : undefined);
  const trace = h("button", "", "역추적");
  trace.title = "이 조각이 지나온 길을 따라갑니다. 다른 프로젝트로 넘어가는 곳에서는 그 프로젝트를 함께 올려 이어 따라갈 수 있습니다";
  trace.onclick = () => act.openTrace({ sessionId: link.sessionId, itemId: link.itemId!, start: link.start ?? 0, end: link.end ?? 1e9 }, link.excerpt);
  trace.hidden = !link.itemId;
  row.append(mine, theirs, trace, h("span", "", link.chars.toLocaleString() + "자"));
  if (link.dir === "out") card.title = "이 프로젝트에서 보낸 조각입니다. 도착은 받은 프로젝트의 기록에서 확인됩니다";
  card.append(head, body, row);
  return card;
}

function redrawContext() {
  const session = state.open ? state.sessions.get(state.open) : undefined;
  if (session && state.tab === "context") drawContext(session);
  if (session) drawTabs(session);
}

function drawTabs(session: Session) {
  const row = part("tabs");
  if (!row) return;
  row.textContent = "";
  const count = state.graph.flows.filter((flow) => flow.from === session.id || flow.to === session.id).reduce((sum, flow) => sum + flow.links.length + flow.waiting.length, 0) + farOf(session.id).length;
  for (const [key, label] of [["talk", "대화"], ["context", "맥락"]] as const) {
    const tab = h("button", "tab t-" + key + (state.tab === key ? " on" : ""));
    tab.append(label);
    if (key === "context" && count + state.basket.length) tab.append(h("b", "", String(count + state.basket.length)));
    tab.onclick = () => { state.tab = key; void drawChat(session.id); };
    row.append(tab);
  }
  if (state.trace) {
    // a piece is being followed and the pane has gone to a talk on its way: the way back to the way
    const back = h("button", "tab t-trace", "조각의 길");
    back.title = "따라가던 조각의 길로 돌아갑니다";
    back.onclick = () => drawTrace();
    row.append(back);
  }
}

/** The way of a piece, read downwards: where its text first appeared, the piece itself, and where it went. A stop is
 *  a place in a session's talk and opens it; between two stops is how the text got from the one to the other. */
export function drawTrace() {
  const trace = state.trace;
  if (!trace) return;
  trace.shown = true;
  leave();
  have = { id: "", count: -1 };
  const box = pane();
  box.hidden = false;
  box.classList.add("ctx-on");
  box.classList.remove("no-send");
  const mapId = (id: string) => owner(id)?.id ?? id;
  box.style.setProperty("--c", colorOf(mapId(trace.piece.sessionId)));
  box.textContent = "";
  const back = trace.steps.filter((step) => step.dir === "back").reverse(); // the furthest back first
  const onward = trace.steps.filter((step) => step.dir === "onward");
  const head = h("header", "chat-head");
  const title = h("div", "chat-title");
  title.append(h("h2", "", "조각이 지나온 길"), h("p", "", "온 길 " + back.length + " · 간 길 " + onward.length));
  const close = h("button", "icon");
  close.innerHTML = ICON.close;
  close.title = "따라가기 끝내기";
  close.onclick = () => {
    state.trace = null;
    if (state.edge) { act.render(); drawEdge(); }
    else if (state.open) { act.render(); void drawChat(state.open); }
    else closeChat();
  };
  head.append(title, close);
  const list = h("div", "ctx trace");
  const heads = new Map(state.snap!.items.map((item) => [item.id, item]));
  const where = (itemId?: string) => {
    const item = itemId ? heads.get(itemId) : undefined;
    return item ? KIND[item.kind] + (item.kind === "change" && item.path ? " · " + item.path.split("/").pop() : "") : "";
  };
  /** far: the stop is a session of a project that is not on the map. The way ends there for now: a press puts that
   *  project on the map and follows the piece again, on through it. */
  const stop = (sessionId: string, itemId: string | undefined, at: number, text: string, span: Span | undefined, note: string, depth = 0, self = false, far?: TraceStep["far"]) => {
    const card = h("button", "trace-stop" + (self ? " self" : "") + (far ? " far" : ""));
    card.style.setProperty("--c", far ? "var(--tie)" : colorOf(mapId(sessionId)));
    card.style.marginLeft = depth * 16 + "px";
    const meta = h("span", "trace-meta");
    meta.append(h("span", "sw " + (far?.client ?? state.sessions.get(sessionId)?.client ?? "codex")), h("b", "", far ? far.title || "다른 프로젝트의 세션" : name(mapId(sessionId))), h("span", "ctx-when", day(at) + " " + clock(at)));
    card.append(meta);
    if (far) card.append(h("span", "trace-note", "프로젝트 " + (far.projectName || "다른 곳") + " · 지도에 없음 · 누르면 함께 올려 이어 따라갑니다"));
    else if (note) card.append(h("span", "trace-note", note));
    if (text) card.append(h("span", "trace-text", text));
    if (far) {
      card.title = "프로젝트 ‘" + far.projectName + "’를 지도에 함께 올리고, 이 조각의 길을 그 안까지 이어 따라갑니다";
      card.onclick = async () => {
        card.disabled = true;
        if (await act.addProject(far.project)) act.openTrace(trace.piece, trace.text);
        else card.disabled = false;
      };
      return card;
    }
    card.title = "이 대화의 그 자리 열기";
    card.onclick = () => act.openChat(sessionId, itemId, span);
    card.onpointerenter = () => act.hover(mapId(sessionId));
    card.onpointerleave = () => act.hover(null);
    return card;
  };
  const hop = (step: TraceStep, depth = 0) => {
    const link = step.link;
    const row = h("div", "trace-hop" + (link.grade === "paste" ? " found" : "") + (step.dir === "onward" ? " on" : ""));
    row.style.setProperty("--c", step.far && step.dir === "back" ? "var(--tie)" : colorOf(mapId(link.from.sessionId))); // what came from off the map has no colour here
    row.style.marginLeft = 16 + depth * 16 + "px";
    row.append(link.kind === "paste" ? "붙여넣기 흔적 · " + (link.chars ?? 0).toLocaleString() + "자 같음" : link.kind === "transfer" ? "조각으로 보냄" + (step.far ? " · 프로젝트 사이" : "") : LINK[link.kind]);
    return row;
  };
  const carried = (link: Link) => (ofText(link) ? link.excerpt ?? "" : STANDS[link.kind] ?? "");
  back.forEach((step, at) => {
    const link = step.link;
    list.append(stop(link.from.sessionId, link.from.itemId, link.from.at, carried(link), fromSpan(link), (at === 0 ? "처음 나온 곳 · " : "") + where(link.from.itemId), 0, false, step.far), hop(step));
  });
  const self = state.sessions.get(trace.piece.sessionId);
  list.append(stop(trace.piece.sessionId, trace.piece.itemId, heads.get(trace.piece.itemId)?.at ?? self?.updatedAt ?? 0, trace.text, { start: trace.piece.start, end: trace.piece.end }, "따라가는 조각 · " + where(trace.piece.itemId), 0, true));
  for (const step of onward) {
    const link = step.link;
    // each place it went hangs, set in, under the place it went from: several under one are several ways out of it
    list.append(hop(step, step.depth - 1), stop(link.to.sessionId, link.to.itemId, link.to.at, carried(link), toSpan(link), where(link.to.itemId) || "세션을 시작하며", step.depth, false, step.far));
  }
  if (!trace.steps.length) list.append(h("div", "ctx-none", "이 조각이 다른 세션에서 왔거나 다른 세션으로 간 흔적은 찾지 못했습니다."));
  box.append(head, list);
}

// ---------- a new session ----------

let starting = false;
const home = (id: string) => owner(id)?.id ?? id;
/** Where and how the new session would run: worked out the way the server will (fresh.ts), from what was chosen here and the first piece attached. */
function freshWay() {
  const fresh = state.fresh!;
  const first = state.basket.find((piece) => state.attached.has(piece.id));
  const ask = (choice: { cwd?: string; like?: string }) => freshPlan(state.snap!.project, state.snap!.sessions, { client: fresh.client, from: first?.sessionId, ...choice });
  let plan = ask({ cwd: fresh.cwd, like: fresh.like });
  if ("error" in plan) {
    // what was chosen no longer holds (the session it named is gone): back to what is worked out
    fresh.cwd = undefined;
    fresh.like = undefined;
    plan = ask({});
  }
  return "error" in plan ? null : plan;
}
/** A folder as it reads from the project's own: the project's name, then the way down. */
function folderName(path: string): string {
  const root = (state.snap?.project.roots ?? []).find((one) => path === one || path.startsWith(one + "/"));
  const shown = root ? root.split("/").pop() + path.slice(root.length) : path;
  const parts = shown.split("/");
  return parts.length > 3 ? parts[0] + "/…/" + parts.slice(-2).join("/") : shown;
}

function tuneNew() {
  const fresh = state.fresh;
  const box = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
  const go = pane().querySelector<HTMLButtonElement>(".composer .go");
  if (!fresh || !box || !go) return;
  go.innerHTML = ICON.send;
  go.title = "새 세션 시작";
  go.disabled = starting || !box.value.trim();
  box.disabled = starting;
  const clip = pane().querySelector<HTMLButtonElement>(".composer .clip");
  if (clip) clip.disabled = starting;
  const plan = freshWay();
  const where = pane().querySelector<HTMLElement>(".fresh-where");
  if (where && plan) {
    where.textContent = CLIENT[fresh.client] + " · " + folderName(plan.cwd) + "에서 시작";
    where.title = plan.cwd;
  }
  // the folder and the model: what was worked out is shown as chosen, and can be changed
  const folder = pane().querySelector<HTMLSelectElement>(".fresh-folder");
  const model = pane().querySelector<HTMLSelectElement>(".fresh-model");
  if (plan && folder && model) {
    const option = (value: string, label: string, tip: string) => { const made = h("option", "", label); made.value = value; made.title = tip; return made; };
    folder.replaceChildren(...[...new Set([plan.cwd, ...plan.folders])].sort().map((path) => option(path, folderName(path), path)));
    folder.value = plan.cwd;
    folder.disabled = starting;
    const likes = plan.like && !plan.likes.some((one) => one.id === plan.like!.id) ? [plan.like, ...plan.likes] : plan.likes;
    model.replaceChildren(...likes.map((one) => option(one.id, one.model ?? "(모델 표시 없음)", "‘" + one.title + "’처럼: 그 세션의 모델과 권한")), option("none", CLIENT[fresh.client] + " 기본 설정", "따르는 세션 없이, 그 클라이언트의 기본 모델과 권한으로"));
    model.value = plan.like?.id ?? "none";
    model.disabled = starting;
  }
  const note = pane().querySelector<HTMLElement>(".fresh-note");
  if (note) note.textContent = plan?.like ? "모델과 권한(승인, 샌드박스)은 ‘" + flat(plan.like.title, 28) + "’ 세션을 따릅니다." : CLIENT[fresh.client] + "의 기본 모델과 권한으로 시작합니다.";
  pane().querySelectorAll<HTMLElement>(".client").forEach((one) => one.classList.toggle("on", one.dataset.client === fresh.client));
  // what the new session will be given besides the request: the pieces attached, each in the colour of where it came from
  const list = pane().querySelector<HTMLElement>(".fresh-pieces");
  if (!list) return;
  list.textContent = "";
  const along = state.basket.filter((piece) => state.attached.has(piece.id));
  const head = h("div", "ctx-head");
  head.append("함께 가는 조각", h("b", "", String(along.length)));
  list.append(head);
  if (!along.length) list.append(h("div", "ctx-none", state.basket.length ? "아래 담아 둔 조각을 누르면 붙습니다. 조각 없이 시작해도 됩니다." : "조각 없이 시작합니다. 다른 세션의 대화에서 글을 골라 지도의 빈 곳에 끌어다 놓으면 그 조각과 함께 시작할 수 있습니다."));
  for (const piece of along) {
    const card = h("div", "ctx-card");
    card.style.setProperty("--c", colorOf(home(piece.sessionId)));
    const meta = h("div", "ctx-meta");
    meta.append(h("span", "", KIND[piece.kind] + "에서"), h("b", "", whose(piece)));
    if (afar(piece)) meta.append(h("span", "ctx-far", "프로젝트 " + (piece.where?.projectName || "다른 곳")));
    meta.append(h("span", "ctx-when", piece.text.length.toLocaleString() + "자"));
    card.append(meta, h("div", "ctx-text", piece.text));
    card.onpointerenter = () => act.hover(home(piece.sessionId));
    card.onpointerleave = () => act.hover(null);
    list.append(card);
  }
}

async function startNew() {
  const fresh = state.fresh;
  const box = pane().querySelector<HTMLTextAreaElement>(".composer textarea");
  const body = part("talk");
  if (!fresh || !box || !body || starting) return;
  const text = box.value.trim();
  if (!text) return;
  const along = state.basket.filter((piece) => state.attached.has(piece.id));
  const going = picked;
  body.querySelectorAll(".turn-error, .turn-live").forEach((node) => node.remove());
  const sending = h("div", "turn-live");
  const mine = h("div", "msg user");
  const shown = sentPictures(going);
  if (shown) mine.append(shown);
  mine.append(h("div", "text", text));
  const others = going.filter((one) => !one.url).length;
  if (along.length || others) mine.append(h("div", "sent-note", [along.length ? "조각 " + along.length + "개" : "", others ? "파일 " + others + "개" : ""].filter(Boolean).join(", ") + "와 함께"));
  const wait = h("div", "live");
  wait.append(h("i", "pulse"), "새 세션을 시작하는 중");
  sending.append(mine, wait);
  body.append(sending);
  starting = true;
  tune();
  try {
    const pieces = along.map(wire);
    // the folder and the session to run like are sent as shown, so that what begins is what was seen
    const plan = freshWay();
    const files = await wireFiles(going);
    const made = await post<{ turn: string; session: string }>("/api/new", { project: state.snap!.project.id, client: fresh.client, text, pieces, cwd: plan?.cwd, like: plan ? plan.like?.id ?? "none" : undefined, ...(files.length ? { files } : {}) });
    box.value = "";
    picked = [];
    sent = { session: made.session, text, pieces: [], files: going, taken: false };
    state.attached.clear();
    for (const piece of along) state.on.add(home(piece.sessionId)); // so that the line to the new session is on the map
    drawBasket();
    // the client writes the session's record a moment after it begins: wait until it can be read
    let found = false;
    for (let tries = 0; tries < 24 && !found; tries += 1) {
      await act.refresh();
      found = state.sessions.has(made.session);
      if (!found) await new Promise((resolve) => window.setTimeout(resolve, 800));
    }
    starting = false;
    if (found) state.on.add(made.session);
    if (state.fresh !== fresh) return act.render(); // the pane has gone elsewhere meanwhile: the session is on the map all the same
    if (found) return act.openChat(made.session);
    wait.remove();
    sending.append(h("div", "turn-error", "세션은 시작했지만 기록이 아직 보이지 않습니다. 잠시 뒤 ‘기록 다시 읽기’를 눌러 주세요."));
    tune();
  } catch (error) {
    starting = false;
    sending.remove();
    body.append(h("div", "turn-error", "시작하지 못했습니다: " + (error as Error).message));
    tune();
    box.focus();
  }
}

/** Where a new session is begun: by which client, with which pieces, and what is asked of it first. */
export function drawNew() {
  const fresh = state.fresh;
  if (!fresh) return;
  leave();
  have = { id: "", count: -1 };
  const box = pane();
  // drawn again while it is open (another piece landed): what was being written stays
  const written = box.querySelector(":scope > .talk.fresh") ? box.querySelector<HTMLTextAreaElement>(".composer textarea")?.value ?? "" : "";
  box.hidden = false;
  box.classList.remove("ctx-on", "no-send");
  box.style.setProperty("--c", "var(--ink)");
  box.textContent = "";
  const head = h("header", "chat-head");
  const title = h("div", "chat-title");
  title.append(h("h2", "", "새 세션"), h("p", "fresh-where", ""));
  const close = h("button", "icon");
  close.innerHTML = ICON.close;
  close.title = "닫기";
  close.onclick = closeChat;
  head.append(title, close);
  const body = h("div", "talk fresh");
  const pick = h("div", "client-pick");
  for (const client of ["codex", "claude"] as const) {
    const one = h("button", "client");
    one.type = "button";
    one.dataset.client = client;
    one.append(h("span", "sw " + client), CLIENT[client]);
    one.onclick = () => {
      if (fresh.client !== client) fresh.like = undefined; // a session of the other client is nothing to go by
      fresh.client = client;
      try {
        localStorage.setItem("cf-new-client", client);
      } catch { /* storage may be shut off; the choice then lasts for this page only */ }
      tune();
    };
    pick.append(one);
  }
  const ways = h("div", "fresh-ways");
  const choose = (cls: string, label: string, tip: string, set: (value: string) => void) => {
    const field = h("label", "fresh-way");
    const select = h("select", cls);
    select.title = tip;
    select.onchange = () => { set(select.value); tune(); };
    field.append(h("span", "", label), select);
    return field;
  };
  ways.append(
    choose("fresh-folder", "폴더", "새 세션이 일할 폴더. 고르지 않으면 첫 조각이 나온 세션의 폴더입니다", (value) => { fresh.cwd = value; fresh.like = undefined; }),
    choose("fresh-model", "모델", "새 세션의 모델. 고른 모델을 쓰던 세션의 권한도 함께 따릅니다", (value) => { fresh.like = value; }),
  );
  body.append(pick, ways, h("p", "fresh-note", ""), h("div", "fresh-pieces"));
  const form = h("form", "composer");
  const basket = h("div", "basket");
  const row = h("div", "composer-row");
  const input = h("textarea", "");
  input.rows = 2;
  input.value = written;
  input.placeholder = "새 세션에 처음 할 말";
  const go = h("button", "go");
  go.type = "submit";
  const attach = attachParts(input);
  row.append(attach.clip, input, go);
  form.append(basket, attach.files, row, attach.input);
  input.oninput = () => {
    input.style.height = "auto";
    input.style.height = Math.min(140, input.scrollHeight) + "px";
    tune();
  };
  input.onkeydown = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    form.requestSubmit();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    void startNew();
  };
  box.append(head, body, form);
  drawBasket();
  tune();
  input.focus();
}

/** What went along one line of the map, both ways if context went both ways. */
export function drawEdge() {
  const edge = state.edge;
  if (!edge) return;
  leave();
  have = { id: "", count: -1 };
  const box = pane();
  box.hidden = false;
  box.classList.add("ctx-on"); // the list is all there is to show
  box.style.setProperty("--c", colorOf(edge.from));
  box.textContent = "";
  const head = h("header", "chat-head edge-head");
  const title = h("div", "chat-title");
  const across = projectOf(edge.from)?.id !== projectOf(edge.to)?.id; // the line goes from one project into another: each end says which it is in
  for (const [id, sign] of [[edge.from, ""], [edge.to, "→ "]] as const) {
    const line = h("button", "edge-end");
    line.style.setProperty("--c", colorOf(id));
    const said = h("span", "", sign + name(id));
    const of = across ? projectOf(id) : undefined;
    if (of) said.append(" ", h("span", "ctx-far", "프로젝트 " + projName(of)));
    line.append(h("span", "sw " + (state.sessions.get(id)?.client ?? "codex")), said);
    line.title = "이 세션의 대화 열기";
    line.onclick = () => act.openChat(id);
    title.append(line);
  }
  const close = h("button", "icon");
  close.innerHTML = ICON.close;
  close.title = "닫기";
  close.onclick = closeChat;
  head.append(title, close);
  const list = h("div", "ctx");
  const flow = state.graph.flows.find((one) => one.from === edge.from && one.to === edge.to);
  const there = flow?.links ?? [];
  const back = state.graph.flows.find((one) => one.from === edge.to && one.to === edge.from)?.links ?? [];
  const waiting = flow?.waiting ?? [];
  if (waiting.length) section(list, "다음 말을 기다리는 조각", waiting.length, "", waiting.map((piece) => waitCard(piece, "both")));
  if (there.length || !waiting.length) section(list, "이 선으로 넘어간 것", there.length, "기록에서 찾지 못했습니다.", there.map((link) => linkCard(link, "both")));
  if (back.length) section(list, "반대쪽으로 넘어간 것", back.length, "", back.map((link) => linkCard(link, "both")));
  box.append(head, list);
}

/** Open, or bring up to date, the pane for one session. quiet: called by a refresh, so leave it alone unless something was added. */
export async function drawChat(id: string, focus?: string, quiet = false, span?: Span) {
  const session = state.sessions.get(id);
  if (!session) return closeChat();
  if (!wired) {
    watchSelection();
    watchDrops();
    wired = true;
  }
  const box = pane();
  box.hidden = false;
  box.style.setProperty("--c", colorOf(id));
  const count = session.counts.prompts + session.counts.answers + session.counts.changes;
  const same = have.id === id && Boolean(part("talk"));
  if (!same) {
    leave();
    have = { id: "", count: -1 };
    box.textContent = "";
    dropPicked(); // what was picked was for the talk that was open
    wantModel = "";
    const form = h("form", "composer");
    composer(form, id);
    box.append(h("header", "chat-head"), h("div", "tabs"), h("div", "ties"), h("div", "talk"), h("div", "ctx"), form);
  }
  box.classList.toggle("ctx-on", state.tab === "context");
  box.classList.toggle("no-send", !top(session) || Boolean(state.bundle)); // a subagent's talk, and an exported record, are read here, not carried on
  const head = part("chat-head")!;
  const body = part("talk")!;
  head.textContent = "";
  head.append(h("span", "sw " + session.client));
  const title = h("div", "chat-title");
  const above = top(session) ? undefined : owner(session.id);
  const of = many() ? projectOf(session.id) : undefined;
  title.append(h("h2", "", session.title), h("p", "", (of ? projName(of) + " · " : "") + CLIENT[session.client] + " · " + stateWord(session) + " · " + day(session.startedAt) + "에 시작" + (above && above.id !== session.id ? " · ‘" + above.title + "’에 딸린 대화" : "")));
  const close = h("button", "icon");
  close.innerHTML = ICON.close;
  close.title = "닫기";
  close.onclick = closeChat;
  head.append(title, close);
  part("ties")!.replaceWith(ties(session));
  drawTabs(session);
  drawBasket();
  drawWaitbar(session);
  drawModels(session);
  tune();
  if (state.tab === "context") drawContext(session);
  if (same && live?.session === id) return; // the turn under way is being shown as it happens; the record is read when it ends
  if (same && have.count === count && !focus) return;
  if (quiet && same && body.scrollHeight - body.scrollTop - body.clientHeight > 80) return; // the user is reading further up: do not move the page under them
  have = { id, count };
  if (!same) body.replaceChildren(h("div", "stamp", "대화를 불러오는 중"));
  try {
    const { items } = await call<{ items: Said[] }>("/api/talk?session=" + encodeURIComponent(id));
    if (state.open !== id) return;
    // a very long item comes cut short; when the stretch to be marked lies beyond the cut, the whole of it is read
    const wanted = focus && span ? items.find((item) => item.id === focus) : undefined;
    if (wanted?.more && Math.max(span!.end, ...(span!.parts ?? []).map((part) => part[1])) > wanted.text.length) {
      const whole = await call<Item>("/api/item?id=" + encodeURIComponent(wanted.id)).catch(() => null);
      if (whole) { wanted.text = whole.text; delete wanted.more; }
    }
    fill(body, session, items, false, focus, span);
    if (!same) void rejoin(id);
  } catch (error) {
    body.replaceChildren(h("div", "stamp", "대화를 읽지 못했습니다: " + (error as Error).message));
  }
}
