// Reads Codex's own records (desktop app and CLI share them) into the common shapes. Read-only.
//   threads and their parents: ~/.codex/state_5.sqlite   (threads, thread_spawn_edges)
//   sidebar projects:          ~/.codex/.codex-global-state.json   (local-projects, thread-project-assignments)
//   what was said and changed: the thread's rollout file (one JSON record per line)
// A thread's record can lie in several files. When a request is said again in the app, or a thread is forked, a new
// file is begun whose first line says where its history lies: in which file, and how far into it (history_base).
// The file is named by an id of its own: the one at the end of its name, or the thread's when its name has none.
// So a thread's talk is read back through the files of its own, and a fork's begins where another thread's file is named.
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { PIECE_MARK, withoutPieces } from "./links.ts";
import type { Activity, Item, Origin, Project, Session } from "./model.ts";
import { HOME } from "./home.ts";
import { ms, oneLine, typed, under } from "./util.ts";

export function codexHome(): string {
  return process.env.CONTEXT_FLOW_CODEX_HOME || join(HOME, ".codex");
}

interface ThreadRow {
  id: string;
  rollout_path: string | null;
  cwd: string | null;
  title: string | null;
  name: string | null;
  model: string | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  thread_source: string | null;
  source: string | null;
  archived: number | null;
  first_user_message: string | null;
  attached_thread_parent_id: string | null;
}

/** Threads that are copies Codex made of Claude Code sessions: thread id -> the Claude session and when it was copied. */
export function readImports(home = codexHome()): Map<string, { claudeId: string; at: number }> {
  const found = new Map<string, { claudeId: string; at: number }>();
  try {
    const state = JSON.parse(readFileSync(join(home, "external_agent_session_imports.json"), "utf8"));
    for (const record of Array.isArray(state?.records) ? state.records : []) {
      const source = String(record?.source_path ?? "");
      if (!record?.imported_thread_id || !source.endsWith(".jsonl")) continue;
      found.set(record.imported_thread_id, { claudeId: source.slice(source.lastIndexOf("/") + 1, -6), at: Number(record.imported_at ?? 0) * 1000 });
    }
  } catch {
    // nothing was ever imported
  }
  return found;
}

/** The sidebar's projects and which thread was put in which. */
export function readCodexProjects(home = codexHome()): { projects: Project[]; assigned: Map<string, string> } {
  const projects: Project[] = [];
  const assigned = new Map<string, string>();
  try {
    const state = JSON.parse(readFileSync(join(home, ".codex-global-state.json"), "utf8"));
    for (const [id, entry] of Object.entries<any>(state["local-projects"] ?? {})) {
      const roots = Array.isArray(entry?.rootPaths) ? entry.rootPaths.filter((root: unknown) => typeof root === "string") : [];
      if (roots.length) projects.push({ id, name: String(entry?.name ?? roots[0].split("/").pop()), roots });
    }
    const known = new Set(projects.map((project) => project.id));
    for (const [thread, entry] of Object.entries<any>(state["thread-project-assignments"] ?? {})) {
      if (entry?.projectId && known.has(entry.projectId)) assigned.set(thread, entry.projectId);
    }
  } catch {
    // no desktop state: fall through to the database
  }
  if (!projects.length) {
    const db = open(home);
    if (db) {
      try {
        const rows = db.prepare("select p.id, p.name, r.path from projects p join project_roots r on r.project_id = p.id order by p.position, r.position").all() as any[];
        const byId = new Map<string, Project>();
        for (const row of rows) {
          const project: Project = byId.get(row.id) ?? { id: row.id, name: row.name, roots: [] };
          project.roots.push(row.path);
          byId.set(row.id, project);
        }
        projects.push(...byId.values());
      } catch {
        // an older database without these tables
      } finally {
        db.close();
      }
    }
  }
  return { projects, assigned };
}

function open(home: string): DatabaseSync | null {
  const path = join(home, "state_5.sqlite");
  if (!existsSync(path)) return null;
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

/** A thread the user did not start and does not read: the reviewer Codex runs on its own for approvals. */
function reviewer(row: ThreadRow): boolean {
  return row.thread_source === "guardian_review" || (row.source ?? "").includes('"guardian"');
}

export interface CodexThreads {
  sessions: Session[];
  /** Every thread's folder, whether or not it is in the project: a parent may live elsewhere. */
  notes: string[];
}

/** The threads of one project, without their contents. */
export function readCodexThreads(project: Project, assigned: Map<string, string>, home = codexHome()): CodexThreads {
  const notes: string[] = [];
  const db = open(home);
  if (!db) return { sessions: [], notes: ["Codex의 스레드 목록(state_5.sqlite)을 열지 못했습니다."] };
  const sessions: Session[] = [];
  try {
    const rows = db.prepare("select id, rollout_path, cwd, title, name, model, created_at_ms, updated_at_ms, thread_source, source, archived, first_user_message, attached_thread_parent_id from threads").all() as unknown as ThreadRow[];
    const parents = new Map<string, string>();
    const imports = readImports(home);
    try {
      for (const edge of db.prepare("select parent_thread_id, child_thread_id from thread_spawn_edges").all() as any[]) parents.set(edge.child_thread_id, edge.parent_thread_id);
    } catch {
      notes.push("Codex의 스레드 생성 관계(thread_spawn_edges)를 읽지 못했습니다.");
    }
    for (const row of rows) {
      if (reviewer(row)) continue;
      const cwd = row.cwd ?? "";
      const here = assigned.get(row.id) === project.id || (!assigned.has(row.id) && project.roots.some((root) => under(cwd, root)));
      if (!here) continue;
      let origin: Origin = "user";
      let parentId: string | null = parents.get(row.id) ?? null;
      const source = row.source ?? "";
      if (source.startsWith("{")) {
        try {
          const spawn = JSON.parse(source)?.subagent?.thread_spawn;
          if (spawn?.parent_thread_id) parentId = spawn.parent_thread_id;
        } catch {
          // not JSON after all
        }
      }
      if (row.thread_source === "subagent" || source.includes('"subagent"')) origin = "subagent";
      else if (row.thread_source === "agent_created_thread") origin = "spawned";
      else if (row.thread_source === "agent_forked_thread") origin = "fork";
      if (row.attached_thread_parent_id) {
        origin = "side";
        parentId = row.attached_thread_parent_id;
      }
      const copied = imports.get(row.id);
      if (copied) {
        origin = "imported";
        parentId = copied.claudeId;
      }
      sessions.push({
        id: row.id,
        client: "codex",
        projectId: project.id,
        cwd,
        // The sidebar's name for the thread when it has one; otherwise what was first typed.
        title: oneLine(row.name || withoutPieces(typed(row.title ?? "")) || withoutPieces(typed(row.first_user_message ?? "")) || "(제목 없음)", 80),
        model: row.model,
        startedAt: row.created_at_ms ?? 0,
        updatedAt: row.updated_at_ms ?? 0,
        origin,
        parentId,
        activity: row.archived ? "archived" : "idle",
        nowFile: null,
        recordPath: row.rollout_path,
        counts: { prompts: 0, answers: 0, changes: 0 },
      });
    }
  } finally {
    db.close();
  }
  return { sessions, notes };
}

export interface Rollout {
  items: Item[];
  forkedFrom: string | null;
  /** For a fork: the thread its history lies in, the file of that thread it names, and how far into that file it
   *  goes. Null when the record does not say, or the file it names is not to be found. */
  base: { thread: string; file: string; end: number } | null;
  /** The files the thread's own talk lies in, the oldest first; of all but the last, only what lies before end. */
  files: { path: string; end?: number }[];
  /** A turn was started and the record does not say it ended. */
  open: boolean;
  /** When the last turn was started. */
  openAt: number;
  lastAt: number;
}

/** Where the record files are: which file an id names, and where a file stands among its thread's files. */
export interface RecordFiles {
  /** The file with that id of its own, and the thread it is a file of. */
  fileOf(own: string): { thread: string; path: string } | null;
  /** Which of its thread's files it is, counted from the oldest (0); -1 when that is not known. */
  seqOf(path: string): number;
}

const NAMED = /rollout-(?:(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-)?([0-9a-f]{8}-[0-9a-f-]{27})(?:_([0-9a-f]{8}-[0-9a-f-]{27}))?\.jsonl$/;
const indexes = new Map<string, { at: number; byOwn: Map<string, { thread: string; path: string }>; seq: Map<string, number> }>();
/** What was asked for and not found, for each place the files are kept in. */
const missing = new Map<string, Set<string>>();

/** The record files Codex keeps, found by their names. They are looked for again when one that is asked for is not
 *  among them (a file begun since): at once the first time it is asked for, and after that not more often than
 *  every other second. */
export function recordFiles(home = codexHome()): RecordFiles {
  const scan = () => {
    const byOwn = new Map<string, { thread: string; path: string }>();
    const byThread = new Map<string, { stamp: string; path: string }[]>();
    const walk = (dir: string, depth: number) => {
      let names: import("node:fs").Dirent[] = [];
      try {
        names = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of names) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 4) walk(path, depth + 1);
          continue;
        }
        const named = NAMED.exec(entry.name);
        if (!named) continue;
        byOwn.set(named[3] ?? named[2], { thread: named[2], path });
        const list = byThread.get(named[2]);
        if (list) list.push({ stamp: named[1] ?? "", path });
        else byThread.set(named[2], [{ stamp: named[1] ?? "", path }]);
      }
    };
    walk(join(home, "sessions"), 0);
    walk(join(home, "archived_sessions"), 0);
    const seq = new Map<string, number>();
    for (const list of byThread.values()) {
      list.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.path < b.path ? -1 : 1));
      list.forEach((one, at) => seq.set(one.path, at));
    }
    const made = { at: Date.now(), byOwn, seq };
    indexes.set(home, made);
    return made;
  };
  const have = () => indexes.get(home) ?? scan();
  const find = <T>(key: string, among: (index: ReturnType<typeof scan>) => T | undefined): T | undefined => {
    const found = among(have());
    if (found !== undefined) return found;
    let missed = missing.get(home);
    if (!missed) missing.set(home, (missed = new Set()));
    const again = !missed.has(key) || Date.now() - have().at > 2000 ? among(scan()) : undefined;
    if (again === undefined) missed.add(key);
    else missed.delete(key);
    return again;
  };
  return {
    fileOf(own) {
      const found = find("id " + own, (index) => index.byOwn.get(own));
      if (found) return found;
      // a file whose name does not say whose it is: the list of threads knows where a thread's record is kept
      const path = rolloutPathOf(own, home);
      return path ? { thread: own, path } : null;
    },
    seqOf(path) {
      return find("file " + path, (index) => index.seq.get(path)) ?? -1;
    },
  };
}

/** One record file read by itself: what it says, and where it says its history lies. */
interface Part {
  items: Item[];
  forkedFrom: string | null;
  /** The file its history lies in, by that file's own id, and how far into it. */
  base: { id: string; end: number } | null;
  open: boolean;
  openAt: number;
  lastAt: number;
}

const cache = new Map<string, { size: number; mtime: number; rollout: Part }>();
/** A file's beginning, read as far as a place in it: what lies before a place in a record does not change. */
const prefixes = new Map<string, Part>();
const made = new WeakMap<Part, Rollout>();

/** What one thread said and changed. Each file is read once, and again only when it has grown. */
export async function readRollout(sessionId: string, path: string, files: RecordFiles = recordFiles()): Promise<Rollout | null> {
  const top = await readPart(sessionId, path);
  if (!top) return null;
  const kept = made.get(top);
  if (kept) return kept;
  // back through the files the thread's own talk lies in, to where another thread's file is named (a fork) or none is
  const own: { part: Part; path: string; end?: number }[] = [{ part: top, path }];
  let base: Rollout["base"] = null;
  let forkedFrom = top.forkedFrom;
  for (let from = top, guard = 0; from.base && guard < 24; guard += 1) {
    const file = files.fileOf(from.base.id);
    if (!file) break; // the file it names is gone: what lay in it is not known
    if (file.thread !== sessionId) {
      base = { thread: file.thread, file: file.path, end: from.base.end };
      forkedFrom = file.thread;
      break;
    }
    const before = await readPart(sessionId, file.path, from.base.end);
    if (!before) break;
    own.unshift({ part: before, path: file.path, end: from.base.end });
    forkedFrom ??= before.forkedFrom;
    from = before;
  }
  // An item is known by the file it lies in and its place there, so that a number never comes to mean another item:
  // what was said after a request that was then said again is no longer of the thread, and its numbers are not
  // given out anew. The thread's first file counts from 0, as a thread with one file does.
  const seqs = own.map((one) => files.seqOf(one.path));
  const known = seqs.every((seq) => seq >= 0);
  const items = own.length === 1 && !(seqs[0] > 0) ? top.items
    : own.flatMap((one, at) => one.part.items.map((item, n) => ({ ...item, id: sessionId + ":" + ((known ? seqs[at] : at) * 1_000_000 + n) })));
  const rollout: Rollout = { items, forkedFrom, base, files: own.map(({ path: file, end }) => ({ path: file, ...(end === undefined ? {} : { end }) })), open: top.open, openAt: top.openAt, lastAt: top.lastAt };
  made.set(top, rollout);
  return rollout;
}

/** The files a thread's own talk lies in, the newest first. */
export async function ownRecords(sessionId: string, path: string): Promise<string[]> {
  return ((await readRollout(sessionId, path))?.files ?? [{ path }]).map((one) => one.path).reverse();
}

/** One record file, or (end) its beginning as far as that place. */
async function readPart(sessionId: string, path: string, end?: number): Promise<Part | null> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const key = path + "@" + end;
  if (end !== undefined) {
    const before = prefixes.get(key);
    if (before) return before;
  }
  const kept = end === undefined ? cache.get(path) : undefined;
  if (kept && kept.size === stat.size && kept.mtime === stat.mtimeMs) return kept.rollout;
  const rollout: Part = { items: [], forkedFrom: null, base: null, open: false, openAt: 0, lastAt: 0 };
  // Older threads, and copies of Claude Code sessions, keep what was said as user_message and agent_message events.
  const older: Item[] = [];
  let answers: Item[] = [];
  // What a hook put with a prompt is not part of the prompt's own record: it is a message of its own, beside it.
  const hooked: { turnId: string | null; text: string; seen: number; seenOlder: number }[] = [];
  const marked = JSON.stringify(PIECE_MARK).slice(1, -1); // the mark as it stands inside a line of JSON
  if (end === 0) return rollout; // nothing of the file is before its beginning
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8", ...(end === undefined ? {} : { end: end - 1 }) }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Most of a rollout is model requests and tool output; only a few kinds of line matter here.
    const head = line.slice(0, 400);
    const meta = head.includes('"session_meta"');
    const along = !meta && head.includes('"role":"developer"') && line.includes(marked);
    if (!meta && !along && !head.includes('"item_completed"') && !head.includes('"task_') && !head.includes('"turn_aborted"') && !head.includes('_message"')) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.payload ?? {};
    const at = ms(record?.timestamp);
    if (at) rollout.lastAt = at;
    if (record?.type === "session_meta") {
      if (typeof payload.forked_from_id === "string" && !rollout.forkedFrom) rollout.forkedFrom = payload.forked_from_id;
      const base = payload.history_base;
      if (!rollout.base && base && typeof base.thread_id === "string" && Number.isInteger(base.end_byte_offset)) rollout.base = { id: base.thread_id, end: base.end_byte_offset };
      continue;
    }
    if (record?.type === "response_item") {
      if (along && payload.type === "message" && payload.role === "developer") {
        const text = parts(payload.content);
        const turn = payload.internal_chat_message_metadata_passthrough?.turn_id;
        if (text.includes(PIECE_MARK)) hooked.push({ turnId: typeof turn === "string" ? turn : null, text, seen: rollout.items.length, seenOlder: older.length });
      }
      continue; // the rest of these are copies of what was sent to the model
    }
    if (payload.type === "task_started") {
      rollout.open = true;
      rollout.openAt = at;
      continue;
    }
    if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      rollout.open = false;
      if (answers.length) answers[answers.length - 1].final = true;
      if (older.length && older[older.length - 1].kind === "answer") older[older.length - 1].final = true;
      answers = [];
      continue;
    }
    if ((payload.type === "user_message" || payload.type === "agent_message") && typeof payload.message === "string") {
      const text = payload.type === "user_message" ? typed(payload.message) : payload.message.trim();
      if (text) older.push({ id: "", sessionId, turnId: null, kind: payload.type === "user_message" ? "prompt" : "answer", at, text });
      continue;
    }
    if (payload.type !== "item_completed") continue;
    const item = payload.item ?? {};
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
    const when = typeof payload.completed_at_ms === "number" ? payload.completed_at_ms : at;
    const push = (kind: Item["kind"], text: string, more: Partial<Item> = {}) => {
      const made: Item = { id: sessionId + ":" + rollout.items.length, sessionId, turnId, kind, at: when, text, ...more };
      rollout.items.push(made);
      return made;
    };
    if (item.type === "UserMessage") {
      const text = typed(parts(item.content));
      const images = Array.isArray(item.content) ? item.content.filter((part: any) => /image/i.test(String(part?.type ?? ""))).length : 0;
      if (text) push("prompt", text, images ? { images } : {});
    } else if (item.type === "AgentMessage") {
      const text = parts(item.content).trim();
      if (text) answers.push(push("answer", text, item.phase === "final_answer" ? { final: true } : {}));
    } else if (item.type === "FileChange" && item.status !== "failed" && item.changes && typeof item.changes === "object") {
      for (const [file, change] of Object.entries<any>(item.changes)) {
        const body = typeof change?.unified_diff === "string" ? change.unified_diff : typeof change?.content === "string" ? change.content : "";
        push("change", body, { path: file });
      }
    }
  }
  const legacy = !rollout.items.length && older.length > 0;
  if (legacy) {
    older.forEach((item, at) => { item.id = sessionId + ":" + at; });
    rollout.items = older;
  }
  // Each goes to the prompt of its turn; without a turn to go by, to the prompt it came right after (or, failing that, before).
  for (const one of hooked) {
    const prompts = rollout.items.filter((item) => item.kind === "prompt");
    const before = rollout.items.slice(0, legacy ? one.seenOlder : one.seen);
    const target = (one.turnId ? prompts.findLast((item) => item.turnId === one.turnId) : undefined) ?? before.findLast((item) => item.kind === "prompt") ?? prompts[0];
    if (target) target.added = target.added ? target.added + "\n\n" + one.text : one.text;
  }
  if (end === undefined) cache.set(path, { size: stat.size, mtime: stat.mtimeMs, rollout });
  else prefixes.set(key, rollout);
  return rollout;
}

function parts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

/** The file a thread's record is kept in, as the list of threads has it. */
export function rolloutPathOf(thread: string, home = codexHome()): string | null {
  const db = open(home);
  if (!db) return null;
  try {
    const row = db.prepare("select rollout_path from threads where id = ?").get(thread) as { rollout_path: string | null } | undefined;
    return row?.rollout_path ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Where a record file says its history lies: in the file with that id of its own, as far as that place. Null when
 *  it does not say. */
function baseOf(path: string): { id: string; end: number } | null {
  try {
    const first = JSON.parse(stretch(path, 0, 4_000_000).split("\n", 1)[0]); // the record's first line says what the thread is
    const base = first?.type === "session_meta" ? first.payload?.history_base : null;
    return base && typeof base.thread_id === "string" && Number.isInteger(base.end_byte_offset) ? { id: base.thread_id, end: base.end_byte_offset } : null;
  } catch {
    return null;
  }
}

/** A stretch of a file, as text. A record can be very long: it is not read whole for the sake of a few lines. */
function stretch(path: string, from: number, to: number): string {
  const file = openSync(path, "r");
  try {
    const room = Buffer.alloc(Math.max(0, to - from));
    return room.subarray(0, readSync(file, room, 0, room.length, from)).toString("utf8");
  } finally {
    closeSync(file);
  }
}

const keptTurns = new Map<string, string | null>();
/** The last turn of a thread that a fork of it keeps: the last its record tells of before where the fork's history
 *  ends. What was found is kept: a record is only ever added to, so what lies before a place in it does not change. */
export function keptTurn(path: string, end: number): string | null {
  const key = path + ":" + end;
  if (!keptTurns.has(key)) keptTurns.set(key, lastTurnWithin(path, end));
  return keptTurns.get(key) ?? null;
}

/** The last turn a record tells of in its first so many bytes. It is looked for from the end backwards. */
function lastTurnWithin(path: string, end: number): string | null {
  try {
    for (let to = Math.min(end, statSync(path).size); to > 0; ) {
      const from = Math.max(0, to - 1_000_000);
      const lines = stretch(path, from, to).split("\n");
      const whole = from === 0 ? lines : lines.slice(1); // the first of them may begin before the stretch
      for (const line of whole.reverse()) {
        if (!line.includes('"turn_id"')) continue;
        try {
          const turn = JSON.parse(line)?.payload?.turn_id;
          if (typeof turn === "string") return turn;
        } catch { /* a line cut short by the end */ }
      }
      // further back, taking the line that was left out along; a line longer than the stretch tells of no turn
      const kept = from === 0 ? 0 : Buffer.byteLength(lines[0], "utf8");
      to = kept < to - from ? from + kept : from;
    }
  } catch { /* not to be read */ }
  return null;
}

/** Where a thread is to be forked so that the fork is the thread as it stood before one of its requests: the thread
 *  to fork and the last of its turns to keep. Null: nothing was said before that request. Undefined: the record does
 *  not tell.
 *  items: the thread's own, in the order they were said (those of its earlier files among them). A thread that is
 *  itself a fork keeps what it was given in a file of the thread it came from: before its own first request stands
 *  that thread, up to where the fork was made, and that is then the thread to fork. */
export function forkPoint(session: Session, items: Item[], prompt: Item, files: RecordFiles = recordFiles()): { from: string; at: string } | null | undefined {
  if (!prompt.turnId) return undefined; // an older record, which does not say which turn is which
  const before = items.slice(0, items.indexOf(prompt)).findLast((item) => item.turnId && item.turnId !== prompt.turnId);
  if (before?.turnId) return { from: session.id, at: before.turnId };
  if (session.origin !== "fork") return null;
  // Back through the files its history lies in. Those of its own were looked through above (their turns are among
  // the items); the first of another thread's that tells of a turn before the place named is where to fork.
  let path = session.recordPath;
  for (let guard = 0; path && guard < 24; guard += 1) {
    const base = baseOf(path);
    const file = base ? files.fileOf(base.id) : null;
    if (!base || !file) return undefined;
    const at = file.thread === session.id ? null : lastTurnWithin(file.path, base.end);
    if (at) return { from: file.thread, at };
    path = file.path;
  }
  return undefined;
}

/** Fill in what only the rollout knows: counts, activity, the file being changed, a fork's parent. */
export function applyRollout(session: Session, rollout: Rollout, now = Date.now()): void {
  const first = rollout.items.find((item) => item.kind === "prompt");
  if (session.title === "(제목 없음)" && first) session.title = oneLine(withoutPieces(first.text) || first.text, 80);
  for (const item of rollout.items) {
    if (item.kind === "prompt") session.counts.prompts += 1;
    else if (item.kind === "answer") session.counts.answers += 1;
    else session.counts.changes += 1;
  }
  if (rollout.forkedFrom && !session.parentId) {
    session.parentId = rollout.forkedFrom;
    session.origin = "fork";
  }
  if (rollout.lastAt > session.updatedAt) session.updatedAt = rollout.lastAt;
  // The list of threads says when the thread's newest file was begun. A thread whose record lies in several files
  // began when the first thing in the oldest of them was said.
  if (rollout.files.length > 1 && rollout.items.length && rollout.items[0].at < session.startedAt) session.startedAt = rollout.items[0].at;
  session.activity = activityOf(session.activity === "archived", rollout.open, session.updatedAt, now);
  if (session.activity === "running") {
    const last = [...rollout.items].reverse().find((item) => item.kind === "change");
    session.nowFile = last?.path ?? null;
  }
}

/** From the record alone. running: a turn is open and the record moved in the last two minutes. waiting: its last
 *  turn ended within a day. (A turn open and quiet for longer is settled by looking at the live processes: live.ts.) */
export function activityOf(archived: boolean, open: boolean, updatedAt: number, now: number): Activity {
  if (archived) return "archived";
  if (open && now - updatedAt < 2 * 60 * 1000) return "running";
  if (now - updatedAt < 24 * 60 * 60 * 1000) return "waiting";
  return "idle";
}
