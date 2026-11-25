// What the clients' own live processes say about their sessions, beyond what the records say. A record alone cannot
// tell a turn that is quiet because a command takes long, or because it waits to be allowed something, from a turn
// whose client died: all three are a turn that was begun and not ended, with nothing written since.
//   Claude Code keeps a small file for each live process (~/.claude/sessions/<pid>.json) that names its session and
//   says whether it is idle, busy, or waiting for the person (and for what).
//   Codex keeps a thread's record open for as long as a process has the thread loaded. A turn that is open in the
//   record is still under way if such a process was already there when the turn began.
// Nothing is written and no client is asked anything: files are read and the process table is looked at.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "./claude.ts";
import type { Session } from "./model.ts";

export interface ClaudeLive { status: "idle" | "busy" | "waiting"; waitingFor: string | null; at: number }
export interface Live {
  /** The Claude Code sessions that have a live process, by session id. */
  claude: Map<string, ClaudeLive>;
  /** When each live Codex process that holds this record open was started. Asked for only when it is needed. */
  codexHolders(recordPath: string | null): number[];
}

const QUIET = 2 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // there, but another user's
  }
}

export function readClaudeLive(home = claudeHome(), now = Date.now()): Map<string, ClaudeLive> {
  const out = new Map<string, ClaudeLive>();
  const dir = join(home, "sessions");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const row = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (typeof row?.sessionId !== "string" || !Number.isInteger(row.pid) || !alive(row.pid)) continue;
      const at = Number(row.statusUpdatedAt ?? row.updatedAt) || 0;
      if (now - at > 7 * DAY) continue; // a file left behind by a crash, its number since given to some other process
      const before = out.get(row.sessionId);
      if (before && before.at > at) continue;
      out.set(row.sessionId, { status: row.status === "busy" || row.status === "waiting" ? row.status : "idle", waitingFor: typeof row.waitingFor === "string" ? row.waitingFor : null, at });
    } catch { /* being written, or not a session file */ }
  }
  return out;
}

let held: { at: number; byPath: Map<string, number[]> } | null = null;
/** The thread records that live Codex processes hold open, each with when its processes were started. */
export function readCodexHolders(now = Date.now()): Map<string, number[]> {
  if (held && now - held.at < 4000) return held.byPath;
  const byPath = new Map<string, number[]>();
  const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const listed = spawnSync(lsof, ["-c", "codex", "-Fpn"], { encoding: "utf8", timeout: 4000 });
  const files = new Map<number, string[]>();
  let pid = 0;
  for (const line of String(listed.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && line.endsWith(".jsonl") && line.includes("/rollout-")) files.set(pid, [...(files.get(pid) ?? []), line.slice(1)]);
  }
  if (files.size) {
    const started = spawnSync(existsSync("/bin/ps") ? "/bin/ps" : "ps", ["-o", "pid=,lstart=", "-p", [...files.keys()].join(",")], { encoding: "utf8", timeout: 4000 });
    const when = new Map<number, number>();
    for (const line of String(started.stdout ?? "").split("\n")) {
      const found = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (found) when.set(Number(found[1]), Date.parse(found[2]) || 0);
    }
    for (const [id, paths] of files) for (const path of paths) byPath.set(path, [...(byPath.get(path) ?? []), when.get(id) ?? 0]);
  }
  held = { at: now, byPath };
  return byPath;
}

export function readLive(now = Date.now()): Live {
  return { claude: readClaudeLive(undefined, now), codexHolders: (recordPath) => (recordPath ? readCodexHolders(now).get(recordPath) ?? [] : []) };
}
/** Nothing known of any live process: what the records say stands. */
export const noLive: Live = { claude: new Map(), codexHolders: () => [] };

/** What a session is doing, settled from its record and from its client's live processes.
 *  turn.open: the record has a turn that was begun and not ended. turn.since: when that turn began. */
export function settleActivity(session: Session, turn: { open: boolean; since: number }, live: Live, now = Date.now()): void {
  if (session.activity === "archived") return;
  const recent = now - session.updatedAt < QUIET;
  let running = turn.open && recent;
  let needs: Session["needs"];
  const mine = session.client === "claude" ? live.claude.get(session.id) : undefined;
  if (mine) {
    // its own process says what it is at: busy however long nothing has been written, idle even with a turn cut short in the record
    running = mine.status !== "idle";
    if (mine.status === "waiting") needs = /permission/i.test(mine.waitingFor ?? "") ? "approval" : "input";
  } else if (session.client === "codex" && turn.open && !recent && now - session.updatedAt < 3 * DAY) {
    // quiet with its turn open: at work still if a process that was there when the turn began has its record open
    running = live.codexHolders(session.recordPath).some((started) => started <= turn.since + 5000);
  }
  session.activity = running ? "running" : now - session.updatedAt < DAY ? "waiting" : "idle";
  if (needs) session.needs = needs;
  else delete session.needs;
}
