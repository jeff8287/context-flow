// The demo is the first thing a person runs, so it is tried like any other part: its records give the story the
// walk-through tells, and a piece set to wait reaches a session of either client through the plugin's own hook.
// Everything is written to a folder of its own beside the demo's, so a demo that is running at the time is not
// disturbed. (Not to the system's temporary folder: the tool takes files there for scratch notes, not shared work.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../packages/core/src/model.ts";

const home = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "home-test-"));
process.env.CONTEXT_FLOW_DEMO_HOME = home; // read by world.ts when it is loaded, and by the agent this starts
const { make, unfit } = await import("./make.ts");
const { PROJECTS, ROOT, SESSIONS, rolloutPath, useDemoHomes, useStandIns } = await import("./world.ts");
const { serve } = await import("../packages/core/src/server.ts");
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
test("a screen that asked to be told hears of it when a session of its project is spoken to in its own window", { skip }, async () => {
  useDemoHomes();
  const served = serve(0, join(ROOT, "packages", "web", "dist"));
  const at = "http://127.0.0.1:" + (await served.ready);
  const answers = async () => ((await (await fetch(at + "/api/snapshot?project=" + PROJECTS.api.id)).json()) as Snapshot).sessions.find((one) => one.id === SESSIONS.docs.id)?.counts.answers ?? -1;
  try {
    const before = await answers();
    const reader = (await fetch(at + "/api/events?project=" + PROJECTS.api.id)).body!.getReader();
    let heard = "";
    const until = async (wanted: string, within: number) => {
      const end = Date.now() + within;
      while (!heard.includes(wanted) && Date.now() < end) {
        const late = new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, end - Date.now())));
        const got = await Promise.race([reader.read(), late]);
        if (!got || got.done) break;
        heard += Buffer.from(got.value).toString("utf8");
      }
      return heard.includes(wanted);
    };
    assert.ok(await until('"t":"hello","watching":true', 3000), "the server watches the records: " + heard);
    await new Promise((resolve) => setTimeout(resolve, 400)); // the watch has a moment to begin
    say("docs", "하나 더 물을게");
    assert.ok(await until('"t":"changed"', 8000), "told that the records changed: " + heard);
    assert.equal(await answers(), before + 1);
    // Codex does not write as the demo's stand-in does: it keeps the record open and adds to it, and of that the
    // system tells nothing until the file is closed. The server finds it by looking.
    await new Promise((resolve) => setTimeout(resolve, 1300)); // what was told of above has been looked at once
    heard = "";
    const fd = openSync(rolloutPath(SESSIONS.docs.id), "a");
    try {
      writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count" } }) + "\n");
      assert.ok(await until('"t":"changed"', 6000), "told of a record that grew while it was held open: " + heard);
    } finally {
      closeSync(fd);
    }
  } finally {
    await served.close();
  }
});
test("a message from the screen takes pictures, other files and another model along, for a session of either client", { skip }, async () => {
  useDemoHomes();
  useStandIns();
  const served = serve(0, join(ROOT, "packages", "web", "dist"));
  const at = "http://127.0.0.1:" + (await served.ready);
  const post = async (path: string, payload: unknown) => {
    const got = await fetch(at + path, { method: "POST", headers: { "content-type": "application/json", origin: at }, body: JSON.stringify(payload) });
    return { status: got.status, body: (await got.json()) as Record<string, any> };
  };
  const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="; // a picture of one dot
  const files = [{ name: "dot.png", type: "image/png", data: dot }, { name: "../odd name;.log", type: "text/plain", data: Buffer.from("line one\nline two\n").toString("base64") }];
  try {
    assert.deepEqual((await (await fetch(at + "/api/models?client=codex")).json()).models.map((one: { id: string }) => one.id), ["demo-codex-1", "demo-codex-mini"]);
    for (const [name, model] of [["docs", "demo-codex-mini"], ["form", "haiku"]] as const) {
      const session = SESSIONS[name];
      const project = PROJECTS[session.project].id;
      // pictures and files go with words that say what is wanted of them
      assert.equal((await post("/api/send", { project, session: session.id, text: "", files })).status, 400);
      const sent = await post("/api/send", { project, session: session.id, text: "이 그림과 로그를 봐줘", files, model });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      let made: Awaited<ReturnType<typeof read>> | null = null;
      for (let tries = 0; tries < 40; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if ((await (await fetch(at + "/api/turn/active?session=" + session.id)).json()).turn) continue;
        made = await read();
        break;
      }
      assert.ok(made, "the turn ended");
      const said = [...made.bodies.values()].filter((item) => item.sessionId === session.id);
      const asked = said.findLast((item) => item.kind === "prompt")!;
      const answered = said.findLast((item) => item.kind === "answer")!;
      assert.equal(asked.images, 1);
      assert.match(asked.text, /odd name_\.log/); // the name cannot lead out of the folder it was kept in
      assert.doesNotMatch(asked.text, /\.\.\//);
      assert.match(answered.text, /함께 받은 그림 1개: image\/png/);
      assert.match(answered.text, /함께 받은 파일 1개: odd name_\.log \(18바이트, 읽을 수 있습니다\)/);
      assert.match(answered.text, new RegExp("이번 답의 모델: " + model));
      // What went with the request can be had again, to be shown and to be sent once more: the picture out of the
      // client's record, the file out of the tool's own folder. (The server reads the records again first.)
      await fetch(at + "/api/snapshot?project=" + project);
      const picture = await fetch(at + "/api/picture?item=" + encodeURIComponent(asked.id) + "&n=0");
      assert.deepEqual([picture.status, picture.headers.get("content-type")], [200, "image/png"]);
      assert.ok(Buffer.from(await picture.arrayBuffer()).equals(Buffer.from(dot, "base64")));
      assert.equal((await fetch(at + "/api/picture?item=" + encodeURIComponent(asked.id) + "&n=1")).status, 404); // there was one
      assert.equal((await fetch(at + "/api/picture?item=" + encodeURIComponent(answered.id) + "&n=0")).status, 404); // an answer has none
      const file = await fetch(at + "/api/attached?item=" + encodeURIComponent(asked.id) + "&n=0");
      assert.equal(file.status, 200);
      assert.equal(await file.text(), "line one\nline two\n");
      assert.equal((await fetch(at + "/api/attached?item=" + encodeURIComponent(asked.id) + "&n=1")).status, 404);
      // the session is named after what was typed, and goes on with the model that was asked for
      const now = made.snapshot.sessions.find((one) => one.id === session.id)!;
      assert.equal(now.model, model);
      assert.equal(made.snapshot.items.find((item) => item.id === asked.id)?.label, "이 그림과 로그를 봐줘");
    }
  } finally {
    await served.close();
  }
});

test("a request said again begins a fork of the session as it stood before that request, for a session of either client; the session itself stays as it was", { skip }, async () => {
  useDemoHomes();
  useStandIns();
  const served = serve(0, join(ROOT, "packages", "web", "dist"));
  const at = "http://127.0.0.1:" + (await served.ready);
  const post = async (path: string, payload: unknown) => {
    const got = await fetch(at + path, { method: "POST", headers: { "content-type": "application/json", origin: at }, body: JSON.stringify(payload) });
    return { status: got.status, body: (await got.json()) as Record<string, any> };
  };
  /** The records, once the turn begun in a session has ended. */
  const ended = async (session: string) => {
    for (let tries = 0; tries < 40; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!(await (await fetch(at + "/api/turn/active?session=" + session)).json()).turn) return read();
    }
    throw new Error("the turn did not end");
  };
  const nth = (item: { id: string }) => Number(item.id.slice(item.id.lastIndexOf(":") + 1));
  const of = (made: Awaited<ReturnType<typeof read>>, session: string) => [...made.bodies.values()].filter((item) => item.sessionId === session).sort((one, other) => nth(one) - nth(other));
  try {
    for (const name of ["docs", "form"] as const) {
      const session = SESSIONS[name];
      const project = PROJECTS[session.project].id;
      say(name, "먼저 이것부터 봐줘");
      say(name, "그다음은 이것");
      const before = of(await read(), session.id);
      const prompts = before.filter((item) => item.kind === "prompt");
      const last = prompts.at(-1)!;
      // the last request, in other words: the fork knows every request before it, and not that one
      const forked = await post("/api/fork", { project, session: session.id, item: last.id, text: "그다음은 저것으로 하자" });
      assert.equal(forked.status, 200, JSON.stringify(forked.body));
      assert.equal(forked.body.from, session.id);
      const made = await ended(forked.body.session);
      const fork = made.snapshot.sessions.find((one) => one.id === forked.body.session)!;
      assert.deepEqual([fork.origin, fork.parentId, fork.title, fork.cwd], ["fork", session.id, "그다음은 저것으로 하자", PROJECTS[session.project].root]);
      assert.ok(made.snapshot.links.some((link) => link.kind === "fork" && link.from.sessionId === session.id && link.to.sessionId === fork.id));
      // the fork's line says where it was made: before the request that was said again
      const line = made.snapshot.links.find((link) => link.kind === "fork" && link.to.sessionId === fork.id)!;
      assert.equal(line.from.itemId, last.id);
      const said = of(made, fork.id);
      assert.deepEqual(said.map((item) => item.kind), ["prompt", "answer"]); // what it was given is the other session's, not its own
      assert.match(said[1].text, new RegExp("요청 " + (prompts.length - 1) + "개와 그 답까지를 물려받았"));
      assert.deepEqual(of(made, session.id).map((item) => item.id), before.map((item) => item.id)); // nothing was taken out of the session, or added to it
      // The fork's own request said again: the session forked is as it stood where the fork was made. A Codex
      // fork keeps its history in the thread it came from, so that thread is the one forked again; Claude Code
      // forks the fork, whose record begins with the copies.
      const again = await post("/api/fork", { project, session: fork.id, item: said[0].id, text: "아니, 이것으로" });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.from, session.client === "codex" ? session.id : fork.id);
      const later = await ended(again.body.session);
      const second = later.snapshot.sessions.find((one) => one.id === again.body.session)!;
      assert.deepEqual([second.origin, second.parentId], ["fork", again.body.from]);
      // Said again, the fork's own request is another way on from the same place. Codex forks the thread the fork came
      // from, before the same request; Claude Code forks the fork, before its first request.
      assert.equal(later.snapshot.links.find((link) => link.kind === "fork" && link.to.sessionId === second.id)!.from.itemId, session.client === "codex" ? last.id : said[0].id);
      assert.match(of(later, second.id)[1].text, new RegExp("요청 " + (prompts.length - 1) + "개와 그 답까지를 물려받았"));
      // an earlier request: only what came before it is kept
      const early = await post("/api/fork", { project, session: session.id, item: prompts.at(-2)!.id, text: "먼저 저것부터" });
      assert.equal(early.status, 200, JSON.stringify(early.body));
      assert.match(of(await ended(early.body.session), early.body.session)[1].text, new RegExp("요청 " + (prompts.length - 2) + "개와 그 답까지를 물려받았"));
    }
    // A session's first request said again keeps nothing: what begins is a session that runs like it, and no fork.
    const docs = SESSIONS.docs;
    const first = of(await read(), docs.id).find((item) => item.kind === "prompt")!;
    const anew = await post("/api/fork", { project: PROJECTS.api.id, session: docs.id, item: first.id, text: "처음부터 다시 물을게" });
    assert.equal(anew.status, 200, JSON.stringify(anew.body));
    assert.equal(anew.body.from, null);
    const began = (await ended(anew.body.session)).snapshot.sessions.find((one) => one.id === anew.body.session)!;
    assert.deepEqual([began.origin, began.parentId, began.client], ["user", null, "codex"]);
    // what is not a request of the session, and words that are not there
    assert.equal((await post("/api/fork", { project: PROJECTS.api.id, session: docs.id, item: SESSIONS.ci.id + ":0", text: "x" })).status, 404);
    assert.equal((await post("/api/fork", { project: PROJECTS.api.id, session: docs.id, item: first.id, text: " " })).status, 400);
  } finally {
    await served.close();
  }
});

test("a talk that went one way and then another is given with what was left behind, and is carried on like any other", { skip }, async () => {
  useDemoHomes();
  useStandIns();
  const served = serve(0, join(ROOT, "packages", "web", "dist"));
  const at = "http://127.0.0.1:" + (await served.ready);
  const post = async (path: string, payload: unknown) => {
    const got = await fetch(at + path, { method: "POST", headers: { "content-type": "application/json", origin: at }, body: JSON.stringify(payload) });
    return { status: got.status, body: (await got.json()) as Record<string, any> };
  };
  type Talk = { items: { id: string; kind: string; text: string }[]; gone: { before: string | null; items: { id: string; kind: string; text: string }[] }[] };
  const talk = async (session: string): Promise<Talk> => {
    await fetch(at + "/api/snapshot?project=" + PROJECTS.web.id); // the records are read again first
    return (await (await fetch(at + "/api/talk?session=" + session)).json()) as Talk;
  };
  try {
    // Codex: the second request was said again in the app. Claude Code: the talk was taken back after its first turn.
    for (const [name, kinds, word] of [["map", "prompt change answer", /바로 예약되게/], ["form", "prompt answer", /탭 순서를/]] as const) {
      const session = SESSIONS[name];
      const before = await talk(session.id);
      const prompts = before.items.filter((item) => item.kind === "prompt");
      assert.ok(prompts.length >= 2, name);
      assert.equal(before.gone.length, 1, name);
      const [behind] = before.gone;
      assert.equal(behind.items.map((item) => item.kind).join(" "), kinds);
      assert.match(behind.items[0].text, word);
      // it is shown before the request that was made in its stead: the second the talk stands on
      assert.equal(behind.before, prompts[1].id);
      // it is of the talk no more: not among its items, nor anything the snapshot counts or ties
      assert.ok(!before.items.some((item) => behind.items.some((one) => one.id === item.id)));
      const snapshot = (await (await fetch(at + "/api/snapshot?project=" + PROJECTS.web.id)).json()) as Snapshot;
      assert.ok(!snapshot.items.some((item) => behind.items.some((one) => one.id === item.id)));
      // and its words can still be read whole
      assert.equal(((await (await fetch(at + "/api/item?id=" + encodeURIComponent(behind.items[0].id))).json()) as { text: string }).text, behind.items[0].text);
      // The session is spoken to in its own window: what is said is added to the talk, not to what was left behind.
      say(name, "하나만 더 봐줘");
      const after = await talk(session.id);
      assert.equal(after.items.filter((item) => item.kind === "prompt").length, prompts.length + 1, name);
      assert.deepEqual(after.gone.map((one) => [one.before, one.items.map((item) => item.id)]), before.gone.map((one) => [one.before, one.items.map((item) => item.id)]));
      // The request made in its stead, said again: the fork is given the first request and its answer, and neither
      // what was left behind nor what came after.
      const forked = await post("/api/fork", { project: PROJECTS.web.id, session: session.id, item: prompts[1].id, text: "이번에는 이렇게 해줘" });
      assert.equal(forked.status, 200, JSON.stringify(forked.body));
      let said: Talk["items"] = [];
      for (let tries = 0; tries < 40 && said.length < 2; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if ((await (await fetch(at + "/api/turn/active?session=" + forked.body.session)).json()).turn) continue;
        said = (await talk(forked.body.session)).items;
      }
      assert.match(said[1]?.text ?? "", /요청 1개와 그 답까지를 물려받았/, name);
    }
    // A piece is cut from what was left behind as from anything else that was said, and is sent on: to another
    // session, and to the very session that left it behind, which has it no more.
    const map = SESSIONS.map;
    const behind = (await talk(map.id)).gone[0].items.find((item) => item.kind === "answer")!;
    const piece = { sessionId: map.id, itemId: behind.id, start: 0, end: behind.text.length };
    for (const to of [SESSIONS.form.id, map.id]) {
      const sent = await post("/api/send", { project: PROJECTS.web.id, session: to, text: "고치기 전의 답도 참고해줘", pieces: [piece] });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      for (let tries = 0; tries < 40; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!(await (await fetch(at + "/api/turn/active?session=" + to)).json()).turn) break;
      }
      const said = (await talk(to)).items;
      assert.match(said.at(-1)?.text ?? "", /함께 받은 조각 1개/); // the stand-in says back what it was given
    }
    // each arrived, and is a line from where it was cut; the session's own is in the talk it was sent back into
    const snap = (await (await fetch(at + "/api/snapshot?project=" + PROJECTS.web.id)).json()) as Snapshot;
    const lines = snap.links.filter((link) => link.kind === "transfer" && link.from.itemId === behind.id);
    assert.deepEqual(lines.map((link) => link.to.sessionId).sort(), [map.id, SESSIONS.form.id].sort());
    assert.ok(!snap.items.some((item) => item.id === behind.id)); // it is still of no talk
    // followed from where it was cut, it went to those two; followed back from where it arrived, it came from there
    const way = async (item: string) => (await (await fetch(at + "/api/trace?project=" + PROJECTS.web.id + "&item=" + encodeURIComponent(item))).json()) as { steps: { dir: string; link: { id: string } }[]; left: Record<string, { kind: string; at: number }> };
    const from = await way(behind.id);
    assert.deepEqual(from.steps.filter((step) => step.dir === "onward").map((step) => step.link.id).sort(), lines.map((link) => link.id).sort());
    assert.deepEqual(from.left, { [behind.id]: { kind: "answer", at: from.left[behind.id]?.at } });
    const arrived = lines.find((link) => link.to.sessionId === SESSIONS.form.id)!;
    const back = await way(arrived.to.itemId!);
    assert.deepEqual(back.steps.filter((step) => step.dir === "back").map((step) => step.link.id), [arrived.id]);
    assert.equal(back.left[behind.id]?.kind, "answer");
  } finally {
    await served.close();
  }
});

test("with no project to begin it in, a first session is begun in a folder the person chose, and that folder is then a project", { skip }, async () => {
  useDemoHomes();
  useStandIns();
  process.env.CONTEXT_FLOW_PROJECTS = "folders"; // as where the Codex app has no projects: the folders the sessions worked in are
  const served = serve(0, join(ROOT, "packages", "web", "dist"));
  const at = "http://127.0.0.1:" + (await served.ready);
  const get = async (path: string) => (await (await fetch(at + path)).json()) as Record<string, any>;
  const post = async (path: string, payload: unknown) => {
    const got = await fetch(at + path, { method: "POST", headers: { "content-type": "application/json", origin: at }, body: JSON.stringify(payload) });
    return { status: got.status, body: (await got.json()) as Record<string, any> };
  };
  const folder = join(home, "work", "first-try");
  mkdirSync(join(folder, ".git"), { recursive: true });
  mkdirSync(join(folder, "src"), { recursive: true });
  try {
    // the folder as the window shows it: what is in it, whether it is a git work tree, and which folder is the
    // project of a session begun there (the work tree it lies in)
    const top = await get("/api/folders?path=" + encodeURIComponent(folder));
    assert.deepEqual([top.git, top.folders.map((one: { path: string; git: boolean }) => [basename(one.path), one.git])], [true, [["src", false]]]);
    const inner = await get("/api/folders?path=" + encodeURIComponent(join(folder, "src")));
    assert.deepEqual([inner.git, inner.up, inner.project], [false, folder, top.shown]);
    assert.equal((await fetch(at + "/api/folders?path=" + encodeURIComponent(join(folder, "nowhere")))).status, 400);
    // the top folder, a folder that is not there, and pieces (there is no session yet to cut them from) are refused
    for (const [cwd, pieces] of [["/", []], [join(folder, "nowhere"), []], [folder, [{ sessionId: SESSIONS.tests.id, itemId: "x", start: 0, end: 1 }]]] as const) {
      assert.equal((await post("/api/new", { client: "claude", text: "x", cwd, pieces })).status, 400);
    }
    for (const [client, cwd] of [["claude", folder], ["codex", join(folder, "src")]] as const) {
      const begun = await post("/api/new", { client, text: "첫 세션 시험", cwd });
      assert.equal(begun.status, 200, JSON.stringify(begun.body));
      assert.equal(begun.body.cwd, cwd);
      for (let tries = 0; tries < 40 && (await get("/api/turn/active?session=" + begun.body.session)).turn; tries += 1) await new Promise((resolve) => setTimeout(resolve, 250));
      // the work tree is a project of its own, and the session is in it
      const project = (await get("/api/projects")).projects.find((one: { roots: string[] }) => one.roots.join() === folder);
      assert.ok(project, "the folder is a project");
      const session = (await get("/api/snapshot?project=" + encodeURIComponent(project.id))).sessions.find((one: { id: string }) => one.id === begun.body.session);
      assert.deepEqual([session?.client, session?.cwd], [client, cwd]);
    }
  } finally {
    delete process.env.CONTEXT_FLOW_PROJECTS;
    await served.close();
  }
});
