// The demo's stand-in for the two clients. No model runs: the "agent" answers by saying back what it was given (the
// request, and each piece that came with it), which is exactly what the demo is there to show. It speaks the same
// protocols the tool uses with the real clients, calls the same hook, and writes records in the clients' own formats,
// so the tool cannot tell it from a real client.
//   agent.ts claude <flags>       as Claude Code run headless (stream-json), started by the tool
//   agent.ts codex app-server     as the Codex app server (JSON-RPC over stdio), started by the tool
//   agent.ts say <session> <text> as a person typing in the session's own window (the desktop app, a terminal)
// Ask it to "고쳐" (fix, edit) something and it asks leave to add a line to NOTES.md in the session's folder.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { filesIn, withoutPieces } from "../packages/core/src/links.ts";
import { CLAUDE, CODEX, FLOW, MODEL, PROJECTS, ROOT, SESSIONS, THREADS, iso, line, rolloutPath, transcriptPath, useDemoHomes } from "./world.ts";

useDemoHomes();
const NOTE = "(아래는 다른 세션에서 골라 온 맥락입니다.)";
const PIECE = /<context-piece id="([^"]+)" from="([^"]*)" kind="([^"]*)">\n([\s\S]*?)\n<\/context-piece>/g;
const short = (text: string, room: number) => { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > room ? flat.slice(0, room - 1) + "…" : flat; };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const size = (bytes: number) => (bytes < 1024 ? bytes + "바이트" : (bytes / 1024).toFixed(1) + "KB");

/** What was typed, without the pieces that came along and without the list of the files that were sent with it. */
const typedOf = (prompt: string) => withoutPieces(prompt).trim();
/** The files the request says were sent with it: the agent is told where they lie, and looks whether it can read them. */
const filesOf = (prompt: string) => filesIn(prompt).map((path) => basename(path) + " (" + (existsSync(path) ? size(statSync(path).size) + ", 읽을 수 있습니다" : "읽을 수 없습니다") + ")");
/** What came with a request besides words and pieces: pictures (each said by its kind and size) and the model asked for. */
interface Extra { pictures: string[]; model?: string; kept?: number }
const wantsEdit = (prompt: string) => /고쳐|수정|적어|edit/i.test(typedOf(prompt));

/** What the client's hook gives for this prompt: the pieces set to wait for the session, handed over the way the
 *  real clients are handed them. The plugin's own hook is run, as a client would run it. */
function hooked(session: string, prompt: string, cwd: string, record: string): string {
  const run = spawnSync("sh", [join(ROOT, "plugin", "context-flow", "hooks", "along.sh")], {
    input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt, cwd, transcript_path: record }),
    env: { ...process.env, CONTEXT_FLOW_HOME: FLOW, CONTEXT_FLOW_NODE: process.execPath }, encoding: "utf8",
  });
  try {
    return String(JSON.parse(run.stdout)?.hookSpecificOutput?.additionalContext ?? "");
  } catch {
    return ""; // nothing was waiting
  }
}

/** The answer: the request and the pieces, said back. */
function answer(prompt: string, added: string, edited: "done" | "refused" | null, extra: Extra = { pictures: [] }): string {
  const pieces = [...(prompt + "\n" + added).matchAll(PIECE)].map((found) => ({ from: found[2], kind: found[3], text: found[4] }));
  const typed = typedOf(prompt);
  const out = ["(데모 에이전트의 답입니다. 실제 모델은 돌지 않고, 받은 것을 그대로 되짚어 말합니다.)", ""];
  // a session forked from another knows what was said in that one up to where it was forked, and nothing after
  if (extra.kept !== undefined) out.push("갈라져 나온 세션입니다. 원래 대화에서 요청 " + extra.kept + "개와 그 답까지를 물려받았고, 그 뒤에 오간 말은 모릅니다.", "");
  out.push(typed ? "요청: “" + short(typed, 120) + "”" : "요청 글 없이 조각만 받았습니다.", "");
  if (pieces.length) {
    out.push("함께 받은 조각 " + pieces.length + "개:");
    pieces.forEach((piece, n) => out.push(n + 1 + ". " + piece.from + "의 " + piece.kind + "에서: “" + short(piece.text, 70) + "”"));
  } else out.push("함께 받은 조각은 없습니다.");
  if (extra.pictures.length) out.push("", "함께 받은 그림 " + extra.pictures.length + "개: " + extra.pictures.join(", "));
  const files = filesOf(prompt);
  if (files.length) out.push("", "함께 받은 파일 " + files.length + "개: " + files.join(", "));
  if (extra.model) out.push("", "이번 답의 모델: " + extra.model);
  if (edited === "done") out.push("", "NOTES.md에 한 줄을 적었습니다.");
  if (edited === "refused") out.push("", "허락을 받지 못해 NOTES.md는 고치지 않았습니다.");
  return out.join("\n");
}

/** The line the agent would add to the folder's notes, and the line it goes after. */
function edit(cwd: string, prompt: string): { path: string; after: string; added: string } {
  const path = join(cwd, "NOTES.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { path, after: before.trimEnd().split("\n").pop() ?? "", added: "- " + short(typedOf(prompt), 60) };
}
function apply(change: { path: string; added: string }): void {
  const before = existsSync(change.path) ? readFileSync(change.path, "utf8") : "";
  writeFileSync(change.path, before.trimEnd() + "\n" + change.added + "\n");
}

// ---------- records, in each client's own format ----------

function claudeRecord(session: string, cwd: string, rows: Record<string, unknown>[]): void {
  const path = transcriptPath(cwd, session);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => line({ cwd, sessionId: session, timestamp: iso(Date.now()), uuid: randomUUID(), ...row })).join(""));
}
const claudeAsked = (prompt: string, added: string, pictures: unknown[] = []) => [{ type: "user", message: { role: "user", content: pictures.length ? [...pictures, { type: "text", text: prompt }] : prompt } },
  ...(added ? [{ type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit", content: [added] } }] : [])];
const claudeChanged = (change: { path: string; after: string; added: string }) => [
  { type: "assistant", message: { role: "assistant", model: MODEL.claude, stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool-edit", name: "Edit", input: { file_path: change.path } }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-edit", content: "ok" }] }, toolUseResult: { filePath: change.path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [" " + change.after, "+" + change.added] }] } }];
const claudeAnswered = (text: string, model = MODEL.claude) => [{ type: "assistant", message: { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text }] } }];

function threads(): DatabaseSync {
  const db = new DatabaseSync(join(CODEX, "state_5.sqlite"));
  db.exec(THREADS);
  return db;
}
function codexRecord(thread: string, turn: string, rows: Record<string, unknown>[]): void {
  const now = Date.now();
  appendFileSync(rolloutPath(thread), rows.map((row) => line("payload" in row ? { timestamp: iso(now), ...row } : { timestamp: iso(now), type: "event_msg", payload: { type: "item_completed", turn_id: turn, completed_at_ms: now, item: row } })).join(""));
  const db = threads();
  db.prepare("update threads set updated_at_ms = ? where id = ?").run(now, thread);
  db.close();
}
const codexAsked = (turn: string, prompt: string, added: string, pictures: unknown[] = []) => [
  { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
  { type: "UserMessage", content: [{ type: "text", text: prompt }, ...pictures] },
  // what a hook put with the prompt is a message of its own, beside it
  ...(added ? [{ type: "response_item", payload: { type: "message", id: "hook-" + turn, role: "developer", content: [{ type: "input_text", text: added }], internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["hooks.additional_context"] } } }] : [])];
const codexChanged = (change: { path: string; after: string; added: string }) => [{ type: "FileChange", status: "completed", changes: { [change.path]: { type: "update", unified_diff: "@@ -1,1 +1,2 @@\n " + change.after + "\n+" + change.added } } }];
const codexAnswered = (turn: string, text: string) => [{ type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text }] }, { type: "event_msg", payload: { type: "task_complete", turn_id: turn } }];

// ---------- as Claude Code, run headless by the tool ----------

function asClaude(args: string[]): void {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const fresh = flag("--session-id");
  const session = fresh ?? flag("--resume") ?? "";
  // --resume <other> --fork-session --session-id <new> --resume-session-at <record>: the other session, carried on
  // under an id of its own from the answer that record holds
  const forked = args.includes("--fork-session") ? { from: flag("--resume") ?? "", at: flag("--resume-session-at") ?? "" } : null;
  const cwd = process.cwd();
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const waiting = new Map<string, (allow: boolean) => void>();
  let begun = false;
  createInterface({ input: process.stdin }).on("line", async (raw) => {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === "control_response") {
      const id = message.response?.request_id;
      waiting.get(id)?.(message.response?.response?.behavior === "allow");
      waiting.delete(id);
      return;
    }
    if (message.type !== "user" || begun) return;
    begun = true;
    const blocks: any[] = Array.isArray(message.message?.content) ? message.message.content : [];
    const prompt = String(blocks.find((block) => block?.type === "text")?.text ?? "");
    const pictures = blocks.filter((block) => block?.type === "image");
    const model = flag("--model");
    const extra: Extra = { pictures: pictures.map((block) => String(block.source?.media_type) + " " + size(Buffer.from(String(block.source?.data ?? ""), "base64").length)), ...(model && model !== MODEL.claude ? { model } : {}) };
    const record = transcriptPath(cwd, session);
    if (!fresh && !existsSync(record)) return out({ type: "result", is_error: true, result: "No conversation found with session ID: " + session });
    if (forked) {
      // As Claude Code does: the fork's record says which session it comes from, and begins with that session's
      // records up to the one named, each a copy under the fork's id.
      const other = transcriptPath(cwd, forked.from);
      if (!existsSync(other)) return out({ type: "result", is_error: true, result: "No conversation found with session ID: " + forked.from });
      const rows = readFileSync(other, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row));
      const upTo = rows.findIndex((row) => row.uuid === forked.at);
      if (upTo === -1) return out({ type: "result", is_error: true, result: "No message found with message.uuid of: " + forked.at });
      const copied = rows.slice(0, upTo + 1).filter((row) => typeof row.uuid === "string").map((row) => ({ ...row, sessionId: session }));
      // a fork of a fork names the whole way it came, the session it was forked from last
      const way = [...(rows.find((row) => row.type === "derived-from")?.sessions ?? []), { type: "claude_code_session", id: forked.from, via: "fork" }];
      mkdirSync(dirname(record), { recursive: true });
      writeFileSync(record, line({ type: "derived-from", v: 1, sessionId: session, sessions: way }) + copied.map(line).join(""));
      extra.kept = copied.filter((row) => row.type === "user" && !row.toolUseResult && (typeof row.message?.content === "string" || (Array.isArray(row.message?.content) && !row.message.content.some((block: any) => block?.type === "tool_result")))).length;
    }
    const added = hooked(session, prompt, cwd, record);
    claudeRecord(session, cwd, claudeAsked(prompt, added, pictures));
    let edited: "done" | "refused" | null = null;
    if (wantsEdit(prompt)) {
      const change = edit(cwd, prompt);
      const input = { file_path: change.path, old_string: change.after, new_string: change.after + "\n" + change.added };
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input }] } });
      const allow = await new Promise<boolean>((resolve) => {
        const id = randomUUID();
        waiting.set(id, resolve);
        out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Edit", input } });
      });
      if (allow) {
        apply(change);
        claudeRecord(session, cwd, claudeChanged(change));
      }
      edited = allow ? "done" : "refused";
    }
    const text = answer(prompt, added, edited, extra);
    out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
    for (let at = 0; at < text.length; at += 14) {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(at, at + 14) } } });
      await pause(12);
    }
    claudeRecord(session, cwd, claudeAnswered(text, model ?? MODEL.claude));
    out({ type: "result", is_error: false });
  });
}

// ---------- as the Codex app server, run by the tool ----------

/** How far into a thread's record a fork of it goes that keeps its turns up to one of them: to the end of the last
 *  line that tells of that turn (to the end of the record when no turn is named). Null when the turn is not there. */
function endOf(thread: string, lastTurn: string | null): number | null {
  const whole = readFileSync(rolloutPath(thread));
  if (!lastTurn) return whole.length;
  let end: number | null = null;
  let at = 0;
  for (const row of whole.toString("utf8").split("\n")) {
    at += Buffer.byteLength(row) + 1;
    if (row.includes('"turn_id":' + JSON.stringify(lastTurn))) end = Math.min(at, whole.length);
  }
  return end;
}
/** How many requests a thread's record holds in its first so many bytes, with those the thread was itself given when
 *  it was forked. */
function keptIn(thread: string, end: number): number {
  const rows = readFileSync(rolloutPath(thread)).subarray(0, end).toString("utf8").split("\n").filter(Boolean).map((row) => { try { return JSON.parse(row); } catch { return null; } });
  const base = rows[0]?.payload?.history_base;
  return rows.filter((row) => row?.payload?.type === "item_completed" && row.payload.item?.type === "UserMessage").length + (base ? keptIn(base.thread_id, base.end_byte_offset) : 0);
}

function asCodex(): void {
  const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const waiting = new Map<number, (allow: boolean) => void>();
  let serial = 100;
  let thread: { id: string; cwd: string; kept?: number } | null = null;
  const turn = async (id: number, prompt: string, pictures: { type: string; path: string }[], model: string | undefined) => {
    if (!thread) return out({ id, error: { message: "no thread" } });
    const kinds: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    const extra: Extra = { pictures: pictures.map((one) => (kinds[one.path.split(".").pop()?.toLowerCase() ?? ""] ?? "image") + " " + (existsSync(one.path) ? size(statSync(one.path).size) : "(읽을 수 없음)")), ...(model ? { model } : {}) };
    if (thread.kept !== undefined) extra.kept = thread.kept; // said once, in the fork's first answer
    delete thread.kept;
    const turnId = "turn-" + Date.now().toString(36);
    out({ id, result: { turn: { id: turnId } } });
    const db = threads();
    db.prepare("update threads set first_user_message = ?, title = ? where id = ? and first_user_message = ''").run(typedOf(prompt), short(typedOf(prompt) || "(조각만 보냄)", 80), thread.id);
    // a model asked for with a turn is the thread's from then on, as with the real client
    if (model) db.prepare("update threads set model = ? where id = ?").run(model, thread.id);
    db.close();
    if (model) appendFileSync(rolloutPath(thread.id), line({ timestamp: iso(Date.now()), type: "turn_context", payload: { cwd: thread.cwd, model, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } }));
    const added = hooked(thread.id, prompt, thread.cwd, rolloutPath(thread.id));
    // the record names a picture the way the real client's record does
    codexRecord(thread.id, turnId, codexAsked(turnId, prompt, added, pictures.map((one) => ({ type: "local_image", path: one.path }))));
    let edited: "done" | "refused" | null = null;
    if (wantsEdit(prompt)) {
      const change = edit(thread.cwd, prompt);
      const itemId = "item-" + turnId;
      out({ method: "item/started", params: { item: { type: "fileChange", id: itemId, changes: [{ path: change.path, diff: " " + change.after + "\n+" + change.added }] } } });
      const allow = await new Promise<boolean>((resolve) => {
        serial += 1;
        waiting.set(serial, resolve);
        out({ id: serial, method: "item/fileChange/requestApproval", params: { itemId, reason: "데모 에이전트가 NOTES.md에 한 줄을 적으려 합니다" } });
      });
      if (allow) {
        apply(change);
        codexRecord(thread.id, turnId, codexChanged(change));
      }
      edited = allow ? "done" : "refused";
    }
    const text = answer(prompt, added, edited, extra);
    out({ method: "item/started", params: { item: { type: "agentMessage" } } });
    for (let at = 0; at < text.length; at += 14) {
      out({ method: "item/agentMessage/delta", params: { delta: text.slice(at, at + 14) } });
      await pause(12);
    }
    codexRecord(thread.id, turnId, codexAnswered(turnId, text));
    out({ method: "turn/completed", params: { turn: { status: "completed" } } });
  };
  createInterface({ input: process.stdin }).on("line", (raw) => {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const params = message.params ?? {};
    if (message.method === undefined && waiting.has(message.id)) {
      waiting.get(message.id)!(message.result?.decision === "accept");
      waiting.delete(message.id);
    } else if (message.method === "initialize") out({ id: message.id, result: {} });
    else if (message.method === "model/list") out({ id: message.id, result: { data: [{ model: MODEL.codex, displayName: "Demo Codex 1", hidden: false }, { model: "demo-codex-mini", displayName: "Demo Codex mini", hidden: false }, { model: "demo-codex-old", displayName: "Demo Codex (hidden)", hidden: true }], nextCursor: null } });
    else if (message.method === "thread/start") {
      const id = "0de0" + randomUUID().slice(4);
      const cwd = String(params.cwd ?? process.cwd());
      const now = Date.now();
      mkdirSync(dirname(rolloutPath(id)), { recursive: true });
      writeFileSync(rolloutPath(id), line({ timestamp: iso(now), type: "session_meta", payload: { id, cwd } })
        + line({ timestamp: iso(now), type: "turn_context", payload: { cwd, model: params.model ?? MODEL.codex, approval_policy: params.approvalPolicy ?? "on-request", sandbox_policy: { type: params.sandbox ?? "workspace-write" } } }));
      const db = threads();
      db.prepare("insert into threads (id, rollout_path, cwd, title, name, model, created_at_ms, updated_at_ms, thread_source, source, archived, first_user_message, attached_thread_parent_id) values (?, ?, ?, '', null, ?, ?, ?, null, 'cli', 0, '', null)")
        .run(id, rolloutPath(id), cwd, String(params.model ?? MODEL.codex), now, now);
      db.close();
      thread = { id, cwd };
      out({ id: message.id, result: { thread: { id } } });
    } else if (message.method === "thread/fork") {
      // As the real server does: the fork is a thread of its own whose record says which thread it comes from and how
      // far into that thread's record its history goes. Nothing of the other thread is copied.
      const db = threads();
      const row = db.prepare("select id, cwd, model from threads where id = ?").get(String(params.threadId ?? "")) as { id: string; cwd: string; model: string } | undefined;
      if (!row) {
        db.close();
        return out({ id: message.id, error: { message: "no rollout found for thread id " + params.threadId } });
      }
      const end = endOf(row.id, typeof params.lastTurnId === "string" ? params.lastTurnId : null);
      if (end === null) {
        db.close();
        return out({ id: message.id, error: { message: "turn not found in thread: " + params.lastTurnId } });
      }
      const id = "0de0" + randomUUID().slice(4);
      const cwd = String(params.cwd ?? row.cwd);
      const model = String(params.model ?? row.model ?? MODEL.codex);
      const now = Date.now();
      writeFileSync(rolloutPath(id), line({ timestamp: iso(now), type: "session_meta", payload: { id, cwd, forked_from_id: row.id, history_mode: "paginated", history_base: { thread_id: row.id, end_byte_offset: end } } })
        + line({ timestamp: iso(now), type: "turn_context", payload: { cwd, model, approval_policy: params.approvalPolicy ?? "on-request", sandbox_policy: { type: params.sandbox ?? "workspace-write" } } }));
      db.prepare("insert into threads (id, rollout_path, cwd, title, name, model, created_at_ms, updated_at_ms, thread_source, source, archived, first_user_message, attached_thread_parent_id) values (?, ?, ?, '', null, ?, ?, ?, null, 'cli', 0, '', null)")
        .run(id, rolloutPath(id), cwd, model, now, now);
      db.close();
      thread = { id, cwd, kept: keptIn(row.id, end) };
      out({ id: message.id, result: { thread: { id } } });
    } else if (message.method === "thread/resume") {
      const db = threads();
      const row = db.prepare("select id, cwd from threads where id = ?").get(String(params.threadId ?? "")) as { id: string; cwd: string } | undefined;
      db.close();
      if (!row) return out({ id: message.id, error: { message: "no rollout found for thread id " + params.threadId } });
      thread = { id: row.id, cwd: row.cwd };
      out({ id: message.id, result: { thread: { id: row.id } } });
    } else if (message.method === "turn/start") {
      const input: any[] = Array.isArray(params.input) ? params.input : [];
      void turn(message.id, String(input.find((one) => one?.type === "text")?.text ?? ""), input.filter((one) => one?.type === "localImage" && typeof one.path === "string"), typeof params.model === "string" ? params.model : undefined);
    }
    else if (message.method === "turn/interrupt") out({ method: "turn/completed", params: { turn: { status: "interrupted" } } });
  });
}

// ---------- as a person typing in the session's own window ----------

/** A session of the demo by its short name, by its id, or by the beginning of its id. */
function find(name: string): { id: string; client: "codex" | "claude"; cwd: string; title: string } | null {
  const known = SESSIONS[name];
  if (known) return { id: known.id, client: known.client, cwd: PROJECTS[known.project].root, title: known.title };
  const db = threads();
  const row = db.prepare("select id, cwd, title from threads where id like ?").get(name + "%") as { id: string; cwd: string; title: string } | undefined;
  db.close();
  if (row) return { id: row.id, client: "codex", cwd: row.cwd, title: row.title };
  const top = join(CLAUDE, "projects");
  for (const folder of existsSync(top) ? readdirSync(top) : []) {
    const file = readdirSync(join(top, folder)).find((one) => one.endsWith(".jsonl") && one.startsWith(name));
    if (!file) continue;
    const first = readFileSync(join(top, folder, file), "utf8").split("\n").map((one) => { try { return JSON.parse(one); } catch { return null; } }).find((one) => one?.cwd);
    if (first) return { id: file.slice(0, -6), client: "claude", cwd: first.cwd, title: short(String(first.message?.content ?? file), 60) };
  }
  return null;
}

function say(name: string, prompt: string): void {
  const who = name ? find(name) : null;
  if (!who || !prompt) {
    console.error("쓰는 법: npm run demo:say -- <세션> \"<할 말>\"\n세션 이름: " + Object.entries(SESSIONS).map(([short, one]) => short + " (" + one.title + ")").join(", ") + "\n데모 중에 새로 만든 세션은 id의 앞머리로 부릅니다.");
    process.exit(1);
  }
  const record = who.client === "codex" ? rolloutPath(who.id) : transcriptPath(who.cwd, who.id);
  const added = hooked(who.id, prompt, who.cwd, record);
  const change = wantsEdit(prompt) ? edit(who.cwd, prompt) : null;
  if (change) apply(change); // in its own window the person is there to allow it
  const text = answer(prompt, added, change ? "done" : null);
  if (who.client === "codex") {
    const turn = "turn-" + Date.now().toString(36);
    codexRecord(who.id, turn, [...codexAsked(turn, prompt, added), ...(change ? codexChanged(change) : []), ...codexAnswered(turn, text)]);
  } else claudeRecord(who.id, who.cwd, [...claudeAsked(prompt, added), ...(change ? claudeChanged(change) : []), ...claudeAnswered(text)]);
  // the person has answered in that window: the session no longer waits for them there
  const live = join(CLAUDE, "sessions");
  for (const file of existsSync(live) ? readdirSync(live) : []) {
    try {
      const row = JSON.parse(readFileSync(join(live, file), "utf8"));
      if (row.sessionId === who.id) writeFileSync(join(live, file), JSON.stringify({ ...row, status: "idle", waitingFor: undefined, statusUpdatedAt: Date.now() }));
    } catch { /* not a session file */ }
  }
  const carried = [...added.matchAll(PIECE)].length;
  console.log("‘" + who.title + "’ 세션의 창에서 말을 쳤습니다: “" + short(prompt, 60) + "”\n" + (carried ? "훅이 걸려 있던 조각 " + carried + "개를 이 말과 함께 실었습니다. 화면이 몇 초 안에 다시 읽으면 대기 선이 실선으로 바뀝니다." : "이 세션에 걸려 있던 조각은 없었습니다."));
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "claude") asClaude(rest);
else if (mode === "codex") asCodex();
else if (mode === "say") say(rest[0] ?? "", rest.slice(1).join(" "));
else {
  console.error("usage: agent.ts claude <flags> | codex app-server | say <session> <text>");
  process.exit(1);
}
