// What the demo sets up before its screen is served: its records, the stand-ins for the two clients, and two sessions
// that are in the middle of something. "npm run demo" does this, and so does the script that takes the pictures.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { make } from "./make.ts";
import { CLAUDE, SESSIONS, useDemoHomes, useStandIns } from "./world.ts";

export async function stage(): Promise<Awaited<ReturnType<typeof make>>> {
  useDemoHomes();
  const made = await make();

  // The two clients are stood in for by demo/agent.ts.
  useStandIns();

  // Two sessions are in the middle of something: one at work, one stopped until it is allowed to run a command. Claude
  // Code says so in a small file for each of its live processes; here this process and a helper that only waits stand
  // for those two.
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
  process.on("exit", () => helper.kill());
  mkdirSync(join(CLAUDE, "sessions"), { recursive: true });
  const live = (pid: number, sessionId: string, status: string, waitingFor?: string) =>
    writeFileSync(join(CLAUDE, "sessions", pid + ".json"), JSON.stringify({ pid, sessionId, status, ...(waitingFor ? { waitingFor } : {}), statusUpdatedAt: Date.now() }));
  live(process.pid, SESSIONS.batch.id, "busy");
  if (helper.pid) live(helper.pid, SESSIONS.dedupe.id, "waiting", "permission prompt");
  return made;
}
