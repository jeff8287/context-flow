// npm run demo:shots: takes the walk-through's pictures (docs/img) again, from the demo as the screen is now. It starts
// the demo on records of its own and goes through the steps of docs/DEMO.md in their order in a headless Chrome,
// pressing, typing and dragging as a person does, and writes a picture wherever the walk-through shows one. A step
// that does not come out as the walk-through says stops it, and a picture of where it stopped is left.
// Two pictures of USAGE.md are taken by hand, since a headless browser shows neither: the browser's window that asks
// to install the app (28-install.png) and the page shown while the server is off (29-server-off.png).
//   CONTEXT_FLOW_CHROME=<path>   the browser to drive, where it is not in one of the usual places
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch, sleep } from "./chrome.ts";

process.removeAllListeners("warning"); // node:sqlite still announces itself as experimental
// Records of its own, beside the demo's, so that a demo running at the time is not disturbed. (Not in the system's
// temporary folder: the tool takes files there for scratch notes, not shared work.)
const home = join(dirname(fileURLToPath(import.meta.url)), "home-shots");
process.env.CONTEXT_FLOW_DEMO_HOME = home; // read by world.ts when it is loaded, and by the stand-ins this starts
const { unfit } = await import("./make.ts");
const { stage } = await import("./stage.ts");
const { ROOT, SESSIONS } = await import("./world.ts");
const { serve } = await import("../packages/core/src/server.ts");

const SIZE = { width: 1440, height: 900 };
const OUT = join(ROOT, "docs", "img");
const dist = join(ROOT, "packages", "web", "dist");

function quit(why: string): never {
  console.error(why);
  process.exit(1);
}
if (!existsSync(join(dist, "index.html"))) quit("화면이 아직 빌드되지 않았습니다. npm run demo:shots 로 시작하거나 npm run build 를 먼저 돌려 주세요.");
const chrome = findChrome();
if (!chrome) quit("Chrome을 찾지 못했습니다. CONTEXT_FLOW_CHROME=<Chrome이나 Chromium 실행 파일의 경로> 로 알려 주세요.");
const unfitWhy = unfit();
if (unfitWhy) quit(unfitWhy);

await stage();
const served = serve(0, dist);
const at = "http://127.0.0.1:" + (await served.ready);
const { page, close } = await launch(chrome, SIZE);

// ---------- what is on the page ----------

const quoted = (words: string) => JSON.stringify(words);
const tile = (name: string) => "#world .tile[data-id=\"" + SESSIONS[name].id + "\"]";
/** The label of the line from one session to another. */
const line = (from: string, to: string) => "#world .pill[data-a=\"" + SESSIONS[from].id + "\"][data-b=\"" + SESSIONS[to].id + "\"]";
/** The first thing a selector finds whose words begin so (with no words, the first it finds). */
const first = (selector: string, words = "") => "[...document.querySelectorAll(" + quoted(selector) + ")].find((one) => one.textContent.trim().startsWith(" + quoted(words) + "))";
const showing = (title: string) => "document.querySelector('#chat .chat-title h2')?.textContent === " + quoted(title);
const talkSays = (words: string) => "(document.querySelector('#chat .talk')?.innerText ?? '').includes(" + quoted(words) + ")";
const tiles = () => page.eval<number>("document.querySelectorAll('#world .tile').length");
const waiting = "[...document.querySelectorAll('#world .pill')].some((one) => one.textContent.includes('대기'))";
const composer = "#chat .composer textarea";
const closer = "#chat .chat-head [title=\"닫기\"]";

// ---------- what a person does ----------

/** Presses a thing on the page. */
async function press(selector: string, words = "") {
  const found = await page.eval<boolean>("(() => { const one = " + first(selector, words) + "; one?.click(); return Boolean(one); })()");
  if (!found) throw new Error("화면에 없습니다: " + selector + (words ? " ‘" + words + "’" : ""));
  await sleep(300);
}
/** Types into a box, over whatever it had. */
async function write(selector: string, words: string) {
  await page.eval("(() => { const box = document.querySelector(" + quoted(selector) + "); box.focus(); box.select(); return true; })()");
  await page.type(words);
}
async function goto(projects: string, least: number) {
  await page.goto(at + "/?project=" + projects);
  await page.wait("document.querySelectorAll('#world .tile').length >= " + least, "지도가 그려지지 않았습니다: " + projects);
}
/** Opens a session's talk from its tile, putting it on the map first if it is not there. */
async function open(name: string) {
  const title = SESSIONS[name].title;
  if (!(await page.eval<boolean>("document.querySelector(" + quoted(tile(name)) + ") !== null"))) await press("#list .row[data-id=\"" + SESSIONS[name].id + "\"]");
  await press(tile(name));
  await page.wait(showing(title) + " && document.querySelector('#chat .talk .msg') !== null", "‘" + title + "’의 대화가 열리지 않았습니다");
  await sleep(500);
}
/** Sends what the box has, and waits until the answer says what it should. */
async function send(answer: string) {
  await press("#chat .composer .go");
  await page.wait(talkSays(answer), "답에 ‘" + answer + "’가 오지 않았습니다", 20_000);
  await sleep(3500); // the screen reads the record again once the turn is over
}
/** Selects, as a person does by dragging over it, the paragraph of an answer that begins with these words. */
async function selectParagraph(words: string) {
  await page.eval("(() => {"
    + " const runs = [...document.querySelectorAll('#chat .talk .msg.agent [data-o]')];"
    + " const from = runs.findIndex((one) => one.textContent.includes(" + quoted(words) + "));"
    + " let to = from;"
    + " while (runs[to + 1] && runs[to + 1].textContent !== '\\n') to += 1;"
    + " runs[from].scrollIntoView({ block: 'center' });"
    + " const range = document.createRange();"
    + " range.setStart(runs[from].firstChild, runs[from].textContent.indexOf(" + quoted(words) + "));"
    + " range.setEnd(runs[to].firstChild, runs[to].textContent.length);"
    + " getSelection().removeAllRanges();"
    + " getSelection().addRange(range);"
    + " return true; })()");
  await page.wait("!document.getElementById('pick').hidden", "글을 골라도 ‘담기’가 뜨지 않았습니다");
}
/** Presses the request of the open talk that says these words, to say it again. */
async function redo(request: string) {
  await page.eval("(() => { const one = " + request + "; one.scrollIntoView({ block: 'center' }); one.querySelector('.acts .redo').click(); return true; })()");
  await page.wait("!document.querySelector('#chat .redo-bar').hidden", "고쳐 보내기가 시작되지 않았습니다");
  await sleep(300);
}
const scrollTalk = (to: "end" | "start") => page.eval("document.querySelector('#chat .talk').scrollTop = " + (to === "end" ? "1e6" : "0") + "; true");
/** Something typed in a session's own window, as "npm run demo:say" does it. */
function say(name: string, words: string) {
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(ROOT, "demo", "agent.ts"), "say", name, words], { encoding: "utf8" });
  if (run.status !== 0) throw new Error("demo:say가 실패했습니다: " + run.stderr);
}
/** A place on the map with nothing on it: where the pointer rests while a picture is taken, and where a piece is let
 *  go to start a new session. */
async function empty(): Promise<[number, number]> {
  const spot = await page.eval<[number, number] | null>("(() => {"
    + " const box = document.getElementById('stage').getBoundingClientRect();"
    + " for (let y = box.bottom - 90; y > box.top + 60; y -= 30) for (let x = box.left + 40; x < box.right - 40; x += 30) {"
    + "   const one = document.elementFromPoint(x, y);"
    + "   if (one && ['map', 'world', 'links'].includes(one.id)) return [x, y];"
    + " }"
    + " return null; })()");
  if (!spot) throw new Error("지도에 빈 곳이 없습니다");
  return spot;
}
let taken = 0;
/** Takes a picture of the screen as it is, with the pointer resting on an empty part of the map. */
async function shot(name: string, settle = 600) {
  await page.move(await empty());
  await sleep(settle);
  await page.shot(join(OUT, name + ".png"));
  taken += 1;
  console.log("  " + name + ".png");
}
/** What the screen says at a step whose words the walk-through repeats, for whoever takes the pictures to check. */
async function note(what: string, expression: string) {
  console.log("    " + what + ": " + (await page.eval<string>(expression)));
}

console.log("데모의 그림을 다시 찍습니다 (" + SIZE.width + "×" + SIZE.height + ")");
try {
  // 1. the map, and the session that waits to be allowed something
  await goto("seat-api", 6);
  await note("목록", "[...document.querySelectorAll('#list .group')].map((one) => one.textContent.trim().replace(/\\s+/g, ' ')).join(', ')");
  await shot("01-map", 900);
  await open("dedupe");
  await shot("23-waiting");

  // 2. the paste the tool found, and what it rests on
  await press(line("cause", "tests"));
  await page.wait("document.querySelector('#chat .ctx-card') !== null", "붙여넣기 선의 카드가 열리지 않았습니다");
  await shot("02-paste");
  await press("#chat .ctx-card button", "받은 자리");
  await page.wait(showing(SESSIONS.tests.title), "받은 자리가 열리지 않았습니다");
  await shot("03-paste-evidence", 900);

  // 3. a paragraph of an answer, kept as a piece (the talk opened afresh, without the stretch marked a step before)
  await press(closer);
  await open("tests");
  await selectParagraph("화면 쪽에서 알아야 할 것");
  await shot("04-pick");
  await press("#pick-hold");
  await page.wait("document.querySelector('#chat .basket .piece') !== null", "담은 조각이 입력칸 위에 없습니다");

  // 4. the piece sent to another session
  await open("docs");
  await press("#chat .basket .piece-body");
  await write(composer, "이 내용도 문서의 오류 응답 절에 반영해줘");
  await shot("05-attach");
  await send("함께 받은 조각 1개");
  await page.wait("document.querySelector(" + quoted(line("tests", "docs")) + ") !== null", "보낸 조각이 실선이 되지 않았습니다");
  await scrollTalk("end");
  await shot("07-sent");
  await press(line("tests", "docs"));
  await page.wait("document.querySelector('#chat .ctx-card') !== null", "선의 카드가 열리지 않았습니다");
  await shot("08-line");

  // 5. the piece set to wait on a session at work, and taken along by the hook when that session is spoken to
  await open("batch");
  await press("#chat .basket .piece-body");
  await press("#chat .composer .later");
  await page.wait(waiting + " && !document.querySelector('#chat .composer .waitbar').hidden", "걸어 둔 조각이 지도와 입력칸에 보이지 않습니다");
  await shot("09-queued");
  say("batch", "지우기 전에 몇 건인지 로그로 남겨줘");
  await page.wait("!" + waiting + " && document.querySelector(" + quoted(line("tests", "batch")) + ") !== null && " + talkSays("지우기 전에 몇 건인지"), "걸어 둔 조각이 실리지 않았습니다", 20_000);
  await sleep(1500);
  await scrollTalk("end");
  await shot("10-delivered");

  // 6. two projects on one map, and the piece the screen project was given, followed back
  await press(closer);
  await press("#project");
  const added = await page.eval<boolean>("(() => { const row = [...document.querySelectorAll('#project-menu .proj-row')].find((one) => one.textContent.includes('seat-web')); row?.querySelector('.proj-with').click(); return Boolean(row); })()");
  if (!added) throw new Error("프로젝트 목록에 seat-web이 없습니다");
  await page.wait("document.querySelectorAll('#world .zone-name').length === 2", "두 프로젝트가 한 지도에 올라오지 않았습니다");
  await page.key("Escape", 27);
  await shot("06-two-projects", 900);
  await press(line("tests", "message"));
  await page.wait(first("#chat .ctx-card button", "역추적") + " !== undefined", "프로젝트를 넘는 선의 카드가 열리지 않았습니다");
  await press("#chat .ctx-card button", "역추적");
  await page.wait("document.querySelectorAll('#chat .trace-stop').length >= 3", "역추적이 열리지 않았습니다");
  await note("역추적", "document.querySelector('#chat .chat-title p').textContent");
  await shot("11-trace", 900);

  // the same piece, from the screen project alone: the way stops at the edge of the map, and goes on when asked
  await goto("seat-web", 2);
  await open("message");
  await press("#chat .tabs button", "맥락");
  await page.wait("document.querySelector('#chat .ctx-card.far') !== null", "맥락 탭에 다른 프로젝트와 주고받은 것이 없습니다");
  await shot("12-context-tab");
  await press("#chat .ctx-card.far button", "역추적");
  await page.wait("document.querySelector('#chat .trace-stop.far') !== null", "길이 프로젝트 경계에서 멈추지 않았습니다");
  await shot("13-trace-boundary", 900);
  await press("#chat .trace-stop.far");
  await page.wait("document.querySelector(" + quoted(tile("cause")) + ") !== null && document.querySelector('#chat .trace-stop.far') === null", "경계 너머로 이어 따라가지 않았습니다");
  await shot("14-trace-continued", 1200);

  // 7. a session that asks to be allowed something, answered on this screen
  await goto("seat-api", 6);
  await open("fix");
  await write(composer, "NOTES.md에 유일 제약을 건 이유를 한 줄 적어줘");
  await press("#chat .composer .go");
  await page.wait("document.querySelector('#chat .allow') !== null && document.querySelector(" + quoted(tile("fix") + ".needs") + ") !== null", "승인 카드가 뜨지 않았습니다", 20_000);
  await shot("15-approve");
  await press("#chat .allow");
  await page.wait(talkSays("NOTES.md에 한 줄을 적었습니다"), "허용한 뒤 답이 끝나지 않았습니다", 20_000);
  await sleep(3500);

  // 8. a new session begun from a piece, by letting the piece go on an empty part of the map
  const chip = await page.at("#chat .basket .piece-body");
  if (!chip) throw new Error("담아 둔 조각이 입력칸 위에 없습니다");
  await page.drag(chip, await empty());
  await page.wait(showing("새 세션") + " && document.querySelector('#chat .fresh-pieces .ctx-card') !== null", "조각을 빈 곳에 놓아도 새 세션 창이 열리지 않았습니다");
  await write(composer, "이 응답 규칙을 모바일 앱에서도 지키는지 점검해줘");
  await shot("16-new-session");
  const before = await tiles();
  await press("#chat .composer .go");
  await page.wait("document.querySelectorAll('#world .tile').length > " + before + " && " + talkSays("함께 받은 조각 1개"), "새 세션이 시작되지 않았습니다", 20_000);
  await sleep(3500);
  await shot("17-new-session-started");

  // 9. a request said again: a session forked off before it; then the answer once more, another way off the same place
  await open("docs");
  await redo("[...document.querySelectorAll('#chat .talk > .msg.user')].find((one) => one.textContent.includes('이 내용도 문서의 오류 응답 절에 반영해줘'))");
  await shot("26-redo");
  await write(composer, "이 내용은 오류 응답 절 말고 '자주 묻는 질문' 절에 넣어줘");
  const unforked = await tiles();
  await press("#chat .composer .go");
  await page.wait("(document.querySelector('#chat .chat-title h2')?.textContent ?? '').startsWith('이 내용은') && " + talkSays("물려받았"), "갈라져 나온 세션이 열리지 않았습니다", 20_000);
  await page.wait("document.querySelectorAll('#world .tile').length > " + unforked, "갈라져 나온 세션이 지도에 올라오지 않았습니다");
  await sleep(3500);
  await scrollTalk("start");
  await shot("27-forked");
  const forked = await tiles();
  await page.eval("[...document.querySelectorAll('#chat .talk > .msg.agent')].at(-1).querySelector('.acts .redo').click(); true"); // 다시 받기
  await page.wait("document.querySelectorAll('#world .tile').length > " + forked, "다시 받기가 세션을 갈라 내지 않았습니다", 20_000);
  await sleep(3500);
  await open("docs");
  await page.wait("document.querySelector('#chat .ways') !== null", "고쳐 보낸 요청에 갈래 표시가 없습니다");
  await page.eval("document.querySelector('#chat .ways').closest('.msg').scrollIntoView({ block: 'center' }); true");
  await note("갈래", "document.querySelector('#chat .ways').innerText.replace(/\\s+/g, ' ')");
  await shot("31-ways");

  // 10. what was said before a request was said again in the Codex app, or before a talk was taken back in Claude Code
  await goto("seat-web", 2);
  await open("map");
  await page.wait("document.querySelector('#chat details.gone') !== null", "고치기 전의 대화가 접혀 있지 않습니다");
  await shot("32-left-behind");
  await open("form");
  await press("#chat details.gone > summary");
  await shot("33-left-behind-open");
  await open("map");
  await press("#chat details.gone > summary");
  await page.eval("(() => { const words = document.querySelector('#chat details.gone .msg.was.agent .text'); words.scrollIntoView({ block: 'center' }); const range = document.createRange(); range.selectNodeContents(words); getSelection().removeAllRanges(); getSelection().addRange(range); return true; })()");
  await page.wait("!document.getElementById('pick').hidden", "접힌 말의 글을 골라도 ‘담기’가 뜨지 않았습니다");
  await shot("34-left-behind-pick");
  await press("#pick-hold");
  const kept = await page.eval<boolean>("(() => { const one = [...document.querySelectorAll('#chat .basket .piece-body')].find((chip) => chip.title.includes('고치거나 되감기 전의 말')); one?.click(); return Boolean(one); })()");
  if (!kept) throw new Error("접힌 말에서 담은 조각이 입력칸 위에 없습니다");
  await write(composer, "고치기 전의 답에 있던 문제도 참고해서, 예약 전에 확인 단계를 넣어줘");
  await send("함께 받은 조각 1개");
  await scrollTalk("end");
  await shot("35-left-behind-sent");

  // 11. a notice of a session spoken to elsewhere
  await goto("seat-api", 6);
  say("docs", "예시도 넣어줘");
  await page.wait("document.querySelector('#toasts .toast') !== null", "알림 카드가 뜨지 않았습니다", 20_000);
  await shot("24-notice");
  await press("#toasts .toast");
  await page.wait(showing(SESSIONS.docs.title), "알림 카드를 눌러도 대화가 열리지 않았습니다");
  await sleep(500);

  // a picture and a file sent with a request, with another model; then the request said again, and they come back
  const picture = join(home, "seat-map.png");
  const grabbed = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 300, y: 200, width: 240, height: 150, scale: 1 } });
  writeFileSync(picture, Buffer.from(grabbed.data, "base64"));
  const log = join(home, "reserve-error.log");
  writeFileSync(log, "2026-11-27 12:01:07 ERROR reserve: UniqueViolation seat_id=7 slot=10:00\n2026-11-27 12:01:07 INFO  responded 409 SEAT_TAKEN\n");
  await page.files("#chat .composer input[type=file]", [picture, log]);
  await page.wait("document.querySelectorAll('#chat .composer .files .file').length === 2", "붙인 그림과 파일이 입력칸에 없습니다");
  await write(composer, "이 좌석 배치 그림과 오류 로그를 보고 문서에 예시를 넣어줘");
  await page.wait("document.querySelector('#chat .composer-foot option[value=\"demo-codex-mini\"]') !== null", "모델 목록이 오지 않았습니다");
  await page.eval("(() => { const choose = document.querySelector('#chat .composer-foot select'); choose.value = 'demo-codex-mini'; choose.dispatchEvent(new Event('change')); return true; })()");
  await shot("25-attach-files");
  await send("함께 받은 그림 1개");
  await redo("[...document.querySelectorAll('#chat .talk > .msg.user[data-item]')].at(-1)");
  await page.wait("document.querySelectorAll('#chat .composer .files .file').length === 2", "고쳐 보낼 때 그림과 파일이 다시 붙지 않았습니다");
  await write(composer, "이 좌석 배치 그림과 오류 로그를 보고, 예시는 표로 넣어줘");
  await page.eval("document.querySelector('#chat .talk > .redoing')?.scrollIntoView({ block: 'center' }); true");
  await shot("30-redo-files");
  await page.key("Escape", 27);

  // close up, time, finding, exporting
  await press(closer);
  await page.eval("document.querySelectorAll('#toasts .toast > button').forEach((one) => one.click()); true"); // the notices of the last steps, put away
  for (let step = 0; step < 4; step += 1) {
    if ((await page.eval<string>("document.getElementById('world').dataset.level")) === "near") break;
    await press("#zoom-in");
    await sleep(400);
  }
  await shot("19-zoom-near", 900);
  await press("#fit");
  await press("#lanes-toggle");
  await page.wait("!document.getElementById('drawer').hidden", "시간 흐름이 열리지 않았습니다");
  await shot("20-lanes", 900);
  await press("#lanes-toggle");
  await write("#find", "SEAT_TAKEN");
  await page.wait("document.querySelector('#list .hit') !== null", "대화의 글에서 찾지 못했습니다");
  await shot("21-find");
  await page.eval("(() => { const box = document.getElementById('find'); box.value = ''; box.dispatchEvent(new Event('input')); return true; })()");
  await press("#io");
  await page.wait("!document.getElementById('io-menu').hidden", "내보내기 메뉴가 열리지 않았습니다");
  await shot("18-export");

  if (page.errors.length) console.log("화면이 낸 오류:\n  " + page.errors.join("\n  "));
  console.log(taken + "장을 docs/img에 썼습니다. 28-install.png와 29-server-off.png는 손으로 찍는 그림이라 그대로 둡니다.");
} catch (error) {
  const where = join(tmpdir(), "context-flow-shots-stopped.png");
  await page.shot(where).catch(() => {});
  console.error("멈췄습니다: " + (error as Error).message + "\n멈춘 곳의 화면: " + where);
  process.exitCode = 1;
} finally {
  await close();
  await served.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit();
