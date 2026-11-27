// The projects there are to choose from.
// A project is a project of the Codex desktop app's sidebar when the app has any: that is what the word means there,
// and the person arranged them (codex.ts). Where it has none (Codex is not used, or only from its CLI) the folders the
// sessions worked in stand for projects: every git work tree a Claude Code session or a Codex thread worked in is
// one, and so is a folder that lies in no work tree. A session is then of one project only: the one whose folder
// lies nearest above where it worked.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { claudeFolders, claudeHome } from "./claude.ts";
import { codexHome, readCodexProjects, threadFolders } from "./codex.ts";
import type { Project } from "./model.ts";
import { under } from "./util.ts";

export interface Projects {
  projects: Project[];
  /** Which thread the Codex app put in which project. */
  assigned: Map<string, string>;
  /** Where the projects were taken from: the Codex app's sidebar, or the folders the sessions worked in. */
  from: "sidebar" | "folders";
}

/** What is said on a map whose project was found from the folders. */
export const FROM_FOLDERS = "Codex 앱의 사이드바에 프로젝트가 없어서, 세션이 일한 폴더를 프로젝트로 삼았습니다. git 작업 폴더마다 하나이고, 저장소 밖의 폴더는 그 폴더가 하나입니다.";

/** The projects on offer. CONTEXT_FLOW_PROJECTS=folders has them found from the folders whatever the sidebar holds. */
export function readProjects(now = Date.now()): Projects {
  const sidebar = process.env.CONTEXT_FLOW_PROJECTS === "folders" ? null : readCodexProjects();
  if (sidebar?.projects.length) return { ...sidebar, from: "sidebar" };
  return { projects: folderProjects(now), assigned: new Map(), from: "folders" };
}

/** A folder -> the work tree it lies in. Kept once found: a folder does not leave its work tree. */
const trees = new Map<string, string>();

/** The git work tree a folder lies in (the nearest folder above it, or itself, that holds a .git), or the folder
 *  itself when it lies in none. A linked work tree is one of its own: it holds a .git file. */
export function workTree(folder: string): string {
  const known = trees.get(folder);
  if (known) return known;
  for (let dir = folder; ;) {
    if (existsSync(join(dir, ".git"))) {
      trees.set(folder, dir);
      return dir;
    }
    const above = dirname(dir);
    if (above === dir) return folder;
    dir = above;
  }
}

let kept: { at: number; of: string; list: Project[] } | null = null;

/** The folders sessions of either client worked in, as projects: the one worked in last comes first. A project whose
 *  folder holds another's says so (not), so that a session in the inner one is not taken for the outer one's too:
 *  a session begun in the home folder would otherwise make a project of everything under it.
 *  Looked for again every few seconds at most: it is asked for with every reading of the records. */
export function folderProjects(now = Date.now(), claude = claudeHome(), codex = codexHome()): Project[] {
  const of = claude + "\n" + codex;
  // (where nothing was found it is looked for again at once: the first session begun is seen as soon as it is there)
  if (kept && kept.of === of && kept.list.length && now >= kept.at && now - kept.at < 5000) return kept.list;
  const worked = new Map<string, number>();
  for (const folders of [claudeFolders(claude), threadFolders(codex)]) {
    for (const [folder, at] of folders) {
      if (!isAbsolute(folder)) continue;
      const root = workTree(folder);
      worked.set(root, Math.max(worked.get(root) ?? 0, at));
    }
  }
  const roots = [...worked.keys()];
  const list = [...worked].sort((one, other) => other[1] - one[1] || (one[0] < other[0] ? -1 : 1)).map(([root]): Project => {
    const not = roots.filter((other) => other !== root && under(other, root));
    return { id: "dir-" + createHash("sha1").update(root).digest("hex").slice(0, 12), name: basename(root) || root, roots: [root], ...(not.length ? { not } : {}) };
  });
  kept = { at: now, of, list };
  return list;
}

/** Forget what was found (for the tests, which make one set of records after another). */
export function forgetProjects(): void {
  kept = null;
  trees.clear();
}

/** A project as the screen is told of it: its name and its folders. */
export function shown(project: Project): Project {
  return { id: project.id, name: project.name, roots: project.roots };
}
