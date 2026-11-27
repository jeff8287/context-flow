// Made-up records only: nothing here reads the user's own sessions.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { answer, makeBundle, maskBundle, readBundle } from "../src/bundle.ts";
import { folderName, readClaudeSessions, stoodBefore } from "../src/claude.ts";
import { freshPlan } from "../src/fresh.ts";
import { applyRollout, forkPoint, keptTurn, readCodexThreads, readRollout, recordFiles, type RecordFiles } from "../src/codex.ts";
import { hookStates } from "../src/hooks.ts";
import { serve } from "../src/server.ts";
import { farLinks, FILES_NOTE, filesIn, filesNote, forkedBefore, overlaps, pieceBlock, recordedLinks, transferLinks, withBlocks, withoutPieces, withPieces, type Kept } from "../src/links.ts";
import { readClaudeLive, settleActivity, type ClaudeLive, type Live } from "../src/live.ts";
import type { Item, Place, Project, Session, Snapshot, Transfer } from "../src/model.ts";
import { flat, forgetPastes, pasteLinks } from "../src/paste.ts";
import { forgetPictures, picturesOf } from "../src/pictures.ts";
import { folderProjects, forgetProjects, projectFor, readProjects } from "../src/projects.ts";
import { tracePiece } from "../src/trace.ts";
import { goneOf, talkOf } from "../src/read.ts";
import { LABEL, servicePath, servicePlist } from "../src/service.ts";
import { buildSnapshot, findProjects, nearestProject, waitingOf } from "../src/snapshot.ts";
import { standalonePage } from "../src/standalone.ts";
import { appendTransfers, dropPending, keepFolder, queuePieces, readBasket, readPending, readTransfers, saveUploads, takePending, tidyStore, uploadedFile, writeBasket, type Pending } from "../src/store.ts";
import { startNew, type Turn } from "../src/talk.ts";
import { typed } from "../src/util.ts";
import { grown, Interest } from "../src/watch.ts";

const scratchDir = mkdtempSync(join(tmpdir(), "context-flow-test-"));
const line = (value: unknown) => JSON.stringify(value) + "\n";
const session = (id: string, more: Partial<Session> = {}): Session => ({
  id, client: "codex", projectId: "p", cwd: "/work/app", title: id, model: null, startedAt: 1000, updatedAt: 1000, origin: "user", parentId: null,
  activity: "idle", nowFile: null, recordPath: null, counts: { prompts: 0, answers: 0, changes: 0 }, ...more,
});

test("what the client wraps around a prompt is not what the user typed", () => {
  assert.equal(typed("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>\n<note a=\"1\">y</note>\n이 줄만 남는다"), "이 줄만 남는다");
  assert.equal(typed("a < b 인 경우를 고쳐줘"), "a < b 인 경우를 고쳐줘");
});

test("a Codex rollout gives prompts, answers and one change per file, and says where it was forked from", async () => {
  const path = join(scratchDir, "rollout.jsonl");
  const item = (at: string, turn: string, body: unknown) => line({ timestamp: at, type: "event_msg", payload: { type: "item_completed", turn_id: turn, completed_at_ms: Date.parse(at), item: body } });
  writeFileSync(path,
    line({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "child", forked_from_id: "parent" } }) +
    line({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }) +
    item("2026-01-01T00:00:02Z", "t1", { type: "UserMessage", content: [{ type: "text", text: "<ctx>앞에 붙은 것</ctx>\n합계를 고쳐줘" }] }) +
    item("2026-01-01T00:00:03Z", "t1", { type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text: "살펴보는 중" }] }) +
    item("2026-01-01T00:00:04Z", "t1", { type: "FileChange", status: "completed", changes: { "/work/app/a.py": { type: "update", unified_diff: "@@\n-x\n+y" }, "/work/app/b.py": { type: "add", content: "새 파일" } } }) +
    item("2026-01-01T00:00:05Z", "t1", { type: "AgentMessage", content: [{ type: "Text", text: "고쳤습니다" }] }) +
    line({ timestamp: "2026-01-01T00:00:06Z", type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } }) +
    line({ timestamp: "2026-01-01T00:00:07Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "이 줄은 모델에 보낸 사본이라 세지 않는다" }] } }));
  const rollout = await readRollout("child", path);
  assert.ok(rollout);
  assert.deepEqual(rollout.items.map((entry) => entry.kind), ["prompt", "answer", "change", "change", "answer"]);
  assert.equal(rollout.items[0].text, "합계를 고쳐줘");
  assert.deepEqual(rollout.items.filter((entry) => entry.kind === "change").map((entry) => entry.path), ["/work/app/a.py", "/work/app/b.py"]);
  assert.deepEqual(rollout.items.filter((entry) => entry.kind === "answer").map((entry) => Boolean(entry.final)), [false, true]);
  assert.equal(rollout.open, false);
  assert.equal(rollout.base, null); // this record does not say how far into its parent's its history goes
  const made = session("child");
  applyRollout(made, rollout, Date.parse("2026-01-01T00:10:00Z"));
  assert.deepEqual([made.origin, made.parentId, made.activity, made.counts.changes], ["fork", "parent", "waiting", 2]);
});

test("an older Codex rollout, which has no item records, is read from its message events", async () => {
  const path = join(scratchDir, "older.jsonl");
  const event = (at: string, payload: unknown) => line({ timestamp: at, type: "event_msg", payload });
  writeFileSync(path, line({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "old", history_mode: "legacy" } }) +
    event("2026-01-01T00:00:01Z", { type: "user_message", message: "요약해줘" }) + event("2026-01-01T00:00:02Z", { type: "agent_message", message: "읽는 중" }) +
    event("2026-01-01T00:00:03Z", { type: "agent_message", message: "요약입니다" }) + event("2026-01-01T00:00:04Z", { type: "task_complete" }));
  const rollout = await readRollout("old", path);
  assert.deepEqual(rollout?.items.map((entry) => [entry.id, entry.kind, Boolean(entry.final)]), [["old:0", "prompt", false], ["old:1", "answer", false], ["old:2", "answer", true]]);
});

test("a Claude Code transcript gives the same shapes, and a subagent hangs off its session", async () => {
  const home = join(scratchDir, "claude");
  const cwd = "/work/app";
  const dir = join(home, "projects", folderName(cwd));
  mkdirSync(join(dir, "s1", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"),
    line({ type: "user", uuid: "u1", cwd, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "표를 만들어줘" } }) +
    line({ type: "attachment", uuid: "x1", parentUuid: "u1", cwd, timestamp: "2026-01-01T00:00:00Z", attachment: { type: "total_tokens_reminder", content: "…" } }) +
    line({ type: "attachment", uuid: "x2", parentUuid: "x1", cwd, timestamp: "2026-01-01T00:00:00Z", attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit", content: ["(실어 보낸 맥락)\n\n" + pieceBlock({ id: "cf555", from: "‘a’ (Codex)", kind: "답변", text: "TOTAL" })] } }) +
    line({ type: "assistant", cwd, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "m", stop_reason: "tool_use", content: [{ type: "text", text: "파일을 고칩니다" }, { type: "tool_use", name: "Edit", input: { file_path: "/work/app/a.py" } }] } }) +
    line({ type: "user", cwd, timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] }, toolUseResult: { filePath: "/work/app/a.py", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }] } }) +
    line({ type: "assistant", cwd, timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "끝났습니다" }] } }) +
    line({ type: "assistant", isSidechain: true, cwd, timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "서브에이전트의 말은 여기서 세지 않는다" }] } }));
  writeFileSync(join(dir, "s1", "subagents", "agent-a1.jsonl"),
    line({ type: "user", isSidechain: true, cwd, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "a.py를 읽어줘" } }) +
    line({ type: "assistant", isSidechain: true, cwd, timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "읽었습니다" }] } }));
  const project: Project = { id: "p", name: "app", roots: [cwd] };
  const { transcripts } = await readClaudeSessions(project, home, Date.parse("2026-01-03T00:00:00Z"));
  assert.deepEqual(transcripts.map((entry) => [entry.session.id, entry.session.origin, entry.session.parentId]), [["s1", "user", null], ["s1~a1", "subagent", "s1"]]);
  assert.deepEqual(transcripts[0].items.map((entry) => entry.kind), ["prompt", "answer", "change", "answer"]);
  assert.deepEqual(transcripts[0].items.map((entry) => Boolean(entry.added?.includes('<context-piece id="cf555"'))), [true, false, false, false]); // what a hook put with the prompt
  assert.match(transcripts[0].items[2].text, /^--- \/work\/app\/a\.py\n\+\+\+ \/work\/app\/a\.py\n@@ -1,1 \+1,1 @@\n-x\n\+y$/);
  assert.equal(transcripts[0].session.activity, "idle");
});

test("a parent outside the project is counted, not drawn", () => {
  const { links, outside } = recordedLinks([session("a"), session("b", { origin: "fork", parentId: "a", startedAt: 5000 }), session("c", { origin: "subagent", parentId: "elsewhere" })]);
  assert.deepEqual(links.map((link) => [link.kind, link.from.sessionId, link.to.sessionId, link.to.at]), [["fork", "a", "b", 5000]]);
  assert.equal(outside, 1);
});

test("a file is an overlap only when two sessions changed it; a burst of changes is one touch", () => {
  const change = (sessionId: string, at: number, path: string, n: number): Item => ({ id: sessionId + ":" + n, sessionId, turnId: null, kind: "change", at, text: "", path });
  const minute = 60_000;
  const found = overlaps([change("a", 0, "/work/app/x.py", 0), change("a", 5 * minute, "/work/app/x.py", 1), change("a", 50 * minute, "/work/app/x.py", 2), change("b", 10 * minute, "/work/app/x.py", 0),
    change("a", 0, "/work/app/only-a.py", 3), change("a", 0, "/private/tmp/note.txt", 4), change("b", 0, "/private/tmp/note.txt", 1)], { id: "p", name: "app", roots: ["/work/app"] });
  assert.deepEqual(found.map((entry) => entry.path), ["x.py"]);
  assert.deepEqual(found[0].touches.map((touch) => touch.itemId), ["a:0", "b:0", "a:2"]);
});

test("a piece that was sent is a link only once the receiving session's record holds its mark", () => {
  const said: Item = { id: "a:1", sessionId: "a", turnId: null, kind: "answer", at: 50, text: "합계는 TOTAL에 있고 지금 7입니다" };
  const transfer: Transfer = { id: "cf123", at: 90, from: { sessionId: "a", itemId: "a:1", start: 4, end: 9 }, to: { sessionId: "b" }, text: "TOTAL" };
  const message = withPieces("이 값을 9로 바꿔줘", [{ id: "cf123", from: "‘a\"의 세션’ (Codex)", kind: "답변", text: "TOTAL" }]);
  assert.ok(message.startsWith("이 값을 9로 바꿔줘\n"));
  assert.equal(typed(message), message); // what the person typed stays first, so stripping the client's wrapping leaves the message whole
  assert.ok(message.includes('<context-piece id="cf123" from="‘a 의 세션’ (Codex)" kind="답변">\nTOTAL\n</context-piece>'));
  assert.equal(withPieces("그대로", []), "그대로");
  assert.equal(withoutPieces(message), "이 값을 9로 바꿔줘"); // a session is named after what was typed, not after a piece
  assert.equal(withoutPieces(withPieces("", [{ id: "cf1", from: "a", kind: "답변", text: "TOTAL" }])), "");
  assert.equal(withoutPieces("조각이 없는 말"), "조각이 없는 말");
  assert.deepEqual(transferLinks([transfer], [said]), []); // sent, but in no record yet: nothing to draw
  const got: Item = { id: "b:4", sessionId: "b", turnId: null, kind: "prompt", at: 100, text: message };
  const links = transferLinks([transfer, { ...transfer, id: "cf999" }], [said, got]);
  assert.equal(links.length, 1);
  const [link] = links;
  assert.deepEqual([link.id, link.kind, link.grade, link.from.sessionId, link.from.itemId, link.from.start, link.from.end, link.from.at, link.to.sessionId, link.to.itemId, link.to.at, link.chars, link.excerpt],
    ["transfer:cf123", "transfer", "recorded", "a", "a:1", 4, 9, 50, "b", "b:4", 100, 5, "TOTAL"]);
});

test("a piece set to wait goes with the next prompt of its session, once, and is then a transfer", () => {
  const home = join(scratchDir, "flow-home");
  process.env.CONTEXT_FLOW_HOME = home;
  const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin", "context-flow", "hooks", "along.sh");
  const say = (session: string, event = "UserPromptSubmit") => spawnSync("sh", [hook], {
    input: JSON.stringify({ session_id: session, hook_event_name: event, prompt: "이어서 해줘", cwd: "/work/app" }),
    env: { ...process.env, CONTEXT_FLOW_HOME: home, CONTEXT_FLOW_NODE: process.execPath }, encoding: "utf8",
  });
  assert.equal(say("b").stdout, ""); // nothing was ever set to wait: not even the folder is there
  const row = (id: string, at: number, to: string, text: string): Pending => ({ id, at, from: { sessionId: "a", itemId: "a:1", start: 0, end: text.length }, to: { sessionId: to }, text, block: pieceBlock({ id, from: "‘a’ (Codex)", kind: "답변", text }) });
  queuePieces([row("cf2", 20, "b", "둘째 조각"), row("cf1", 10, "b", "첫째 조각"), row("cf3", 30, "c", "다른 세션의 것"), row("cf4", 40, "b", "거둔 조각")]);
  assert.deepEqual(readPending().map((one) => one.id), ["cf1", "cf2", "cf3", "cf4"]);
  assert.throws(() => queuePieces([row("cf5", 50, "../elsewhere", "x")]));
  assert.equal(dropPending("b", "cf4"), true);
  assert.equal(dropPending("b", "cf4"), false);
  assert.equal(say("nobody").stdout, "");
  assert.equal(say("b", "SessionStart").stdout, ""); // only a prompt carries pieces
  assert.equal(readPending().length, 3);
  const out = JSON.parse(say("b").stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const added: string = out.hookSpecificOutput.additionalContext;
  assert.ok(added.indexOf('<context-piece id="cf1"') < added.indexOf('<context-piece id="cf2"')); // in the order they were set
  assert.ok(added.includes("\n첫째 조각\n</context-piece>") && !added.includes("cf3") && !added.includes("cf4"));
  assert.deepEqual(readTransfers().map((one) => [one.id, one.to.sessionId, one.via, one.text]), [["cf1", "b", "hook", "첫째 조각"], ["cf2", "b", "hook", "둘째 조각"]]);
  assert.deepEqual(readPending().map((one) => one.id), ["cf3"]);
  assert.equal(existsSync(join(home, "pending", "b")), false);
  assert.equal(say("b").stdout, ""); // taken once
  assert.deepEqual(readdirSync(join(home, "pending", "c")), ["cf3.json"]);
  // Claude Code cuts what a hook adds once it is over 10,000 characters: a piece too long goes in part, its marks whole, the rest in a file
  const long = "가나다라마바사아자차".repeat(1200);
  queuePieces([row("cf6", 60, "d", "짧은 조각"), row("cf7", 70, "d", long)]);
  const cut: string = JSON.parse(spawnSync("sh", [hook], { input: JSON.stringify({ session_id: "d", hook_event_name: "UserPromptSubmit", transcript_path: "/home/someone/.claude/projects/x/d.jsonl" }),
    env: { ...process.env, CONTEXT_FLOW_HOME: home, CONTEXT_FLOW_NODE: process.execPath }, encoding: "utf8" }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(cut.length <= 9000 && cut.length > 8000, String(cut.length));
  assert.ok(cut.includes("\n짧은 조각\n</context-piece>") && cut.includes('<context-piece id="cf7"') && cut.endsWith("</context-piece>"));
  assert.match(cut, /…\(이 조각은 12000자 가운데 앞의 \d+자만 실었습니다\. 전체는 다음 파일에 있습니다: .*pieces\/cf7\.txt\)\n<\/context-piece>$/);
  assert.equal(readFileSync(join(home, "pieces", "cf7.txt"), "utf8"), long);
  assert.equal(readTransfers().find((one) => one.id === "cf7")?.text, long); // what is kept is the whole piece
  queuePieces([row("cf8", 80, "e", long)]); // Codex, known by the name of its record, takes it whole
  const whole: string = JSON.parse(spawnSync("sh", [hook], { input: JSON.stringify({ session_id: "e", hook_event_name: "UserPromptSubmit", transcript_path: "/home/someone/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-e.jsonl" }),
    env: { ...process.env, CONTEXT_FLOW_HOME: home, CONTEXT_FLOW_NODE: process.execPath }, encoding: "utf8" }).stdout).hookSpecificOutput.additionalContext;
  assert.ok(whole.includes("\n" + long + "\n</context-piece>"));
  delete process.env.CONTEXT_FLOW_HOME;
});

test("what a hook put with a prompt is read beside it in a Codex rollout, and ties the piece to that prompt", async () => {
  const path = join(scratchDir, "hooked.jsonl");
  const item = (at: string, turn: string, body: unknown) => line({ timestamp: at, type: "event_msg", payload: { type: "item_completed", turn_id: turn, completed_at_ms: Date.parse(at), item: body } });
  const block = pieceBlock({ id: "cf777", from: "‘a’ (Codex)", kind: "답변", text: "TOTAL" });
  const developer = (at: string, turn: string | null, text: string) => line({ timestamp: at, type: "response_item", payload: { type: "message", id: "m", role: "developer", content: [{ type: "input_text", text }],
    ...(turn ? { internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["hooks.additional_context"] } } : {}) } });
  writeFileSync(path,
    item("2026-01-01T00:00:02Z", "t1", { type: "UserMessage", content: [{ type: "text", text: "첫 요청" }] }) +
    developer("2026-01-01T00:00:02Z", "t1", "조각과 상관없는 안내문") +
    item("2026-01-01T00:00:03Z", "t1", { type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text: "답" }] }) +
    developer("2026-01-01T00:00:09Z", "t2", "(실어 보낸 맥락)\n\n" + block) + // written before the prompt of its turn: the turn says where it belongs
    item("2026-01-01T00:00:10Z", "t2", { type: "UserMessage", content: [{ type: "text", text: "이 값을 9로" }] }) +
    line({ timestamp: "2026-01-01T00:00:11Z", type: "response_item", payload: { type: "function_call_output", output: "기록을 읽다 나온 글: " + block } }) +
    item("2026-01-01T00:00:12Z", "t3", { type: "UserMessage", content: [{ type: "text", text: "셋째 요청" }] }) +
    developer("2026-01-01T00:00:12Z", null, pieceBlock({ id: "cf888", from: "‘a’ (Codex)", kind: "요청", text: "턴 표시 없이 온 것" })));
  const rollout = await readRollout("b", path);
  assert.ok(rollout);
  assert.deepEqual(rollout.items.map((entry) => [entry.text, entry.added?.includes("cf777") ?? null, entry.added?.includes("cf888") ?? null]), [["첫 요청", null, null], ["답", null, null], ["이 값을 9로", true, false], ["셋째 요청", false, true]]);
  const said: Item = { id: "a:1", sessionId: "a", turnId: null, kind: "answer", at: 50, text: "합계는 TOTAL에 있다" };
  const transfer: Transfer = { id: "cf777", at: 90, from: { sessionId: "a", itemId: "a:1", start: 4, end: 9 }, to: { sessionId: "b" }, text: "TOTAL", via: "hook" };
  const links = transferLinks([transfer], [said, ...rollout.items]);
  assert.deepEqual(links.map((link) => [link.id, link.to.itemId, link.to.at]), [["transfer:cf777", "b:2", Date.parse("2026-01-01T00:00:10Z")]]);
});

test("a waiting piece is marked missed when its session was spoken to afterwards", () => {
  const prompt = (sessionId: string, at: number): Item => ({ id: sessionId + ":" + at, sessionId, turnId: null, kind: "prompt", at, text: "말" });
  const row = (id: string, at: number, to: string): Pending => ({ id, at, from: { sessionId: "a", itemId: "a:1", start: 0, end: 2 }, to: { sessionId: to }, text: "조각", block: "" });
  const found = waitingOf([row("w1", 10_000, "b"), row("w2", 60_000, "b"), row("w3", 10_000, "gone")], [session("a"), session("b")], [prompt("b", 5_000), prompt("b", 40_000), prompt("a", 90_000)]);
  assert.deepEqual(found.map((one) => [one.id, one.missed, one.chars]), [["w1", true, 2], ["w2", false, 2]]);
});

test("the hook is ready in Codex only once it is installed and approved", () => {
  const codex = join(scratchDir, "codex-home");
  const claude = join(scratchDir, "claude-home");
  assert.deepEqual(hookStates(codex, claude), { codex: "absent", claude: "absent" });
  mkdirSync(join(codex, "plugins", "cache", "some-market", "context-flow", "0.1.0"), { recursive: true });
  writeFileSync(join(codex, "config.toml"), '[hooks.state."other@market:hooks/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "x"\n');
  assert.equal(hookStates(codex, claude).codex, "untrusted");
  writeFileSync(join(codex, "config.toml"), '[plugins."context-flow@some-market"]\nenabled = true\n\n[hooks.state."context-flow@some-market:hooks/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "x"\n');
  mkdirSync(join(claude, "plugins"), { recursive: true });
  writeFileSync(join(claude, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "context-flow@context-flow": [{}] } }));
  assert.deepEqual(hookStates(codex, claude), { codex: "ready", claude: "ready" });
});

// ---------- pastes and following a piece ----------

const SAID = "합계는 `TOTAL`에 있고 **지금 7**입니다. 이 값을 9로 바꾸려면 tally.py의 첫 줄만 고치면 되고, 다른 파일은 건드리지 않아도 됩니다.\n- 고친 뒤에는 시험을 다시 돌려 주세요.";
// the same words as they read on a screen, where the marks are gone
const SHOWN = "합계는 TOTAL에 있고 지금 7입니다. 이 값을 9로 바꾸려면 tally.py의 첫 줄만 고치면 되고, 다른 파일은 건드리지 않아도 됩니다.\n고친 뒤에는 시험을 다시 돌려 주세요.";
const say = (sessionId: string, n: number, kind: Item["kind"], at: number, text: string, more: Partial<Item> = {}): Item => ({ id: sessionId + ":" + n, sessionId, turnId: null, kind, at, text, ...more });

test("text is flattened to what a screen shows, and each letter keeps its place", () => {
  const made = flat(SAID, "answer");
  assert.equal(made.text, flat(SHOWN, "prompt").text);
  assert.equal(SAID[made.raw[made.text.indexOf("TOTAL")]], "T");
  assert.equal(flat("--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-TOTAL = 7\n+TOTAL = 9\n print(TOTAL)", "change").text, "TOTAL = 7 TOTAL = 9 print(TOTAL)");
  assert.equal(flat("[이 글](https://example.com/a_b)을 보고\n1. 첫째\n2. 둘째", "answer").text, "이 글을 보고 첫째 둘째");
});

test("a paste is what a person typed that another session had said before; its grounds are the stretches that match", () => {
  forgetPastes();
  const sessions = [session("a"), session("b"), session("f", { origin: "fork", parentId: "a" }), session("sub", { origin: "subagent", parentId: "b" })];
  const items = [
    say("a", 0, "prompt", 10, "합계가 어디 있어?"),
    say("a", 1, "answer", 20, SAID),
    say("b", 0, "prompt", 30, "아래대로 해줘.\n\n" + SHOWN + "\n\n끝나면 알려줘."),
    say("a", 2, "prompt", 40, SHOWN), // the same session: nothing moved
    say("f", 0, "prompt", 50, SHOWN), // a fork began with all its parent had said
    say("sub", 0, "prompt", 60, SHOWN), // handed to a subagent by an agent, not typed
    say("b", 1, "prompt", 15, SHOWN.slice(0, 60) + " 뒤는 내가 지어 쓴 말"), // too little, and before the answer was given
  ];
  const links = pasteLinks(items, sessions);
  assert.deepEqual(links.map((link) => [link.id, link.grade, link.kind]), [["paste:a:1>b:0", "paste", "paste"]]);
  const [link] = links;
  const got = items[2].text.slice(link.to.start, link.to.end);
  assert.ok(got.startsWith("합계는 TOTAL에 있고") && got.endsWith("다시 돌려 주세요."), got);
  const from = SAID.slice(link.from.start, link.from.end);
  assert.ok(from.startsWith("합계는 `TOTAL`에") && from.endsWith("다시 돌려 주세요."), from);
  assert.equal(link.chars, flat(SHOWN, "prompt").text.length);
  assert.deepEqual([link.from.at, link.to.at, link.parts?.length], [20, 30, 1]);
  assert.deepEqual(pasteLinks(items, sessions).map((one) => one.id), ["paste:a:1>b:0"]); // kept, and the same when asked again
});

test("what an agent only said back, what everybody says, and what was said later are not pastes; a change to a file can be one", () => {
  forgetPastes();
  const typed = "보고서의 첫 문단은 결론부터 쓰고, 근거가 되는 측정값은 표로 모으고, 추정과 측정을 문장마다 구분해서 적어 주세요. 그림은 다시 그리지 말고요.";
  const license = "이 파일은 시험용으로 지어낸 것이며 어떤 실제 기록도 담고 있지 않습니다. 그대로 두거나 지워도 됩니다. 고치지 않아도 됩니다.";
  const names = ["e", "g", "h", "s1", "s2", "s3", "s4", "s5", "w", "x"];
  const sessions = names.map((id) => session(id));
  const diff = "--- a/report.md\n+++ b/report.md\n@@ -1,2 +1,3 @@\n-옛 문장\n+새 측정에서는 열여섯 개 코어를 모두 쓸 때 지연 시간이 절반 아래로 내려갔고,\n+에너지는 한 번 실행에 사 줄 남짓 줄었습니다. 표 3에 값을 모았습니다.";
  const items = [
    say("e", 0, "prompt", 5, typed), // typed by the person first
    say("e", 1, "answer", 6, "말씀하신 대로 하겠습니다: " + typed), // the agent says it back
    say("g", 0, "prompt", 50, typed), // typed again elsewhere: the words are the person's own
    ...["s1", "s2", "s3", "s4", "s5"].map((id, n) => say(id, 0, "answer", 7 + n, license)),
    say("h", 0, "prompt", 60, license), // in five sessions' answers: nothing says which it came from
    say("w", 0, "change", 70, diff, { path: "/work/app/report.md" }),
    say("x", 0, "prompt", 80, "이 부분 다시 봐줘: 새 측정에서는 열여섯 개 코어를 모두 쓸 때 지연 시간이 절반 아래로 내려갔고, 에너지는 한 번 실행에 사 줄 남짓 줄었습니다. 표 3에 값을 모았습니다."),
    say("w", 1, "prompt", 65, "새 측정에서는 열여섯 개 코어를 모두 쓸 때 지연 시간이 절반 아래로 내려갔고, 에너지는 한 번 실행에 사 줄 남짓 줄었습니다."), // before the change
  ];
  const links = pasteLinks(items, sessions);
  assert.deepEqual(links.map((link) => link.id), ["paste:w:0>x:0"]);
  assert.ok(diff.slice(links[0].from.start, links[0].from.end).startsWith("새 측정에서는"));
});

test("a piece is followed back to where its text first appeared and onward to where it went", () => {
  forgetPastes();
  const sessions = [session("a", { startedAt: 1 }), session("b", { startedAt: 2 }), session("c", { startedAt: 3 }), session("f", { origin: "fork", parentId: "a", startedAt: 45 }), session("z", { startedAt: 4 })];
  const restated = "정리하면, " + SHOWN.slice(0, 70) + " 그래서 한 줄만 바꾸면 됩니다.";
  const transfer: Transfer = { id: "cf42", at: 60, from: { sessionId: "b", itemId: "b:1", start: 0, end: restated.length }, to: { sessionId: "c" }, text: restated };
  const items = [
    say("a", 0, "prompt", 10, "합계가 어디 있어?"),
    say("a", 1, "answer", 20, SAID),
    say("b", 0, "prompt", 30, "아래대로 해줘.\n\n" + SHOWN),
    say("b", 1, "answer", 40, restated),
    say("c", 0, "prompt", 61, withPieces("이걸 참고해", [{ id: "cf42", from: "‘b’ (Codex)", kind: "답변", text: restated }])),
    say("z", 0, "answer", 5, "상관없는 말"),
  ];
  const bodies = new Map(items.map((item) => [item.id, item]));
  const links = [...recordedLinks(sessions).links, ...transferLinks([transfer], items), ...pasteLinks(items, sessions)];
  assert.deepEqual(links.map((link) => link.id).sort(), ["fork:a>f", "paste:a:1>b:0", "transfer:cf42"]);
  // from the piece that went to c: it came into b from a, and it went on to c
  const mid = tracePiece({ sessionId: "b", itemId: "b:1", start: 0, end: restated.length }, links, bodies, sessions);
  assert.deepEqual(mid.map((step) => [step.dir, step.depth, step.link.id]), [["back", 1, "paste:a:1>b:0"], ["onward", 1, "transfer:cf42"]]);
  // from where it was first said: to b by a paste, on to c by a piece, and into the fork that began afterwards
  const first = tracePiece({ sessionId: "a", itemId: "a:1", start: 0, end: SAID.length }, links, bodies, sessions);
  assert.deepEqual(first.map((step) => [step.dir, step.depth, step.link.id]), [["onward", 1, "paste:a:1>b:0"], ["onward", 2, "transfer:cf42"], ["onward", 1, "fork:a>f"]]);
  // from where it ended up: all the way back
  const last = tracePiece({ sessionId: "c", itemId: "c:0", start: 0, end: items[4].text.length }, links, bodies, sessions);
  assert.deepEqual(last.map((step) => [step.dir, step.depth, step.link.id]), [["back", 1, "transfer:cf42"], ["back", 2, "paste:a:1>b:0"]]);
  assert.deepEqual(tracePiece({ sessionId: "z", itemId: "z:0", start: 0, end: 6 }, links, bodies, sessions), []);
});

// ---------- exporting for an experiment ----------

/** A made-up project: a said something, b pasted it and has a subagent, f forked off a, c stands apart; a, b and c changed one file. */
function madeUp(): { snapshot: Snapshot; bodies: Map<string, Item> } {
  forgetPastes();
  const sessions = [session("a", { startedAt: 1, recordPath: "/home/someone/.codex/sessions/a.jsonl" }), session("b", { startedAt: 2 }), session("c", { startedAt: 3 }),
    session("f", { origin: "fork", parentId: "a", startedAt: 45 }), session("sub", { origin: "subagent", parentId: "b", startedAt: 35 })];
  const items = [
    say("a", 0, "prompt", 10, "합계가 어디 있어?"),
    say("a", 1, "answer", 20, SAID),
    say("a", 2, "change", 21, "@@\n-TOTAL = 7\n+TOTAL = 9", { path: "/work/app/x.py" }),
    say("b", 0, "prompt", 30, "아래대로 해줘.\n\n" + SHOWN),
    say("b", 1, "change", 31, "@@\n-a\n+b", { path: "/work/app/x.py" }),
    say("sub", 0, "prompt", 36, "tally.py를 읽어줘"),
    say("sub", 1, "answer", 37, "읽었습니다 </script><b>$& 그대로"),
    say("f", 0, "prompt", 50, "갈라진 뒤의 요청"),
    say("c", 0, "prompt", 61, "상관없는 요청"),
    say("c", 1, "change", 62, "@@\n-b\n+c", { path: "/work/app/x.py" }),
  ];
  const project: Project = { id: "p", name: "app", roots: ["/work/app"] };
  const snapshot: Snapshot = {
    version: 1, madeAt: new Date(2026, 0, 2, 3, 4).getTime(), project, sessions,
    items: items.map(({ text, ...rest }) => ({ ...rest, size: text.length, label: text.slice(0, 20) })),
    links: [...recordedLinks(sessions).links, ...pasteLinks(items, sessions)],
    waiting: [{ id: "w", at: 70, from: { sessionId: "a", itemId: "a:1", start: 0, end: 2 }, to: { sessionId: "b" }, chars: 2, excerpt: "합계", missed: false }],
    hooks: { codex: "ready", claude: "ready" },
    overlaps: overlaps(items, project),
    notes: ["점선 화살표(붙여넣기)는 글자를 견줘 찾은 것입니다.", "이 컴퓨터에만 해당하는 알림"],
  };
  return { snapshot, bodies: new Map(items.map((item) => [item.id, item])) };
}

test("a bundle holds the chosen sessions with what hangs off them and what ties them, and nothing of the rest", () => {
  const { snapshot, bodies } = madeUp();
  assert.deepEqual(snapshot.links.map((link) => link.id).sort(), ["fork:a>f", "paste:a:1>b:0", "subagent:b>sub"]);
  const bundle = makeBundle(snapshot, bodies, { sessions: ["a", "b", "nobody"], theme: "dark" });
  assert.deepEqual(bundle.snapshot.sessions.map((one) => [one.id, one.recordPath, one.projectId === bundle.snapshot.project.id]), [["a", null, true], ["b", null, true], ["sub", null, true]]);
  assert.ok(bundle.snapshot.project.id.startsWith("bundle:") && bundle.snapshot.project.name === "app");
  assert.deepEqual(bundle.snapshot.links.map((link) => link.id).sort(), ["paste:a:1>b:0", "subagent:b>sub"]);
  assert.deepEqual(bundle.items.map((item) => item.id), ["a:0", "a:1", "a:2", "b:0", "b:1", "sub:0", "sub:1"]);
  assert.deepEqual(bundle.snapshot.items.map((item) => item.id), bundle.items.map((item) => item.id));
  assert.deepEqual(bundle.snapshot.overlaps.map((overlap) => [overlap.path, overlap.touches.map((touch) => touch.sessionId)]), [["x.py", ["a", "b"]]]);
  assert.deepEqual([bundle.snapshot.waiting, bundle.snapshot.hooks], [[], { codex: "absent", claude: "absent" }]); // nothing waits, nothing is sent
  assert.deepEqual(bundle.view, { on: ["a", "b"], theme: "dark" });
  assert.equal(bundle.snapshot.notes.length, 2);
  assert.match(bundle.snapshot.notes[0], /^01-02 03:04에 내보낸 기록입니다\. 세션 2개\(딸린 대화 1개 포함\)가 들어 있고/);
  // a file that is the only one two of the chosen sessions share is no overlap once one of them is left out
  assert.deepEqual(makeBundle(snapshot, bodies, { sessions: ["a", "c"] }).snapshot.overlaps.length, 1);
  assert.deepEqual(makeBundle(snapshot, bodies, { sessions: ["a", "f"] }).snapshot.overlaps, []);
  // with no sessions named: all of them, and the screen chooses what is on
  const whole = makeBundle(snapshot, bodies);
  assert.deepEqual([whole.snapshot.sessions.length, whole.items.length, whole.view], [5, 10, { on: [], theme: "light" }]);
  assert.throws(() => makeBundle(snapshot, bodies, { sessions: ["nobody"] }), /내보낼 세션이 없습니다/);
});

test("a bundle read back from its file answers what the server would, and refuses the rest", () => {
  const { snapshot, bodies } = madeUp();
  const bundle = makeBundle(snapshot, bodies, { sessions: ["a", "b"] });
  const back = readBundle(JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(back, bundle);
  assert.deepEqual(answer(back, "/api/projects"), { projects: [bundle.snapshot.project] });
  assert.equal(answer(back, "/api/snapshot?project=anything"), back.snapshot);
  assert.equal((answer(back, "/api/item?id=a:1") as Item).text, SAID);
  assert.deepEqual(answer(back, "/api/talk?session=b"), { items: talkOf(bundle.items, "b") });
  assert.deepEqual((answer(back, "/api/talk?session=sub") as { items: Item[] }).items.map((item) => item.id), ["sub:0", "sub:1"]);
  assert.deepEqual((answer(back, "/api/find?q=TALLY") as { hits: { id: string }[] }).hits.map((hit) => hit.id), ["sub:0", "b:0", "a:1"]); // the newest first
  assert.deepEqual((answer(back, "/api/trace?item=a:1") as { steps: { dir: string; depth: number; link: { id: string } }[] }).steps.map((step) => [step.dir, step.depth, step.link.id]), [["onward", 1, "paste:a:1>b:0"]]); // the fork was left out
  assert.deepEqual((answer(back, "/api/trace?item=b%3A0&start=10&end=60") as { steps: { dir: string; link: { id: string } }[] }).steps.map((step) => [step.dir, step.link.id]), [["back", "paste:a:1>b:0"]]);
  assert.deepEqual(answer(back, "/api/turn/active?session=a"), { turn: null });
  assert.throws(() => answer(back, "/api/item?id=c:0"), /그런 조각이 없습니다/);
  assert.throws(() => answer(back, "/api/talk?session=c"), /그런 세션이 없습니다/);
  assert.throws(() => answer(back, "/api/turn/stream?turn=x"), /내보낸 기록에서는 할 수 없는 일/);
  assert.throws(() => readBundle({ sessions: [] }), /묶음 파일이 아닙니다/);
  assert.throws(() => readBundle({ ...bundle, version: 2 }), /읽지 못하는 판/);
  assert.throws(() => readBundle({ kind: "context-flow-bundle", version: 1, snapshot: {} }), /온전하지 않습니다/);
});

test("an exported page holds the screen and the bundle, and asks for nothing outside itself", () => {
  const { snapshot, bodies } = madeUp();
  const bundle = makeBundle(snapshot, bodies, { sessions: ["a", "b"] });
  const web = join(scratchDir, "web-dist");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), '<!doctype html>\n<html><head>\n<title>맥락 흐름</title>\n<link rel="manifest" href="/manifest.webmanifest">\n<link rel="icon" href="/icon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n  <script type="module" crossorigin src="/assets/index-abc.js"></script>\n  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n</head><body><div id="app"></div></body></html>');
  writeFileSync(join(web, "assets", "index-abc.js"), 'console.log("a</script>b", "$1 $& $$");');
  writeFileSync(join(web, "assets", "index-abc.css"), "body{color:red}");
  const page = standalonePage(web, bundle);
  assert.ok(!/\ssrc=|\shref=/.test(page.replace(/<script type="application\/json"[\s\S]*?<\/script>/, ""))); // nothing is fetched
  assert.ok(page.includes('<script type="module">console.log("a<\\/script>b", "$1 $& $$");</script>')); // a script that names its own end tag stays whole
  assert.ok(page.includes("<style>body{color:red}</style>") && page.includes("<title>맥락 흐름 · app</title>"));
  const data = /<script type="application\/json" id="cf-bundle">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
  assert.ok(!data.includes("<")); // what a subagent said ("</script><b>…") cannot end the data early
  assert.deepEqual(readBundle(JSON.parse(data)), bundle);
  assert.throws(() => standalonePage(join(scratchDir, "no-such-dir"), bundle), /npm run build/);
});

test("pieces that wait can be taken to go with a message sent from here; the hook then finds nothing, and they come back if the message did not go", () => {
  const home = join(scratchDir, "take-home");
  process.env.CONTEXT_FLOW_HOME = home;
  const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugin", "context-flow", "hooks", "along.sh");
  const say = (session: string) => spawnSync("sh", [hook], { input: JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit", prompt: "이어서" }), env: { ...process.env, CONTEXT_FLOW_HOME: home, CONTEXT_FLOW_NODE: process.execPath }, encoding: "utf8" });
  const row = (id: string, at: number, to: string, text: string): Pending => ({ id, at, from: { sessionId: "a", itemId: "a:1", start: 0, end: text.length }, to: { sessionId: to }, text, block: pieceBlock({ id, from: "‘a’ (Codex)", kind: "답변", text }) });
  assert.deepEqual(takePending("b").rows, []); // nothing was ever set to wait
  assert.deepEqual(takePending("../elsewhere").rows, []);
  queuePieces([row("cf2", 20, "b", "둘째"), row("cf1", 10, "b", "첫째"), row("cf3", 30, "c", "다른 세션의 것")]);
  const taken = takePending("b");
  assert.deepEqual(taken.rows.map((one) => one.id), ["cf1", "cf2"]); // in the order they were set
  assert.deepEqual(readPending().map((one) => one.id), ["cf3"]); // while they are on their way they do not wait
  assert.equal(say("b").stdout, ""); // the client's hook, called for the same message, adds nothing a second time
  assert.deepEqual(takePending("b").rows, []);
  taken.back(); // the session did not take the message
  assert.deepEqual(readPending().map((one) => one.id), ["cf1", "cf2", "cf3"]);
  const again = takePending("b");
  const message = withBlocks("이어서 해줘", again.rows.map((one) => one.block));
  assert.equal(message, withPieces("이어서 해줘", [{ id: "cf1", from: "‘a’ (Codex)", kind: "답변", text: "첫째" }, { id: "cf2", from: "‘a’ (Codex)", kind: "답변", text: "둘째" }]));
  assert.equal(withBlocks("그대로", []), "그대로");
  again.done();
  assert.equal(existsSync(join(home, "pending", "b")), false);
  assert.deepEqual(readPending().map((one) => one.id), ["cf3"]);
  assert.deepEqual(readTransfers(), []); // whoever sent the message writes down what went; taking them does not
  delete process.env.CONTEXT_FLOW_HOME;
});

test("a new session is begun by its own client, in the folder asked for, like a session of that client already there", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "context-flow-new-")));
  const fake = (name: string, body: string) => {
    const script = join(dir, name + ".mjs");
    writeFileSync(script, body);
    const run = join(dir, name);
    writeFileSync(run, "#!/bin/sh\nexec \"" + process.execPath + "\" \"" + script + "\" \"$@\"\n");
    chmodSync(run, 0o755);
    return run;
  };
  // a stand-in for Claude Code: says back how it was called and what it was told
  process.env.CONTEXT_FLOW_CLAUDE = fake("claude", `
    import { createInterface } from "node:readline";
    const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    createInterface({ input: process.stdin }).once("line", (line) => {
      const said = JSON.parse(line).message.content[0].text;
      out({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } });
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), said }) } } });
      out({ type: "result", is_error: false });
    });
  `);
  // a stand-in for the Codex app server; it refuses a thread in a folder named "refused"
  process.env.CONTEXT_FLOW_CODEX = fake("codex", `
    import { createInterface } from "node:readline";
    const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    let started = null;
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") out({ id: message.id, result: {} });
      else if (message.method === "thread/start" || message.method === "thread/resume") {
        started = message;
        if (process.cwd().endsWith("refused")) out({ id: message.id, error: { message: "no room for a thread" } });
        else out({ id: message.id, result: { thread: { id: "thread-new" } } });
      } else if (message.method === "turn/start") {
        out({ id: message.id, result: { turn: { id: "turn-1" } } });
        out({ method: "item/started", params: { item: { type: "agentMessage" } } });
        out({ method: "item/agentMessage/delta", params: { delta: JSON.stringify({ args: process.argv.slice(2), started, turn: message.params }) } });
        out({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
    });
  `);
  const ended = (turn: Turn) => new Promise<void>((resolve) => { if (turn.done) resolve(); else turn.listen((event) => { if (event.t === "done") resolve(); }); });
  const told = (turn: Turn) => JSON.parse(turn.events.filter((event) => event.t === "text").map((event) => (event as { d: string }).d).join(""));
  const last = (turn: Turn) => turn.events[turn.events.length - 1];

  const claude = startNew({ client: "claude", cwd: dir, like: session("old", { client: "claude", model: "claude-test-1", cwd: "/elsewhere" }) }, "처음 할 말");
  const id = await claude.ready;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(claude.turn.sessionId, id);
  await ended(claude.turn);
  assert.deepEqual(last(claude.turn), { t: "done", ok: true });
  const heard = told(claude.turn);
  assert.equal(heard.args[heard.args.indexOf("--session-id") + 1], id); // a new session under the id it was given, not a resumed one
  assert.ok(!heard.args.includes("--resume"));
  assert.equal(heard.args[heard.args.indexOf("--model") + 1], "claude-test-1"); // the model of the session it runs like
  assert.deepEqual([heard.cwd, heard.said], [dir, "처음 할 말"]); // in the folder asked for, not in that session's
  assert.deepEqual(claude.turn.events[0], { t: "prompt", text: "처음 할 말" });

  const record = join(dir, "like.jsonl");
  writeFileSync(record, line({ type: "turn_context", payload: { cwd: "/elsewhere", model: "model-like", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, effort: "low" } }));
  const codex = startNew({ client: "codex", cwd: dir, like: session("old", { recordPath: record, cwd: "/elsewhere" }) }, "처음 할 말");
  assert.equal(codex.turn.sessionId, ""); // not known until Codex has made the thread
  assert.equal(await codex.ready, "thread-new");
  assert.equal(codex.turn.sessionId, "thread-new");
  await ended(codex.turn);
  assert.deepEqual(last(codex.turn), { t: "done", ok: true });
  const got = told(codex.turn);
  assert.deepEqual(got.args, ["app-server"]);
  assert.equal(got.started.method, "thread/start");
  assert.deepEqual(got.started.params, { cwd: dir, model: "model-like", approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" });
  assert.equal(got.turn.threadId, "thread-new");
  assert.deepEqual([got.turn.input[0].text, got.turn.effort], ["처음 할 말", "low"]);

  // a session of the other client is nothing to go by: the client's own defaults
  const plain = startNew({ client: "codex", cwd: dir, like: session("old", { client: "claude", model: "claude-test-1", recordPath: record }) }, "처음 할 말");
  await plain.ready;
  await ended(plain.turn);
  assert.deepEqual(told(plain.turn).started.params, { cwd: dir, approvalsReviewer: "user" });

  const refused = join(dir, "refused");
  mkdirSync(refused);
  const none = startNew({ client: "codex", cwd: refused, like: null }, "처음 할 말");
  await assert.rejects(none.ready, /no room for a thread/);
  assert.equal(none.turn.sessionId, "");
  assert.equal(last(none.turn).t === "done" && (last(none.turn) as { ok: boolean }).ok, false);
  delete process.env.CONTEXT_FLOW_CLAUDE;
  delete process.env.CONTEXT_FLOW_CODEX;
});

test("a session begun from here works where its first piece came from and runs like the nearest session of its client, unless the person chose otherwise", () => {
  const project: Project = { id: "p", name: "app", roots: ["/work/app"] };
  const sessions = [
    session("old-root", { updatedAt: 10, model: "m-old" }),
    session("sub", { cwd: "/work/app/sub", updatedAt: 30, model: "m-sub" }),
    session("sub-older", { cwd: "/work/app/sub", updatedAt: 20, model: "m-sub" }),
    session("claude", { client: "claude", cwd: "/work/app/sub", updatedAt: 40, model: "claude-x" }),
    session("kid", { cwd: "/work/app/sub", updatedAt: 90, model: "m-kid", origin: "subagent", parentId: "sub" }),
    session("gone", { cwd: "/work/app/shelf", updatedAt: 80, model: "m-gone", activity: "archived" }),
    session("outside", { cwd: "/elsewhere", updatedAt: 70, model: "m-out" }),
  ];
  const plan = (choice: Parameters<typeof freshPlan>[2]) => {
    const made = freshPlan(project, sessions, choice);
    if ("error" in made) throw new Error(made.error);
    return made;
  };
  // no piece: the project's first folder; like the newest session of the client there, else the newest anywhere
  assert.deepEqual([plan({ client: "codex" }).cwd, plan({ client: "codex" }).like?.id], ["/work/app", "old-root"]);
  assert.deepEqual([plan({ client: "claude" }).cwd, plan({ client: "claude" }).like?.id], ["/work/app", "claude"]);
  // a piece: the folder it came from
  const withPiece = plan({ client: "codex", from: "sub-older" });
  assert.deepEqual([withPiece.cwd, withPiece.like?.id], ["/work/app/sub", "sub"]);
  assert.equal(plan({ client: "codex", from: "outside" }).cwd, "/work/app"); // a piece from outside the project does not take the session out of it
  // what can be chosen: the project's folders and the ones its sessions work in; one session for each model, the nearest first
  assert.deepEqual(withPiece.folders, ["/work/app", "/work/app/sub"]); // no subagent's, archived session's or outsider's folder
  assert.deepEqual(withPiece.likes.map((one) => [one.id, one.model]), [["sub", "m-sub"], ["outside", "m-out"], ["old-root", "m-old"]]);
  // chosen otherwise
  const chosen = plan({ client: "codex", from: "sub", cwd: "/work/app", like: "sub" });
  assert.deepEqual([chosen.cwd, chosen.like?.id], ["/work/app", "sub"]);
  assert.equal(plan({ client: "codex", like: "none" }).like, null); // the client's own defaults
  assert.deepEqual(freshPlan(project, sessions, { client: "codex", cwd: "/elsewhere" }), { error: "새 세션은 이 프로젝트의 폴더 안에서만 시작합니다" });
  assert.deepEqual(freshPlan(project, sessions, { client: "codex", like: "claude" }), { error: "따를 세션을 찾지 못했습니다" }); // a session of the other client is nothing to go by
  assert.equal(plan({ client: "claude", cwd: "/work/app/sub/deeper" }).cwd, "/work/app/sub/deeper");
});

test("a turn that has gone quiet is still at work when its client's live process says so, and not when that process is gone", () => {
  const now = 100 * 3600_000;
  const quiet = now - 20 * 60_000; // nothing written for twenty minutes
  const began = quiet - 60_000;
  const live = (holders: number[] = [], claude = new Map<string, ClaudeLive>()): Live => ({ claude, codexHolders: () => holders });
  const settled = (more: Partial<Session>, turn: { open: boolean; since: number }, with_: Live) => {
    const made = session("s", { updatedAt: quiet, recordPath: "/r.jsonl", activity: "waiting", ...more });
    settleActivity(made, turn, with_, now);
    return [made.activity, made.needs];
  };
  // Codex: the record alone says a turn is open and has been quiet
  assert.deepEqual(settled({}, { open: true, since: began }, live()), ["waiting", undefined]); // no process holds its record: the client is gone
  assert.deepEqual(settled({}, { open: true, since: began }, live([began - 3600_000])), ["running", undefined]); // held by a process that was there when the turn began: a long command, or a wait
  assert.deepEqual(settled({}, { open: true, since: began }, live([now - 60_000])), ["waiting", undefined]); // held by a process started since: it only loaded the thread again
  assert.deepEqual(settled({}, { open: false, since: began }, live([0])), ["waiting", undefined]); // the turn ended: loaded, and idle
  const never: Live = { claude: new Map(), codexHolders: () => { throw new Error("the process table is not looked at for this"); } };
  assert.deepEqual(settled({ updatedAt: now - 30_000 }, { open: true, since: now - 90_000 }, never), ["running", undefined]); // written to a moment ago
  assert.deepEqual(settled({ updatedAt: now - 5 * 24 * 3600_000 }, { open: true, since: 0 }, never), ["idle", undefined]); // days old: nobody is asked
  assert.deepEqual(settled({ activity: "archived" }, { open: true, since: began }, never), ["archived", undefined]);
  // Claude Code: a live process says for itself what its session is at
  const says = (status: ClaudeLive["status"], waitingFor: string | null = null) => live([], new Map([["s", { status, waitingFor, at: now }]]));
  assert.deepEqual(settled({ client: "claude" }, { open: true, since: 0 }, says("busy")), ["running", undefined]); // however long it has been quiet
  assert.deepEqual(settled({ client: "claude" }, { open: true, since: 0 }, says("waiting", "permission prompt")), ["running", "approval"]);
  assert.deepEqual(settled({ client: "claude" }, { open: true, since: 0 }, says("waiting", "question")), ["running", "input"]);
  assert.deepEqual(settled({ client: "claude", updatedAt: now - 10_000 }, { open: true, since: 0 }, says("idle")), ["waiting", undefined]); // a turn cut short in the record: its process is idle
  assert.deepEqual(settled({ client: "claude" }, { open: true, since: 0 }, live()), ["waiting", undefined]); // no live process: the record's own rule
  assert.deepEqual(settled({ client: "claude", updatedAt: now - 10_000 }, { open: true, since: 0 }, live()), ["running", undefined]);
  const once = session("s", { client: "claude", updatedAt: quiet, needs: "approval", activity: "running" });
  settleActivity(once, { open: false, since: 0 }, live(), now);
  assert.equal("needs" in once, false); // what it waited for is not kept once it waits no more
});

test("Claude Code's live sessions are read from the files its processes keep; a file whose process is gone says nothing", () => {
  const home = join(scratchDir, "claude-live");
  mkdirSync(join(home, "sessions"), { recursive: true });
  const now = Date.now();
  const put = (name: string, row: unknown) => writeFileSync(join(home, "sessions", name), JSON.stringify(row));
  put(process.pid + ".json", { pid: process.pid, sessionId: "here", status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: now });
  put("99999999.json", { pid: 99999999, sessionId: "gone", status: "busy", statusUpdatedAt: now }); // no such process
  put(process.pid + ".abc.key", { peerToken: "x" });
  put("1.json", { pid: process.pid, sessionId: "stale", status: "busy", statusUpdatedAt: now - 30 * 24 * 3600_000 }); // left behind long ago
  assert.deepEqual([...readClaudeLive(home, now)], [["here", { status: "waiting", waitingFor: "permission prompt", at: now }]]);
  assert.deepEqual([...readClaudeLive(join(home, "nowhere"), now)], []);
});

test("the agent that keeps the server up says what to run, where, and with which PATH", () => {
  const plist = servicePlist({ node: "/opt/n&v/bin/node", cli: "/work/context-flow/packages/core/src/cli.ts", port: 8801, cwd: "/work/context-flow", path: "/opt/n&v/bin:/usr/bin", log: "/home/me/.context-flow/server.log" });
  assert.ok(plist.includes("<key>Label</key><string>" + LABEL + "</string>"));
  const args = [...plist.matchAll(/^    <string>(.*)<\/string>$/gm)].map((found) => found[1]);
  assert.deepEqual(args, ["/opt/n&amp;v/bin/node", "--disable-warning=ExperimentalWarning", "/work/context-flow/packages/core/src/cli.ts", "serve", "--port", "8801"]);
  assert.ok(plist.includes("<key>PATH</key><string>/opt/n&amp;v/bin:/usr/bin</string>")); // written so that the file stays well formed
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>") && plist.includes("<key>SuccessfulExit</key><false/>")); // up at login, up again after a fall, not after being stopped
  // the PATH: this node's folder first, then where claude is found now, then the usual ones; nothing of the shell it was installed from
  const bin = join(scratchDir, "claude-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "");
  const path = servicePath({ PATH: ["/tmp/passing-shell/bin", bin, "/usr/bin"].join(":") }, "/opt/node/bin/node").split(":");
  assert.deepEqual(path.slice(0, 2), ["/opt/node/bin", bin]);
  assert.ok(path.includes("/usr/bin") && path.includes("/bin") && !path.includes("/tmp/passing-shell/bin"));
  assert.equal(new Set(path).size, path.length);
});

test("a piece that went between projects is listed with the session of this project, and is no line on its map", () => {
  const there: Place = { project: "q", projectName: "other", title: "그쪽 세션", client: "claude" };
  const here: Place = { project: "p", projectName: "app", title: "이쪽 세션", client: "codex" };
  const sessions = [session("a"), session("b")];
  const got: Item = { id: "b:2", sessionId: "b", turnId: null, kind: "prompt", at: 300, text: withPieces("이걸 보고 고쳐줘", [{ id: "cfin", from: "‘그쪽 세션’ (Claude Code, 프로젝트 other)", kind: "답변", text: "밖에서 온 글" }]) };
  const said: Item = { id: "a:1", sessionId: "a", turnId: null, kind: "answer", at: 100, text: "안에서 나간 글입니다" };
  const transfers: Transfer[] = [
    { id: "cfin", at: 290, from: { sessionId: "x", itemId: "x:7", start: 3, end: 10, where: there }, to: { sessionId: "b", where: here }, text: "밖에서 온 글" },
    { id: "cfout", at: 400, from: { sessionId: "a", itemId: "a:1", start: 0, end: 9, where: here }, to: { sessionId: "y", where: there }, text: "안에서 나간 글" },
    { id: "cfnot", at: 410, from: { sessionId: "x", itemId: "x:8", start: 0, end: 4, where: there }, to: { sessionId: "a", where: here }, text: "아직 안 온 글" }, // sent, and in no record here yet
    { id: "cflost", at: 420, from: { sessionId: "a", itemId: "a:1", start: 0, end: 2 }, to: { sessionId: "gone" }, text: "안에" }, // its other end is simply gone: nothing says where it was
    { id: "cfsame", at: 430, from: { sessionId: "a", itemId: "a:1", start: 0, end: 2 }, to: { sessionId: "b" }, text: "안에" }, // within the project: a line, not this
  ];
  assert.deepEqual(farLinks(transfers, sessions, [said, got]), [
    { id: "far:cfin", chars: 7, excerpt: "밖에서 온 글", dir: "in", sessionId: "b", itemId: "b:2", at: 300, other: { ...there, sessionId: "x", itemId: "x:7", start: 3, end: 10 } },
    { id: "far:cfout", chars: 8, excerpt: "안에서 나간 글", dir: "out", sessionId: "a", itemId: "a:1", start: 0, end: 9, at: 400, other: { ...there, sessionId: "y" } },
  ]);
  assert.deepEqual(transferLinks(transfers.filter((one) => one.id === "cfin"), [said, got]).map((link) => link.id), ["transfer:cfin"]); // (the same mark, were both ends here)
  // waiting: for a session here from anywhere that says where; or from here for a session elsewhere that says where
  const row = (id: string, from: string, to: string, more: { from?: Place; to?: Place } = {}): Pending => ({ id, at: 500, from: { sessionId: from, itemId: from + ":1", start: 0, end: 2, ...(more.from ? { where: more.from } : {}) }, to: { sessionId: to, ...(more.to ? { where: more.to } : {}) }, text: "글", block: "" });
  const waits = waitingOf([row("w1", "a", "b"), row("w2", "x", "b", { from: there, to: here }), row("w3", "a", "y", { from: here, to: there }), row("w4", "x", "y", { from: there, to: there }), row("w5", "a", "gone")], sessions, []);
  assert.deepEqual(waits.map((one) => one.id), ["w1", "w2", "w3"]);
  assert.deepEqual(waits[1].from.where, there);
});

test("the basket is kept whole in one file, and nothing kept is an empty basket", () => {
  process.env.CONTEXT_FLOW_HOME = join(scratchDir, "basket-home");
  assert.deepEqual(readBasket(), []);
  const pieces = [{ id: "k1", sessionId: "a", itemId: "a:1", start: 0, end: 3, text: "글자들", kind: "answer", at: 1, from: { project: "p", projectName: "app", title: "a", client: "codex" } }];
  writeBasket(pieces);
  assert.deepEqual(readBasket(), pieces);
  writeBasket([]);
  assert.deepEqual(readBasket(), []);
  assert.deepEqual(readdirSync(process.env.CONTEXT_FLOW_HOME), ["basket.json"]); // no half-written file is left beside it
  delete process.env.CONTEXT_FLOW_HOME;
});

// ---------- several projects on one map ----------

test("projects are named one at a time or several at once, and a folder is of the project whose own folder is nearest above it", () => {
  const projects: Project[] = [{ id: "p", name: "app", roots: ["/work/app"] }, { id: "n", name: "x", roots: ["/work/app/tools/x"] }, { id: "q", name: "lib", roots: ["/work/lib", "/work/lib2"] }];
  const ids = (wanted: string) => findProjects(wanted, projects).map((one) => one.id);
  assert.deepEqual(ids("p"), ["p"]);
  assert.deepEqual(ids("/work/lib2"), ["q"]);
  assert.deepEqual(ids("q,p,q,nobody"), ["q", "p"]); // each once, in the order asked for
  assert.deepEqual(ids("/work/lib, app"), ["q", "p"]); // by a folder, by a name
  assert.deepEqual(ids("nobody"), []);
  assert.equal(nearestProject("/work/app/tools/x/src", projects)?.id, "n");
  assert.equal(nearestProject("/work/app/src", projects)?.id, "p");
  assert.equal(nearestProject("/work/application", projects), undefined);
});

test("what was found for a prompt among one set of projects is not taken for what there is among another", () => {
  forgetPastes();
  const said = say("a", 1, "answer", 20, SAID);
  const pasted = say("b", 0, "prompt", 30, "아래대로 해줘.\n\n" + SHOWN);
  assert.deepEqual(pasteLinks([pasted], [session("b")], "q"), []); // the session it was said in is not on this map
  assert.deepEqual(pasteLinks([said, pasted], [session("a"), session("b")], "p,q").map((link) => link.id), ["paste:a:1>b:0"]);
  assert.deepEqual(pasteLinks([pasted], [session("b")], "q"), []);
});

test("several projects on one map are read as one: a piece that went between two of them is a line, and is followed across", async () => {
  forgetPastes();
  const claude = join(scratchDir, "claude-many");
  const codex = join(scratchDir, "codex-none");
  mkdirSync(codex, { recursive: true });
  const write = (id: string, cwd: string, rows: [string, "user" | "assistant", string][]) => {
    const dir = join(claude, "projects", folderName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + ".jsonl"), rows.map(([at, role, text]) => line(role === "user"
      ? { type: "user", cwd, timestamp: at, message: { role, content: text } }
      : { type: "assistant", cwd, timestamp: at, message: { role, model: "m", stop_reason: "end_turn", content: [{ type: "text", text }] } })).join(""));
  };
  const from = 0;
  const cut = SAID.slice(0, 60); // long enough to be known again by its letters
  write("s1", "/work/app", [["2026-01-01T00:00:00Z", "user", "합계가 어디 있어?"], ["2026-01-01T00:00:01Z", "assistant", SAID]]);
  write("s2", "/work/lib", [["2026-01-01T01:00:00Z", "user", withPieces("이 이름을 여기서도 써줘", [{ id: "cfx", from: "‘s1’ (Claude Code, 프로젝트 app)", kind: "답변", text: cut }])], ["2026-01-01T01:00:01Z", "assistant", "그렇게 했습니다"]]);
  write("s3", "/work/app/tools/x", [["2026-01-01T02:00:00Z", "user", "도구를 손봐줘"], ["2026-01-01T02:00:01Z", "assistant", "손봤습니다"]]);
  const p: Project = { id: "p", name: "app", roots: ["/work/app"] };
  const q: Project = { id: "q", name: "lib", roots: ["/work/lib"] };
  const n: Project = { id: "n", name: "x", roots: ["/work/app/tools/x"] };
  const transfers: Transfer[] = [{ id: "cfx", at: Date.parse("2026-01-01T00:59:59Z"),
    from: { sessionId: "s1", itemId: "s1:1", start: from, end: from + cut.length, where: { project: "p", projectName: "app", title: "s1", client: "claude" } },
    to: { sessionId: "s2", where: { project: "q", projectName: "lib", title: "s2", client: "claude" } }, text: cut }];
  const now = Date.parse("2026-01-03T00:00:00Z");
  const live: Live = { claude: new Map(), codexHolders: () => [] };
  process.env.CONTEXT_FLOW_CLAUDE_HOME = claude;
  process.env.CONTEXT_FLOW_CODEX_HOME = codex;
  try {
    // alone, the project the piece left lists it as gone to another project: the other end is not there to draw a line to
    const alone = await buildSnapshot(p, new Map(), now, transfers, [], live);
    const answerOf = [...alone.bodies.values()].find((item) => item.sessionId === "s1" && item.kind === "answer")!;
    assert.equal(answerOf.id, "s1:1");
    assert.deepEqual(alone.snapshot.sessions.map((one) => one.id), ["s1", "s3"]);
    assert.equal(alone.snapshot.projects, undefined);
    assert.deepEqual(alone.snapshot.links.map((link) => link.kind), []);
    assert.deepEqual((alone.snapshot.far ?? []).map((one) => [one.id, one.dir, one.other.project]), [["far:cfx", "out", "q"]]);
    // followed from where it was said, the way goes as far as the edge of the map, and says what lies beyond
    const edge = tracePiece({ sessionId: "s1", itemId: "s1:1", start: from, end: from + cut.length }, alone.snapshot.links, alone.bodies, alone.snapshot.sessions, alone.snapshot.far);
    assert.deepEqual(edge.map((step) => [step.dir, step.link.id, step.link.to.sessionId, step.far?.project, step.far?.title]), [["onward", "far:cfx", "s2", "q", "s2"]]);
    // with both on one map it is a line like any other, listed nowhere as far, and the way goes on through it
    const both = await buildSnapshot([p, q], new Map(), now, transfers, [], live);
    assert.deepEqual([both.snapshot.project.id, both.snapshot.project.name, both.snapshot.project.roots], ["p,q", "app + lib", ["/work/app", "/work/lib"]]);
    assert.deepEqual(both.snapshot.projects?.map((one) => one.id), ["p", "q"]);
    assert.deepEqual(both.snapshot.sessions.map((one) => [one.id, one.projectId]), [["s1", "p"], ["s2", "q"], ["s3", "p"]]);
    assert.deepEqual(both.snapshot.links.map((link) => [link.id, link.from.sessionId, link.to.sessionId]), [["transfer:cfx", "s1", "s2"]]);
    assert.deepEqual(both.snapshot.far, []);
    const across = tracePiece({ sessionId: "s1", itemId: "s1:1", start: from, end: from + cut.length }, both.snapshot.links, both.bodies, both.snapshot.sessions, both.snapshot.far);
    assert.deepEqual(across.map((step) => [step.dir, step.link.id, step.far]), [["onward", "transfer:cfx", undefined]]);
    const whole = both.bodies.get("s2:0")!.text.length;
    const back = tracePiece({ sessionId: "s2", itemId: "s2:0", start: 0, end: whole }, both.snapshot.links, both.bodies, both.snapshot.sessions, both.snapshot.far);
    assert.deepEqual(back.map((step) => [step.dir, step.link.id]), [["back", "transfer:cfx"]]);
    // where it arrived, alone: it came from another project, and the way back says so
    const there = await buildSnapshot(q, new Map(), now, transfers, [], live);
    const came = tracePiece({ sessionId: "s2", itemId: "s2:0", start: 0, end: whole }, there.snapshot.links, there.bodies, there.snapshot.sessions, there.snapshot.far);
    assert.deepEqual(came.map((step) => [step.dir, step.link.from.sessionId, step.link.from.itemId, step.far?.project]), [["back", "s1", "s1:1", "p"]]);
    // a project whose folder lies inside another's: its session is drawn once, as its own
    const nested = await buildSnapshot([p, n], new Map(), now, [], [], live);
    assert.deepEqual(nested.snapshot.sessions.map((one) => [one.id, one.projectId]), [["s1", "p"], ["s3", "n"]]);
    assert.equal(nested.bodies.size, 4);
  } finally {
    delete process.env.CONTEXT_FLOW_CLAUDE_HOME;
    delete process.env.CONTEXT_FLOW_CODEX_HOME;
  }
});

test("where the Codex app has no projects, the folders the sessions worked in stand for them: a work tree is a project, and a session is of one project only", async () => {
  forgetProjects();
  const base = join(scratchDir, "only"); // stands for a home folder: a session was begun in it, and every other folder lies under it
  const claude = join(scratchDir, "only-claude");
  const codex = join(scratchDir, "only-codex");
  const repo = join(base, "repo"); // a git work tree
  const tree = join(base, "repo-tree"); // a linked work tree: what it holds is a .git file
  const notes = join(base, "notes"); // a folder that lies in no work tree but the "home" one's
  const cli = join(base, "cli"); // a folder only a Codex thread worked in
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "packages", "web"), { recursive: true });
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, ".git"), "gitdir: " + join(repo, ".git", "worktrees", "tree") + "\n");
  mkdirSync(notes, { recursive: true });
  mkdirSync(cli, { recursive: true });
  mkdirSync(codex, { recursive: true });
  const hour = (n: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + n * 3_600_000);
  // a session of Claude Code: its transcript lies in a folder named after where it works, and was written to last at that hour
  const session = (id: string, cwd: string, at: number, before = "") => {
    const dir = join(claude, "projects", folderName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + ".jsonl"), before + line({ type: "user", uuid: id + "-u", cwd, timestamp: hour(at).toISOString(), message: { role: "user", content: id + "의 요청" } })
      + line({ type: "assistant", uuid: id + "-a", cwd, timestamp: hour(at).toISOString(), message: { role: "assistant", model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "답" }] } }));
    utimesSync(join(dir, id + ".jsonl"), hour(at), hour(at));
  };
  session("at-home", base, 0);
  session("in-repo", repo, 1);
  // its first lines do not say where it works, and one of them holds the words a record says it with: the record's own word is taken
  session("in-notes", notes, 2, line({ type: "queue-operation", content: "\"cwd\":\"/elsewhere\"" }) + line({ type: "last-prompt", lastPrompt: "x" }));
  session("in-tree", tree, 3);
  session("in-web", join(repo, "packages", "web"), 4);
  // Codex used from its CLI only: threads, and no projects
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec("create table threads (id text primary key, rollout_path text, cwd text, title text, name text, model text, created_at_ms integer, updated_at_ms integer, thread_source text, source text, archived integer, first_user_message text, attached_thread_parent_id text); create table thread_spawn_edges (parent_thread_id text, child_thread_id text);");
  const thread = db.prepare("insert into threads (id, cwd, title, created_at_ms, updated_at_ms, archived) values (?, ?, ?, ?, ?, 0)");
  thread.run("t1", repo, "저장소에서", hour(5).getTime(), hour(5).getTime());
  thread.run("t2", cli, "CLI에서", hour(0.5).getTime(), hour(0.5).getTime());
  db.close();

  const found = folderProjects(Date.now(), claude, codex);
  // a project a work tree (or a folder in none), the one worked in last first; a folder under a work tree is of that tree
  assert.deepEqual(found.map((one) => [one.name, one.roots]), [["repo", [repo]], ["repo-tree", [tree]], ["notes", [notes]], ["cli", [cli]], ["only", [base]]]);
  assert.ok(found.every((one) => /^dir-[0-9a-f]{12}$/.test(one.id)) && new Set(found.map((one) => one.id)).size === 5);
  // the folder the others lie under says which folders under it are theirs; none of the others holds another's
  assert.deepEqual(found.map((one) => (one.not ?? []).slice().sort()), [[], [], [], [], [cli, notes, repo, tree].sort()]);
  // so every session is of one project, and of one only
  const mine: Record<string, string[]> = {};
  for (const project of found) {
    const sessions = (await readClaudeSessions(project, claude, hour(6).getTime())).transcripts.map((one) => one.session.id);
    mine[project.name] = [...sessions, ...readCodexThreads(project, new Map(), codex).sessions.map((one) => one.id)].sort();
  }
  assert.deepEqual(mine, { repo: ["in-repo", "in-web", "t1"], "repo-tree": ["in-tree"], notes: ["in-notes"], cli: ["t2"], only: ["at-home"] });
  // a new session of the outer project is not begun in a folder that is another project's
  const home = found.find((one) => one.name === "only")!;
  assert.deepEqual(freshPlan(home, [], { client: "claude", cwd: repo }), { error: "새 세션은 이 프로젝트의 폴더 안에서만 시작합니다" });
  assert.equal((freshPlan(home, [], { client: "claude" }) as { cwd: string }).cwd, base);

  process.env.CONTEXT_FLOW_CLAUDE_HOME = claude;
  process.env.CONTEXT_FLOW_CODEX_HOME = codex;
  process.env.CONTEXT_FLOW_HOME = join(scratchDir, "only-flow"); // nothing kept from a screen yet (the person's own is not read)
  try {
    // that is what there is to choose from while the Codex app has no projects
    forgetProjects();
    assert.deepEqual([readProjects().from, readProjects().projects.map((one) => one.name)], ["folders", ["repo", "repo-tree", "notes", "cli", "only"]]);
    // the screen is not told which folders are another project's: a snapshot's project is its name and its folders
    const made = await buildSnapshot(home, new Map(), hour(6).getTime(), [], [], { claude: new Map(), codexHolders: () => [] });
    assert.deepEqual([Object.keys(made.snapshot.project).sort(), made.snapshot.sessions.map((one) => one.id)], [["id", "name", "roots"], ["at-home"]]);
    // The server gives them out as found from the folders, and says so on the map of each. (They are found anew
    // every few seconds at most: here, as they were found a moment ago.)
    const served = serve(0, join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public"));
    try {
      const at = "http://127.0.0.1:" + (await served.ready);
      const listed = (await (await fetch(at + "/api/projects")).json()) as { from: string; projects: Project[] };
      assert.deepEqual([listed.from, listed.projects.map((one) => Object.keys(one).sort().join(" ") + ":" + one.name)], ["folders", ["repo", "repo-tree", "notes", "cli", "only"].map((name) => "id name roots:" + name)]);
      const snap = (await (await fetch(at + "/api/snapshot?project=" + home.id)).json()) as Snapshot;
      assert.deepEqual(snap.sessions.map((one) => one.id), ["at-home"]);
      assert.ok(snap.notes.some((note) => note.startsWith("Codex 앱의 사이드바에 프로젝트가 없어서")));
      // a project is asked for by its folder or its name as well (the Codex thread there has no record to be read, and is left out)
      assert.deepEqual(((await (await fetch(at + "/api/snapshot?project=" + encodeURIComponent(repo))).json()) as Snapshot).sessions.map((one) => one.id).sort(), ["in-repo", "in-web"]);
    } finally {
      await served.close();
    }
    // once the app has projects, they are the projects; unless the folders are asked for
    writeFileSync(join(codex, ".codex-global-state.json"), JSON.stringify({ "local-projects": { side: { name: "사이드바의 것", rootPaths: [repo] } } }));
    assert.deepEqual([readProjects().from, readProjects().projects.map((one) => one.id)], ["sidebar", ["side"]]);
    // A folder a session was begun in from the screen while it was in no project is kept, and is a project beside the
    // sidebar's: the one begun in last first. One in a sidebar project is that project's; one deleted since is let go.
    const newRepo = join(scratchDir, "only-new"); // a repository just made
    const plain = join(scratchDir, "only-plain"); // a folder in no repository
    mkdirSync(join(newRepo, ".git"), { recursive: true });
    mkdirSync(join(newRepo, "src"), { recursive: true });
    mkdirSync(plain, { recursive: true });
    keepFolder(join(repo, "packages"), hour(1).getTime());
    keepFolder(join(scratchDir, "only-gone"), hour(2).getTime());
    keepFolder(newRepo, hour(6).getTime());
    keepFolder(plain, hour(7).getTime());
    assert.deepEqual(readProjects().projects.map((one) => [one.id === "side" ? one.id : one.name, one.roots, /^dir-/.test(one.id) || one.id === "side"]), [["side", [repo], true], ["only-plain", [plain], true], ["only-new", [newRepo], true]]);
    // the project a session begun in a folder is of: the one it is in, kept or the sidebar's; or, in none, its work tree, not kept yet
    assert.deepEqual([projectFor(join(repo, "packages", "web")).project.id, projectFor(join(newRepo, "src")).project.name, projectFor(join(newRepo, "src")).known], ["side", "only-new", true]);
    const other = join(scratchDir, "only-other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "docs"), { recursive: true });
    const unknown = projectFor(join(other, "docs"));
    assert.deepEqual([unknown.known, unknown.project.roots, unknown.project.name], [false, [other], "only-other"]);
    process.env.CONTEXT_FLOW_PROJECTS = "folders";
    // found from the folders, a kept folder counts as a folder a session worked in when it was kept: of its work tree
    assert.deepEqual([readProjects().from, readProjects().projects.map((one) => one.name)], ["folders", ["only-plain", "only-new", "repo", "repo-tree", "notes", "cli", "only"]]);
  } finally {
    delete process.env.CONTEXT_FLOW_CLAUDE_HOME;
    delete process.env.CONTEXT_FLOW_CODEX_HOME;
    delete process.env.CONTEXT_FLOW_PROJECTS;
    delete process.env.CONTEXT_FLOW_HOME;
  }
  // where neither client was ever used there is nothing to choose from, and nothing is said of what is not there
  forgetProjects();
  assert.deepEqual(folderProjects(Date.now(), join(scratchDir, "no-claude"), join(scratchDir, "no-codex")), []);
  assert.deepEqual(readCodexThreads(home, new Map(), join(scratchDir, "no-codex")).notes, []);
  assert.deepEqual((await readClaudeSessions(home, join(scratchDir, "no-claude"))).notes, []);
});

test("a bundle keeps where tiles were put, and which project each session is of when it is taken from several", () => {
  const { snapshot, bodies } = madeUp();
  const bundle = makeBundle(snapshot, bodies, { sessions: ["a", "b"], spots: [["a", 10, 20], ["c", 1, 2], ["sub", 3, 4]] });
  assert.deepEqual(bundle.view.spots, [["a", 10, 20]]); // c is not in it; sub is no tile of its own
  assert.deepEqual(readBundle(JSON.parse(JSON.stringify(bundle))).view.spots, [["a", 10, 20]]);
  assert.deepEqual(readBundle({ ...bundle, view: { on: [], theme: "light", spots: [["a", "x", 1], "bad", ["b", 5, 6]] } }).view.spots, [["b", 5, 6]]);
  assert.equal("spots" in makeBundle(snapshot, bodies).view, false);
  // a session that was at work when the record was made is kept as it was, and the record says so
  const busy = makeBundle({ ...snapshot, sessions: snapshot.sessions.map((one) => (one.id === "a" ? { ...one, activity: "running" as const } : one)) }, bodies, { sessions: ["a", "b"] });
  assert.equal(busy.snapshot.sessions[0].activity, "running");
  assert.match(busy.snapshot.notes.at(-1)!, /^내보낼 때 작업 중이던 세션 1개\(‘a’\)/);
  const lib: Project = { id: "q", name: "lib", roots: ["/work/lib"] };
  const two: Snapshot = { ...snapshot, project: { id: "p,q", name: "app + lib", roots: ["/work/app", "/work/lib"] }, projects: [snapshot.project, lib], sessions: snapshot.sessions.map((one) => (one.id === "c" ? { ...one, projectId: "q" } : one)) };
  const both = makeBundle(two, bodies, { sessions: ["a", "c"] });
  assert.deepEqual(both.snapshot.projects?.map((one) => one.id), ["p", "q"]);
  assert.deepEqual(both.snapshot.sessions.map((one) => [one.id, one.projectId]), [["a", "p"], ["c", "q"]]);
  assert.deepEqual([both.snapshot.project.name, both.snapshot.project.roots], ["app + lib", ["/work/app", "/work/lib"]]);
  const one = makeBundle(two, bodies, { sessions: ["c"] }); // of the two, only one is left: a bundle of that project
  assert.deepEqual([one.snapshot.projects, one.snapshot.project.name, one.snapshot.project.roots, one.snapshot.sessions[0].projectId === one.snapshot.project.id], [undefined, "lib", ["/work/lib"], true]);
});

test("words covered in a bundle are covered letter for letter, so that every place in a text stays where it was", () => {
  const { snapshot, bodies } = madeUp();
  const bundle = makeBundle(snapshot, bodies, { sessions: ["a", "b"] });
  const { bundle: masked, covered } = maskBundle(bundle, ["total", "tally.py", "work", "sub", " ", "a"]); // capitals are not minded; a word of one letter is not taken
  assert.ok(covered > 0);
  const text = (from: typeof bundle, id: string) => from.items.find((item) => item.id === id)!.text;
  assert.equal(text(masked, "a:1"), SAID.replace("TOTAL", "•••••").replace("tally.py", "••••••••"));
  assert.deepEqual(masked.items.map((item) => item.text.length), bundle.items.map((item) => item.text.length));
  assert.ok(!JSON.stringify(masked.items).toLowerCase().includes("total"));
  // names and folders are covered; ids, and the tool's own words, are not
  assert.deepEqual(masked.snapshot.sessions.map((one) => [one.id, one.title, one.cwd, one.client]), [["a", "a", "/••••/app", "codex"], ["b", "b", "/••••/app", "codex"], ["sub", "•••", "/••••/app", "codex"]]);
  assert.deepEqual(masked.items.map((item) => item.id), bundle.items.map((item) => item.id));
  assert.deepEqual(masked.snapshot.project.roots, ["/••••/app"]);
  assert.equal(masked.items.find((item) => item.id === "a:2")!.path, "/••••/app/x.py");
  // what a link points at is the same stretch as before
  const strip = (from: typeof bundle) => from.snapshot.links.map(({ excerpt: _, ...rest }) => rest);
  assert.deepEqual(strip(masked), strip(bundle));
  const paste = masked.snapshot.links.find((link) => link.kind === "paste")!;
  assert.equal(paste.excerpt?.length, bundle.snapshot.links.find((link) => link.kind === "paste")!.excerpt?.length);
  assert.match(masked.snapshot.notes.at(-1)!, /^낱말 4개\(사용자 이름 등\)를 \d+곳에서 같은 글자 수의 ‘•’로 가렸습니다/);
  assert.equal(bundle.snapshot.notes.length + 1, masked.snapshot.notes.length);
  assert.equal(text(bundle, "a:1"), SAID); // the bundle it was made from is as it was
  const none = maskBundle(bundle, ["없는낱말", ""]);
  assert.deepEqual([none.bundle === bundle, none.covered], [true, 0]);
});

test("what a hook or a server left half done is cleared away: a piece taken and never let go waits again, unless it was written down as gone", () => {
  const home = join(scratchDir, "tidy-home");
  process.env.CONTEXT_FLOW_HOME = home;
  try {
    const row = (id: string, at: number): Pending => ({ id, at, from: { sessionId: "a", itemId: "a:1", start: 0, end: 2 }, to: { sessionId: "b" }, text: "조각", block: pieceBlock({ id, from: "‘a’ (Codex)", kind: "답변", text: "조각" }) });
    queuePieces([row("cf1", 10), row("cf2", 20), row("cf3", 30), row("cf4", 40)]);
    const dir = join(home, "pending", "b");
    renameSync(join(dir, "cf1.json"), join(dir, "cf1.json.123.taken")); // a hook took it and died before it wrote anything down
    renameSync(join(dir, "cf2.json"), join(dir, "cf2.json.456.taken")); // a hook took it, wrote it down, and died
    appendTransfers([{ id: "cf2", at: 21, from: row("cf2", 20).from, to: { sessionId: "b" }, text: "조각", via: "hook" }]);
    renameSync(join(dir, "cf3.json"), join(dir, "cf3.json.sending")); // a server took it to send, and died
    writeFileSync(join(dir, ".cf9.part"), "{\"id\":"); // half written
    mkdirSync(join(home, "pending", "empty"));
    mkdirSync(join(home, "pieces"));
    writeFileSync(join(home, "pieces", "cf0.txt"), "긴 조각의 전문");
    const now = Date.now();
    assert.deepEqual(tidyStore(now + 60_000), { back: 0, gone: 0 }); // it may be on its way right now: left alone
    assert.deepEqual(readdirSync(dir).sort(), [".cf9.part", "cf1.json.123.taken", "cf2.json.456.taken", "cf3.json.sending", "cf4.json"]);
    assert.deepEqual(tidyStore(now + 11 * 60_000), { back: 2, gone: 2 });
    assert.deepEqual(readdirSync(dir).sort(), ["cf1.json", "cf3.json", "cf4.json"]);
    assert.deepEqual(readPending().map((one) => one.id), ["cf1", "cf3", "cf4"]);
    assert.deepEqual(readdirSync(join(home, "pending")), ["b"]); // a folder nothing waits in is gone
    assert.deepEqual(readdirSync(join(home, "pieces")), ["cf0.txt"]);
    assert.deepEqual(tidyStore(now + 15 * 24 * 3600_000), { back: 0, gone: 1 }); // the whole text of a long piece is kept two weeks
    assert.deepEqual(readdirSync(join(home, "pieces")), []);
    assert.deepEqual(readPending().map((one) => one.id), ["cf1", "cf3", "cf4"]); // what waits is never cleared away, however long it waits
  } finally {
    delete process.env.CONTEXT_FLOW_HOME;
  }
});
test("a screen is told of changes to the records of its own sessions, of a record it does not know once, and of pieces and of what processes say always", () => {
  const known = new Set(["/records/mine.jsonl"]);
  const interest = new Interest();
  const records = (path: string) => ({ where: "records" as const, path });
  assert.equal(interest.matters(records("/records/mine.jsonl"), known), true);
  // a record that is not known may be a session just begun: it matters until the records were read and did not hold it
  assert.equal(interest.matters(records("/records/other.jsonl"), known), true);
  assert.equal(interest.matters(records("/records/other.jsonl"), known), true);
  interest.settle(known);
  assert.equal(interest.matters(records("/records/other.jsonl"), known), false);
  assert.equal(interest.matters(records("/records/mine.jsonl"), known), true);
  // it turned out to be a session of the screen's after all (a later reading holds it): it matters again
  assert.equal(interest.matters(records("/records/other.jsonl"), new Set([...known, "/records/other.jsonl"])), true);
  // before anything was read for the screen, everything matters
  assert.equal(new Interest().matters(records("/records/any.jsonl"), null), true);
  assert.equal(interest.matters({ where: "flow", path: "/flow/pending/x/y.json" }, known), true);
  assert.equal(interest.matters({ where: "live", path: "/live/1.json" }, known), true);
});

test("a record that is kept open and added to is found to have grown by looking at it, since nothing tells of it", () => {
  const dir = join(scratchDir, "grown");
  mkdirSync(dir, { recursive: true });
  const held = join(dir, "held.jsonl");
  const still = join(dir, "still.jsonl");
  writeFileSync(still, "a line\n");
  const fd = openSync(held, "a"); // as Codex holds a thread's record: opened once, written to, not closed
  try {
    const seen = new Map<string, number>();
    // the first look only takes note
    assert.deepEqual(grown([held, still, join(dir, "none.jsonl")], seen), []);
    writeSync(fd, "one more line\n");
    assert.deepEqual(grown([held, still], seen), [held]);
    assert.deepEqual(grown([held, still], seen), []);
    writeSync(fd, "and another\n");
    writeFileSync(still, "a line\nmore\n");
    assert.deepEqual(grown([held, still], seen).sort(), [held, still].sort());
    // a record that went away has not changed: there is nothing to read
    rmSync(still);
    assert.deepEqual(grown([held, still], seen), []);
  } finally {
    closeSync(fd);
  }
});
test("the files sent along with a message are kept under names that stay in their folder, and are no more or larger than is taken", () => {
  const home = join(scratchDir, "uploads-home");
  mkdirSync(home, { recursive: true });
  const before = process.env.CONTEXT_FLOW_HOME;
  process.env.CONTEXT_FLOW_HOME = home;
  try {
    const data = (text: string) => Buffer.from(text).toString("base64");
    assert.deepEqual(saveUploads(undefined), { dir: null, saved: [] });
    const kept = saveUploads([{ name: "shot.png", type: "image/png", data: data("p") }, { name: "../../etc/passwd", type: "", data: data("x") }, { name: "a.log", type: "text/plain", data: data("one") }, { name: "a.log", type: "text/plain", data: data("two") }, { name: ".hidden$(rm).sh", type: "text/x-sh", data: data("s") }, { name: "pic.svg", type: "image/svg+xml", data: data("<svg/>") }]);
    assert.deepEqual(kept.saved.map((one) => [one.name, one.image]), [["shot.png", true], ["passwd", false], ["a.log", false], ["a-2.log", false], ["hidden_(rm).sh", false], ["pic.svg", false]]);
    for (const one of kept.saved) assert.equal(dirname(one.path), kept.dir);
    assert.ok(kept.dir!.startsWith(join(home, "uploads")));
    assert.equal(readFileSync(kept.saved[3].path, "utf8"), "two");
    assert.throws(() => saveUploads(Array.from({ length: 9 }, (_, n) => ({ name: n + ".txt", type: "text/plain", data: data("x") }))), /8개까지/);
    assert.throws(() => saveUploads([{ name: "big.bin", type: "", data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }]), /10MB/);
    // what is thirty days old goes when the store is tidied; what is newer stays
    const old = join(home, "uploads", "long-ago");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "x.txt"), "x");
    tidyStore(Date.now() + 31 * 24 * 3600_000);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(kept.dir!), false);
  } finally {
    if (before === undefined) delete process.env.CONTEXT_FLOW_HOME;
    else process.env.CONTEXT_FLOW_HOME = before;
  }
});

test("what was typed in a message is known apart from the list of files that went along with it", () => {
  const typed = "이 로그를 봐줘";
  const note = filesNote(["/keep/a b.log", "/keep/c.csv"]);
  assert.deepEqual(filesIn(typed + note), ["/keep/a b.log", "/keep/c.csv"]);
  assert.equal(withoutPieces(typed + note), typed);
  const whole = withBlocks(typed + note, [pieceBlock({ id: "cf1", from: "‘다른 세션’ (Codex)", kind: "답변", text: "조각" })]);
  assert.equal(withoutPieces(whole), typed);
  assert.deepEqual(filesIn(whole), ["/keep/a b.log", "/keep/c.csv"]);
  assert.equal(filesNote([]), "");
  assert.deepEqual(filesIn(typed), []);
  // the words alone, when somebody happens to type them, are not a list of files
  assert.equal(withoutPieces("그 말은 " + FILES_NOTE + " 라는 뜻"), "그 말은 " + FILES_NOTE + " 라는 뜻");
});

test("a Claude Code session forked from another begins with copies of that one's records: they are the other's, and the fork is what was said in it", async () => {
  const home = join(scratchDir, "claude-fork");
  const cwd = "/work/forked";
  const dir = join(home, "projects", folderName(cwd));
  mkdirSync(dir, { recursive: true });
  const user = (id: string, uuid: string, at: string, content: string) => ({ type: "user", uuid, sessionId: id, cwd, timestamp: at, message: { role: "user", content } });
  const agent = (id: string, uuid: string, at: string, text: string) => ({ type: "assistant", uuid, sessionId: id, cwd, timestamp: at, message: { role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text }] } });
  const base = [user("base", "u1", "2026-01-01T00:00:00Z", "암호는 moonstone"), agent("base", "a1", "2026-01-01T00:00:05Z", "알겠습니다"),
    user("base", "u2", "2026-01-01T00:01:00Z", "이제 잊어"), agent("base", "a2", "2026-01-01T00:01:05Z", "네")];
  writeFileSync(join(dir, "base.jsonl"), base.map(line).join(""));
  // the fork: where it comes from, the other's first turn under the fork's id, then what was said in the fork itself
  writeFileSync(join(dir, "fork.jsonl"), line({ type: "derived-from", v: 1, sessionId: "fork", sessions: [{ type: "claude_code_session", id: "base", via: "fork" }] })
    + base.slice(0, 2).map((row) => line({ ...row, sessionId: "fork" })).join("")
    + line(user("fork", "u3", "2026-01-01T00:02:00Z", "암호가 뭐였지?")) + line(agent("fork", "a3", "2026-01-01T00:02:05Z", "moonstone")));
  const project: Project = { id: "p", name: "forked", roots: [cwd] };
  const { transcripts } = await readClaudeSessions(project, home, Date.parse("2026-01-01T01:00:00Z"));
  const fork = transcripts.find((one) => one.session.id === "fork")!;
  assert.deepEqual([fork.session.origin, fork.session.parentId, fork.session.title], ["fork", "base", "암호가 뭐였지?"]);
  assert.equal(fork.forkKept, "u1"); // the last request it was given: it was made before the next one
  // its items keep the numbers their records give them, whatever is left out
  assert.deepEqual(fork.items.map((item) => [item.id, item.kind, item.text]), [["fork:2", "prompt", "암호가 뭐였지?"], ["fork:3", "answer", "moonstone"]]);
  assert.equal(fork.session.startedAt, Date.parse("2026-01-01T00:02:00Z"));
  assert.deepEqual(transcripts.find((one) => one.session.id === "base")!.items.length, 4);
  assert.deepEqual(recordedLinks(transcripts.map((one) => one.session)).links.map((link) => [link.kind, link.from.sessionId, link.to.sessionId]), [["fork", "base", "fork"]]);
  // where a session is carried on from, to say one of its requests again: the record of the last answer before it
  assert.deepEqual(await stoodBefore(join(dir, "base.jsonl"), "u2"), { at: "a1" });
  assert.deepEqual(await stoodBefore(join(dir, "base.jsonl"), "u1"), { at: null }); // nothing was said before the first
  assert.deepEqual(await stoodBefore(join(dir, "base.jsonl"), "nowhere"), { not: "found" });
  // in the fork, before its own first request stands the copy of the other's answer
  assert.deepEqual(await stoodBefore(join(dir, "fork.jsonl"), "u3"), { at: "a1" });
  // A fork of the fork, made before the fork's own request: its record names the whole way it came, the nearest last,
  // and begins with the same copies. It is a fork of the fork, and nothing of either is its own.
  writeFileSync(join(dir, "again.jsonl"), line({ type: "derived-from", v: 1, sessionId: "again", sessions: [{ type: "claude_code_session", id: "base", via: "fork" }, { type: "claude_code_session", id: "fork", via: "fork" }] })
    + base.slice(0, 2).map((row) => line({ ...row, sessionId: "again" })).join("") + line(user("again", "u4", "2026-01-01T00:03:00Z", "암호는 몇 글자지?")) + line(agent("again", "a4", "2026-01-01T00:03:05Z", "9")));
  const later = (await readClaudeSessions(project, home, Date.parse("2026-01-01T01:00:00Z"))).transcripts.find((one) => one.session.id === "again")!;
  assert.deepEqual([later.session.origin, later.session.parentId, later.items.map((item) => item.text).join(" / "), later.forkKept], ["fork", "fork", "암호는 몇 글자지? / 9", "u1"]);
});

test("a Claude Code talk that was taken back is read the way it came, not the way its records lie", async () => {
  // The shapes are those Claude Code 2.1.332 wrote when a talk was taken back (/rewind) and summed up in part.
  const home = join(scratchDir, "claude-back");
  const cwd = "/work/back";
  const dir = join(home, "projects", folderName(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "back.jsonl");
  let second = 0;
  const row = (type: string, uuid: string, parentUuid: string | null, more: Record<string, unknown> = {}) => line({ type, uuid, parentUuid, sessionId: "back", cwd, timestamp: new Date(Date.parse("2026-01-01T00:00:00Z") + 1000 * second++).toISOString(), ...more });
  const user = (uuid: string, parent: string | null, content: string) => row("user", uuid, parent, { message: { role: "user", content } });
  const agent = (uuid: string, parent: string, text: string) => row("assistant", uuid, parent, { message: { role: "assistant", model: "claude-x", stop_reason: "end_turn", content: [{ type: "text", text }] } });
  const ended = (uuid: string, parent: string) => row("system", uuid, parent, { subtype: "turn_duration" });
  const mark = (uuid: string, head: string, after: string, tail: string) => row("system", uuid, null, { subtype: "compact_boundary", logicalParentUuid: tail, compactMetadata: { preservedSegment: { headUuid: head, anchorUuid: after, tailUuid: tail } } });
  const summary = (uuid: string, parent: string) => row("user", uuid, parent, { isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context." } });
  const project: Project = { id: "p", name: "back", roots: [cwd] };
  const read = async () => (await readClaudeSessions(project, home, Date.parse("2026-01-01T01:00:00Z"))).transcripts[0];
  const said = (transcript: Awaited<ReturnType<typeof read>>) => transcript.items.map((item) => item.id.slice(5) + " " + item.text).join(" / ");

  // Three requests; then the talk is taken back to before the second, and a fourth is made there. The fourth names the
  // end of the first turn as what it was made after. Two answers name a record that was never written (as some
  // versions did): the record written just before stands for it.
  writeFileSync(path, row("attachment", "h0", null, { attachment: { type: "hook_success" } })
    + user("u1", "h0", "하나: 사과") + agent("a1", "u1", "사과") + ended("e1", "a1")
    + user("u2", "e1", "둘: 배") + agent("a2", "not-written", "배") + ended("e2", "a2")
    + user("u3", "e2", "셋: 감") + agent("a3", "u3", "감") + ended("e3", "a3")
    + user("u4", "e1", "넷: 귤") + agent("a4", "not-written-either", "사과, 귤") + ended("e4", "a4"));
  let talk = await read();
  // the turns that were taken back are not the talk; the items keep the numbers their records give them
  assert.equal(said(talk), "0 하나: 사과 / 1 사과 / 6 넷: 귤 / 7 사과, 귤");
  // what was taken back is kept beside the talk, and is shown before the request made in its stead
  assert.deepEqual(talk.gone?.map((stretch) => stretch.map((item) => item.id.slice(5) + " " + item.text).join(" / ")), ["2 둘: 배 / 3 배 / 4 셋: 감 / 5 감"]);
  assert.deepEqual(goneOf(talk.items, "back", talk.gone).map((one) => [one.before, one.items.length]), [["back:6", 4]]);
  assert.deepEqual([talk.session.counts.prompts, talk.session.counts.answers, talk.session.title], [2, 2, "하나: 사과"]);
  // to say the fourth request again, the talk is taken up at the first answer: not at the answer written just before it
  assert.deepEqual(await stoodBefore(path, "u4"), { at: "a1" });
  assert.deepEqual(await stoodBefore(path, "u1"), { at: null });
  assert.deepEqual(await stoodBefore(path, "u3"), { not: "back" });

  // "Summarize from here" at the fourth request: a mark that names no record before it, the summary, and on. The
  // summary is not something the user asked. What it was made of was said, and stays; what the mark says was left
  // as it was said (the first turn) is the beginning of what Claude Code can take up again.
  appendFileSync(path, mark("m1", "h0", "m1", "e1") + summary("c1", "m1") + user("u5", "c1", "다섯: 밤") + agent("a5", "u5", "밤") + ended("e5", "a5"));
  talk = await read();
  assert.equal(said(talk), "0 하나: 사과 / 1 사과 / 6 넷: 귤 / 7 사과, 귤 / 8 다섯: 밤 / 9 밤");
  assert.deepEqual(await stoodBefore(path, "u5"), { at: "c1" }); // after the summary: the summary itself
  assert.deepEqual(await stoodBefore(path, "u4"), { not: "summed" }); // it cannot be gone back to before a summary
  assert.deepEqual(await stoodBefore(path, "u1"), { at: null }); // the stretch left as it was said begins with it
  assert.deepEqual(await stoodBefore(path, "u2"), { not: "back" });

  // "Summarize up to here" at the fifth request: the fifth turn is left as it was said and is taken to come after
  // the summary. A sixth request follows; then the talk is taken back, and a seventh names the summary.
  appendFileSync(path, mark("m2", "u5", "c2", "e5") + summary("c2", "m2") + row("attachment", "x6", "c2", { attachment: { type: "model" } })
    + user("u6", "x6", "여섯: 잣") + agent("a6", "u6", "잣") + ended("e6", "a6") + user("u7", "c2", "일곱: 깨") + agent("a7", "u7", "깨"));
  talk = await read();
  assert.equal(said(talk), "0 하나: 사과 / 1 사과 / 6 넷: 귤 / 7 사과, 귤 / 8 다섯: 밤 / 9 밤 / 12 일곱: 깨 / 13 깨");
  assert.deepEqual(talk.gone?.map((stretch) => stretch.map((item) => item.text).join(" / ")), ["둘: 배 / 배 / 셋: 감 / 감", "여섯: 잣 / 잣"]);
  assert.deepEqual(goneOf(talk.items, "back", talk.gone).map((one) => one.before), ["back:6", "back:12"]);
  assert.deepEqual(await stoodBefore(path, "u7"), { at: "a5" }); // the stretch the summary left comes before it
  assert.deepEqual(await stoodBefore(path, "u5"), { at: "c2" }); // and the summary before that stretch
  assert.deepEqual(await stoodBefore(path, "u6"), { not: "back" });
  assert.deepEqual(await stoodBefore(path, "u4"), { not: "summed" });

  // A talk taken back to before its first request: the next request says nothing was before it.
  rmSync(path);
  writeFileSync(join(dir, "start.jsonl"), user("v1", null, "쌀") + agent("b1", "v1", "쌀") + user("v2", "b1", "밀") + agent("b2", "v2", "밀") + user("v3", null, "귀리") + agent("b3", "v3", "귀리"));
  talk = await read();
  assert.equal(talk.items.map((item) => item.id + " " + item.text).join(" / "), "start:4 귀리 / start:5 귀리");
  assert.deepEqual(talk.gone?.map((stretch) => stretch.map((item) => item.text).join(" ")), ["쌀 쌀 밀 밀"]);
  assert.deepEqual(await stoodBefore(join(dir, "start.jsonl"), "v3"), { at: null });

  // An answer has been seen written before the request it names (one record of one real talk): the way the talk
  // came is still followed, and nothing is left out for it.
  rmSync(join(dir, "start.jsonl"));
  writeFileSync(join(dir, "early.jsonl"), agent("d1", "w1", "먼저 적힌 답") + ended("f1", "d1") + row("attachment", "g0", null, { attachment: { type: "hook_success" } }) + user("w1", "g0", "나중에 적힌 요청")
    + user("w2", "f1", "다음 요청") + agent("d2", "w2", "다음 답"));
  talk = await read();
  assert.equal(talk.items.map((item) => item.text).join(" / "), "먼저 적힌 답 / 나중에 적힌 요청 / 다음 요청 / 다음 답");
  assert.deepEqual(await stoodBefore(join(dir, "early.jsonl"), "w2"), { at: "d1" });
});

test("a Codex thread is forked after the turn before the request to be said again; a fork's own first request, where the fork itself was made", async () => {
  const dir = join(scratchDir, "codex-fork");
  mkdirSync(dir, { recursive: true });
  const item = (turn: string, kind: Item["kind"], n: number, of = "base"): Item => ({ id: of + ":" + n, sessionId: of, turnId: turn, kind, at: n, text: kind + " " + n });
  const own = [item("t1", "prompt", 0), item("t1", "answer", 1), item("t2", "prompt", 2), item("t2", "change", 3), item("t2", "answer", 4), item("t3", "prompt", 5)];
  const base = session("base");
  assert.deepEqual(forkPoint(base, own, own[5]), { from: "base", at: "t2" });
  assert.deepEqual(forkPoint(base, own, own[2]), { from: "base", at: "t1" });
  assert.equal(forkPoint(base, own, own[0]), null); // nothing before the first request: there is nothing to keep
  assert.equal(forkPoint(base, [{ ...own[0], turnId: null }], { ...own[0], turnId: null }), undefined); // an older record does not say
  // The base's record, and a fork of it that keeps its first two turns: the fork's record says how far into the base's its history goes.
  const turnLine = (turn: string, type: string) => line({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type, turn_id: turn } });
  const kept = line({ type: "session_meta", payload: { id: "base" } }) + turnLine("t1", "task_started") + turnLine("t1", "task_complete") + turnLine("t2", "task_started") + line({ type: "response_item", payload: { type: "message", content: "한글이 든 줄 " + "가".repeat(400) } }) + turnLine("t2", "task_complete");
  writeFileSync(join(dir, "base.jsonl"), kept + turnLine("t3", "task_started") + turnLine("t3", "task_complete"));
  writeFileSync(join(dir, "fork.jsonl"), line({ type: "session_meta", payload: { id: "fork", forked_from_id: "base", history_base: { thread_id: "base", end_byte_offset: Buffer.byteLength(kept) } } }) + turnLine("f1", "task_started"));
  // (here a file is simply named after its thread)
  const files: RecordFiles = { fileOf: (own) => (["base", "fork", "again"].includes(own) ? { thread: own, path: join(dir, own + ".jsonl") } : null), seqOf: () => 0, filesOf: () => [] };
  const fork = session("fork", { origin: "fork", parentId: "base", recordPath: join(dir, "fork.jsonl") });
  const first = item("f1", "prompt", 0, "fork");
  assert.deepEqual(forkPoint(fork, [first, item("f1", "answer", 1, "fork")], first, files), { from: "base", at: "t2" });
  // read as a record, the fork says the same of itself; and the last turn it keeps of the base is found from that
  const read = await readRollout("fork", join(dir, "fork.jsonl"), files);
  assert.deepEqual(read?.base, { thread: "base", file: join(dir, "base.jsonl"), end: Buffer.byteLength(kept) });
  assert.equal(keptTurn(read!.base!.file, read!.base!.end), "t2");
  // a fork of that fork, made before anything was said in it: its history is still the base's
  writeFileSync(join(dir, "again.jsonl"), line({ type: "session_meta", payload: { id: "again", forked_from_id: "fork", history_base: { thread_id: "fork", end_byte_offset: Buffer.byteLength(readFileSync(join(dir, "fork.jsonl"), "utf8").split("\n")[0]) + 1 } } }));
  const again = session("again", { origin: "fork", parentId: "fork", recordPath: join(dir, "again.jsonl") });
  const theirs = item("g1", "prompt", 0, "again");
  assert.deepEqual(forkPoint(again, [theirs], theirs, files), { from: "base", at: "t2" });
  // a fork whose record does not say where its history ends is not guessed at
  writeFileSync(join(dir, "old.jsonl"), line({ type: "session_meta", payload: { id: "old", forked_from_id: "base" } }));
  assert.equal(forkPoint(session("old", { origin: "fork", parentId: "base", recordPath: join(dir, "old.jsonl") }), [theirs], theirs, files), undefined);
});

test("what makes the screen an app is served as what it is, and the page shown while the server is down needs nothing from it", async () => {
  // The files lie beside the screen's own and are served with it. Here they are served from where they are kept.
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");
  const served = serve(0, dir);
  const at = "http://127.0.0.1:" + (await served.ready);
  try {
    const got = await fetch(at + "/manifest.webmanifest");
    assert.match(got.headers.get("content-type") ?? "", /^application\/manifest\+json/);
    const manifest = (await got.json()) as { name: string; display: string; start_url: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
    assert.deepEqual([manifest.name, manifest.display, manifest.start_url], ["맥락 흐름", "standalone", "/"]);
    // a browser makes an app of the page only with icons of these sizes, each of which is there and is what it says
    assert.ok(["192x192", "512x512"].every((size) => manifest.icons.some((icon) => icon.sizes === size && icon.type === "image/png" && icon.purpose === "any")));
    for (const icon of manifest.icons) {
      const file = await fetch(at + icon.src);
      assert.equal(file.status, 200, icon.src);
      assert.equal(file.headers.get("content-type"), icon.type, icon.src);
      if (icon.type !== "image/png") continue;
      const bytes = Buffer.from(await file.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", icon.src);
      assert.equal(bytes.readUInt32BE(16) + "x" + bytes.readUInt32BE(20), icon.sizes, icon.src); // as wide and as high as it says
    }
    assert.match((await fetch(at + "/sw.js")).headers.get("content-type") ?? "", /^text\/javascript/);
    // The page the worker keeps is all there is while the server is down: it brings what it shows, and asks the
    // server only whether it is back.
    const page = readFileSync(join(dir, "offline.html"), "utf8");
    assert.ok(!/\s(?:src|href)=/.test(page));
    assert.deepEqual([...page.matchAll(/fetch\("([^"]+)"/g)].map((found) => found[1]), ["/api/projects"]);
    assert.ok(readFileSync(join(dir, "sw.js"), "utf8").includes('"/offline.html"'));
  } finally {
    await served.close();
  }
});

test("the pictures that went with a request are read from the client's record, where they are kept; a file is read only if this tool kept it", async () => {
  const dir = join(scratchDir, "pictures");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const before = process.env.CONTEXT_FLOW_HOME;
  process.env.CONTEXT_FLOW_HOME = home;
  forgetPictures();
  try {
    const dot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"); // a picture of one dot
    const png = { type: "image", source: { type: "base64", media_type: "image/png", data: dot.toString("base64") } };
    const read = async (client: "codex" | "claude", path: string, turn: string) => (await picturesOf(client, path, turn)).map((one) => one.type + (one.bytes.equals(dot) ? " dot" : " " + one.bytes.toString("utf8")));
    // Claude Code: the request's own record holds them
    const claude = join(dir, "claude.jsonl");
    writeFileSync(claude,
      line({ type: "user", uuid: "u1", message: { role: "user", content: [png, { type: "text", text: "이 그림을 봐줘" }] } }) +
      line({ type: "user", uuid: "t1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [png] }] } }) +
      line({ type: "user", uuid: "u2", message: { role: "user", content: "그림 없는 말" } }));
    assert.deepEqual(await read("claude", claude, "u1"), ["image/png dot"]);
    assert.deepEqual(await read("claude", claude, "t1"), []); // a picture a tool gave back was not sent with a request
    assert.deepEqual(await read("claude", claude, "u2"), []);
    // the record goes on: what was added is found without the rest being read again, a line half written is left for the next time
    const jpeg = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("jpeg").toString("base64") } };
    const next = line({ type: "user", uuid: "u3", message: { role: "user", content: [{ type: "text", text: "둘 더" }, jpeg, png] } });
    appendFileSync(claude, next.slice(0, 40));
    assert.deepEqual(await read("claude", claude, "u3"), []);
    appendFileSync(claude, next.slice(40));
    assert.deepEqual(await read("claude", claude, "u3"), ["image/jpeg jpeg", "image/png dot"]);
    assert.deepEqual(await read("claude", claude, "u1"), ["image/png dot"]);
    // Codex: what went to the model in the turn holds them; the request's own item names a file, which may be gone
    const address = "data:image/png;base64," + dot.toString("base64");
    const asked = (turn: string, content: unknown[]) => line({ type: "event_msg", payload: { type: "item_completed", turn_id: turn, item: { type: "UserMessage", content: [{ type: "text", text: "봐줘" }, ...content] } } });
    const kept = saveUploads([{ name: "kept.png", type: "image/png", data: dot.toString("base64") }]).saved[0].path;
    const stray = join(dir, "stray.png");
    writeFileSync(stray, dot);
    const codex = join(dir, "rollout.jsonl");
    writeFileSync(codex,
      asked("t1", [{ type: "local_image", path: "/nowhere/gone.png" }, { type: "local_image", path: "/nowhere/gone-2.png" }]) +
      line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "봐줘" }, { type: "input_image", image_url: address }, { type: "input_text", text: "</image>" }, { type: "input_image", image_url: "data:image/webp;base64," + Buffer.from("webp").toString("base64") }], internal_chat_message_metadata_passthrough: { turn_id: "t1" } } }) +
      asked("t2", [{ type: "image", image_url: address }]) + // pasted in the app: in the item itself
      asked("t3", [{ type: "local_image", path: stray }]) + // a file that is not one this tool kept is not read, wherever it lies
      asked("t4", [{ type: "local_image", path: kept }]));
    assert.deepEqual(await read("codex", codex, "t1"), ["image/png dot", "image/webp webp"]);
    assert.deepEqual(await read("codex", codex, "t2"), ["image/png dot"]);
    assert.deepEqual(await read("codex", codex, "t3"), []);
    assert.deepEqual(await read("codex", codex, "t4"), ["image/png dot"]);
    assert.deepEqual(await read("codex", codex, "no such turn"), []);
    assert.deepEqual(await read("codex", join(dir, "no such record"), "t1"), []);
    // only a file in the tool's own folder of such files is one it kept: not one beside it, nor one a link in it leads to
    assert.equal(uploadedFile(kept), realpathSync(kept));
    assert.equal(uploadedFile(stray), null);
    assert.equal(uploadedFile(join(dirname(kept), "..", "..", "..", "stray.png")), null);
    symlinkSync(stray, join(dirname(kept), "link.png"));
    assert.equal(uploadedFile(join(dirname(kept), "link.png")), null);
    assert.equal(uploadedFile(dirname(kept)), null); // a folder is not a file
  } finally {
    if (before === undefined) delete process.env.CONTEXT_FLOW_HOME;
    else process.env.CONTEXT_FLOW_HOME = before;
  }
});

test("a fork's line says which request of its parent it was made before, for a fork of either client, and a piece is followed into a fork only if it was said before that request", () => {
  const item = (of: string, n: number, kind: Item["kind"], turn: string, at: number, text = kind + " " + n): Item => ({ id: of + ":" + n, sessionId: of, turnId: turn, kind, at, text });
  // a session of three requests
  const base = [item("base", 0, "prompt", "t1", 100), item("base", 1, "answer", "t1", 110, "원인은 잠금 없이 읽고 쓰는 데 있습니다. 좌석 행을 잠그면 막을 수 있습니다. 이 문장은 따라가는 조각입니다."),
    item("base", 2, "prompt", "t2", 200), item("base", 3, "change", "t2", 205), item("base", 4, "answer", "t2", 210, "두 번째 답에서 나온 결론입니다. 유일 제약을 거는 쪽이 더 낫다는 것, 이것도 따라가 볼 조각입니다."),
    item("base", 5, "prompt", "t3", 300), item("base", 6, "answer", "t3", 310)];
  const fork = (id: string, parent: string, at: number) => session(id, { origin: "fork", parentId: parent, startedAt: at, updatedAt: at });
  const sessions = [session("base", { startedAt: 100 }), fork("codex-fork", "base", 400), fork("codex-end", "base", 410), fork("codex-lost", "base", 420), fork("unsaid", "base", 430)];
  const said = [...base, item("codex-fork", 0, "prompt", "f1", 400), item("codex-end", 0, "prompt", "e1", 410)];
  // Codex names the last turn the fork keeps: the fork was made before the first request after that turn
  const kept = new Map<string, Kept>([["codex-fork", { turn: "t1" }], ["codex-end", { turn: "t3" }], ["codex-lost", { turn: "no such turn" }]]);
  const before = forkedBefore(sessions, said, kept);
  assert.deepEqual([...before], [["codex-fork", "base:2"]]); // made after all that was said: no such request; a turn that is not there, or nothing said of it: not known
  const { links } = recordedLinks(sessions, before);
  assert.deepEqual(links.map((link) => [link.to.sessionId, link.from.itemId ?? null]), [["codex-fork", "base:2"], ["codex-end", null], ["codex-lost", null], ["unsaid", null]]);
  // the parent is spoken to again after a fork was made at its end: that request is one the fork does not know
  assert.deepEqual([...forkedBefore(sessions, [...said, item("base", 7, "prompt", "t4", 500)], kept)], [["codex-fork", "base:2"], ["codex-end", "base:7"]]);
  // Claude Code names the last request the fork was given. A fork of a fork, made before anything was said in it,
  // was given none of that fork's own: it was made before the fork's first request.
  const claude = [session("c", { client: "claude" }), { ...fork("c-fork", "c", 400), client: "claude" as const }, { ...fork("c-again", "c-fork", 500), client: "claude" as const }, { ...fork("c-odd", "c", 600), client: "claude" as const }];
  const talk = [item("c", 0, "prompt", "u1", 100), item("c", 1, "answer", "u1", 110), item("c", 2, "prompt", "u2", 200), item("c", 3, "answer", "u2", 210), item("c-fork", 2, "prompt", "u3", 400), item("c-fork", 3, "answer", "u3", 410), item("c-again", 2, "prompt", "u4", 500)];
  assert.deepEqual([...forkedBefore(claude, talk, new Map([["c-fork", { request: "u1" }], ["c-again", { request: "u1" }], ["c-odd", { request: "not there" }]]))], [["c-fork", "c:2"], ["c-again", "c-fork:2"]]);
  // A piece of the first answer went into the fork made before the second request; a piece of the second answer did
  // not, though the fork began long after it was said. The fork made at the end has both.
  const bodies = new Map(said.map((one) => [one.id, one]));
  const into = (itemId: string) => tracePiece({ sessionId: "base", itemId, start: 0, end: 30 }, links, bodies, sessions).filter((step) => step.dir === "onward").map((step) => step.link.to.sessionId).sort();
  assert.deepEqual(into("base:1"), ["codex-end", "codex-fork", "codex-lost", "unsaid"]);
  assert.deepEqual(into("base:4"), ["codex-end", "codex-lost", "unsaid"]);
});

test("a piece cut from what a session left behind goes where it was sent, and is followed there and no further out of its session", () => {
  const LEFT = "고치기 전의 답에만 있던 문단입니다. 좌석을 누르면 곧바로 예약하게 하면 확인 단계가 없어서, 잘못 누른 좌석도 그대로 예약됩니다.";
  // a: a talk of two turns; between them, an answer that was said and then left behind (its request was said again)
  const talk = [say("a", 0, "prompt", 100_000, "배치도를 만들어줘"), say("a", 1, "answer", 110_000, "만들었습니다"),
    say("a", 1_000_000, "prompt", 300_000, "누르면 폼에 골라지게만 해줘"), say("a", 1_000_001, "answer", 310_000, "그렇게 했습니다. " + LEFT)]; // (it says the same again, later)
  const behind = say("a", 3, "answer", 210_000, LEFT);
  const left = new Map([[behind.id, behind]]);
  // the piece is sent to b, and back to a itself; what a said later is sent to c; d is a fork of a
  const sent = (id: string, to: string, from: Item) => ({ id, at: 900_000, from: { sessionId: "a", itemId: from.id, start: from.text.indexOf(LEFT), end: from.text.indexOf(LEFT) + LEFT.length }, to: { sessionId: to }, text: LEFT });
  const got = (session: string, n: number, at: number, id: string) => say(session, n, "prompt", at, withPieces("이것을 참고해줘", [{ id, from: "‘a’ (Codex)", kind: "답변", text: LEFT }]));
  const items = [...talk, got("b", 0, 1_000_000, "cf1"), got("a", 2_000_000, 1_100_000, "cf2"), got("c", 0, 1_200_000, "cf3"), say("d", 0, "prompt", 1_300_000, "갈라진 쪽의 요청")];
  const transfers: Transfer[] = [sent("cf1", "b", behind), sent("cf2", "a", behind), sent("cf3", "c", talk[3])];
  const sessions = [session("a", { startedAt: 100_000 }), session("b", { startedAt: 1_000_000 }), session("c", { startedAt: 1_200_000 }), session("d", { origin: "fork", parentId: "a", startedAt: 1_300_000 })];
  const links = [...recordedLinks(sessions).links, ...transferLinks(transfers, items, left)];
  // the lines are drawn as for any piece; the one out of what was left behind is said to have been said when that was
  const line = (id: string) => links.find((link) => link.id === "transfer:" + id)!;
  assert.deepEqual([line("cf1").from.itemId, line("cf1").from.at, line("cf1").to.itemId], ["a:3", 210_000, "b:0"]);
  assert.deepEqual([line("cf2").from.sessionId, line("cf2").to.sessionId, line("cf2").to.itemId], ["a", "a", "a:2000000"]); // back into the session that left it behind
  assert.equal(transferLinks(transfers, items).find((link) => link.id === "transfer:cf1")!.from.at, 900_000); // (when it is not known: when it was sent)
  const bodies = new Map(items.map((item) => [item.id, item]));
  const way = (piece: Item, dir: "back" | "onward", known = left, among = links) => tracePiece({ sessionId: piece.sessionId, itemId: piece.id, start: 0, end: piece.text.length }, among, bodies, sessions, [], known).filter((step) => step.dir === dir).map((step) => step.link.id).sort();
  // From what was left behind: to where the piece itself was sent. Not on with what the session said later (though
  // that holds the same words), and not into the fork: the session had it no more.
  assert.deepEqual(way(behind, "onward", left, links.filter((link) => link.id !== "transfer:cf2")), ["transfer:cf1"]);
  // Sent back into its own session, it is in that session's talk again from then on: the fork made after that has it.
  assert.deepEqual(way(behind, "onward"), ["fork:a>d", "transfer:cf1", "transfer:cf2"]);
  // from the same words as the session said them later, in its talk: on with what was cut from there, and into the fork
  assert.deepEqual(way(talk[3], "onward"), ["fork:a>d", "transfer:cf3"]);
  // where it arrived, the way back is the piece's own; without what was left behind there are no words to know it by
  assert.deepEqual(way(items[4], "back"), ["transfer:cf1"]);
  assert.deepEqual(way(items[4], "back", new Map()), []);
  assert.deepEqual(way(behind, "onward", new Map()), []); // and it is no item at all
});

test("a Codex thread whose request was said again in the app is read back through its files; a file is named by an id of its own", async () => {
  // As Codex keeps them: a folder for each day, a file named by when it was begun and the thread, and (for a file
  // begun when a request was said again) an id of its own at the end.
  const home = join(scratchDir, "codex-files");
  const day = join(home, "sessions", "2026", "01", "01");
  mkdirSync(day, { recursive: true });
  const T = "0aaaaaaa-0000-4000-8000-000000000001";
  const S = "0bbbbbbb-0000-4000-8000-000000000002"; // the file begun when the second request was said again
  const S2 = "0ccccccc-0000-4000-8000-000000000003"; // and the one begun when that was said again
  const F = "0ddddddd-0000-4000-8000-000000000004"; // a fork of the thread, made before any of that
  const G = "0eeeeeee-0000-4000-8000-000000000005"; // a fork made later, of the thread as it then stood
  const at = (minute: number) => "2026-01-01T00:" + String(minute).padStart(2, "0") + ":00Z";
  const turn = (id: string, minute: number, asked: string, answered: string) =>
    line({ timestamp: at(minute), type: "event_msg", payload: { type: "task_started", turn_id: id } }) +
    line({ timestamp: at(minute), type: "event_msg", payload: { type: "item_completed", turn_id: id, item: { type: "UserMessage", content: [{ type: "text", text: asked }] } } }) +
    line({ timestamp: at(minute), type: "event_msg", payload: { type: "item_completed", turn_id: id, item: { type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text: answered }] } } }) +
    line({ timestamp: at(minute), type: "event_msg", payload: { type: "task_complete", turn_id: id } });
  const meta = (id: string, more: object = {}) => line({ timestamp: at(0), type: "session_meta", payload: { id, ...more } });
  const lines = (text: string) => text.split("\n").length - 1;
  // the thread's first file: two turns
  const first = meta(T) + turn("t1", 1, "첫 요청", "첫 답");
  const one = join(day, "rollout-2026-01-01T00-00-00-" + T + ".jsonl");
  writeFileSync(one, first + turn("t2", 2, "고치기 전의 요청", "버려질 답"));
  // the second request said again: a file of its own, whose history is the first file up to before that request
  const second = meta(T, { history_base: { thread_id: T, end_ordinal_exclusive: lines(first), end_byte_offset: Buffer.byteLength(first) } });
  const two = join(day, "rollout-2026-01-01T01-00-00-" + T + "_" + S + ".jsonl");
  writeFileSync(two, second + turn("t3", 3, "고친 요청", "고친 답"));
  const files = recordFiles(home);
  assert.deepEqual([files.fileOf(T), files.fileOf(S), files.seqOf(one), files.seqOf(two)], [{ thread: T, path: one }, { thread: T, path: two }, 0, 1]);
  const read = (await readRollout(T, two, files))!;
  assert.deepEqual(read.items.map((item) => [item.id.slice(T.length + 1), item.kind, item.text]), [["0", "prompt", "첫 요청"], ["1", "answer", "첫 답"], ["1000000", "prompt", "고친 요청"], ["1000001", "answer", "고친 답"]]);
  assert.deepEqual([read.forkedFrom, read.base, read.files], [null, null, [{ path: one, end: Buffer.byteLength(first) }, { path: two }]]);
  // what was said after that place in the first file is of the talk no more: it is kept beside it, under the numbers it had
  assert.deepEqual(read.gone.map((stretch) => stretch.map((item) => item.id.slice(T.length + 1) + " " + item.text)), [["2 고치기 전의 요청", "3 버려질 답"]]);
  // and is shown before the request that was made in its stead
  assert.deepEqual(goneOf(read.items, T, read.gone).map((one) => [one.before?.slice(T.length + 1), one.items.length]), [["1000000", 2]]);
  // what the first file alone gives is what it always gave: the numbers of the thread's first file are not changed
  assert.deepEqual((await readRollout(T, one, files))!.items.map((item) => item.id.slice(T.length + 1) + " " + item.text), ["0 첫 요청", "1 첫 답", "2 고치기 전의 요청", "3 버려질 답"]);
  // the thread began when its first word was said, not when its newest file was begun
  const made = session(T, { startedAt: Date.parse(at(30)), updatedAt: Date.parse(at(30)) });
  applyRollout(made, read, Date.parse(at(40)));
  assert.deepEqual([made.startedAt, made.counts.prompts, made.origin], [Date.parse(at(1)), 2, "user"]);
  // said again once more: the new file names the second by that file's own id, and the second names the first
  const third = join(day, "rollout-2026-01-01T02-00-00-" + T + "_" + S2 + ".jsonl");
  writeFileSync(third, meta(T, { history_base: { thread_id: S, end_ordinal_exclusive: lines(first) + lines(second), end_byte_offset: Buffer.byteLength(second) } }) + turn("t4", 4, "또 고친 요청", "또 고친 답"));
  const later = (await readRollout(T, third, files))!;
  assert.deepEqual(later.items.map((item) => item.id.slice(T.length + 1) + " " + item.text), ["0 첫 요청", "1 첫 답", "2000000 또 고친 요청", "2000001 또 고친 답"]);
  assert.equal(later.files.length, 3);
  // each time the request was said again left a stretch behind: the first file's, and the second's own
  assert.deepEqual(later.gone.map((stretch) => stretch.map((item) => item.id.slice(T.length + 1) + " " + item.text)), [["2 고치기 전의 요청", "3 버려질 답"], ["1000000 고친 요청", "1000001 고친 답"]]);
  assert.deepEqual(goneOf(later.items, T, later.gone).map((one) => one.before?.slice(T.length + 1)), ["2000000", "2000000"]);
  // A fork made of the thread while its first file was all there was keeps naming that file, whatever the thread
  // has been through since: the last turn it keeps is found there.
  const whole = readFileSync(one, "utf8");
  const forked = join(day, "rollout-2026-01-01T00-30-00-" + F + ".jsonl");
  writeFileSync(forked, meta(F, { forked_from_id: T, history_base: { thread_id: T, end_ordinal_exclusive: lines(whole), end_byte_offset: Buffer.byteLength(whole) } }) + turn("f1", 5, "갈라진 쪽의 요청", "갈라진 쪽의 답"));
  const fork = (await readRollout(F, forked, files))!;
  assert.deepEqual([fork.forkedFrom, fork.base, fork.items.map((item) => item.id.slice(F.length + 1) + " " + item.text)], [T, { thread: T, file: one, end: Buffer.byteLength(whole) }, ["0 갈라진 쪽의 요청", "1 갈라진 쪽의 답"]]);
  assert.equal(keptTurn(fork.base!.file, fork.base!.end), "t2");
  // A fork made of the thread as it stood after the request was said again names the newer file, by that file's
  // own id (which is no thread's). It is a fork of the thread all the same, though its record does not say of what.
  const afterTwo = readFileSync(two, "utf8");
  const newer = join(day, "rollout-2026-01-01T03-00-00-" + G + ".jsonl");
  writeFileSync(newer, meta(G, { history_base: { thread_id: S, end_ordinal_exclusive: lines(first) + lines(afterTwo), end_byte_offset: Buffer.byteLength(afterTwo) } }) + turn("g1", 6, "새 갈래의 요청", "새 갈래의 답"));
  const other = (await readRollout(G, newer, files))!;
  assert.deepEqual([other.forkedFrom, other.base?.thread, other.base?.file, other.items.length], [T, T, two, 2]);
  // to say the newer fork's first request again, the thread is forked after the last turn the fork was given
  const g = session(G, { origin: "fork", parentId: T, recordPath: newer });
  assert.deepEqual(forkPoint(g, other.items, other.items[0], files), { from: T, at: "t3" });
  // and had the fork been made before anything was said in the newer file, after the last turn of the file before it
  const early = join(day, "rollout-2026-01-01T03-30-00-0fffffff-0000-4000-8000-000000000006.jsonl");
  writeFileSync(early, meta("0fffffff-0000-4000-8000-000000000006", { history_base: { thread_id: S, end_ordinal_exclusive: lines(first) + lines(second), end_byte_offset: Buffer.byteLength(second) } }) + turn("h1", 7, "더 앞에서 갈라진 요청", "답"));
  const h = (await readRollout("0fffffff-0000-4000-8000-000000000006", early, files))!;
  assert.deepEqual(forkPoint(session("0fffffff-0000-4000-8000-000000000006", { origin: "fork", parentId: T, recordPath: early }), h.items, h.items[0], files), { from: T, at: "t1" });
  // a file that names one that is not there is read by itself, and says what it can
  const lost = join(day, "rollout-2026-01-01T04-00-00-" + T + "_0abcdef0-0000-4000-8000-000000000007.jsonl");
  writeFileSync(lost, meta(T, { history_base: { thread_id: "01234567-0000-4000-8000-00000000dead", end_ordinal_exclusive: 3, end_byte_offset: 10 } }) + turn("t9", 9, "홀로 남은 요청", "답"));
  const alone = (await readRollout(T, lost, recordFiles(home)))!;
  assert.deepEqual([alone.base, alone.items.map((item) => item.id.slice(T.length + 1))], [null, ["3000000", "3000001"]]); // its numbers are still its own
  // where its history lies is not known, so the thread's older files are not taken for something left behind
  assert.deepEqual(alone.gone, []);
  // A thread whose first request was said again begins anew, in a file that names no other: all that was said in
  // the thread's older files is left behind, a file a stretch. A newer file than the one read is not looked at.
  const anew = join(day, "rollout-2026-01-01T03-45-00-" + T + "_0abcdef0-0000-4000-8000-000000000008.jsonl");
  writeFileSync(anew, meta(T) + turn("t8", 8, "처음부터 다시 한 요청", "답"));
  const begun = (await readRollout(T, anew, recordFiles(home)))!;
  assert.deepEqual(begun.items.map((item) => item.id.slice(T.length + 1)), ["3000000", "3000001"]);
  assert.deepEqual(begun.gone.map((stretch) => stretch.map((item) => item.id.slice(T.length + 1)).join(" ")), ["0 1 2 3", "1000000 1000001", "2000000 2000001"]);
  assert.deepEqual(goneOf(begun.items, T, begun.gone).map((one) => one.before?.slice(T.length + 1)), ["3000000", "3000000", "3000000"]);
});

test("what a fork was given when it was made is not pasted into it; what its parent said after that place can be", () => {
  forgetPastes();
  const first = "좌석 예약이 겹치는 까닭은 읽기와 쓰기 사이에 잠금이 없기 때문입니다. 두 요청이 같은 좌석을 동시에 읽으면 둘 다 비어 있다고 보고, 둘 다 예약 행을 넣습니다.";
  const later = "유일 제약을 건 뒤에는 스무 번을 돌려도 한 번도 겹치지 않았습니다. 제약에 걸린 요청은 409와 SEAT_TAKEN을 돌려받고, 화면은 좌석 목록을 새로 불러와야 합니다.";
  const elsewhere = "배포 전에 기존 중복 행을 먼저 지워야 합니다. 그러지 않으면 유일 제약을 거는 마이그레이션이 실패하고, 되돌리려면 수동으로 인덱스를 지워야 합니다.";
  // a session of two requests; forks of it
  const base = [say("a", 0, "prompt", 100, "왜 겹치지?"), say("a", 1, "answer", 110, first), say("a", 2, "prompt", 200, "고친 뒤는?"), say("a", 3, "answer", 210, later)];
  const fork = (id: string, at: number, parent = "a") => session(id, { origin: "fork", parentId: parent, startedAt: at });
  const sessions = [session("a"), session("s"), fork("edit", 900), fork("end", 300), fork("early", 150), fork("deep", 950, "edit"), session("copy", { origin: "imported", parentId: "a", startedAt: 50 })];
  const items = [...base,
    say("s", 0, "prompt", 120, "다른 일"), say("s", 1, "answer", 130, elsewhere), say("s", 2, "answer", 250, first), // another session says the first answer over again, later
    // made before the second request, long after it was said: it was given the first answer, and not the second
    say("edit", 0, "prompt", 910, first), say("edit", 1, "prompt", 920, later), say("edit", 2, "prompt", 930, elsewhere),
    // made after all that was said: it was given both
    say("end", 0, "prompt", 310, first + "\n" + later),
    // made after the first turn, with no word of where: what its parent said after it began was not given to it
    say("early", 0, "prompt", 500, later), say("early", 1, "prompt", 510, first),
    // a fork of the first fork, made before anything was said in it: given what that fork was given, and no more
    say("deep", 0, "prompt", 960, first), say("deep", 1, "prompt", 970, later),
    // a copy has all that the session it was copied from says, whenever that was said
    say("copy", 0, "prompt", 980, later),
  ];
  const before = new Map([["edit", "a:2"], ["deep", "edit:0"]]); // the request each was made before, where that is known
  const found = pasteLinks(items, sessions, "", before).map((link) => link.id).sort();
  assert.deepEqual(found, [
    "paste:a:3>deep:1", // the second answer was never given to the fork of the fork
    "paste:a:3>early:0", // said by the parent after the fork had begun
    "paste:a:3>edit:1", // the second answer, typed into the fork that was made before it
    "paste:s:1>edit:2", // what a session it has nothing to do with said is pasted as it ever was
  ]);
  // (The first answer typed into a fork that was given it is no paste, though another session said the same since: the
  // fork had it from its parent. Nor is anything a paste into a fork that was given all of it, or into a copy.)
  assert.ok(!found.some((id) => id.includes(">edit:0") || id.includes(">end:") || id.includes(">early:1") || id.includes(">deep:0") || id.includes(">copy:")));
});
