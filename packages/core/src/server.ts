// The local API and the screen's files. Listens on 127.0.0.1 only. It reads the clients' records, and it can carry
// on a session's talk, or begin a session, through the session's own client (talk.ts). What it writes itself is the pieces: the ones it
// sent from one session to another, and the ones set to wait for a session's next prompt (store.ts).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { basename, extname, join, normalize } from "node:path";
import { HOME } from "./home.ts";
import { claudeHome, stoodBefore } from "./claude.ts";
import { codexHome, forkPoint, ownRecords } from "./codex.ts";
import { makeBundle, maskBundle, type Spot } from "./bundle.ts";
import { folderNamed, foldersIn, nearTrees } from "./folders.ts";
import { freshPlan } from "./fresh.ts";
import { filesIn, filesNote, pieceBlock, withBlocks } from "./links.ts";
import type { Client, Place, Project, Session, Transfer } from "./model.ts";
import { picturesOf, SHOWN } from "./pictures.ts";
import { findIn, goneOf, talkOf } from "./read.ts";
import { forgetKept, FROM_FOLDERS, lookAgain, projectFor, readProjects, shown } from "./projects.ts";
import { buildSnapshot, findProjects, nearestProject, type Built } from "./snapshot.ts";
import { standalonePage } from "./standalone.ts";
import { appendTransfers, dropPending, keepFolder, queuePieces, readBasket, saveUploads, takePending, tidyStore, uploadedFile, writeBasket, type Pending } from "./store.ts";
import { tracePiece } from "./trace.ts";
import { canStart, listModels, startFork, startNew, startTurn, type Along, type Turn } from "./talk.ts";
import { oneLine, within } from "./util.ts";
import { grown, Interest, watchRecords, type Changed } from "./watch.ts";

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".webmanifest": "application/manifest+json; charset=utf-8" }; // the last two: what makes the screen an app (its icons, and what it says of itself)

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 16_000_000) throw new Error("너무 깁니다"); // room for the files that may go with a message
  }
  const parsed = JSON.parse(text || "{}");
  return parsed && typeof parsed === "object" ? parsed : {};
}

type Cut = { transfer: Transfer; block: { id: string; from: string; kind: string; text: string } };

/** What a message from the screen brings besides its words and its pieces: the files (kept here, to be handed to the
 *  client or read by the agent) and the model asked for. note: what the agent is told of the files that are not
 *  pictures, put after the words. Throws with the reason when the files are more or larger than is taken. */
function alongOf(asked: Record<string, unknown>): { along: Along; note: string } {
  const { dir, saved } = saveUploads(asked.files);
  const model = typeof asked.model === "string" && /^[\w.:/@-]{1,100}$/.test(asked.model) ? asked.model : undefined;
  const others = saved.filter((one) => !one.image);
  return {
    along: { images: saved.filter((one) => one.image).map((one) => ({ path: one.path, type: one.type })), dirs: others.length && dir ? [dir] : [], ...(model ? { model } : {}) },
    note: filesNote(others.map((one) => one.path)),
  };
}
const brings = (asked: Record<string, unknown>) => Array.isArray(asked.files) && asked.files.length > 0;

/** The pieces asked for, cut from the records by where they are, so that what goes is what was said there. Null when
 *  one is not found. to: the receiving session (its id is "" when it is yet to be given one) and what it is.
 *  A piece may come from another project and says so: it is cut from that project's records, and both of its ends
 *  are written down in full with it, since neither project's records hold the other end. */
async function cut(read: (project: string) => Promise<Built | null>, home: Built, picked: Record<string, unknown>[], to: { sessionId: string; where: Place }, now: number): Promise<Cut[] | null> {
  const said = { prompt: "요청", answer: "답변", change: "변경" } as const;
  const client = { codex: "Codex", claude: "Claude Code" } as const;
  const out: Cut[] = [];
  const others = new Map<string, Built | null>();
  for (const one of picked) {
    // on the map (which may hold several projects), or else in the project the piece says it is from
    let made: Built | null | undefined = home;
    // (an item of the talk, or of what the session said and then left behind: a piece is cut from either)
    const id = String(one?.itemId ?? "");
    let item = home.bodies.get(id) ?? home.left.get(id);
    const named = typeof one?.project === "string" ? one.project : "";
    if (!item && named) {
      if (!others.has(named)) others.set(named, await read(named));
      made = others.get(named);
      item = made?.bodies.get(id) ?? made?.left.get(id);
    }
    const start = Number(one?.start);
    const end = Number(one?.end);
    if (!made || !item || item.sessionId !== one?.sessionId || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > item.text.length || start >= end) return null;
    const source = made.snapshot.sessions.find((other) => other.id === item.sessionId);
    const from = source ? placeOf(made, source) : null;
    const far = from && from.project !== to.where.project ? from : null; // the two ends are sessions of different projects
    const mark = "cf" + randomUUID().replace(/-/g, "").slice(0, 12);
    const text = item.text.slice(start, end);
    out.push({
      transfer: { id: mark, at: now, from: { sessionId: item.sessionId, itemId: item.id, start, end, ...(far ? { where: far } : {}) }, to: { sessionId: to.sessionId, ...(far ? { where: to.where } : {}) }, text },
      block: { id: mark, from: "‘" + (source?.title ?? "") + "’ (" + (source ? client[source.client] : "") + (far ? ", 프로젝트 " + far.projectName : "") + ")", kind: said[item.kind], text },
    });
  }
  return out;
}
/** What a session is, said in full: its own project (of the several that may be on the map), its name, its client. */
function placeOf(made: Built, session: Pick<Session, "projectId" | "title" | "client">, project?: Project): Place {
  const own = project ?? (made.snapshot.projects ?? []).find((one) => one.id === session.projectId) ?? made.snapshot.project;
  return { project: own.id, projectName: own.name, title: session.title, client: session.client };
}

/** A screen that asked to be told when what it shows has changed. key: the project it shows, or the several, as a
 *  snapshot of them is known by. */
interface Screen { key: string; interest: Interest; tell(event: unknown): void; timer: ReturnType<typeof setTimeout> | null; last: number }

/** The server that was started: which port it took (the one asked for, or any when 0 was asked for), and how to end it. */
export interface Served { ready: Promise<number>; close(): Promise<void> }

export function serve(port: number, webDir: string): Served {
  const built = new Map<string, Built>();
  const turns = new Map<string, Turn>();
  let bound = port;
  // The screens are told when the records change, so that they need not ask to find out. A burst of writing is told
  // of once it has had a moment to end, and a screen is told at most once a second.
  const screens = new Set<Screen>();
  const paths = new WeakMap<Built, Set<string>>();
  const knownOf = (made: Built): Set<string> => {
    let known = paths.get(made);
    if (!known) {
      known = new Set(made.snapshot.sessions.map((session) => session.recordPath).filter((path): path is string => Boolean(path)));
      paths.set(made, known);
    }
    return known;
  };
  const nudge = (screen: Screen) => {
    if (screen.timer) return;
    screen.timer = setTimeout(() => {
      screen.timer = null;
      screen.last = Date.now();
      screen.tell({ t: "changed" });
    }, Math.max(150, screen.last + 1000 - Date.now()));
  };
  const heard = (change: Changed) => {
    for (const screen of screens) {
      const made = built.get(screen.key);
      if (screen.interest.matters(change, made ? knownOf(made) : null)) nudge(screen);
    }
  };
  const watcher = watchRecords(heard);
  // A record that its client keeps open and adds to is not told of by the watch (watch.ts says why): the records the
  // screens know are looked at once a second for whether they have grown. Nobody listening, nothing is looked at.
  const sizes = new Map<string, number>();
  const looking = setInterval(() => {
    if (!screens.size) return sizes.clear();
    const known = new Set<string>();
    for (const screen of screens) {
      const made = built.get(screen.key);
      if (made) for (const path of knownOf(made)) known.add(path);
    }
    for (const path of grown(known, sizes)) heard({ where: "records", path });
  }, 1000);
  looking.unref();
  /** A turn this server runs changes what its session is doing, and the server knows it before any record says so. */
  const follow = (turn: Turn) => {
    for (const screen of screens) nudge(screen);
    turn.listen((event) => {
      if (event.t === "ask" || event.t === "answered" || event.t === "done") for (const screen of screens) nudge(screen);
    });
  };
  // wanted: a project (its id, a folder of it, or its name), or several put on one map (their ids, joined by commas)
  const read = async (wanted: string): Promise<Built | null> => {
    const { projects, assigned, from } = readProjects();
    const chosen = findProjects(wanted, projects);
    if (!chosen.length) return null;
    const made = await buildSnapshot(chosen.length === 1 ? chosen[0] : chosen, assigned);
    if (from === "folders") made.snapshot.notes.push(FROM_FOLDERS);
    // A turn this tool is running is known here at first hand: the session is at work, and waits to be allowed something
    // for as long as a request of its turn is unanswered.
    for (const turn of turns.values()) {
      const session = turn.done ? undefined : made.snapshot.sessions.find((one) => one.id === turn.sessionId);
      if (!session || session.activity === "archived") continue;
      session.activity = "running";
      const asked = new Set<string>();
      for (const event of turn.events) {
        if (event.t === "ask") asked.add(event.id);
        else if (event.t === "answered") asked.delete(event.id);
      }
      if (asked.size) session.needs = "approval";
    }
    built.set(made.snapshot.project.id, made);
    for (const screen of screens) if (screen.key === made.snapshot.project.id) screen.interest.settle(knownOf(made));
    return made;
  };
  // A session can be on several maps that were read (its project alone, and beside another). The one read last knows
  // the most, so that is the one asked about a session or an item.
  const newestFirst = () => [...built.values()].sort((one, other) => other.snapshot.madeAt - one.snapshot.madeAt);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (code: number, payload: unknown) => {
      response.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    try {
      // Only this machine's own page may talk to the API: a page from elsewhere could otherwise start a turn in a session.
      const host = request.headers.host ?? "";
      const mine = host === "127.0.0.1:" + bound || host === "localhost:" + bound;
      if (url.pathname.startsWith("/api/") && !mine) return send(403, { error: "이 컴퓨터의 화면에서만 씁니다" });
      if (request.method === "POST") {
        if (request.headers.origin !== "http://" + host || !String(request.headers["content-type"] ?? "").startsWith("application/json")) return send(403, { error: "이 화면에서 보낸 요청만 받습니다" });
        const asked = await body(request);
        if (url.pathname === "/api/send") {
          const text = typeof asked.text === "string" ? asked.text.trim() : "";
          const picked = Array.isArray(asked.pieces) ? (asked.pieces as Record<string, unknown>[]) : [];
          if (!text && brings(asked)) return send(400, { error: "붙인 것과 함께 보낼 말을 적어 주세요" });
          if (!text && !picked.length) return send(400, { error: "보낼 말이 없습니다" });
          // Read the records again first: whether the session is at work somewhere else is only known from them.
          const made = await read(String(asked.project ?? ""));
          const session = made?.snapshot.sessions.find((one) => one.id === asked.session);
          if (!session) return send(404, { error: "그런 세션이 없습니다" });
          if ([...turns.values()].some((turn) => turn.sessionId === session.id && !turn.done)) return send(409, { error: "이 세션은 앞서 보낸 말에 답하는 중입니다" });
          if (session.activity === "running") return send(409, { error: "이 세션은 지금 다른 곳에서 작업 중입니다. 끝난 뒤에 보내 주세요" });
          const now = Date.now();
          for (const [id, turn] of turns) if (turn.done && now - turn.endedAt > 600_000) turns.delete(id);
          const pieces = await cut(read, made!, picked, { sessionId: session.id, where: placeOf(made!, session) }, now);
          if (!pieces) return send(400, { error: "붙인 조각을 기록에서 찾지 못했습니다. 기록을 다시 읽은 뒤 담아 주세요" });
          let more: ReturnType<typeof alongOf>;
          try {
            more = alongOf(asked);
          } catch (error) {
            return send(400, { error: String(error instanceof Error ? error.message : error) });
          }
          // What was set to wait for this session goes with this message too. It is taken here, before the client is
          // started, so that the client's own hook finds nothing to add to the same message.
          const waited = takePending(session.id);
          const transfers = [...waited.rows.map(({ block: _, ...row }) => row as Transfer), ...pieces.map((piece) => piece.transfer)];
          const turn = startTurn(session, withBlocks(text + more.note, [...waited.rows.map((row) => row.block), ...pieces.map((piece) => pieceBlock(piece.block))]), more.along);
          turns.set(turn.id, turn);
          follow(turn);
          // The pieces are written down once the session has taken the message: when it begins to answer, or ends well.
          let kept = false;
          turn.listen((event) => {
            if (kept || event.t === "prompt") return;
            kept = true;
            if (event.t === "done" && !event.ok) return waited.back();
            waited.done();
            appendTransfers(transfers);
          });
          return send(200, { turn: turn.id, waited: waited.rows.length });
        }
        if (url.pathname === "/api/new") {
          // Begin a session with a first request, and the pieces picked for it. It is begun by its own client. Unless
          // the person chose otherwise it works in the folder the first piece came from (the project's first folder
          // when there is none) and runs like the nearest session of that client: its model and what it may do
          // without asking (fresh.ts). It may be begun in a folder outside the projects on the map, chosen from the
          // disk: it is then of the project that folder is in, or of a project of its own.
          // project: the project it is of, for the screen to put on the map when it is not there.
          const text = typeof asked.text === "string" ? asked.text.trim() : "";
          const picked = Array.isArray(asked.pieces) ? (asked.pieces as Record<string, unknown>[]) : [];
          const client: Client | null = asked.client === "codex" || asked.client === "claude" ? asked.client : null;
          if (!client) return send(400, { error: "어느 클라이언트로 시작할지 정해 주세요" });
          if (!text) return send(400, { error: "새 세션에 처음 할 말을 적어 주세요" });
          const now = Date.now();
          let begun: { cwd: string; like: Session | null; pieces: Cut[]; into?: Project; keep?: string };
          if (!asked.project) {
            // The first session of all, begun in a folder the person chose before there is a project to begin it in:
            // with no pieces (there is no session yet to cut them from) and its client's own defaults. Its folder is a
            // project once the session has written its record (projects.ts).
            const cwd = folderNamed(asked.cwd);
            if (!cwd) return send(400, { error: "그런 폴더가 없습니다: " + String(asked.cwd ?? "") });
            if (cwd === "/") return send(400, { error: "맨 위 폴더에서는 시작하지 않습니다. 일할 폴더를 골라 주세요" });
            if (picked.length) return send(400, { error: "첫 세션에는 조각을 붙일 수 없습니다" });
            begun = { cwd, like: null, pieces: [] };
          } else {
            const made = await read(String(asked.project));
            if (!made) return send(404, { error: "그런 프로젝트가 없습니다" });
            const on = made.snapshot.projects ?? [made.snapshot.project];
            let named = typeof asked.cwd === "string" && asked.cwd ? asked.cwd : undefined;
            // A folder outside the projects on the map, chosen from the disk: the session is of the project it lies
            // in, or of a project of its own (the work tree it lies in, or itself), kept once the session has begun.
            let away: ReturnType<typeof projectFor> | null = null;
            if (named && !on.some((one) => within(named!, one))) {
              const folder = folderNamed(named);
              if (!folder) return send(400, { error: "그런 폴더가 없습니다: " + named });
              if (folder === "/") return send(400, { error: "맨 위 폴더에서는 시작하지 않습니다. 일할 폴더를 골라 주세요" });
              away = projectFor(folder);
              named = folder;
            }
            const plan = freshPlan(made.snapshot.project, made.snapshot.sessions, {
              client, from: String(picked[0]?.sessionId ?? ""), cwd: named, anywhere: Boolean(away),
              like: typeof asked.like === "string" && asked.like ? asked.like : undefined,
            });
            if ("error" in plan) return send(400, { error: plan.error });
            if (!existsSync(plan.cwd)) return send(400, { error: "새 세션이 일할 폴더가 없습니다: " + plan.cwd });
            // with several projects on the map, the new session is of the one whose folder it is begun in
            const into = away?.project ?? nearestProject(plan.cwd, on);
            const pieces = await cut(read, made, picked, { sessionId: "", where: placeOf(made, { projectId: null, title: oneLine(text, 80), client }, into) }, now);
            if (!pieces) return send(400, { error: "붙인 조각을 기록에서 찾지 못했습니다. 기록을 다시 읽은 뒤 담아 주세요" });
            begun = { cwd: plan.cwd, like: plan.like, pieces, into, keep: away && !away.known ? away.project.roots[0] : undefined };
          }
          const { cwd, like, pieces, into, keep } = begun;
          let more: ReturnType<typeof alongOf>;
          try {
            more = alongOf(asked);
          } catch (error) {
            return send(400, { error: String(error instanceof Error ? error.message : error) });
          }
          const { turn, ready } = startNew({ client, cwd, like }, withBlocks(text + more.note, pieces.map((piece) => pieceBlock(piece.block))), more.along);
          turns.set(turn.id, turn);
          follow(turn);
          // its folder may be one no session worked in before: the folders are looked for again once it has written
          // its record (it answers), and when it is done
          let told = false;
          turn.listen((event) => {
            if (event.t === "prompt" || (told && event.t !== "done")) return;
            told = true;
            lookAgain();
          });
          let kept = false;
          turn.listen((event) => {
            if (kept || event.t === "prompt" || !turn.sessionId) return;
            kept = true;
            if (event.t === "done" && !event.ok) return;
            appendTransfers(pieces.map((piece) => ({ ...piece.transfer, to: { ...piece.transfer.to, sessionId: turn.sessionId } })));
          });
          try {
            const session = await Promise.race([ready, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("새 세션이 시작되지 않았습니다")), 20_000))]);
            if (keep) keepFolder(keep); // a project of its own from now on, beside the others
            return send(200, { turn: turn.id, session, client, cwd, model: like?.model ?? null, ...(into ? { project: shown(into) } : {}) });
          } catch (error) {
            if (!turn.done) turn.stop();
            return send(502, { error: String(error instanceof Error ? error.message : error) });
          }
        }
        if (url.pathname === "/api/projects/forget") {
          // Take a project this screen put on the list (a folder a session was begun in from here while it lay in no
          // project) off it again. Only the note of it goes: no record is touched, and the sessions there are on no
          // map until a session is begun there from here again.
          const project = readProjects().projects.find((one) => one.id === asked.project);
          if (!project) return send(404, { error: "그런 프로젝트가 없습니다" });
          if (!project.kept) return send(400, { error: "이 화면에서 더한 프로젝트만 목록에서 뺄 수 있습니다" });
          forgetKept(project);
          const { projects, from } = readProjects();
          return send(200, { projects: projects.map(shown), from });
        }
        if (url.pathname === "/api/fork") {
          // Say one of a session's requests again, in other words or the same. What was said stays said: the session
          // is forked as it stood before that request (by its own client), and the fork is given the new request. On
          // the map it is a session of its own, with the line of a fork from the session it came out of.
          const text = typeof asked.text === "string" ? asked.text.trim() : "";
          const picked = Array.isArray(asked.pieces) ? (asked.pieces as Record<string, unknown>[]) : [];
          if (!text) return send(400, { error: "고쳐 보낼 말을 적어 주세요" });
          const made = await read(String(asked.project ?? ""));
          const session = made?.snapshot.sessions.find((one) => one.id === asked.session);
          if (!made || !session) return send(404, { error: "그런 세션이 없습니다" });
          if (session.origin === "subagent" || session.origin === "side") return send(400, { error: "다른 세션에 딸린 대화는 갈라 낼 수 없습니다" });
          const prompt = made.bodies.get(String(asked.item ?? ""));
          if (!prompt || prompt.sessionId !== session.id || prompt.kind !== "prompt") return send(404, { error: "고칠 요청을 기록에서 찾지 못했습니다. 기록을 다시 읽은 뒤 해 주세요" });
          if (!existsSync(session.cwd)) return send(400, { error: "세션이 일하던 폴더가 없습니다: " + session.cwd });
          // Where the session is to be forked: each client names the place in its own way.
          let point: { from: string; at: string } | null | undefined;
          if (session.client === "claude") {
            const stood = session.recordPath && prompt.turnId ? await stoodBefore(session.recordPath, prompt.turnId) : { not: "found" as const };
            if ("not" in stood && stood.not === "summed") return send(400, { error: "Claude Code가 이 요청 뒤에 대화를 요약했습니다. 요약한 자리보다 앞에서는 대화를 갈라 낼 수 없습니다" });
            if ("not" in stood && stood.not === "back") return send(400, { error: "되감아서 지금 대화에 없는 요청입니다. 여기서는 대화를 갈라 낼 수 없습니다" });
            point = "not" in stood ? undefined : stood.at === null ? null : { from: session.id, at: stood.at };
          } else {
            const nth = (item: { id: string }) => Number(item.id.slice(item.id.lastIndexOf(":") + 1));
            const own = [...made.bodies.values()].filter((item) => item.sessionId === session.id).sort((one, other) => nth(one) - nth(other));
            point = forkPoint(session, own, prompt);
          }
          if (point === undefined) return send(400, { error: "이 요청 앞에서 대화를 갈라 낼 곳을 기록에서 찾지 못했습니다" });
          const now = Date.now();
          const pieces = await cut(read, made, picked, { sessionId: "", where: placeOf(made, { projectId: session.projectId, title: oneLine(text, 80), client: session.client }) }, now);
          if (!pieces) return send(400, { error: "붙인 조각을 기록에서 찾지 못했습니다. 기록을 다시 읽은 뒤 담아 주세요" });
          let more: ReturnType<typeof alongOf>;
          try {
            more = alongOf(asked);
          } catch (error) {
            return send(400, { error: String(error instanceof Error ? error.message : error) });
          }
          const { turn, ready } = startFork(session, point, withBlocks(text + more.note, pieces.map((piece) => pieceBlock(piece.block))), more.along);
          turns.set(turn.id, turn);
          follow(turn);
          let kept = false;
          turn.listen((event) => {
            if (kept || event.t === "prompt" || !turn.sessionId) return;
            kept = true;
            if (event.t === "done" && !event.ok) return;
            appendTransfers(pieces.map((piece) => ({ ...piece.transfer, to: { ...piece.transfer.to, sessionId: turn.sessionId } })));
          });
          try {
            const fork = await Promise.race([ready, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("갈라 낸 세션이 시작되지 않았습니다")), 20_000))]);
            // from: the session the fork's record will name as the one it came out of; null when nothing was kept
            return send(200, { turn: turn.id, session: fork, from: point?.from ?? null });
          } catch (error) {
            if (!turn.done) turn.stop();
            return send(502, { error: String(error instanceof Error ? error.message : error) });
          }
        }
        if (url.pathname === "/api/queue") {
          // Set pieces to go with the next thing said to a session, wherever that is typed. No turn is started here, so
          // it does not matter who holds the session or whether it is at work: the hook of its client takes them.
          const picked = Array.isArray(asked.pieces) ? (asked.pieces as Record<string, unknown>[]) : [];
          if (!picked.length) return send(400, { error: "걸어 둘 조각이 없습니다" });
          const made = await read(String(asked.project ?? ""));
          const session = made?.snapshot.sessions.find((one) => one.id === asked.session);
          if (!session) return send(404, { error: "그런 세션이 없습니다" });
          const pieces = await cut(read, made!, picked, { sessionId: session.id, where: placeOf(made!, session) }, Date.now());
          if (!pieces) return send(400, { error: "붙인 조각을 기록에서 찾지 못했습니다. 기록을 다시 읽은 뒤 담아 주세요" });
          const rows: Pending[] = pieces.map((piece) => ({ ...piece.transfer, block: pieceBlock(piece.block) }));
          queuePieces(rows);
          return send(200, { queued: rows.map((row) => row.id), hook: made!.snapshot.hooks[session.client] });
        }
        if (url.pathname === "/api/queue/cancel") return send(200, { ok: dropPending(String(asked.session ?? ""), String(asked.id ?? "")) });
        if (url.pathname === "/api/basket") {
          // The pieces kept on the screen, kept here: one basket whatever project or browser the screen is opened in.
          const pieces = (Array.isArray(asked.pieces) ? (asked.pieces as Record<string, unknown>[]) : []).filter((one) => one && typeof one.id === "string" && typeof one.sessionId === "string" && typeof one.itemId === "string"
            && typeof one.text === "string" && Number.isInteger(one.start) && Number.isInteger(one.end) && ["prompt", "answer", "change"].includes(String(one.kind)));
          writeBasket(pieces.slice(-500));
          return send(200, { kept: Math.min(pieces.length, 500) });
        }
        const turn = turns.get(String(asked.turn ?? ""));
        if (!turn) return send(404, { error: "그런 턴이 없습니다" });
        if (url.pathname === "/api/turn/answer") return send(200, { ok: turn.answer(String(asked.id ?? ""), asked.allow === true) });
        if (url.pathname === "/api/turn/stop") {
          turn.stop();
          return send(200, { ok: true });
        }
        return send(404, { error: "없습니다" });
      }
      if (request.method !== "GET") return send(405, { error: "받지 않는 요청입니다" });
      if (url.pathname === "/api/basket") return send(200, { pieces: readBasket() });
      if (url.pathname === "/api/folders") {
        // The folders in one, for choosing where a session is begun from the disk (the first one, or one outside the
        // projects on the map): from the home folder unless another is asked for. Asked for the home folder, or with
        // near, the git work trees near the home folder are named too. of: the project there is already that a
        // session begun there would be of.
        const asked = url.searchParams.get("path");
        const path = folderNamed(asked || "~");
        if (!path) return send(400, { error: "그런 폴더가 없습니다: " + asked });
        const found = projectFor(path);
        return send(200, { ...foldersIn(path), ...(found.known ? { of: { id: found.project.id, name: found.project.name } } : {}), ...(asked && !url.searchParams.has("near") ? {} : { near: nearTrees() }) });
      }
      if (url.pathname === "/api/models") {
        // What a client offers to answer with, for the box in which the model of a session's next message is chosen.
        const client = url.searchParams.get("client");
        return send(200, { models: client === "codex" || client === "claude" ? await listModels(client) : [] });
      }
      if (url.pathname === "/api/projects") {
        // from: whether they are the Codex app's sidebar projects, or were found from the folders the sessions worked in.
        // clients: which of the two can be started here. looked: where the records were looked for, said only when
        // nothing was found there (a person who has not run a session yet, or whose records are kept elsewhere).
        const { projects, from } = readProjects();
        const place = (client: Client, path: string) => ({ client, path: path.startsWith(HOME + "/") ? "~" + path.slice(HOME.length) : path, there: existsSync(path) });
        const looked = projects.length ? undefined : [place("codex", codexHome()), place("claude", claudeHome())];
        return send(200, { projects: projects.map(shown), from, clients: { codex: canStart("codex"), claude: canStart("claude") }, looked });
      }
      if (url.pathname === "/api/snapshot") {
        const made = await read(url.searchParams.get("project") ?? "");
        if (!made) return send(404, { error: "그런 프로젝트가 없습니다" });
        return send(200, made.snapshot);
      }
      if (url.pathname === "/api/item") {
        const id = url.searchParams.get("id") ?? "";
        for (const made of newestFirst()) {
          const item = made.bodies.get(id);
          if (item) return send(200, item);
        }
        // something that was said and then taken back: it is in no snapshot, and is read as a whole all the same
        for (const made of newestFirst()) {
          const item = made.left.get(id);
          if (item) return send(200, item);
        }
        return send(404, { error: "그런 조각이 없습니다" });
      }
      if (url.pathname === "/api/picture" || url.pathname === "/api/attached") {
        // What went with a request besides its words: a picture (read from the client's record, where it is kept),
        // or another file (one this tool kept when the request was sent from here). The n-th of that request.
        const id = url.searchParams.get("item") ?? "";
        const n = Number(url.searchParams.get("n") ?? 0);
        const made = newestFirst().find((one) => one.bodies.has(id));
        const item = made?.bodies.get(id);
        const session = item ? made!.snapshot.sessions.find((one) => one.id === item.sessionId) : undefined;
        if (item?.kind === "prompt" && session && Number.isInteger(n) && n >= 0) {
          if (url.pathname === "/api/attached") {
            const kept = uploadedFile(filesIn(item.text)[n] ?? "");
            if (kept) {
              response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(basename(kept)), "cache-control": "no-store", "x-content-type-options": "nosniff" });
              return response.end(readFileSync(kept));
            }
          } else if (session.recordPath && item.turnId) {
            // several requests can be of one Codex turn: the turn's pictures are theirs in the order they were said
            const nth = (one: { id: string }) => Number(one.id.slice(one.id.lastIndexOf(":") + 1));
            let before = 0;
            if (session.client === "codex") for (const other of made!.bodies.values()) if (other.sessionId === item.sessionId && other.kind === "prompt" && other.turnId === item.turnId && nth(other) < nth(item)) before += other.images ?? 0;
            // a Codex thread's record may lie in several files: the turn is in one of them
            let picture: Awaited<ReturnType<typeof picturesOf>>[number] | undefined;
            if (n < (item.images ?? 0)) {
              for (const path of session.client === "codex" ? await ownRecords(session.id, session.recordPath) : [session.recordPath]) {
                picture = (await picturesOf(session.client, path, item.turnId))[before + n];
                if (picture) break;
              }
            }
            if (picture && SHOWN.has(picture.type)) {
              // what a request was sent with does not change: the page need not ask for it again
              response.writeHead(200, { "content-type": picture.type, "content-length": picture.bytes.length, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
              return response.end(picture.bytes);
            }
          }
        }
        return send(404, { error: url.pathname === "/api/picture" ? "그 그림을 기록에서 꺼내지 못했습니다" : "그 파일은 이제 없습니다" });
      }
      if (url.pathname === "/api/talk") {
        // One session's items in the order they were said, for the talk pane. A very long text is cut; /api/item has the whole.
        const id = url.searchParams.get("session") ?? "";
        for (const made of newestFirst()) {
          if (!made.snapshot.sessions.some((session) => session.id === id)) continue;
          return send(200, { items: talkOf(made.bodies.values(), id), gone: goneOf(made.bodies.values(), id, made.gone.get(id)) });
        }
        return send(404, { error: "그런 세션이 없습니다" });
      }
      if (url.pathname === "/api/find") {
        // Where a word was said, in any session of the project: a few places a session, the newest first.
        const made = built.get(url.searchParams.get("project") ?? "") ?? (await read(url.searchParams.get("project") ?? ""));
        if (!made) return send(404, { error: "그런 프로젝트가 없습니다" });
        return send(200, { hits: findIn(made.bodies.values(), url.searchParams.get("q") ?? "") });
      }
      if (url.pathname === "/api/export") {
        // Some sessions of a project, as the records have them now, in one file: a bundle (as=json), or the screen
        // with the bundle in it (as=html), which opens by itself anywhere. Sent as a file to be kept; with view=1 the
        // page is shown instead, to be looked over before it is handed out.
        const made = await read(url.searchParams.get("project") ?? "");
        if (!made) return send(404, { error: "그런 프로젝트가 없습니다" });
        const ids = (url.searchParams.get("sessions") ?? "").split(",").filter(Boolean);
        // spots: where tiles were put by hand, as the screen has them: id:x:y, with commas between
        const spots = (url.searchParams.get("spots") ?? "").split(",").map((one) => one.split(":")).filter((one) => one.length === 3 && one[0] && Number.isFinite(Number(one[1])) && Number.isFinite(Number(one[2]))).map((one): Spot => [one[0], Number(one[1]), Number(one[2])]);
        let bundle = makeBundle(made.snapshot, made.bodies, { sessions: ids.length ? ids : undefined, theme: url.searchParams.get("theme") === "dark" ? "dark" : "light", spots });
        // mask=1: the name of the person whose machine this is (as the home folder and the login have it) is covered
        // wherever it stands, and so are the words asked for besides
        if (url.searchParams.get("mask") === "1") bundle = maskBundle(bundle, [basename(HOME), userInfo().username, ...(url.searchParams.get("words") ?? "").split(",")]).bundle;
        const html = url.searchParams.get("as") === "html";
        const two = (value: number) => String(value).padStart(2, "0");
        const when = new Date(bundle.madeAt);
        const name = "맥락흐름-" + bundle.snapshot.project.name.replace(/[^\p{L}\p{N}_-]+/gu, "_") + "-" + two(when.getMonth() + 1) + two(when.getDate()) + "-" + two(when.getHours()) + two(when.getMinutes()) + (html ? ".html" : ".json");
        const shown = html && url.searchParams.get("view") === "1";
        response.writeHead(200, {
          "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
          "content-disposition": (shown ? "inline" : "attachment") + "; filename=\"context-flow" + (html ? ".html" : ".json") + "\"; filename*=UTF-8''" + encodeURIComponent(name),
          "cache-control": "no-store",
        });
        return response.end(html ? standalonePage(webDir, bundle) : JSON.stringify(bundle));
      }
      if (url.pathname === "/api/trace") {
        // Where a piece came from and where it went: the stretch of an item from start to end, followed both ways.
        const made = built.get(url.searchParams.get("project") ?? "") ?? (await read(url.searchParams.get("project") ?? ""));
        if (!made) return send(404, { error: "그런 프로젝트가 없습니다" });
        const wanted = url.searchParams.get("item") ?? "";
        const item = made.bodies.get(wanted) ?? made.left.get(wanted);
        if (!item) return send(404, { error: "그런 조각이 없습니다" });
        const start = Math.max(0, Number(url.searchParams.get("start") ?? 0) || 0);
        const end = Math.min(item.text.length, Number(url.searchParams.get("end") ?? item.text.length) || item.text.length);
        const steps = tracePiece({ sessionId: item.sessionId, itemId: item.id, start, end }, made.snapshot.links, made.bodies, made.snapshot.sessions, made.snapshot.far ?? [], made.left);
        // left: the stops of the way that lie in what a session left behind (they are in no snapshot): what each is, and when it was said
        const left: Record<string, { kind: string; at: number }> = {};
        for (const id of [item.id, ...steps.flatMap((step) => [step.link.from.itemId, step.link.to.itemId])]) {
          const one = id ? made.left.get(id) : undefined;
          if (one) left[one.id] = { kind: one.kind, at: one.at };
        }
        return send(200, { steps, left });
      }
      if (url.pathname === "/api/turn/active") {
        // The turn this tool is running in a session, if any: a screen opened in the middle of one joins it.
        const id = url.searchParams.get("session") ?? "";
        const turn = [...turns.values()].find((one) => one.sessionId === id && !one.done);
        return send(200, { turn: turn?.id ?? null });
      }
      if (url.pathname === "/api/events") {
        // Told when what a screen shows has changed: the records of its projects, what a client's process says it is
        // at, a piece set to wait or taken. Only that something changed is said; the screen then reads again.
        const chosen = findProjects(url.searchParams.get("project") ?? "", readProjects().projects);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        const tell = (event: unknown) => { response.write("data: " + JSON.stringify(event) + "\n\n"); };
        const screen: Screen = { key: chosen.map((one) => one.id).join(","), interest: new Interest(), tell, timer: null, last: 0 };
        screens.add(screen);
        tell({ t: "hello", watching: watcher.watching() > 0 });
        const beat = setInterval(() => response.write(": beat\n\n"), 25_000);
        request.on("close", () => {
          clearInterval(beat);
          if (screen.timer) clearTimeout(screen.timer);
          screens.delete(screen);
        });
        return;
      }
      if (url.pathname === "/api/turn/stream") {
        const turn = turns.get(url.searchParams.get("turn") ?? "");
        if (!turn) return send(404, { error: "그런 턴이 없습니다" });
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        const write = (event: unknown) => response.write("data: " + JSON.stringify(event) + "\n\n");
        for (const event of turn.events) write(event);
        if (turn.done) return response.end();
        const quit = turn.listen((event) => {
          write(event);
          if (event.t === "done") response.end();
        });
        request.on("close", quit);
        return;
      }
      const wanted = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = join(webDir, wanted);
      if (!file.startsWith(webDir) || !existsSync(file)) return send(404, { error: "없습니다" });
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      response.end(readFileSync(file));
    } catch (error) {
      send(500, { error: String(error instanceof Error ? error.message : error) });
    }
  });
  const ready = new Promise<number>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      bound = (server.address() as AddressInfo).port;
      console.log("context-flow: http://127.0.0.1:" + bound);
      resolve(bound);
    });
  });
  // what a hook or an earlier server left half done is cleared away: now, and every ten minutes
  const tidy = () => {
    try {
      const done = tidyStore();
      if (done.back || done.gone) console.log("context-flow: 남은 것을 치웠습니다 (다시 기다리게 한 조각 " + done.back + ", 지운 파일 " + done.gone + ")");
    } catch { /* nothing to clear, or not ours to clear */ }
  };
  tidy();
  const tidying = setInterval(tidy, 600_000);
  tidying.unref();
  // a turn's client must not outlive this server
  const quit = () => {
    for (const turn of turns.values()) if (!turn.done) turn.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  return {
    ready,
    close: () => new Promise<void>((resolve) => {
      process.off("SIGINT", quit);
      process.off("SIGTERM", quit);
      clearInterval(tidying);
      clearInterval(looking);
      watcher.close();
      for (const turn of turns.values()) if (!turn.done) turn.stop();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
