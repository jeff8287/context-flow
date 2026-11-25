// The drawer under the map: the sessions that are on, laid out over time. Secondary to the map, so it starts closed.
import * as d3 from "d3";
import type { Session } from "../../core/src/model.ts";
import { act, clock, colorOf, day, el, fit, KIND, LINK, MINUTE, owner, state } from "./state.ts";

const PITCH = 32;

export function drawLanes() {
  const snap = state.snap!;
  const drawer = el<HTMLElement>("drawer");
  const svg = d3.select<SVGSVGElement, unknown>("#lanes");
  svg.selectAll("*").remove();
  const chosen = [...state.on].map((id) => state.sessions.get(id)).filter((session): session is Session => Boolean(session)).sort((a, b) => a.startedAt - b.startedAt);
  const need = 40 + Math.max(1, chosen.length) * PITCH + 10;
  drawer.style.height = Math.min(Math.round(window.innerHeight * 0.42), need) + "px";
  svg.attr("height", need);
  const width = Math.max(320, drawer.getBoundingClientRect().width);
  if (!chosen.length) {
    svg.append("text").attr("class", "lane-none").attr("x", width / 2).attr("y", 46).attr("text-anchor", "middle").text("켜 둔 세션이 없습니다");
    return;
  }
  const ids = new Set(chosen.map((session) => session.id));
  const heads = snap.items.filter((item) => ids.has(item.sessionId) && item.at);
  // Time with the idle stretches folded: only spans where a shown session did something take up room.
  const moments = heads.map((item) => item.at).concat(chosen.map((session) => session.startedAt)).filter(Boolean).sort((a, b) => a - b);
  const spans: { a: number; b: number; x: number }[] = [];
  for (const at of moments) {
    const last = spans[spans.length - 1];
    if (last && at - last.b <= 30 * MINUTE) last.b = at;
    else spans.push({ a: at, b: at, x: 0 });
  }
  const left = width < 620 ? 136 : 212;
  const right = width - 22;
  const fold = 22;
  const length = (span: { a: number; b: number }) => Math.max(span.b - span.a, 4 * MINUTE);
  const scale = Math.max(0, right - left - fold * (spans.length - 1)) / d3.sum(spans, length);
  let x = left;
  for (const span of spans) {
    span.x = x;
    x += length(span) * scale + fold;
  }
  const X = (at: number) => {
    let span = spans[0];
    for (const candidate of spans) if (candidate.a <= at) span = candidate;
    return span.x + Math.min(Math.max(at - span.a, 0), length(span)) * scale;
  };
  const Y = new Map(chosen.map((session, at) => [session.id, 46 + at * PITCH]));
  const bottom = 46 + (chosen.length - 1) * PITCH + 14;
  let lastDay = "";
  let taken = -100;
  spans.forEach((span, at) => {
    if (at) svg.append("path").attr("class", "lane-fold").attr("d", "M" + (span.x - fold / 2) + " 24 V" + bottom);
    const today = day(span.a);
    const label = today !== lastDay ? today + " " + clock(span.a) : clock(span.a);
    const long = label.length * 6.4;
    const where = Math.min(span.x, width - 4 - long);
    if (where < taken + 8) return; // it would run into the label before it; the day is then said by the next one that fits
    svg.append("text").attr("class", "lane-axis" + (today !== lastDay ? " day" : "")).attr("x", where).attr("y", 16).text(label);
    lastDay = today;
    taken = where + long;
  });
  for (const session of chosen) {
    const y = Y.get(session.id)!;
    const color = colorOf(session.id);
    const mine = heads.filter((item) => item.sessionId === session.id).sort((a, b) => a.at - b.at);
    const lane = svg.append("g").attr("class", "lane " + session.activity).attr("data-id", session.id).style("--c", color)
      .on("pointerenter", () => act.hover(session.id)).on("pointerleave", () => act.hover(null));
    lane.append("rect").attr("class", "lane-hit").attr("x", 4).attr("y", y - PITCH / 2 + 1).attr("width", width - 8).attr("height", PITCH - 2).attr("rx", 7);
    lane.append("rect").attr("class", "lane-sw").attr("x", 12).attr("y", y - 5.5).attr("width", 11).attr("height", 11).attr("rx", session.client === "codex" ? 5.5 : 3);
    lane.append("text").attr("class", "lane-title").attr("x", 31).attr("y", y + 4).text(fit(session.title, 12.5, left - 42)).on("click", () => act.openChat(session.id)).append("title").text(session.title);
    if (!mine.length) continue;
    lane.append("path").attr("class", "lane-line").attr("d", "M" + X(mine[0].at) + " " + y + " H" + X(mine[mine.length - 1].at));
    const bars: { a: number; b: number }[] = [];
    for (const item of mine) {
      const last = bars[bars.length - 1];
      if (last && item.at - last.b <= 8 * MINUTE) last.b = item.at;
      else bars.push({ a: item.at, b: item.at });
    }
    for (const bar of bars) lane.append("rect").attr("class", "lane-work").attr("x", X(bar.a)).attr("y", y - 3).attr("width", Math.max(3, X(bar.b) - X(bar.a))).attr("height", 6).attr("rx", 3);
    let lastChange = -100;
    for (const item of mine) {
      const at = X(item.at);
      let mark: d3.Selection<any, unknown, HTMLElement, unknown> | null = null;
      if (item.kind === "prompt") mark = lane.append("path").attr("d", "M" + at + " " + (y - 8) + " V" + (y + 8));
      else if (item.kind === "answer" && item.final) mark = lane.append("circle").attr("cx", at).attr("cy", y).attr("r", 3.4);
      else if (item.kind === "change" && at - lastChange >= 6) {
        mark = lane.append("rect").attr("x", at - 2.5).attr("y", y - 13).attr("width", 5).attr("height", 5);
        lastChange = at;
      }
      mark?.attr("class", "lane-mark " + item.kind).on("click", () => act.openChat(session.id, item.id)).append("title").text(KIND[item.kind] + " · " + clock(item.at) + " · " + item.label);
    }
  }
  // context that moved, drawn where it arrived in time
  for (const link of snap.links) {
    const child = owner(link.to.sessionId);
    const parent = owner(link.from.sessionId);
    if (!child || !parent || child.id === parent.id || link.to.sessionId !== child.id) continue;
    const to = Y.get(child.id);
    const from = Y.get(parent.id);
    if (to === undefined || from === undefined) continue;
    const at = X(link.to.at);
    const down = to > from ? 1 : -1;
    const group = svg.append("g").attr("class", "lane-flow").style("--c", colorOf(parent.id));
    group.append("path").attr("d", "M" + (at - 12) + " " + (from + down * 4) + " C" + (at - 12) + " " + (from + down * 16) + " " + at + " " + (to - down * 22) + " " + at + " " + (to - down * 12));
    group.append("path").attr("class", "head").attr("d", "M" + at + " " + (to - down * 6) + " l-4.5 " + -down * 7 + " h9 z");
    group.append("title").text(LINK[link.kind]);
  }
}
