// Reads Claude Code's own records into the common shapes. Read-only.
//   one conversation: ~/.claude/projects/<folder with every non-letter turned into ->/<session id>.jsonl
//   its subagents:    ~/.claude/projects/<folder>/<session id>/subagents/agent-<id>.jsonl
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    // In a main transcript, sidechain lines are a subagent's talk: that has its own file.
    if (record?.isSidechain && !parentId) continue;
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
      return made;
    };
    if (record?.type === "user") {
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content) && !content.some((block) => block?.type === "tool_result")) {
        text = content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).filter(Boolean).join("\n");
      }
      text = record.isMeta ? "" : typed(text);
      if (text && !/^(\[Request interrupted|Caveat:)/.test(text)) {
        close();
        turnId = typeof record.uuid === "string" ? record.uuid : turnId;
        push("prompt", text);
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
          origin: parentId ? "subagent" : "user",
          parentId,
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
      }
    : null;
  if (transcript && transcript.session.activity === "running") {
    transcript.session.nowFile = [...items].reverse().find((item) => item.kind === "change")?.path ?? null;
  }
  cache.set(path, { size: stat.size, mtime: stat.mtimeMs, transcript });
  return transcript;
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
