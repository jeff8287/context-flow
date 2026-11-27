// Carrying on a session's talk from this tool: one turn at a time, through the session's own client, so that the
// record, the model and the permissions stay the session's own. A new session is begun the same way, and runs like
// a session of the same client that is already in the project.
//   Codex: its app server, JSON-RPC over stdio (thread/resume or thread/start, then turn/start).
//   Claude Code: headless, stream-json in both directions (--resume, or --session-id for a new one).
// Both are turned into one stream of small events for the screen. A request for approval is passed to the screen
// and waits there; nothing is approved here.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Client, Session, TurnEvent } from "./model.ts";

/** A session to be begun: by which client, in which folder, and like which session of that client (its model and
 *  what it may do without asking); with none to go by, the client's own defaults. */
export interface Fresh { client: Client; cwd: string; like: Session | null }

/** What goes with a request besides its words. images: pictures, as files on this machine. dirs: folders the agent
 *  is let read without asking (the other files that were sent along lie there). model: the model to answer with,
 *  when it is not to be the session's own; the session goes on with it afterwards, as when it is changed in the client. */
export interface Along { images?: { path: string; type: string }[]; dirs?: string[]; model?: string }

/** Where a turn runs. id: the session's, or null for a Codex thread that is yet to be given one. fork: the session
 *  is to be begun as another one stood after one of its turns (from: that session; at: the last turn of it that is
 *  kept, as its client knows it). */
interface Where { id: string | null; fresh: boolean; cwd: string; recordPath: string | null; model: string | null; fork?: { from: string; at: string } }

export interface Turn {
  id: string;
  /** Empty while a new Codex thread has not been given its id yet. */
  sessionId: string;
  /** Everything so far, so that a screen that joins late can catch up. */
  events: TurnEvent[];
  done: boolean;
  endedAt: number;
  listen(hear: (event: TurnEvent) => void): () => void;
  /** Answer a request for approval. False when there is no such request waiting. */
  answer(id: string, allow: boolean): boolean;
  stop(): void;
}

interface Runner {
  answer(id: string, allow: boolean): boolean;
  stop(): void;
}
type Emit = (event: TurnEvent) => void;

const cut = (text: unknown, room: number) => { const flat = String(text ?? ""); return flat.length > room ? flat.slice(0, room) + "…" : flat; };
const tail = (text: string) => text.trim().split("\n").slice(-3).join(" ").slice(-300);

/** The Codex the desktop app carries is the one that wrote its threads; the one on the PATH may be older. */
function codexBin(): string {
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  return process.env.CONTEXT_FLOW_CODEX ?? (existsSync(bundled) ? bundled : "codex");
}

/** What the thread's last turn ran with, read from its record, so that the next turn runs the same way. */
function lastTurnContext(recordPath: string | null): Record<string, any> {
  if (!recordPath || !existsSync(recordPath)) return {};
  const text = readFileSync(recordPath, "utf8");
  for (let at = text.lastIndexOf('"type":"turn_context"'); at !== -1; at = text.lastIndexOf('"type":"turn_context"', at - 1)) {
    const from = text.lastIndexOf("\n", at) + 1;
    const to = text.indexOf("\n", at);
    try {
      const row = JSON.parse(text.slice(from, to === -1 ? undefined : to));
      if (row?.type === "turn_context" && row.payload) return row.payload;
    } catch { /* the string was inside some other line: look further back */ }
    if (at === 0) break;
  }
  return {};
}

function runCodex(session: Where, prompt: string, along: Along, emit: Emit, named: (id: string) => void): Runner {
  const context = lastTurnContext(session.recordPath);
  let threadId = session.id;
  const child = spawn(codexBin(), ["app-server"], { cwd: session.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const send = (message: unknown) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n"); };
  const waiting = new Map<string, number | string>(); // our id for a request → the server's
  const labels = new Map<string, string>(); // an item's id → what it does, for the request that names only the item
  let turnId: string | null = null;
  let finished = false;
  let stopped = false;
  let stderr = "";
  let trouble = "";
  const finish = (ok: boolean, error?: string) => {
    if (finished) return;
    finished = true;
    emit({ t: "done", ok, ...(error ? { error } : {}) });
    child.kill();
  };
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.on("error", (error) => finish(false, "Codex를 실행하지 못했습니다: " + error.message));
  child.on("exit", (code) => finish(false, stopped ? "멈췄습니다" : "Codex가 답을 끝내기 전에 닫혔습니다 (" + code + ") " + tail(stderr)));
  send({ id: 0, method: "initialize", params: { clientInfo: { name: "context-flow", title: "context flow", version: "0.0.1" } } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const method = message.method as string | undefined;
    const params = message.params ?? {};
    if (message.id !== undefined && method) {
      // The server asks this client something. Only a request for approval is passed on; it waits for the person.
      if (!method.endsWith("requestApproval")) return send({ id: message.id, error: { code: -32601, message: "this client does not answer that" } });
      const id = randomUUID();
      waiting.set(id, message.id);
      const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
      const what = command ?? labels.get(params.itemId) ?? "";
      const title = method.includes("fileChange") ? "파일을 고쳐도 될까요?" : method.includes("commandExecution") ? "이 명령을 실행해도 될까요?" : "허용할까요?";
      emit({ t: "ask", id, title, detail: cut([what, params.reason].filter(Boolean).join("\n"), 1200) });
      return;
    }
    if (message.id !== undefined && message.error) {
      // Codex lets one process at a time write to a thread. A thread that the desktop app (or an editor) has opened is
      // held by it for as long as it keeps it loaded, and cannot be carried on from here.
      const why = String(message.error.message ?? JSON.stringify(message.error));
      if (message.id === 1 || message.id === 2) finish(false, why.includes("active writer") ? "이 스레드는 지금 Codex 데스크톱 앱(또는 편집기)이 열어 두고 있어 여기서 이어 쓸 수 없습니다. 그쪽에서 이어 쓰거나, 그쪽이 스레드를 놓은 뒤 다시 보내 주세요." : "Codex가 받아 주지 않았습니다: " + cut(why, 300));
      return;
    }
    if (message.id === 0) {
      send({ method: "initialized", params: {} });
      const sandbox = typeof context.sandbox_policy === "string" ? context.sandbox_policy : context.sandbox_policy?.type;
      const how = {
        ...(along.model ?? context.model ?? session.model ? { model: along.model ?? context.model ?? session.model } : {}),
        ...(context.approval_policy ? { approvalPolicy: context.approval_policy } : {}),
        ...(sandbox ? { sandbox } : {}),
        approvalsReviewer: "user", // requests come to the screen, whoever reviewed them before
      };
      // a new thread works in the folder it was asked for, not in the folder of the session it runs like
      if (session.fork) send({ id: 1, method: "thread/fork", params: { threadId: session.fork.from, lastTurnId: session.fork.at, cwd: context.cwd ?? session.cwd, ...how, excludeTurns: true } });
      else if (session.fresh) send({ id: 1, method: "thread/start", params: { cwd: session.cwd, ...how } });
      else send({ id: 1, method: "thread/resume", params: { threadId, cwd: context.cwd ?? session.cwd, ...how } });
    } else if (message.id === 1) {
      if (session.fresh) {
        threadId = typeof message.result?.thread?.id === "string" ? message.result.thread.id : null;
        if (!threadId) return finish(false, "Codex가 새 스레드를 만들지 못했습니다");
        named(threadId);
      }
      const pictures = (along.images ?? []).map((image) => ({ type: "localImage", path: image.path }));
      send({ id: 2, method: "turn/start", params: { threadId, input: [{ type: "text", text: prompt, text_elements: [] }, ...pictures], ...(along.model ? { model: along.model } : {}), ...(context.effort ? { effort: context.effort } : {}) } });
    } else if (message.id === 2) {
      turnId = message.result?.turn?.id ?? null;
      if (stopped) stop();
    } else if (method === "item/started") {
      const item = params.item ?? {};
      if (item.type === "agentMessage") emit({ t: "break" });
      else if (item.type === "commandExecution") {
        const label = cut(Array.isArray(item.command) ? item.command.join(" ") : item.command, 300);
        labels.set(item.id, label);
        emit({ t: "step", kind: "command", label });
      } else if (item.type === "fileChange") {
        const label = (item.changes ?? []).map((change: any) => within(change.path, session.cwd)).join(", ");
        // for the person who is asked to allow it: each file with the lines that go and the lines that come
        const whole = (item.changes ?? []).map((change: any) => within(change.path, session.cwd) + (typeof change.diff === "string" && change.diff.trim() ? "\n" + change.diff.trim() : "")).join("\n\n");
        labels.set(item.id, whole || label);
        emit({ t: "step", kind: "change", label: cut(label, 300) });
      } else if (item.type === "mcpToolCall") emit({ t: "step", kind: "tool", label: cut([item.server, item.tool].filter(Boolean).join(" · "), 200) });
      else if (item.type && !["userMessage", "reasoning", "hookPrompt"].includes(item.type)) emit({ t: "step", kind: "tool", label: String(item.type) });
    } else if (method === "item/agentMessage/delta") {
      if (typeof params.delta === "string") emit({ t: "text", d: params.delta });
    } else if (method === "error") {
      if (!params.willRetry) trouble = cut(params.error?.message ?? JSON.stringify(params), 300);
    } else if (method === "turn/completed") {
      const failed = params.turn?.error;
      if (stopped) finish(false, "멈췄습니다");
      else if (failed) finish(false, cut(failed.message ?? JSON.stringify(failed), 300));
      else if (params.turn?.status === "failed") finish(false, trouble || "턴이 실패했습니다");
      else finish(true);
    }
  });
  const stop = () => {
    stopped = true;
    if (turnId) send({ id: 9, method: "turn/interrupt", params: { threadId, turnId } });
    setTimeout(() => finish(false, "멈췄습니다"), turnId ? 2500 : 8000);
  };
  return {
    answer(id, allow) {
      const request = waiting.get(id);
      if (request === undefined) return false;
      waiting.delete(id);
      send({ id: request, result: { decision: allow ? "accept" : "decline" } });
      emit({ t: "answered", id, allow });
      return true;
    },
    stop,
  };
}

/** A path as it reads from the session's folder. */
const within = (path: unknown, cwd: string) => { const full = String(path ?? ""); return full.startsWith(cwd + "/") ? full.slice(cwd.length + 1) : full; };

/** A tool call of Claude Code, said in a line. */
function claudeStep(name: string, input: Record<string, any>, cwd: string): Extract<TurnEvent, { t: "step" }> {
  if (name === "Bash") return { t: "step", kind: "command", label: cut(input.command, 300) };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return { t: "step", kind: "change", label: cut(within(input.file_path ?? input.notebook_path, cwd), 300) };
  const about = input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? "";
  return { t: "step", kind: "tool", label: cut(name + (about ? " · " + within(about, cwd) : ""), 300) };
}

/** What a tool call of Claude Code would do, for the person who is asked to allow it: for a change, the lines that go and the lines that come. */
function claudeAsk(name: string, input: Record<string, any>, cwd: string): string {
  const lines = (sign: string, text: unknown) => String(text ?? "").split("\n").map((line) => sign + " " + line).join("\n");
  const path = within(input.file_path ?? input.notebook_path, cwd);
  if (name === "Edit") return path + "\n" + lines("-", input.old_string) + "\n" + lines("+", input.new_string);
  if (name === "MultiEdit") return path + "\n" + (input.edits ?? []).map((edit: any) => lines("-", edit.old_string) + "\n" + lines("+", edit.new_string)).join("\n");
  if (name === "Write") return path + "\n" + lines("+", input.content);
  return claudeStep(name, input, cwd).label;
}

function runClaude(session: Where & { id: string }, prompt: string, along: Along, emit: Emit): Runner {
  const flags = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
  // a fork is the other session carried on under an id of its own, from the answer it is to keep as its last
  if (session.fork) flags.push("--resume", session.fork.from, "--fork-session", "--session-id", session.id, "--resume-session-at", session.fork.at);
  else flags.push(session.fresh ? "--session-id" : "--resume", session.id);
  const model = along.model ?? (session.model && /^claude-/.test(session.model) ? session.model : undefined);
  if (model) flags.push("--model", model);
  for (const dir of along.dirs ?? []) flags.push("--add-dir", dir);
  const child = spawn(process.env.CONTEXT_FLOW_CLAUDE ?? "claude", flags, { cwd: session.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const send = (message: unknown) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n"); };
  const waiting = new Map<string, { request: string; input: unknown }>();
  let finished = false;
  let stopped = false;
  let stderr = "";
  const finish = (ok: boolean, error?: string) => {
    if (finished) return;
    finished = true;
    emit({ t: "done", ok, ...(error ? { error } : {}) });
    if (child.stdin.writable) child.stdin.end();
    setTimeout(() => child.kill(), 500);
  };
  child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-2000); });
  child.on("error", (error) => finish(false, "Claude Code를 실행하지 못했습니다: " + error.message));
  child.on("exit", (code) => finish(false, stopped ? "멈췄습니다" : "Claude Code가 답을 끝내기 전에 닫혔습니다 (" + code + ") " + tail(stderr)));
  // a picture is handed over as it is, before the words that are about it
  const pictures: unknown[] = [];
  for (const image of along.images ?? []) {
    try {
      pictures.push({ type: "image", source: { type: "base64", media_type: image.type, data: readFileSync(image.path).toString("base64") } });
    } catch { /* it went away since it was kept: the words go without it */ }
  }
  send({ type: "user", message: { role: "user", content: [...pictures, { type: "text", text: prompt }] } });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event ?? {};
      if (message.parent_tool_use_id) return; // a subagent's own words are not this talk's
      if (event.type === "content_block_start" && event.content_block?.type === "text") emit({ t: "break" });
      else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") emit({ t: "text", d: event.delta.text });
    } else if (message.type === "assistant") {
      if (message.parent_tool_use_id) return;
      for (const block of message.message?.content ?? []) if (block?.type === "tool_use") emit(claudeStep(String(block.name), block.input ?? {}, session.cwd));
    } else if (message.type === "control_request") {
      const request = message.request ?? {};
      if (request.subtype !== "can_use_tool") return send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "not handled" } });
      const id = randomUUID();
      waiting.set(id, { request: message.request_id, input: request.input ?? {} });
      const step = claudeStep(String(request.tool_name), request.input ?? {}, session.cwd);
      const title = step.kind === "change" ? "파일을 고쳐도 될까요?" : step.kind === "command" ? "이 명령을 실행해도 될까요?" : "이 도구를 써도 될까요?";
      emit({ t: "ask", id, title, detail: cut(claudeAsk(String(request.tool_name), request.input ?? {}, session.cwd), 1500) });
    } else if (message.type === "result") {
      finish(!message.is_error, message.is_error ? cut(typeof message.result === "string" ? message.result : message.subtype, 300) : undefined);
    }
  });
  return {
    answer(id, allow) {
      const held = waiting.get(id);
      if (!held) return false;
      waiting.delete(id);
      const response = allow ? { behavior: "allow", updatedInput: held.input } : { behavior: "deny", message: "사용자가 거절했습니다" };
      send({ type: "control_response", response: { subtype: "success", request_id: held.request, response } });
      emit({ t: "answered", id, allow });
      return true;
    },
    stop() {
      stopped = true;
      child.kill("SIGINT");
      setTimeout(() => finish(false, "멈췄습니다"), 1500);
    },
  };
}

/** Start one turn in a session. The turn runs on whether or not anything listens. */
export function startTurn(session: Session, prompt: string, along: Along = {}): Turn {
  const where = { id: session.id, fresh: false, cwd: session.cwd, recordPath: session.recordPath, model: session.model };
  return begin(session.id, prompt, (emit) => (session.client === "codex" ? runCodex(where, prompt, along, emit, () => {}) : runClaude(where, prompt, along, emit)));
}

/** Begin a new session with a first request. ready: the new session's id, once the client has given it one; it fails
 *  with the reason when the client would not begin. */
export function startNew(fresh: Fresh, prompt: string, along: Along = {}): { turn: Turn; ready: Promise<string> } {
  const like = fresh.like?.client === fresh.client ? fresh.like : null;
  const where = { fresh: true, cwd: fresh.cwd, recordPath: like?.recordPath ?? null, model: like?.model ?? null };
  if (fresh.client === "claude") {
    const id = randomUUID(); // Claude Code takes the id it is given
    const turn = begin(id, prompt, (emit) => runClaude({ ...where, id }, prompt, along, emit));
    return { turn, ready: Promise.resolve(id) };
  }
  let name: (id: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const ready = new Promise<string>((resolve, reject) => { name = resolve; fail = reject; });
  ready.catch(() => {}); // whoever waits for it hears of the failure; nobody waiting is no error
  const turn: Turn = begin("", prompt, (emit) => runCodex({ ...where, id: null }, prompt, along, emit, (id) => { turn.sessionId = id; name(id); }));
  const quit = turn.listen((event) => {
    if (event.t !== "done") return;
    quit();
    if (!turn.sessionId) fail(new Error(event.error ?? "새 세션을 시작하지 못했습니다"));
  });
  return { turn, ready };
}

/** Begin a session that is another one as it stood before one of its requests, with a request of its own in that
 *  one's place. The other stays as it is: nothing is taken out of its record. point: the session to fork and the
 *  last turn of it that is kept (Codex: the turn's id; Claude Code: the id of the record of the last answer). For a
 *  Codex thread that is itself a fork it may name the thread that one came from. Null when nothing is kept: the new
 *  session is then simply one that runs like the other. */
export function startFork(session: Session, point: { from: string; at: string } | null, prompt: string, along: Along = {}): { turn: Turn; ready: Promise<string> } {
  if (point === null) return startNew({ client: session.client, cwd: session.cwd, like: session }, prompt, along);
  const where = { fresh: true, cwd: session.cwd, recordPath: session.recordPath, model: session.model, fork: point };
  if (session.client === "claude") {
    const id = randomUUID();
    const turn = begin(id, prompt, (emit) => runClaude({ ...where, id }, prompt, along, emit));
    return { turn, ready: Promise.resolve(id) };
  }
  let name: (id: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const ready = new Promise<string>((resolve, reject) => { name = resolve; fail = reject; });
  ready.catch(() => {});
  const turn: Turn = begin("", prompt, (emit) => runCodex({ ...where, id: null }, prompt, along, emit, (id) => { turn.sessionId = id; name(id); }));
  const quit = turn.listen((event) => {
    if (event.t !== "done") return;
    quit();
    if (!turn.sessionId) fail(new Error(event.error ?? "세션을 갈라 내지 못했습니다"));
  });
  return { turn, ready };
}

function begin(sessionId: string, prompt: string, run: (emit: Emit) => Runner): Turn {
  const hearers = new Set<(event: TurnEvent) => void>();
  let runner: Runner | null = null;
  const turn: Turn = {
    id: randomUUID(),
    sessionId,
    events: [],
    done: false,
    endedAt: 0,
    listen(hear) {
      hearers.add(hear);
      return () => { hearers.delete(hear); };
    },
    answer: (id, allow) => runner?.answer(id, allow) ?? false,
    stop: () => runner?.stop(),
  };
  const emit: Emit = (event) => {
    if (turn.done) return;
    turn.events.push(event);
    if (event.t === "done") {
      turn.done = true;
      turn.endedAt = Date.now();
    }
    for (const hear of hearers) hear(event);
  };
  emit({ t: "prompt", text: prompt });
  runner = run(emit);
  return turn;
}

/** A model that can be chosen for a client. */
export interface ModelChoice { id: string; name: string }

let codexModels: { at: number; list: ModelChoice[] } | null = null;

/** The models a client offers, as far as it will say. Codex is asked (its app server lists them); Claude Code takes
 *  the short names of its newest models. What the sessions themselves were seen to run on is added by the screen.
 *  Never fails: a client that does not answer offers nothing. */
export async function listModels(client: Client): Promise<ModelChoice[]> {
  if (client === "claude") return ["opus", "sonnet", "haiku"].map((id) => ({ id, name: id }));
  if (codexModels && Date.now() - codexModels.at < 10 * 60_000) return codexModels.list;
  const list = await new Promise<ModelChoice[]>((resolve) => {
    const child = spawn(codexBin(), ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    const done = (found: ModelChoice[]) => { clearTimeout(late); child.kill(); resolve(found); };
    const late = setTimeout(() => done([]), 8000);
    const send = (message: unknown) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n"); };
    child.on("error", () => done([]));
    child.on("exit", () => done([]));
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "context-flow", title: "context flow", version: "0.0.1" } } });
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0) {
        send({ method: "initialized", params: {} });
        send({ id: 1, method: "model/list", params: {} });
      } else if (message.id === 1) {
        const data = Array.isArray(message.result?.data) ? message.result.data : [];
        done(data.filter((one: any) => one && typeof one.model === "string" && !one.hidden).map((one: any) => ({ id: one.model, name: typeof one.displayName === "string" && one.displayName ? one.displayName : one.model })));
      }
    });
  });
  if (list.length) codexModels = { at: Date.now(), list };
  return list;
}
