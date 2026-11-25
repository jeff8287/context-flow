// Carrying a piece across the screen. Something that stands for a piece (a chip of the basket, a card of the
// context tab, the button on a message, a stretch of selected text) is pressed and dragged; a mark follows the
// pointer; it is let go on a session (its tile on the map, its row in the list) to go with what is said to that
// session next, or on the empty map to begin a session with it.
// Done with pointer events, not the browser's own drag and drop: the map is a zoomed layer under other things, and
// what lies under the pointer is asked for directly. While a piece is carried a veil lies over the page, so that
// nothing under it answers the pointer.
import { colorOf, el, h, owner, state, top, type Held } from "./state.ts";

/** A piece as it is carried: where it was cut from and what it says. It is kept in the basket only when it lands. */
export type Spec = Pick<Held, "sessionId" | "itemId" | "start" | "end" | "text" | "kind" | "where">;
/** Where it landed: on a session, or on the empty map (a session to be begun). */
export type Drop = { session: string } | { fresh: true };

let landed: (drop: Drop, specs: Spec[]) => void = () => {};
/** Say what is done with pieces that land. */
export function onLanding(handler: (drop: Drop, specs: Spec[]) => void) { landed = handler; }

const short = (text: string, room: number) => { const one = text.replace(/\s+/g, " ").trim(); return one.length > room ? one.slice(0, room - 1) + "…" : one; };
const home = (id: string) => owner(id)?.id ?? id;

/** Where the carried pieces would land if let go at a place; node: what lights up there. Null where nothing takes them. */
function landing(x: number, y: number, specs: Spec[], floating: boolean): { drop: Drop; node: HTMLElement } | null {
  const session = (id: string | undefined, node: HTMLElement) => {
    const found = id ? state.sessions.get(id) : undefined;
    // a session takes pieces of other sessions: its own words it has already
    if (!found || !top(found) || found.activity === "archived" || specs.every((spec) => home(spec.sessionId) === found.id)) return null;
    return { drop: { session: found.id }, node };
  };
  for (const node of document.elementsFromPoint(x, y) as HTMLElement[]) {
    if (node.id === "carry-veil" || node.closest("#carry, #carry-hint")) continue;
    if (floating && node.closest("#chat")) continue; // laid over the map, and seen through while a piece is carried
    const place = node.closest<HTMLElement>(".tile, #list .row, #list .hit");
    if (place) return session(place.dataset.id, place);
    const pane = node.closest<HTMLElement>("#chat");
    if (pane) return state.open ? session(state.open, pane) : state.fresh ? { drop: { fresh: true }, node: pane } : null;
    if (node.closest(".float, #peek, #drawer, #side, .pill")) return null;
    const stage = node.closest<HTMLElement>("#stage");
    return stage ? { drop: { fresh: true }, node: stage } : null;
  }
  return null;
}

function begin(specs: Spec[]) {
  const veil = h("div");
  veil.id = "carry-veil";
  const mark = h("div");
  mark.id = "carry";
  mark.style.setProperty("--c", colorOf(home(specs[0].sessionId)));
  const where = h("span", "carry-to");
  mark.append(h("span", "carry-text", (specs.length > 1 ? "조각 " + specs.length + " · " : "") + short(specs[0].text, 28)), where);
  const hint = h("div", "", "세션에 놓으면 붙이기 · 빈 곳에 놓으면 새 세션");
  hint.id = "carry-hint";
  document.body.append(veil, mark);
  el<HTMLElement>("stage").append(hint);
  document.body.classList.add("carrying");
  const floating = getComputedStyle(el<HTMLElement>("chat")).position === "absolute";
  let lit: HTMLElement | null = null;
  const at = (x: number, y: number) => landing(x, y, specs, floating);
  return {
    specs,
    at,
    to(x: number, y: number) {
      const hit = at(x, y);
      if (lit !== (hit?.node ?? null)) {
        lit?.classList.remove("drop");
        lit = hit?.node ?? null;
        lit?.classList.add("drop");
      }
      mark.classList.toggle("ok", Boolean(hit));
      where.textContent = !hit ? "" : "fresh" in hit.drop ? "＋ 새 세션 시작" : "→ " + short(state.sessions.get(hit.drop.session)?.title ?? "", 24);
      mark.style.left = Math.max(8, Math.min(window.innerWidth - mark.offsetWidth - 8, x + 14)) + "px";
      mark.style.top = Math.max(8, Math.min(window.innerHeight - mark.offsetHeight - 8, y + 16)) + "px";
    },
    end() {
      lit?.classList.remove("drop");
      veil.remove();
      mark.remove();
      hint.remove();
      document.body.classList.remove("carrying");
    },
  };
}

/** A press that may turn into a carry: it does once the pointer has moved a little. what: the pieces, asked for when
 *  the carry begins. tap: the press ended where it began. */
export function press(event: MouseEvent, what: () => Spec[], tap?: () => void) {
  if (event.button !== 0 || state.bundle) return; // nothing is sent from an exported record
  const x0 = event.clientX;
  const y0 = event.clientY;
  let run: ReturnType<typeof begin> | null = null;
  const move = (now: PointerEvent) => {
    if (!run) {
      if (Math.hypot(now.clientX - x0, now.clientY - y0) < 6) return;
      const specs = what();
      if (!specs.length) return quit();
      run = begin(specs);
    }
    now.preventDefault();
    run.to(now.clientX, now.clientY);
  };
  const up = (now: PointerEvent) => {
    const went = run;
    const hit = went?.at(now.clientX, now.clientY) ?? null;
    quit();
    if (!went) return tap?.();
    if (hit) landed(hit.drop, went.specs);
  };
  const key = (now: KeyboardEvent) => {
    if (now.key !== "Escape") return;
    now.preventDefault();
    now.stopImmediatePropagation(); // Escape lets go of the piece; it does not also close the pane
    quit();
  };
  function quit() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", quit, true);
    window.removeEventListener("keydown", key, true);
    if (!run) return;
    run.end();
    run = null;
    state.calm = Date.now() + 1500; // the pointer now rests where the piece was let go: no card pops up over the map for that
    // the press that carried a piece is not also a click on what it began on
    const eat = (click: Event) => { click.stopPropagation(); click.preventDefault(); };
    window.addEventListener("click", eat, true);
    window.setTimeout(() => window.removeEventListener("click", eat, true), 0);
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", quit, true);
  window.addEventListener("keydown", key, true);
}

/** Make something a piece can be carried from. */
export function carries(node: HTMLElement, what: () => Spec[]) {
  if (state.bundle) return;
  node.classList.add("carries");
  node.addEventListener("pointerdown", (event) => press(event, what));
}
