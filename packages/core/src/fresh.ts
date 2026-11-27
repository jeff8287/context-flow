// Where and how a session begun from this tool would run. Worked out the same way by the server, which begins it,
// and by the screen, which shows it beforehand and lets the person choose otherwise. Nothing of Node in here.
import type { Client, Project, Session } from "./model.ts";
import { within } from "./util.ts";

/** What the person chose, if anything. from: the session the first piece came from. like: a session's id, or "none" for the client's own defaults. */
export interface FreshChoice { client: Client; cwd?: string; like?: string; from?: string }
export interface FreshPlan {
  /** The folder it works in. */
  cwd: string;
  /** The session it runs like: its model, and what it may do without asking. Null: the client's own defaults. */
  like: Session | null;
  /** The folders it may be begun in: the project's own, and the ones its sessions work in, the newest first. */
  folders: string[];
  /** The sessions it may run like: for each model seen among this client's sessions, the nearest session that has it. */
  likes: Session[];
}

const main = (session: Session) => session.origin !== "subagent" && session.origin !== "side" && session.activity !== "archived";

export function freshPlan(project: Project, sessions: Session[], choice: FreshChoice): FreshPlan | { error: string } {
  const inside = (path: string) => within(path, project);
  const recent = sessions.filter(main).sort((a, b) => b.updatedAt - a.updatedAt);
  const folders = [...new Set([...project.roots, ...recent.map((session) => session.cwd).filter(inside)])].slice(0, 12);
  const source = sessions.find((session) => session.id === choice.from);
  if (choice.cwd && !inside(choice.cwd)) return { error: "새 세션은 이 프로젝트의 폴더 안에서만 시작합니다" };
  const cwd = choice.cwd || (source && inside(source.cwd) ? source.cwd : project.roots[0]);
  if (!cwd) return { error: "새 세션이 일할 폴더를 찾지 못했습니다" };
  const peers = recent.filter((session) => session.client === choice.client);
  // the same folder first: a session there was set up for the work done there
  const near = [...peers.filter((session) => session.cwd === cwd), ...peers.filter((session) => session.cwd !== cwd)];
  const likes: Session[] = [];
  for (const session of near) if (session.model && !likes.some((one) => one.model === session.model)) likes.push(session);
  let like: Session | null = near[0] ?? null;
  if (choice.like === "none") like = null;
  else if (choice.like) {
    like = peers.find((session) => session.id === choice.like) ?? null;
    if (!like) return { error: "따를 세션을 찾지 못했습니다" };
  }
  return { cwd, like, folders, likes };
}
