// What is worth telling the person of, found by setting two readings of the records side by side: a session that was
// at work and has stopped, and a session that has come to wait for the person. Nothing of the page in here, so that
// it can be tried without one.
import type { ItemHead, Session, Snapshot } from "../../core/src/model.ts";

/** done: the session ended a turn and waits for what is said next. approval: it waits to be allowed something.
 *  input: it waits for an answer to a question it put. */
export interface Notice { kind: "done" | "approval" | "input"; sessionId: string; title: string; body: string }

const SAYS = { done: "끝났습니다", approval: "허용을 기다립니다", input: "질문에 답하기를 기다립니다" } as const;

/** What a notice says under the session's name. */
export const noticeLine = (notice: Notice) => SAYS[notice.kind] + (notice.body ? " · " + notice.body : "");

/** What changed between two readings that the person would want to be told of. A session's subagents and side talks
 *  are its own business, and an archived session nobody waits for. */
export function noticesOf(before: Pick<Snapshot, "madeAt" | "sessions">, after: Pick<Snapshot, "sessions" | "items">): Notice[] {
  const was = new Map(before.sessions.map((session) => [session.id, session]));
  const lastAnswer = (id: string) => after.items.findLast((item: ItemHead) => item.sessionId === id && item.kind === "answer")?.label ?? "";
  const waits = (session: Session | undefined) => (session?.activity === "running" ? session.needs : undefined);
  const out: Notice[] = [];
  for (const now of after.sessions) {
    if (now.origin === "subagent" || now.origin === "side" || now.activity === "archived") continue;
    const then = was.get(now.id);
    const needs = waits(now);
    if (needs) {
      // told once, when it begins to wait: not again at every reading while it still does
      if (needs !== waits(then)) out.push({ kind: needs, sessionId: now.id, title: now.title, body: now.nowFile ? now.nowFile.split("/").pop() ?? "" : "" });
      continue;
    }
    if (now.activity === "running") continue;
    // It is not at work. It ended a turn since the last reading if it was at work then, or has answered more since
    // (a short turn can begin and end between two readings); a session not seen before, if it was begun since.
    const ended = then ? then.activity === "running" || now.counts.answers > then.counts.answers : now.startedAt >= before.madeAt && now.counts.answers > 0;
    if (ended) out.push({ kind: "done", sessionId: now.id, title: now.title, body: lastAnswer(now.id) });
  }
  return out;
}
