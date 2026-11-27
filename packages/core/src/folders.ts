// The folders a first session can be begun in, for a person who has no session yet: the screen lets them be gone
// through from the home folder down, and names the git work trees found near it. Only names are read here, and
// whether a folder holds a .git; nothing in a folder's files.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HOME } from "./home.ts";
import { workTree } from "./projects.ts";

/** A folder as the person reads it: from "~" when it is in the home folder. */
export const tilde = (path: string) => (path === HOME ? "~" : path.startsWith(HOME + "/") ? "~" + path.slice(HOME.length) : path);

/** The folder the person named (the whole way down, or from "~"), if there is such a folder. */
export function folderNamed(asked: unknown): string | null {
  if (typeof asked !== "string" || !asked.trim()) return null;
  const named = asked.trim();
  const path = named === "~" ? HOME : named.startsWith("~/") ? join(HOME, named.slice(2)) : named;
  if (!isAbsolute(path)) return null;
  const whole = resolve(path);
  try {
    return statSync(whole).isDirectory() ? whole : null;
  } catch {
    return null;
  }
}

export interface Folder { path: string; shown: string; git: boolean }
/** A folder and the folders in it. up: the one it is in (null at the top). project: the folder that is the project of a
 *  session begun there (the git work tree it lies in, or itself). more: how many were left out of a long list. shut:
 *  it could not be read (on macOS, an app may need the person's leave to look in some folders). of: the project there
 *  is already that a session begun there would be of (the server says it). */
export interface Folders extends Folder { up: string | null; project: string; folders: Folder[]; more: number; shut?: boolean; of?: { id: string; name: string } }

const ROOM = 300;
const holdsGit = (path: string) => existsSync(join(path, ".git"));
const folder = (path: string): Folder => ({ path, shown: tilde(path), git: holdsGit(path) });

/** The folders in a folder, by name; the ones whose names begin with a dot are left out. */
export function foldersIn(path: string): Folders {
  const up = dirname(path) === path ? null : dirname(path);
  const project = tilde(workTree(path));
  let names: string[];
  try {
    names = readdirSync(path, { withFileTypes: true }).filter((one) => one.isDirectory() && !one.name.startsWith(".")).map((one) => one.name);
  } catch {
    return { ...folder(path), up, project, folders: [], more: 0, shut: true };
  }
  names.sort((one, other) => one.localeCompare(other, undefined, { numeric: true, sensitivity: "base" }));
  return { ...folder(path), up, project, folders: names.slice(0, ROOM).map((name) => folder(join(path, name))), more: Math.max(0, names.length - ROOM) };
}

/** The folders of the home folder macOS asks the person about before it lets an app look in them. They are looked in
 *  only when the person goes there. */
const ASKED = new Set(["Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "Public"]);

/** Git work trees a few folders below the home folder, the one worked in last first (as its .git was last touched).
 *  Looked for for a moment only: it is a help to the person, not a list of everything. */
export function nearTrees(limit = 8, ms = 300): Folder[] {
  const end = Date.now() + ms;
  const found: { path: string; at: number }[] = [];
  let level = [HOME];
  for (let depth = 1; depth <= 3 && level.length && Date.now() < end; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      if (Date.now() >= end) break;
      let names: string[] = [];
      try {
        names = readdirSync(dir, { withFileTypes: true }).filter((one) => one.isDirectory() && !one.name.startsWith(".") && one.name !== "node_modules").map((one) => one.name);
      } catch { /* not to be read: passed by */ }
      for (const name of names) {
        if (depth === 1 && process.platform === "darwin" && ASKED.has(name)) continue;
        const path = join(dir, name);
        if (!holdsGit(path)) next.push(path);
        else {
          try {
            found.push({ path, at: statSync(join(path, ".git")).mtimeMs });
          } catch { /* gone meanwhile */ }
        }
      }
    }
    level = next;
  }
  return found.sort((one, other) => other.at - one.at).slice(0, limit).map((one) => ({ path: one.path, shown: tilde(one.path), git: true }));
}
