// One project as the screen sees it: the sessions of both clients, what they said and changed, and what ties them.
// Several projects can be put on one map: they are then read one by one and seen as one.
import { basename } from "node:path";
import { readClaudeSessions } from "./claude.ts";
import { applyRollout, keptTurn, readCodexProjects, readCodexThreads, readRollout } from "./codex.ts";
import { hookStates } from "./hooks.ts";
import { farLinks, forkedBefore, overlaps, recordedLinks, transferLinks, withoutPieces, type Kept } from "./links.ts";
import { readLive, settleActivity, type Live } from "./live.ts";
import { pasteLinks } from "./paste.ts";
import type { Item, ItemHead, Project, Session, Snapshot, Transfer, Waiting } from "./model.ts";
import { readPending, readTransfers, type Pending } from "./store.ts";
import { oneLine, under } from "./util.ts";

export interface Built {
  snapshot: Snapshot;
  /** The text of every item, by id: handed out one at a time, never with the snapshot. */
  bodies: Map<string, Item>;
  /** For a session: what was said in it and then taken back, a stretch at a time. It is in no snapshot and ties
   *  nothing; a session's talk is given with it, to be looked at. */
  gone: Map<string, Item[][]>;
}

/** What a prompt asks, for its label: the desktop app puts the files and the selection it attaches before the request itself. */
function asking(text: string): string {
  const found = /\n## My request(?: for Codex)?:[ \t]*\n/.exec(text);
  return found ? text.slice(found.index + found[0].length) : text;
}

function head(item: Item): ItemHead {
  const { text, added, ...rest } = item;
  // a request is known by what was typed; one that was nothing but pieces, by saying so
  let label = oneLine(item.kind === "prompt" ? withoutPieces(asking(text)) || "(조각만 보냄)" : text, 90);
  if (item.kind === "change") {
    const lines = text.split("\n");
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    label = basename(item.path ?? "") + (added || removed ? "  +" + added + " −" + removed : "");
  }
  return { ...rest, size: text.length, label };
}

export function findProject(wanted: string, projects: Project[]): Project | undefined {
  return projects.find((project) => project.id === wanted) ?? projects.find((project) => project.roots.includes(wanted)) ?? projects.find((project) => project.name === wanted);
}

/** The projects asked for: one (its id, a folder of it, or its name), or several to be put on one map, named the
 *  same ways with commas between. Each is given once, in the order asked for. */
export function findProjects(wanted: string, projects: Project[]): Project[] {
  const one = findProject(wanted, projects);
  if (one) return [one];
  const found = wanted.split(",").map((part) => findProject(part.trim(), projects)).filter((project): project is Project => Boolean(project));
  return [...new Set(found)];
}

/** The pieces set to wait for sessions of this project, or by them for a session of another project (those say where
 *  they go). missed: the session was spoken to since, and the piece is still here. */
export function waitingOf(pending: Pending[], sessions: Session[], items: Item[]): Waiting[] {
  const here = new Set(sessions.map((session) => session.id));
  const spoken = new Map<string, number>();
  for (const item of items) if (item.kind === "prompt" && item.at > (spoken.get(item.sessionId) ?? 0)) spoken.set(item.sessionId, item.at);
  return pending.filter((row) => (here.has(row.to.sessionId) && (here.has(row.from.sessionId) || row.from.where)) || (here.has(row.from.sessionId) && row.to.where)).map((row) => ({
    id: row.id, at: row.at, from: row.from, to: row.to, chars: row.text.length, excerpt: row.text.slice(0, 600),
    missed: (spoken.get(row.to.sessionId) ?? 0) > row.at + 2000, // the hook runs a moment before the prompt is written down
  }));
}

/** The project, of several, that a folder is taken to be in: the one whose own folder lies nearest above it. */
export function nearestProject(cwd: string, projects: Project[]): Project | undefined {
  let best: Project | undefined;
  let deep = -1;
  for (const project of projects) {
    for (const root of project.roots) {
      if (under(cwd, root) && root.length > deep) { best = project; deep = root.length; }
    }
  }
  return best;
}

/** One project's sessions with what they said and changed, as the records and the live processes have them. */
async function readProject(project: Project, assigned: Map<string, string>, now: number, live: Live): Promise<{ sessions: Session[]; items: Item[]; notes: string[]; forks: Map<string, Fork>; gone: Map<string, Item[][]> }> {
  const notes: string[] = [];
  const sessions: Session[] = [];
  const items: Item[] = [];
  const forks = new Map<string, Fork>();
  const gone = new Map<string, Item[][]>();
  const codex = readCodexThreads(project, assigned);
  notes.push(...codex.notes);
  let unread = 0;
  for (const session of codex.sessions) {
    const rollout = session.recordPath ? await readRollout(session.id, session.recordPath) : null;
    if (!rollout) {
      unread += 1;
      continue;
    }
    applyRollout(session, rollout, now);
    settleActivity(session, { open: rollout.open, since: rollout.openAt }, live, now);
    if (session.activity === "running") session.nowFile = rollout.items.findLast((item) => item.kind === "change")?.path ?? null;
    else session.nowFile = null;
    sessions.push(session);
    items.push(...rollout.items);
    if (rollout.gone.length) gone.set(session.id, rollout.gone);
    if (rollout.base) forks.set(session.id, { base: rollout.base });
  }
  if (unread) notes.push("기록 파일을 읽지 못한 Codex 스레드 " + unread + "개는 뺐습니다.");
  const claude = await readClaudeSessions(project, undefined, now);
  notes.push(...claude.notes);
  for (const transcript of claude.transcripts) {
    settleActivity(transcript.session, { open: transcript.open, since: 0 }, live, now);
    transcript.session.nowFile = transcript.session.activity === "running" ? transcript.items.findLast((item) => item.kind === "change")?.path ?? null : null;
    sessions.push({ ...transcript.session }); // its own copy: the reader keeps the one it made, and what is settled here is this snapshot's
    items.push(...transcript.items);
    if (transcript.gone) gone.set(transcript.session.id, transcript.gone);
    if (transcript.forkKept) forks.set(transcript.session.id, { request: transcript.forkKept });
  }
  // A copy Codex made of a Claude Code session, never talked to since, is the same conversation twice: keep the original.
  const have = new Set(sessions.map((session) => session.id));
  const copies = new Set(sessions.filter((session) => session.origin === "imported" && session.parentId && have.has(session.parentId) && session.counts.prompts <= (sessions.find((other) => other.id === session.parentId)?.counts.prompts ?? 0)).map((session) => session.id));
  if (copies.size) {
    notes.push("Codex가 Claude Code에서 가져온 사본 " + copies.size + "개는 그 뒤 이어 쓴 것이 없어 원본 세션 하나로 그렸습니다.");
    for (let at = sessions.length - 1; at >= 0; at -= 1) if (copies.has(sessions[at].id)) sessions.splice(at, 1);
    for (let at = items.length - 1; at >= 0; at -= 1) if (copies.has(items[at].sessionId)) items.splice(at, 1);
    for (const id of copies) gone.delete(id);
  }
  return { sessions, items, notes, forks, gone };
}

/** What a fork's own record says of where it was made. base (Codex): the thread its history lies in and how far
 *  into that thread's record it goes. request (Claude Code): the last request it was given. */
interface Fork { base?: { thread: string; file: string; end: number }; request?: string }

/** One project as the screen sees it; or several put on one map, as one: every session of any of them, and what
 *  ties them, across the projects as within them. A session that lies in more than one of them (a project's folder
 *  may lie inside another's) is drawn once, as of the project whose folder is nearest to where it works. */
export async function buildSnapshot(project: Project | Project[], assigned: Map<string, string>, now = Date.now(), transfers: Transfer[] = readTransfers(), pending: Pending[] = readPending(), live: Live = readLive(now)): Promise<Built> {
  const projects = Array.isArray(project) ? project : [project];
  const many = projects.length > 1;
  const notes: string[] = [];
  const sessions: Session[] = [];
  const items: Item[] = [];
  const holders = new Map<string, Project[]>();
  const forks = new Map<string, Fork>();
  const gone = new Map<string, Item[][]>();
  for (const one of projects) {
    const part = await readProject(one, assigned, now, live);
    for (const [id, fork] of part.forks) forks.set(id, fork);
    for (const [id, stretches] of part.gone) gone.set(id, stretches);
    notes.push(...part.notes.map((note) => (many ? one.name + ": " + note : note)));
    const fresh = new Set<string>();
    for (const session of part.sessions) {
      const held = holders.get(session.id);
      if (held) {
        held.push(one);
        continue;
      }
      holders.set(session.id, [one]);
      fresh.add(session.id);
      sessions.push(session);
    }
    for (const item of part.items) if (fresh.has(item.sessionId)) items.push(item);
  }
  if (many) for (const session of sessions) session.projectId = (nearestProject(session.cwd, holders.get(session.id)!) ?? holders.get(session.id)![0]).id;
  const whole: Project = many ? { id: projects.map((one) => one.id).join(","), name: projects.map((one) => one.name).join(" + "), roots: [...new Set(projects.flatMap((one) => one.roots))] } : { id: projects[0].id, name: projects[0].name, roots: projects[0].roots };
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  // Where each fork was made, in its parent's talk. A Codex fork says how far into a file of a thread its history
  // goes: when that thread is its parent, the last turn before that place is the last it keeps.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const kept = new Map<string, Kept>();
  for (const [id, fork] of forks) {
    const parent = byId.get(byId.get(id)?.parentId ?? "");
    if (fork.request) kept.set(id, { request: fork.request });
    else if (fork.base && parent && fork.base.thread === parent.id) {
      // (the file the fork names: the parent's record may have been begun anew since, when a request of it was said again)
      const turn = keptTurn(fork.base.file, fork.base.end);
      if (turn) kept.set(id, { turn });
    }
  }
  const before = forkedBefore(sessions, items, kept);
  const recorded = recordedLinks(sessions, before);
  if (recorded.outside) notes.push("부모가 " + (many ? "이 프로젝트들" : "이 프로젝트") + " 밖에 있는 세션 " + recorded.outside + "개는 연결 없이 그렸습니다.");
  const here = new Set(sessions.map((session) => session.id));
  const sent = transferLinks(transfers.filter((transfer) => here.has(transfer.from.sessionId) && here.has(transfer.to.sessionId)), items);
  const pasted = pasteLinks(items, sessions, whole.id, before);
  notes.push("점선 화살표(붙여넣기)는 기록에 남은 것이 아니라 글자를 견줘 찾은 것입니다: 요청에 친 글 가운데 80자 이상이, 다른 세션이 그보다 먼저 한 답변이나 변경과 같을 때. 파일에서 직접 복사한 글도 잡힐 수 있습니다.");
  const bodies = new Map(items.map((item) => [item.id, item]));
  return {
    snapshot: { version: 1, madeAt: now, project: whole, ...(many ? { projects: projects.map((one) => ({ id: one.id, name: one.name, roots: one.roots })) } : {}), sessions, items: items.map(head), links: [...recorded.links, ...sent, ...pasted], waiting: waitingOf(pending, sessions, items), far: farLinks(transfers, sessions, items), hooks: hookStates(), overlaps: overlaps(items, whole), notes },
    bodies,
    gone,
  };
}

export { readCodexProjects };
