// Context Flow, the hook for UserPromptSubmit (run by along.sh). It takes the pieces set to wait for this session
// (<home>/pending/<session id>/<piece id>.json, put there by the screen's server) and hands them to the client as
// context that goes with the prompt. Each piece taken is written to <home>/transfers.jsonl; the screen draws its
// line once the session's own record holds the piece's mark.
// Plain JavaScript on purpose: it runs on whatever node the client's machine has, with nothing to build or install.
// Whatever goes wrong, the prompt must go as it was typed: every way out of here is a quiet one.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.CONTEXT_FLOW_HOME ?? join(homedir(), ".context-flow");
const NOTE = "(아래는 사용자가 다른 세션에서 골라, 이 말과 함께 보라고 실어 보낸 맥락입니다.)";
const CLOSE = "</context-piece>";

/** The pieces as they go, within the room the client leaves a hook. A piece too long for its share goes in part,
 *  between its marks all the same, with the whole of it in a file the agent can read (<home>/pieces/<id>.txt). */
function fit(rows, room) {
  const blocks = new Map(rows.map((row) => [row.id, row.block]));
  let left = room - NOTE.length - 2 * rows.length;
  const shortestFirst = [...rows].sort((a, b) => a.block.length - b.block.length); // what a short piece does not use is left to the long ones
  shortestFirst.forEach((row, at) => {
    const share = Math.floor(left / (shortestFirst.length - at));
    if (row.block.length > share) {
      const open = row.block.slice(0, row.block.indexOf("\n")); // the opening mark is the block's first line
      const file = join(home, "pieces", row.id + ".txt");
      let where = "나머지는 싣지 못했습니다.";
      try {
        mkdirSync(join(home, "pieces"), { recursive: true });
        writeFileSync(file, row.text);
        where = "전체는 다음 파일에 있습니다: " + file;
      } catch { /* the part still goes */ }
      const keep = Math.max(0, share - open.length - CLOSE.length - where.length - 60);
      blocks.set(row.id, open + "\n" + row.text.slice(0, keep) + "\n…(이 조각은 " + row.text.length + "자 가운데 앞의 " + keep + "자만 실었습니다. " + where + ")\n" + CLOSE);
    }
    left -= blocks.get(row.id).length;
  });
  return rows.map((row) => blocks.get(row.id));
}

function main() {
  let asked;
  try {
    asked = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const session = asked?.session_id;
  if (asked?.hook_event_name !== "UserPromptSubmit" || typeof session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(session)) return;
  const dir = join(home, "pending", session);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return; // nothing waits for this session
  }
  // Renaming a file is taking it: a piece cancelled on the screen, or taken by another call, is no longer there to rename.
  const mine = [];
  for (const name of names) {
    const taken = join(dir, name + "." + process.pid + ".taken");
    try {
      renameSync(join(dir, name), taken);
    } catch {
      continue;
    }
    try {
      const row = JSON.parse(readFileSync(taken, "utf8"));
      if (row?.id && row.from?.itemId && row.to?.sessionId === session && typeof row.text === "string" && typeof row.block === "string") {
        mine.push({ row, taken, back: join(dir, name) });
        continue;
      }
    } catch { /* not a piece */ }
    try { unlinkSync(taken); } catch { /* gone already */ }
  }
  if (!mine.length) return;
  mine.sort((a, b) => a.row.at - b.row.at);
  const putBack = () => {
    for (const one of mine) try { renameSync(one.taken, one.back); } catch { /* leave it */ }
  };
  const now = Date.now();
  try {
    appendFileSync(join(home, "transfers.jsonl"), mine.map(({ row }) => JSON.stringify({ id: row.id, at: now, from: row.from, to: row.to, text: row.text, via: "hook" }) + "\n").join(""));
  } catch {
    return putBack();
  }
  // Claude Code swaps what a hook puts with a prompt for a short preview once it is over 10,000 characters; Codex
  // was seen to take 46,000 whole. Codex is known by its record's name (rollout-….jsonl); anything else gets the small room.
  const room = /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(String(asked.transcript_path ?? "")) ? 40000 : 9000;
  const context = NOTE + "\n\n" + fit(mine.map((one) => one.row), room).join("\n\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }), (error) => {
    if (error) return putBack(); // the client did not get them: they wait for the next prompt (the lines written above draw nothing without the mark)
    for (const one of mine) try { unlinkSync(one.taken); } catch { /* gone already */ }
    try { rmdirSync(dir); } catch { /* more pieces were set meanwhile */ }
  });
}

try {
  main();
} catch { /* quiet */ }
