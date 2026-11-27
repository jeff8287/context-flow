// Being told when the records change, so that the screen need not ask again and again to find out.
// The folders the clients write their records to are watched, and this tool's own. Nothing is read here and no client
// is asked anything. Where a folder cannot be watched, the screen goes on asking at its own pace, as it did before.
//
// Watching a folder does not tell of everything. macOS says that a file was written to when the file is closed, and
// Codex keeps a thread's record open for as long as it has the thread loaded: nothing is heard of such a record
// while it grows. So the records a screen knows are also looked at, once a second, for whether they have grown
// (grown, below). The watch still finds what the look cannot: a record that has just been made, a piece set to wait.
import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import { claudeHome } from "./claude.ts";
import { codexHome } from "./codex.ts";
import { HOME } from "./home.ts";

/** records: a session's record was written to. live: a client's process said what it is at. flow: a piece was set
 *  to wait, taken, or sent. */
export interface Changed { where: "records" | "live" | "flow"; path: string }

export interface Watch {
  /** How many of the folders are being watched: none means the screen is told nothing. */
  watching(): number;
  close(): void;
}

export function watchRecords(heard: (change: Changed) => void): Watch {
  const flow = process.env.CONTEXT_FLOW_HOME ?? join(HOME, ".context-flow");
  const places: { where: Changed["where"]; dir: string; keep(name: string): boolean }[] = [
    { where: "records", dir: join(codexHome(), "sessions"), keep: (name) => name.endsWith(".jsonl") },
    { where: "records", dir: join(claudeHome(), "projects"), keep: (name) => name.endsWith(".jsonl") },
    { where: "live", dir: join(claudeHome(), "sessions"), keep: (name) => name.endsWith(".json") },
    // of this tool's own folder only what says a piece moved: its log is written by the server itself
    { where: "flow", dir: flow, keep: (name) => name === "transfers.jsonl" || name === "pending" || name.startsWith("pending" + sep) },
  ];
  const open = new Map<string, FSWatcher>();
  const attach = () => {
    for (const place of places) {
      if (open.has(place.dir) || !existsSync(place.dir)) continue;
      try {
        const watcher = watch(place.dir, { recursive: true }, (_event, name) => {
          if (typeof name === "string" && place.keep(name)) heard({ where: place.where, path: join(place.dir, name) });
        });
        // the folder went away: it is looked for again below
        watcher.on("error", () => { watcher.close(); open.delete(place.dir); });
        watcher.unref();
        open.set(place.dir, watcher);
      } catch { /* cannot be watched here */ }
    }
  };
  attach();
  // a folder that is not there yet (a client never run, no piece ever set to wait) is watched once it is
  const again = setInterval(attach, 30_000);
  again.unref();
  return {
    watching: () => open.size,
    close() {
      clearInterval(again);
      for (const watcher of open.values()) watcher.close();
      open.clear();
    },
  };
}

/** Of these records, the ones whose size is not what it was at the last look. seen keeps the sizes between looks; a
 *  record looked at for the first time is only taken note of. A record that is gone is not said to have changed. */
export function grown(paths: Iterable<string>, seen: Map<string, number>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    const before = seen.get(path);
    seen.set(path, size);
    if (before !== undefined && before !== size) out.push(path);
  }
  return out;
}

/** Which changes matter to one screen. A screen shows some projects; the clients write the records of every project
 *  into the same folders. A record the screen's sessions are known by matters. One that is not known may be a
 *  session that has just begun: it matters once, and if the next reading of the records does not hold it either, it
 *  is somebody else's and is passed over from then on. */
export class Interest {
  #foreign = new Set<string>();
  #unsure = new Set<string>();

  /** known: the records of the sessions the screen has; null when nothing was read for it yet. */
  matters(change: Changed, known: Set<string> | null): boolean {
    if (change.where !== "records" || !known || known.has(change.path)) return true;
    if (this.#foreign.has(change.path)) return false;
    this.#unsure.add(change.path);
    return true;
  }

  /** The records were read again for this screen. */
  settle(known: Set<string>): void {
    for (const path of this.#unsure) if (!known.has(path)) this.#foreign.add(path);
    this.#unsure.clear();
    if (this.#foreign.size > 5000) this.#foreign.clear(); // they are learnt again, one reading each
  }
}
