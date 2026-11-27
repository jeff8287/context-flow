// Makes the demo's records: two small projects with sessions of both clients, written in the clients' own formats so
// that the tool reads them exactly as it reads real ones. The story: a seat-booking service has a double-booking bug.
// One session finds the cause, a fork of it fixes it, another writes tests from the cause (pasted in by hand), the
// fix's new error code is sent to the session that writes the docs, and a finding is sent on to the web project.
// Times are set back from now, so that "waiting for an answer" and "three hours ago" read true whenever it is run.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pieceBlock, withBlocks } from "../packages/core/src/links.ts";
import { noLive } from "../packages/core/src/live.ts";
import type { Item, Place, Transfer } from "../packages/core/src/model.ts";
import { forgetPastes } from "../packages/core/src/paste.ts";
import { buildSnapshot, readCodexProjects } from "../packages/core/src/snapshot.ts";
import { scratch } from "../packages/core/src/util.ts";
import { CLAUDE, CODEX, FLOW, HOME, MODEL, PROJECTS, SESSIONS, THREADS, iso, laterFile, line, rolloutPath, transcriptPath, useDemoHomes } from "./world.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// ---------- what the sessions said ----------

/** What the first session found, as it wrote it (with the marks of Markdown). */
const CAUSE = "원인을 찾았습니다.\n\n**중복 예약은 `reserve()`가 좌석 상태를 읽은 뒤 쓰기까지 잠금 없이 두 단계로 나뉘어 있어서 생깁니다.** 두 요청이 거의 동시에 들어오면 둘 다 `status == 'free'`를 읽고, 둘 다 예약 행을 넣습니다. 좌석 행을 `SELECT … FOR UPDATE`로 잠그거나 `(seat_id, slot)`에 유일 제약을 걸면 막을 수 있습니다.\n\n- 재현: 같은 좌석에 요청 두 개를 50ms 안에 보내면 열 번 중 서너 번 중복됩니다.\n- 영향 범위: `app/reserve.py`의 `reserve()` 한 곳입니다.";
/** The same finding as a person copies it off the screen: the marks are gone. This is what gets pasted into another session. */
const CAUSE_COPIED = "중복 예약은 reserve()가 좌석 상태를 읽은 뒤 쓰기까지 잠금 없이 두 단계로 나뉘어 있어서 생깁니다. 두 요청이 거의 동시에 들어오면 둘 다 status == 'free'를 읽고, 둘 다 예약 행을 넣습니다. 좌석 행을 SELECT … FOR UPDATE로 잠그거나 (seat_id, slot)에 유일 제약을 걸면 막을 수 있습니다.";
/** The part of the fix's answer that is sent to the session that writes the docs. */
const NEW_ERROR = "같은 좌석·시간대에 예약이 이미 있으면 `POST /reservations`는 `409 Conflict`와 `{\"code\": \"SEAT_TAKEN\"}`을 돌려줍니다. 클라이언트는 이 코드를 받으면 좌석 목록을 다시 불러와야 합니다.";
const FIXED = "고쳤습니다.\n\n- `reservations`에 `(seat_id, slot)` 유일 제약을 거는 마이그레이션 `0007_unique_seat_slot.sql`을 만들었습니다.\n- `reserve()`는 이제 행을 바로 넣고, 제약에 걸리면 예외를 잡아 실패로 돌려줍니다.\n\n" + NEW_ERROR + "\n\n기존 데이터에 이미 중복이 있으면 마이그레이션이 실패합니다. 먼저 중복 행을 정리해야 합니다.";
/** The part of the tests' answer that is sent to the web project: it repeats a sentence of the cause, which is how the piece can be followed back to where that was first said. */
const FOR_THE_SCREEN = "두 요청이 거의 동시에 들어오면 둘 다 `status == 'free'`를 읽고, 둘 다 예약 행을 넣습니다. 고치기 전 코드에서는 스무 번 중 일곱 번 중복이 났고, 유일 제약을 건 뒤에는 한 번도 나지 않았습니다.\n\n화면 쪽에서 알아야 할 것: 좌석이 방금 다른 사람에게 예약되면 서버가 `409`와 `SEAT_TAKEN`을 돌려줍니다. 화면은 \"방금 다른 분이 예약했습니다\"라고 알리고 좌석 목록을 새로 고쳐야 합니다.";
const TESTED = "재현 테스트 `test_double_booking`을 추가했습니다.\n\n원인은 분석 그대로였습니다. " + FOR_THE_SCREEN + "\n\n테스트에서 시각을 고정하려고 `reserve()`가 `now` 인자를 받도록 한 줄 고쳤습니다.";

// ---------- writers for the two clients' formats ----------

interface Step { say?: string; change?: { path: string; diff: string }; last?: boolean }
interface Turn { at: number; prompt: string; steps: Step[] }

/** A Codex thread: its row in the list of threads and its rollout file.
 *  again: a request of it was said again in the app, in other words. As Codex does it, the record is then begun in a
 *  new file, whose first line says how far into the file before it the talk still holds (keep: so many turns); what
 *  was said after that place stays in the old file and is of the talk no more. */
function codexThread(db: DatabaseSync, thread: { id: string; cwd: string; title: string; at: number; archived?: boolean; forkedFrom?: string }, turns: Turn[], again?: { own: string; keep: number; turns: Turn[] }): void {
  const head = (more: object = {}) => line({ timestamp: iso(thread.at), type: "session_meta", payload: { id: thread.id, cwd: thread.cwd, ...(thread.forkedFrom ? { forked_from_id: thread.forkedFrom } : {}), ...more } })
    + line({ timestamp: iso(thread.at), type: "turn_context", payload: { cwd: thread.cwd, model: MODEL.codex, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } });
  let last = thread.at;
  const said = (list: Turn[], name: (n: number) => string) => list.map((turn, n) => {
    const turnId = name(n);
    let at = turn.at;
    const item = (body: unknown) => line({ timestamp: iso(at), type: "event_msg", payload: { type: "item_completed", turn_id: turnId, completed_at_ms: at, item: body } });
    let text = line({ timestamp: iso(at), type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
    text += item({ type: "UserMessage", content: [{ type: "text", text: turn.prompt }] });
    for (const step of turn.steps) {
      at += 40_000;
      if (step.say) text += item({ type: "AgentMessage", phase: step.last ? "final_answer" : "commentary", content: [{ type: "Text", text: step.say }] });
      if (step.change) text += item({ type: "FileChange", status: "completed", changes: { [step.change.path]: { type: "update", unified_diff: step.change.diff } } });
    }
    at += 5_000;
    last = at;
    return text + line({ timestamp: iso(at), type: "event_msg", payload: { type: "task_complete", turn_id: turnId } });
  });
  const first = said(turns, (n) => "turn-" + (n + 1));
  let path = rolloutPath(thread.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, head() + first.join(""));
  if (again) {
    const kept = head() + first.slice(0, again.keep).join("");
    path = rolloutPath(thread.id, again.own);
    writeFileSync(path, head({ history_mode: "paginated", history_base: { thread_id: thread.id, end_ordinal_exclusive: kept.split("\n").length - 1, end_byte_offset: Buffer.byteLength(kept) } })
      + said(again.turns, (n) => "turn-" + (again.keep + n + 1) + "-again").join(""));
  }
  db.prepare("insert into threads (id, rollout_path, cwd, title, name, model, created_at_ms, updated_at_ms, thread_source, source, archived, first_user_message, attached_thread_parent_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(thread.id, path, thread.cwd, thread.title, thread.title, MODEL.codex, thread.at, last, null, "cli", thread.archived ? 1 : 0, turns[0]?.prompt ?? "", null);
}

/** after: the request was made with the talk taken back to there (to after the row with that number; -1: to before
 *  anything was said). What was said in between stays in the record, as Claude Code leaves it. */
interface Said { at: number; user?: string; text?: string; edit?: { path: string; lines: string[] }; bash?: string; task?: string; end?: boolean; after?: number }

/** A Claude Code session: its transcript. A turn that does not end (end left out on its last line) is one still under way.
 *  Each record names the one it was written after, as Claude Code's do: that is how a talk that was taken back is known. */
function claudeSession(session: { id: string; cwd: string; title: string }, said: Said[], sub?: { name: string; said: Said[] }): void {
  const lines = (id: string, rows: Said[], side: boolean) => {
    let text = side ? "" : line({ type: "summary", summary: session.title, leafUuid: id + "-0" });
    let before: string | null = null; // the record written last
    const ends: (string | null)[] = []; // the last record of each row
    rows.forEach((row, n) => {
      const more = { cwd: session.cwd, sessionId: session.id, timestamp: iso(row.at), uuid: id + "-" + n, parentUuid: row.after === undefined ? before : row.after < 0 ? null : ends[row.after] ?? null, ...(side ? { isSidechain: true } : {}) };
      before = more.uuid;
      if (row.user !== undefined) {
        text += line({ type: "user", ...more, message: { role: "user", content: row.user } });
        ends.push(before);
        return;
      }
      const use = row.edit ? { type: "tool_use", id: "tool-" + n, name: "Edit", input: { file_path: row.edit.path } }
        : row.bash ? { type: "tool_use", id: "tool-" + n, name: "Bash", input: { command: row.bash } }
        : row.task ? { type: "tool_use", id: "tool-" + n, name: "Task", input: { description: row.task } } : null;
      text += line({ type: "assistant", ...more, message: { role: "assistant", model: MODEL.claude, stop_reason: row.end ? "end_turn" : "tool_use", content: [...(row.text ? [{ type: "text", text: row.text }] : []), ...(use ? [use] : [])] } });
      if (row.edit) {
        const added = row.edit.lines.filter((one) => one.startsWith("+")).length;
        const removed = row.edit.lines.filter((one) => one.startsWith("-")).length;
        text += line({ type: "user", ...more, uuid: id + "-" + n + "r", parentUuid: before, timestamp: iso(row.at + 2000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-" + n, content: "ok" }] },
          toolUseResult: { filePath: row.edit.path, structuredPatch: [{ oldStart: 1, oldLines: removed + 1, newStart: 1, newLines: added + 1, lines: row.edit.lines }] } });
        before = id + "-" + n + "r";
      }
      ends.push(before);
    });
    return text;
  };
  const path = transcriptPath(session.cwd, session.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines(session.id, said, false));
  if (sub) {
    const dir = join(dirname(path), session.id, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-" + sub.name + ".jsonl"), lines(session.id + "~" + sub.name, sub.said, true));
  }
}

// ---------- the records ----------

/** Why the demo cannot be made where it is, or nothing. The tool does not count a file in a temporary folder as work
 *  two sessions share (such files are scratch notes), so records kept there would not tell the whole story. */
export function unfit(): string | null {
  return scratch(HOME + "/")
    ? "데모의 기록 폴더(" + HOME + ")가 임시 폴더 아래에 있습니다. 이 도구는 임시 폴더의 파일을 두 세션이 함께 고친 파일로 세지 않아서, 여기서는 데모의 이야기가 다 보이지 않습니다.\n저장소를 임시 폴더 밖에 받아 주세요. 또는 CONTEXT_FLOW_DEMO_HOME=<다른 폴더> 로 기록 폴더만 옮겨도 됩니다."
    : null;
}

export async function make(now = Date.now()): Promise<{ sessions: number; links: Record<string, number> }> {
  const why = unfit();
  if (why) throw new Error(why);
  rmSync(HOME, { recursive: true, force: true });
  useDemoHomes();
  forgetPastes();
  const { api, web } = PROJECTS;
  for (const project of [api, web]) {
    mkdirSync(project.root, { recursive: true });
    writeFileSync(join(project.root, "NOTES.md"), "# " + project.name + " 메모\n\n데모가 만든 빈 작업 폴더입니다. 데모 에이전트에게 무언가를 '고쳐' 달라고 하면 이 파일에 한 줄을 적습니다.\n");
  }
  mkdirSync(CODEX, { recursive: true });
  mkdirSync(FLOW, { recursive: true });
  // the sidebar's projects, as the Codex desktop app keeps them
  writeFileSync(join(CODEX, ".codex-global-state.json"), JSON.stringify({ "local-projects": Object.fromEntries([api, web].map((one) => [one.id, { name: one.name, rootPaths: [one.root] }])), "thread-project-assignments": {} }));
  // both clients have the plugin whose hook carries waiting pieces, and Codex has approved it
  mkdirSync(join(CODEX, "plugins", "cache", "demo", "context-flow"), { recursive: true });
  writeFileSync(join(CODEX, "config.toml"), '[hooks.state."context-flow@demo:hooks/hooks.json:user_prompt_submit:0:0"]\ntrusted = true\n');
  mkdirSync(join(CLAUDE, "plugins"), { recursive: true });
  writeFileSync(join(CLAUDE, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "context-flow@demo": [{ scope: "user" }] } }));
  const db = new DatabaseSync(join(CODEX, "state_5.sqlite"));
  db.exec(THREADS);
  const S = SESSIONS;
  const reserve = join(api.root, "app", "reserve.py");

  // seat-api, Codex: the cause is found; a fork of that session fixes it
  codexThread(db, { id: S.cause.id, cwd: api.root, title: S.cause.title, at: now - 20 * HOUR }, [{
    at: now - 20 * HOUR, prompt: "같은 좌석이 두 번 예약되는 일이 가끔 있어. 원인부터 찾아줘. 아직 고치지는 마.",
    steps: [{ say: "`app/reserve.py`와 예약 테이블 정의를 읽어 보겠습니다." }, { say: CAUSE, last: true }],
  }]);
  codexThread(db, { id: S.fix.id, cwd: api.root, title: S.fix.title, at: now - 19 * HOUR, forkedFrom: S.cause.id }, [{
    at: now - 19 * HOUR, prompt: "유일 제약으로 막는 쪽으로 고쳐줘. 마이그레이션도 같이 만들어줘.",
    steps: [
      { change: { path: reserve, diff: "@@ -12,9 +12,10 @@ def reserve(seat_id, slot, user_id):\n-    seat = db.get_seat(seat_id, slot)\n-    if seat.status != 'free':\n-        return Taken()\n-    db.insert_reservation(seat_id, slot, user_id)\n+    try:\n+        db.insert_reservation(seat_id, slot, user_id)\n+    except UniqueViolation:\n+        return Taken(code='SEAT_TAKEN')\n     return Reserved()" } },
      { change: { path: join(api.root, "migrations", "0007_unique_seat_slot.sql"), diff: "@@ -0,0 +1,2 @@\n+ALTER TABLE reservations\n+  ADD CONSTRAINT uq_seat_slot UNIQUE (seat_id, slot);" } },
      { say: FIXED, last: true },
    ],
  }]);
  codexThread(db, { id: S.ci.id, cwd: api.root, title: S.ci.title, at: now - 3 * DAY }, [{
    at: now - 3 * DAY, prompt: "CI에서 pip 캐시가 안 먹는 것 같아. 워크플로를 봐줘.",
    steps: [{ change: { path: join(api.root, ".github", "workflows", "ci.yml"), diff: "@@ -14,3 +14,4 @@\n       - uses: actions/setup-python@v5\n         with:\n           python-version: '3.12'\n+          cache: pip" } }, { say: "`setup-python`에 `cache: pip`이 빠져 있었습니다. 넣었고, 다음 실행부터 의존성 설치가 캐시를 씁니다.", last: true }],
  }]);
  codexThread(db, { id: S.logs.id, cwd: api.root, title: S.logs.title, at: now - 9 * DAY, archived: true }, [{
    at: now - 9 * DAY, prompt: "로그를 JSON 한 줄 형식으로 바꿔줘.",
    steps: [{ say: "로그 설정을 JSON 형식으로 바꿨습니다.", last: true }],
  }]);

  // seat-api, Claude Code: tests written from the cause, which the person pasted in by hand
  const tests = join(api.root, "tests", "test_reserve.py");
  claudeSession({ id: S.tests.id, cwd: api.root, title: S.tests.title }, [
    { at: now - 5 * HOUR, user: "아래 원인 분석대로 중복 예약을 재현하는 테스트부터 만들어줘.\n\n" + CAUSE_COPIED },
    { at: now - 5 * HOUR + MINUTE, text: "먼저 지금 코드에서 중복이 실제로 나는지 세어 보겠습니다.", task: "중복 예약 재현 횟수 세기" },
    { at: now - 5 * HOUR + 4 * MINUTE, edit: { path: tests, lines: [" import threading", "+", "+def test_double_booking(db):", "+    results = run_together(lambda: reserve(seat_id=7, slot='10:00', user_id=new_user()), times=2)", "+    assert results.count(Reserved()) == 1"] } },
    { at: now - 5 * HOUR + 6 * MINUTE, edit: { path: reserve, lines: ["-def reserve(seat_id, slot, user_id):", "+def reserve(seat_id, slot, user_id, now=None):"] } },
    { at: now - 5 * HOUR + 8 * MINUTE, text: TESTED, end: true },
  ], { name: "count", said: [
    { at: now - 5 * HOUR + 2 * MINUTE, user: "tests/test_reserve.py의 재현 코드를 스무 번 돌려 중복이 몇 번 나는지 세어줘." },
    { at: now - 5 * HOUR + 3 * MINUTE, text: "스무 번 중 일곱 번 중복이 났습니다.", end: true },
  ] });
  // at work right now, and stopped until the person allows something: what the live files written by run.ts say
  claudeSession({ id: S.batch.id, cwd: api.root, title: S.batch.title }, [
    { at: now - 18 * MINUTE, user: "30분 넘게 결제되지 않은 예약을 지우는 배치를 만들어줘. 먼저 지울 대상을 세는 것부터." },
    { at: now - 15 * MINUTE, text: "대상을 세는 쿼리부터 넣겠습니다.", edit: { path: join(api.root, "app", "cleanup.py"), lines: ["+def count_expired(db, now):", "+    return db.scalar(\"SELECT count(*) FROM reservations WHERE paid_at IS NULL AND created_at < ?\", now - HOLD)"] } },
    { at: now - 40_000, text: "대상을 세는 부분은 됐습니다. 이제 실제로 지우는 부분을 만들고 시험을 돌리는 중입니다.", bash: "pytest tests/test_cleanup.py -q" },
  ]);
  claudeSession({ id: S.dedupe.id, cwd: api.root, title: S.dedupe.title }, [
    { at: now - 12 * MINUTE, user: "유일 제약을 걸기 전에, 이미 들어 있는 중복 예약을 정리해야 해. 중복을 찾아 나중 것을 지우는 스크립트를 만들고 돌려줘." },
    { at: now - 9 * MINUTE, text: "중복을 찾는 스크립트를 만들겠습니다.", edit: { path: join(api.root, "scripts", "dedupe_reservations.py"), lines: ["+# keeps the first reservation of each (seat_id, slot) and deletes the later ones", "+def dedupe(db, apply=False):", "+    rows = db.all(DUPLICATES)", "+    if apply:", "+        db.delete_many(row.id for row in rows)", "+    return len(rows)"] } },
    { at: now - 6 * MINUTE, text: "중복은 14건입니다. 나중에 들어온 행을 지우려면 스크립트를 `--apply`로 돌려야 하고, 그러려면 허락이 필요합니다.", bash: "python scripts/dedupe_reservations.py --apply" },
  ]);

  // seat-web: one session that worked on the same file as the next, and an old one
  const form = join(web.root, "src", "ReserveForm.tsx");
  claudeSession({ id: S.form.id, cwd: web.root, title: S.form.title }, [
    { at: now - 7 * HOUR, user: "예약 폼을 키보드만으로 끝까지 쓸 수 있는지 점검하고 고쳐줘." },
    { at: now - 7 * HOUR + 3 * MINUTE, edit: { path: form, lines: ["-<div onClick={submit}>예약</div>", "+<button type=\"submit\">예약</button>"] } },
    { at: now - 7 * HOUR + 5 * MINUTE, text: "제출 단추가 `div`라 키보드로 누를 수 없었습니다. `button`으로 바꿨고, 탭 순서는 문제없습니다.", end: true },
    // The person asked for something more, did not like where it went, and took the talk back (/rewind) to ask
    // for something else: what was said in between stays in the record, and is the talk no more.
    { at: now - 7 * HOUR + 9 * MINUTE, user: "탭 순서를 날짜, 시간, 좌석 순으로 직접 정해줘." },
    { at: now - 7 * HOUR + 11 * MINUTE, text: "세 입력에 `tabindex`를 1, 2, 3으로 주면 순서는 고정됩니다. 다만 양수 `tabindex`는 페이지의 다른 요소보다 항상 먼저 잡혀서, 머리말의 링크를 건너뛰게 됩니다. 그래도 진행할까요?", end: true },
    { at: now - 7 * HOUR + 14 * MINUTE, after: 2, user: "키보드로 옮겨 다닐 때 어디에 있는지 안 보여. 포커스 테두리가 보이게 해줘." },
    { at: now - 7 * HOUR + 16 * MINUTE, edit: { path: join(web.root, "src", "form.css"), lines: ["-button:focus { outline: none; }", "+button:focus-visible, input:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }"] } },
    { at: now - 7 * HOUR + 18 * MINUTE, text: "`outline: none`이 포커스 테두리를 지우고 있었습니다. `:focus-visible`일 때 2px 테두리가 보이게 바꿨습니다. 마우스로 누를 때는 나타나지 않습니다.", end: true },
  ]);
  // Its second request was said again in the app, in other words: Codex began the record in a new file, and the
  // request as it was first made, with what came of it, stays behind in the old one.
  const seatMap = join(web.root, "src", "SeatMap.tsx");
  codexThread(db, { id: S.map.id, cwd: web.root, title: S.map.title, at: now - 3 * DAY }, [{
    at: now - 3 * DAY, prompt: "좌석 배치도를 SVG로 그리는 컴포넌트를 만들어줘. 예약된 좌석은 회색으로.",
    steps: [{ change: { path: seatMap, diff: "@@ -0,0 +1,3 @@\n+export function SeatMap({ seats }: Props) {\n+  return <svg>{seats.map((seat) => <Seat key={seat.id} {...seat} />)}</svg>;\n+}" } }, { say: "`SeatMap` 컴포넌트를 만들었습니다. 예약된 좌석은 회색이고 누를 수 없습니다.", last: true }],
  }, {
    at: now - 3 * DAY + 20 * MINUTE, prompt: "좌석을 누르면 바로 예약되게 해줘.",
    steps: [{ change: { path: seatMap, diff: "@@ -1,3 +1,3 @@\n export function SeatMap({ seats }: Props) {\n-  return <svg>{seats.map((seat) => <Seat key={seat.id} {...seat} />)}</svg>;\n+  return <svg>{seats.map((seat) => <Seat key={seat.id} {...seat} onClick={() => reserve(seat.id)} />)}</svg>;\n }" } }, { say: "좌석을 누르면 곧바로 `reserve()`를 부르게 했습니다. 확인 단계가 없어서, 잘못 누른 좌석도 그대로 예약됩니다.", last: true }],
  }], { own: laterFile(1), keep: 1, turns: [{
    at: now - 3 * DAY + 26 * MINUTE, prompt: "좌석을 누르면 예약 폼에 그 좌석이 골라지게만 해줘. 예약은 폼의 단추로 하게.",
    steps: [{ change: { path: seatMap, diff: "@@ -1,3 +1,3 @@\n-export function SeatMap({ seats }: Props) {\n-  return <svg>{seats.map((seat) => <Seat key={seat.id} {...seat} />)}</svg>;\n+export function SeatMap({ seats, onPick }: Props) {\n+  return <svg>{seats.map((seat) => <Seat key={seat.id} {...seat} onClick={() => onPick(seat.id)} />)}</svg>;\n }" } }, { say: "좌석을 누르면 `onPick`으로 그 좌석을 알리기만 하게 했습니다. 예약은 폼의 '예약' 단추를 눌러야 됩니다.", last: true }],
  }] });
  db.close();

  // The pieces that were sent with this tool. Each is cut from where it was said (found by reading the records made
  // so far, the way the tool does), written down as the tool writes it, and put between its marks in the request
  // the receiving session was given: the line is drawn because the mark is in that session's own record.
  const { projects, assigned } = readCodexProjects();
  const first = await buildSnapshot(projects, assigned, now, [], [], noLive);
  const cut = (session: string, text: string): Item & { start: number } => {
    const found = [...first.bodies.values()].find((item) => item.sessionId === session && item.kind === "answer" && item.text.includes(text));
    if (!found) throw new Error("the demo's own records do not hold the piece it wants to send");
    return { ...found, start: found.text.indexOf(text) };
  };
  const place = (name: keyof typeof SESSIONS): Place => ({ project: PROJECTS[S[name].project].id, projectName: PROJECTS[S[name].project].name, title: S[name].title, client: S[name].client });
  const error = cut(S.fix.id, NEW_ERROR);
  const finding = cut(S.tests.id, FOR_THE_SCREEN);
  const transfers: Transfer[] = [
    { id: "cfdemo000001", at: now - 3 * HOUR, from: { sessionId: S.fix.id, itemId: error.id, start: error.start, end: error.start + NEW_ERROR.length }, to: { sessionId: S.docs.id }, text: NEW_ERROR },
    // between two projects: both ends are said in full, since neither project's records hold the other end
    { id: "cfdemo000002", at: now - 2 * HOUR, from: { sessionId: S.tests.id, itemId: finding.id, start: finding.start, end: finding.start + FOR_THE_SCREEN.length, where: place("tests") }, to: { sessionId: S.message.id, where: place("message") }, text: FOR_THE_SCREEN },
  ];
  writeFileSync(join(FLOW, "transfers.jsonl"), transfers.map(line).join(""));
  const again = new DatabaseSync(join(CODEX, "state_5.sqlite"));
  codexThread(again, { id: S.docs.id, cwd: api.root, title: S.docs.title, at: now - 3 * HOUR }, [{
    at: now - 3 * HOUR, prompt: withBlocks("예약 API 문서에 새 오류 응답을 추가해줘.", [pieceBlock({ id: transfers[0].id, from: "‘" + S.fix.title + "’ (Codex)", kind: "답변", text: NEW_ERROR })]),
    steps: [{ change: { path: join(api.root, "docs", "api.md"), diff: "@@ -41,2 +41,3 @@ POST /reservations\n | 201 | 예약됨 |\n | 400 | 요청 형식 오류 |\n+| 409 | SEAT_TAKEN: 같은 좌석·시간대에 예약이 이미 있음. 좌석 목록을 다시 불러올 것 |" } }, { say: "`docs/api.md`의 `POST /reservations` 응답 표에 `409 SEAT_TAKEN`을 추가했습니다.", last: true }],
  }]);
  again.close();
  claudeSession({ id: S.message.id, cwd: web.root, title: S.message.title }, [
    { at: now - 2 * HOUR, user: withBlocks("좌석이 이미 예약됐을 때 화면에 띄울 안내를 넣어줘.", [pieceBlock({ id: transfers[1].id, from: "‘" + S.tests.title + "’ (Claude Code, 프로젝트 " + api.name + ")", kind: "답변", text: FOR_THE_SCREEN })]) },
    { at: now - 2 * HOUR + 2 * MINUTE, edit: { path: form, lines: ["+if (error.code === 'SEAT_TAKEN') {", "+  toast('방금 다른 분이 예약했습니다');", "+  reloadSeats();", "+}"] } },
    { at: now - 2 * HOUR + 4 * MINUTE, text: "`ReserveForm`이 `409 SEAT_TAKEN`을 받으면 '방금 다른 분이 예약했습니다'를 띄우고 좌석 목록을 다시 불러오게 했습니다.", end: true },
  ]);

  // Read it all once more, the way the screen will, and see that the story is in it: a demo that silently lost a
  // line would teach the wrong thing.
  forgetPastes();
  const whole = await buildSnapshot(projects, assigned, now, transfers, [], noLive);
  const links: Record<string, number> = {};
  for (const link of whole.snapshot.links) links[link.kind] = (links[link.kind] ?? 0) + 1;
  const wanted = { fork: 1, paste: 1, transfer: 2, subagent: 1 };
  for (const [kind, count] of Object.entries(wanted)) if (links[kind] !== count) throw new Error("the demo's records should give " + count + " " + kind + " link(s), and give " + (links[kind] ?? 0) + ": " + JSON.stringify(links));
  if (whole.snapshot.overlaps.length !== 2) throw new Error("the demo's records should give two files that two sessions changed, and give " + whole.snapshot.overlaps.length);
  // two talks went one way and then another: each is the two requests it stands on, with one left behind beside it
  for (const name of ["map", "form"]) {
    const asked = whole.snapshot.sessions.find((one) => one.id === S[name].id)?.counts.prompts;
    const behind = (whole.gone.get(S[name].id) ?? []).map((stretch) => stretch.filter((item) => item.kind === "prompt").length).join(",");
    if (asked !== 2 || behind !== "1") throw new Error("the demo's ‘" + S[name].title + "’ should be a talk of two requests with one request left behind, and is one of " + asked + " with " + (behind || "none"));
  }
  return { sessions: whole.snapshot.sessions.length, links };
}

if (process.argv[1]?.endsWith("make.ts")) console.log(JSON.stringify(await make()));
