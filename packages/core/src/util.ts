// Small helpers with nothing of Node in them: the screen uses them too.

/** One line of at most `room` characters. */
export function oneLine(text: string, room: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= room ? flat : flat.slice(0, room - 1) + "…";
}

/** Whether `path` is `root` or lies under it. */
export function under(path: string, root: string): boolean {
  if (!path || !root) return false;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === base || path.startsWith(base + "/");
}

/** Whether a folder is of a project: under one of the project's folders, and not in one that is another project's. */
export function within(path: string, project: { roots: string[]; not?: string[] }): boolean {
  return project.roots.some((root) => under(path, root)) && !(project.not ?? []).some((root) => under(path, root));
}

/** What the clients wrap around what the user typed: blocks like <environment_context>…</environment_context>. */
const WRAPPED = /^\s*<([a-zA-Z_][\w-]*)[^>]*>[\s\S]*?<\/\1>\s*/;

export function typed(text: string): string {
  let rest = text;
  for (let guard = 0; guard < 12; guard += 1) {
    const found = WRAPPED.exec(rest);
    if (!found) break;
    rest = rest.slice(found[0].length);
  }
  return rest.trim();
}

/** Not a work tree: a file there is a scratch note, not something two sessions share. */
export function scratch(path: string): boolean {
  return /^(\/private)?\/tmp\/|^\/var\/folders\/|^\/dev\//.test(path);
}

export function ms(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isNaN(at) ? 0 : at;
  }
  return 0;
}
