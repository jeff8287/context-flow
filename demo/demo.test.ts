// The demo is the first thing a person runs, so it is tried like any other part: its records give the story the
// walk-through tells, and a piece set to wait reaches a session of either client through the plugin's own hook.
// Everything is written to a folder of its own beside the demo's, so a demo that is running at the time is not
// disturbed. (Not to the system's temporary folder: the tool takes files there for scratch notes, not shared work.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "home-test-"));
process.env.CONTEXT_FLOW_DEMO_HOME = home; // read by world.ts when it is loaded, and by the agent this starts
const { make, unfit } = await import("./make.ts");
const { ROOT, SESSIONS, useDemoHomes } = await import("./world.ts");
const { pieceBlock } = await import("../packages/core/src/links.ts");
const { noLive } = await import("../packages/core/src/live.ts");
const { forgetPastes } = await import("../packages/core/src/paste.ts");
const { buildSnapshot, readCodexProjects } = await import("../packages/core/src/snapshot.ts");
const { queuePieces, readPending, readTransfers } = await import("../packages/core/src/store.ts");

after(() => rmSync(home, { recursive: true, force: true }));
// with the repository itself under a temporary folder there is nowhere fit to write the records
const skip = unfit() ? "the repository is under a temporary folder" : false;

/** The demo's records, read the way the screen's server reads them. */
async function read() {
  forgetPastes();
  const { projects, assigned } = readCodexProjects();
  return buildSnapshot(projects, assigned, Date.now(), readTransfers(), readPending(), noLive);
}
/** Something typed in a session's own window, as "npm run demo:say" does it. */
function say(session: string, text: string): string {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "demo", "agent.ts"), "say", session, text], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test("the demo's records tell its story: a fork, a pasted finding, two pieces sent (one to another project), two files changed by two sessions", { skip }, async () => {
  useDemoHomes();
  const made = await make();
  assert.deepEqual(made.links, { fork: 1, subagent: 1, transfer: 2, paste: 1 });
  const { snapshot } = await read();
  const paste = snapshot.links.find((link) => link.kind === "paste");
  assert.equal(paste?.from.sessionId, SESSIONS.cause.id);
  assert.equal(paste?.to.sessionId, SESSIONS.tests.id);
  assert.deepEqual(snapshot.overlaps.map((one) => one.path).sort(), ["app/reserve.py", "src/ReserveForm.tsx"]);
  assert.deepEqual(snapshot.hooks, { codex: "ready", claude: "ready" });
});

test("a piece set to wait goes with the next thing typed in the session's own window, for a session of either client, and is then a line", { skip }, async () => {
  useDemoHomes();
  const before = await read();
  const sentence = "화면 쪽에서 알아야 할 것";
  const answer = [...before.bodies.values()].find((item) => item.sessionId === SESSIONS.tests.id && item.kind === "answer" && item.text.includes(sentence));
  assert.ok(answer, "the answer the walk-through takes a piece from");
  const start = answer.text.indexOf(sentence);
  const text = answer.text.slice(start, start + 60);
  const wait = (to: string, id: string) => ({ id, at: Date.now(), from: { sessionId: answer.sessionId, itemId: answer.id, start, end: start + text.length }, to: { sessionId: to }, text,
    block: pieceBlock({ id, from: "‘" + SESSIONS.tests.title + "’ (Claude Code)", kind: "답변", text }) });
  queuePieces([wait(SESSIONS.ci.id, "cftestcodex01"), wait(SESSIONS.batch.id, "cftestclaude1")]);
  assert.equal((await read()).snapshot.waiting.length, 2);

  assert.match(say("ci", "이어서 해줘"), /조각 1개/);
  assert.match(say("batch", "이어서 해줘"), /조각 1개/);
  const { snapshot, bodies } = await read();
  assert.equal(snapshot.waiting.length, 0);
  for (const [to, id] of [[SESSIONS.ci.id, "cftestcodex01"], [SESSIONS.batch.id, "cftestclaude1"]]) {
    const link = snapshot.links.find((one) => one.id === "transfer:" + id);
    assert.equal(link?.from.sessionId, SESSIONS.tests.id);
    assert.equal(link?.to.sessionId, to);
    const said = [...bodies.values()].filter((item) => item.sessionId === to && item.kind === "answer").at(-1);
    assert.match(said?.text ?? "", /함께 받은 조각 1개/);
  }
  // nothing waits for it any more: the next thing typed goes alone
  assert.match(say("ci", "하나 더"), /걸려 있던 조각은 없었습니다/);
});
