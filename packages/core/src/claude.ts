// Reads Claude Code's own records into the common shapes. Read-only.
//   one conversation: ~/.claude/projects/<folder with every non-letter turned into ->/<session id>.jsonl
//   its subagents:    ~/.claude/projects/<folder>/<session id>/subagents/agent-<id>.jsonl
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Item, Project, Session } from "./model.ts";
import { activityOf } from "./codex.ts";
import { PIECE_MARK, withoutPieces } from "./links.ts";
import { HOME } from "./home.ts";
import { ms, oneLine, typed, under } from "./util.ts";

export function claudeHome(): string {
  return process.env.CONTEXT_FLOW_CLAUDE_HOME || join(HOME, ".claude");
}

/** The name Claude Code gives the folder of transcripts for a working folder. */
export function folderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface Transcript {
  session: Session;
  items: Item[];
  /** For a fork: the last request it was given when it was made (the id of that request's record, which is the
   *  same in the record of the session it was forked from). */
  forkKept?: string;
  /** A request was made and the record does not say the answer to it ended. */
  open: boolean;
}

const cache = new Map<string, { size: number; mtime: number; transcript: Transcript | null }>();

/** The unified diff one Edit or Write made, as the record holds it. */
function patchText(result: any): string {
  const path = String(result.filePath ?? "");
  const hunks = Array.isArray(result.structuredPatch) ? result.structuredPatch : [];
  if (!hunks.length) return typeof result.content === "string" ? result.content : "";
  const lines = ["--- " + path, "+++ " + path];
  for (const hunk of hunks) {
    lines.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
    for (const line of hunk.lines ?? []) lines.push(String(line));
  }
  return lines.join("\n");
}

/** What the user typed in a record of theirs. "" when the record is not a request: a tool's result, a note of the
 *  client's own, or the summary it wrote when it made the talk shorter. */
function typedIn(record: any): string {
  if (record?.type !== "user" || record.isMeta || record.isCompactSummary) return "";
  const content = record.message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content) && !content.some((block) => block?.type === "tool_result")) {
    text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).filter(Boolean).join("\n");
  }
  text = typed(text);
  return /^(\[Request interrupted|Caveat:)/.test(text) ? "" : text;
}

/** A record of a talk, as far as how the talk hangs together goes.
 *  parent: the record it names as the one before it (null: it says there is none; undefined: it does not say).
 *  kind: "user", "assistant", and so on as the record says; "summary" for the summary Claude Code wrote when it made
 *        the talk shorter, "mark" for the mark it puts before such a summary.
 *  asked: it is a request the user typed.
 *  kept (a mark's): the stretch of the talk the summary left as it was said, from its first record to its last, and
 *        the record that stretch is taken to come after (the mark itself, or the summary). */
interface Link { uuid: string; parent: string | null | undefined; kind: string; asked: boolean; kept?: { head: string; tail: string; after: string } }

function linkOf(record: any): Link {
  const mark = record.type === "system" && record.subtype === "compact_boundary";
  const kept = mark ? record.compactMetadata?.preservedSegment : null;
  return {
    uuid: record.uuid,
    parent: typeof record.parentUuid === "string" ? record.parentUuid : record.parentUuid === null ? null : undefined,
    kind: mark ? "mark" : record.type === "user" && record.isCompactSummary ? "summary" : String(record.type),
    asked: typedIn(record) !== "",
    ...(kept && typeof kept.headUuid === "string" && typeof kept.tailUuid === "string" && typeof kept.anchorUuid === "string" ? { kept: { head: kept.headUuid, tail: kept.tailUuid, after: kept.anchorUuid } } : {}),
  };
}

/** The records of a talk in the order they were written, and where each one is. */
interface Chain { links: Link[]; place: Map<string, number> }

function chained(chain: Chain, record: any): void {
  chain.place.set(record.uuid, chain.links.length);
  chain.links.push(linkOf(record));
}

/** Where the record that one was written after is (-1: the talk begins with it).
 *  Claude Code keeps what was said in the record even after the talk is taken back to before it (/rewind, or a
 *  request made from an earlier place): the next request names the record it was made after, and what lies between
 *  the two is no longer the talk. So a talk is read back from its last record, each record naming the one before.
 *  A request that says nothing was before it is where the talk was taken back to its very start. Any other record
 *  that names none, or names one that is not in the record, is taken to follow the one written just before it: a
 *  summary's mark names none, some versions did not write every record they named, and a record may not say.
 *  The record named is not always the earlier one in the file (an answer has been seen written before its request). */
function before({ links, place }: Chain, at: number): number {
  const one = links[at];
  if (one.parent === null && one.asked) return -1;
  return (typeof one.parent === "string" ? place.get(one.parent) : undefined) ?? at - 1;
}

/** The way back from a record: where it is, where the one before it is, and so on to where the talk begins. */
function* wayBack(chain: Chain, from: number): Generator<number> {
  const seen = new Set<number>();
  for (let at = from; at >= 0 && !seen.has(at); at = before(chain, at)) {
    seen.add(at);
    yield at;
  }
}

/** Where the last thing said in a talk is: its last request, answer or summary. */
function lastSaid({ links }: Chain): number {
  return links.findLastIndex((one) => one.kind === "user" || one.kind === "assistant" || one.kind === "summary");
}

/** The records a talk stands on now: from the last thing said in it, back to its beginning. What a summary was made
 *  of stands with them: it was said, and the talk goes on from what the summary says of it. */
function standing(chain: Chain): Set<string> {
  const stands = new Set<string>();
  for (const at of wayBack(chain, lastSaid(chain))) stands.add(chain.links[at].uuid);
  return stands;
}

async function readTranscript(path: string, id: string, parentId: string | null, now: number): Promise<Transcript | null> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const kept = cache.get(path);
  if (kept && kept.size === stat.size && kept.mtime === stat.mtimeMs) {
    if (kept.transcript) kept.transcript.session.activity = activityOf(false, kept.transcript.open, kept.transcript.session.updatedAt, now);
    return kept.transcript;
  }
  const items: Item[] = [];
  /** For each item, the record it was read from: a fork's record begins with copies of its parent's records. */
  const sources = new Map<Item, string>();
  const chain: Chain = { links: [], place: new Map() };
  /** The sessions this one comes from by forking, the nearest last: a fork of a fork names both. */
  let forkOf: string[] = [];
  let forkKept: string | undefined;
  let cwd = "";
  let model: string | null = null;
  let first = 0;
  let last = 0;
  let summary = "";
  let turnId: string | null = null;
  let open = false;
  let answers: Item[] = [];
  const close = () => {
    if (answers.length) answers[answers.length - 1].final = true;
    answers = [];
  };
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "summary" && typeof record.summary === "string") {
      summary = record.summary;
      continue;
    }
    if (record?.type === "derived-from") {
      // Claude Code says so when a session was begun as another one stood (--fork-session, or /branch in its window).
      // A fork of a fork is told the whole way it came: the session it was forked from stands last.
      const from = (Array.isArray(record.sessions) ? record.sessions : []).filter((one: any) => (one?.via === "fork" || one?.via === "branch") && typeof one.id === "string").map((one: any) => one.id as string);
      if (from.length) forkOf = from;
      continue;
    }
    // In a main transcript, sidechain lines are a subagent's talk: that has its own file.
    if (record?.isSidechain && !parentId) continue;
    if (typeof record?.uuid === "string") chained(chain, record);
    if (record?.type === "attachment") {
      // What a hook put with a prompt is written right after it, as a record of its own.
      const attached = record.attachment;
      if (attached?.type === "hook_additional_context") {
        const text = (Array.isArray(attached.content) ? attached.content : [attached.content]).filter((part: unknown) => typeof part === "string").join("\n");
        const prompt = items.findLast((item) => item.kind === "prompt");
        if (prompt && text.includes(PIECE_MARK)) prompt.added = prompt.added ? prompt.added + "\n\n" + text : text;
      }
      continue;
    }
    const at = ms(record?.timestamp);
    if (at) {
      first ||= at;
      last = at;
    }
    if (!cwd && typeof record?.cwd === "string") cwd = record.cwd;
    const message = record?.message && typeof record.message === "object" ? record.message : {};
    const content = message.content;
    const push = (kind: Item["kind"], text: string, more: Partial<Item> = {}) => {
      const made: Item = { id: id + ":" + items.length, sessionId: id, turnId, kind, at, text, ...more };
      items.push(made);
      if (typeof record?.uuid === "string") sources.set(made, record.uuid);
      return made;
    };
    if (record?.type === "user") {
      const text = typedIn(record);
      const images = Array.isArray(content) ? content.filter((block) => block?.type === "image").length : 0;
      if (text) {
        close();
        turnId = typeof record.uuid === "string" ? record.uuid : turnId;
        push("prompt", text, images ? { images } : {});
        open = true;
      }
      const result = record.toolUseResult;
      if (result && typeof result === "object" && typeof result.filePath === "string" && "structuredPatch" in result) {
        const body = patchText(result);
        if (body) push("change", body, { path: result.filePath });
      }
    } else if (record?.type === "assistant") {
      if (typeof message.model === "string" && message.model !== "<synthetic>") model = message.model;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) answers.push(push("answer", block.text.trim()));
      }
      if (message.stop_reason === "end_turn") open = false;
      else if (message.stop_reason === "tool_use") open = true;
    }
  }
  close();
  // The items keep the numbers they were given, so that an item is known by the same id whatever is left out below.
  // A turn (a request and what came of it) the talk was taken back to before is not the talk any more: it is left
  // out when its request is not among the records the talk stands on. A subagent's talk is not taken back.
  if (!parentId) {
    const stands = standing(chain);
    let kept = true; // what was said before any request stays
    const still = items.filter((item) => {
      if (item.kind === "prompt") {
        const record = sources.get(item);
        kept = record === undefined || stands.has(record);
      }
      return kept;
    });
    if (still.length !== items.length) {
      items.length = 0;
      items.push(...still);
    }
  }
  // A fork's record begins with copies of what its parent had said (the same records, under the fork's id). They
  // are the parent's: here the fork is what was said in it, and the line to its parent says the rest.
  if (forkOf.length && !parentId) {
    const theirs = new Set<string>();
    for (const one of forkOf) for (const record of await recordIds(join(dirname(path), one + ".jsonl"))) theirs.add(record);
    if (theirs.size) {
      const own = items.filter((item) => !theirs.has(sources.get(item) ?? ""));
      forkKept = items.findLast((item) => item.kind === "prompt" && theirs.has(sources.get(item) ?? ""))?.turnId ?? undefined;
      items.length = 0;
      items.push(...own);
      first = items[0]?.at ?? first;
    }
  }
  const firstPrompt = items.find((item) => item.kind === "prompt");
  const transcript: Transcript | null = items.length
    ? {
        session: {
          id,
          client: "claude",
          projectId: null,
          cwd,
          title: oneLine(summary || withoutPieces(firstPrompt?.text ?? "") || firstPrompt?.text || "(지시 없음)", 80),
          model,
          startedAt: first,
          updatedAt: last,
          origin: parentId ? "subagent" : forkOf.length ? "fork" : "user",
          parentId: parentId ?? forkOf.at(-1) ?? null,
          activity: activityOf(false, open, last, now),
          nowFile: null,
          recordPath: path,
          counts: {
            prompts: items.filter((item) => item.kind === "prompt").length,
            answers: items.filter((item) => item.kind === "answer").length,
            changes: items.filter((item) => item.kind === "change").length,
          },
        },
        items,
        open,
        ...(forkKept ? { forkKept } : {}),
      }
    : null;
  if (transcript && transcript.session.activity === "running") {
    transcript.session.nowFile = [...items].reverse().find((item) => item.kind === "change")?.path ?? null;
  }
  cache.set(path, { size: stat.size, mtime: stat.mtimeMs, transcript });
  return transcript;
}

/** The ids of the records in a transcript. Empty when it cannot be read. */
async function recordIds(path: string): Promise<Set<string>> {
  const found = new Set<string>();
  if (!existsSync(path)) return found;
  for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
    const at = line.indexOf('"uuid":"');
    if (at !== -1) found.add(line.slice(at + 8, line.indexOf('"', at + 8)));
  }
  return found;
}

/** Where a session's talk stood just before one of its requests, as Claude Code can take it up again.
 *  at: the record to stop at (null: nothing stood before the request, so the talk is begun anew).
 *  not: why it cannot be taken up from there. "found": the request is not in the record. "back": the talk was taken
 *       back to before the request, and does not stand on it. "summed": Claude Code has made a summary of the talk
 *       since; it takes a talk up from its last summary on, never from before it. */
export type Stood = { at: string | null } | { not: "found" | "back" | "summed" };

/** In a session's record: where the talk stood before one of its requests (the request known by the id of its own
 *  record). It is the record of the last answer before the request, going back the way the talk came, not the way
 *  the records lie. Where a summary comes first that way, it is the summary: or, when the summary left the last
 *  stretch of the talk as it was said, the last answer of that stretch. */
export async function stoodBefore(path: string, prompt: string): Promise<Stood> {
  const chain: Chain = { links: [], place: new Map() };
  if (!existsSync(path)) return { not: "found" };
  for await (const line of createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity })) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record?.isSidechain && typeof record?.uuid === "string") chained(chain, record);
  }
  const { links, place } = chain;
  const asked = place.get(prompt);
  if (asked === undefined) return { not: "found" };
  /** Going back from a record to the one named: the last answer or summary on the way, the two ends among them. */
  const last = (from: number, end?: string): string | null => {
    for (const at of wayBack(chain, from)) {
      if (links[at].kind === "assistant" || links[at].kind === "summary") return links[at].uuid;
      if (links[at].kind === "mark" || links[at].uuid === end) break;
    }
    return null;
  };
  // what Claude Code takes up: the talk from its last record back to the mark of its last summary
  const taken = new Set<number>();
  let mark = -1;
  for (const at of wayBack(chain, lastSaid(chain))) {
    taken.add(at);
    if (links[at].kind === "mark") {
      mark = at;
      break;
    }
  }
  const kept = mark === -1 ? undefined : links[mark].kept;
  if (taken.has(asked)) {
    const found = last(before(chain, asked));
    // a summary that left the end of the talk as it was said is taken to come before that stretch
    if (found !== null && kept && kept.after === found && links[place.get(found) ?? -1]?.kind === "summary") return { at: last(place.get(kept.tail) ?? -1, kept.head) ?? found };
    return { at: found };
  }
  if (mark === -1) return { not: "back" };
  // not among what is taken up: only what the summary left as it was said can be gone back to
  if (kept) {
    for (const at of wayBack(chain, place.get(kept.tail) ?? -1)) {
      if (at === asked) {
        const found = links[at].uuid === kept.head ? null : last(before(chain, at), kept.head);
        // nothing in the stretch before the request: the summary, when the stretch is taken to come after it
        return { at: found ?? (kept.after !== links[mark].uuid && place.has(kept.after) ? kept.after : null) };
      }
      if (links[at].uuid === kept.head) break;
    }
  }
  // what the summary was made of was said and cannot be gone back to; the rest is what the talk was taken back from
  let summed = false;
  for (const at of wayBack(chain, mark)) summed ||= at === asked;
  return { not: summed ? "summed" : "back" };
}

/** The Claude Code sessions whose working folder lies in the project, with what they said and changed. */
export async function readClaudeSessions(project: Project, home = claudeHome(), now = Date.now()): Promise<{ transcripts: Transcript[]; notes: string[] }> {
  const notes: string[] = [];
  const top = join(home, "projects");
  if (!existsSync(top)) return { transcripts: [], notes: ["Claude Code의 기록 폴더(" + top + ")가 없습니다."] };
  const prefixes = project.roots.map(folderName);
  const transcripts: Transcript[] = [];
  for (const folder of readdirSync(top)) {
    // The folder name loses which characters were which, so it only narrows: the record's own cwd decides.
    if (!prefixes.some((prefix) => folder === prefix || folder.startsWith(prefix + "-"))) continue;
    const dir = join(top, folder);
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -6);
      const main = await readTranscript(join(dir, name), id, null, now);
      if (!main || !project.roots.some((root) => under(main.session.cwd, root))) continue;
      main.session.projectId = project.id;
      transcripts.push(main);
      const subs = join(dir, id, "subagents");
      if (!existsSync(subs)) continue;
      for (const sub of readdirSync(subs)) {
        if (!sub.startsWith("agent-") || !sub.endsWith(".jsonl")) continue;
        const child = await readTranscript(join(subs, sub), id + "~" + sub.slice(6, -6), id, now);
        if (!child) continue;
        child.session.projectId = project.id;
        transcripts.push(child);
      }
    }
  }
  return { transcripts, notes };
}
