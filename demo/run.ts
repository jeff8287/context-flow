// npm run demo: makes the demo's records and serves the screen on them, with stand-ins for the two clients.
// Nothing of the person's own is read or written: the tool is pointed at demo/home for everything.
//   --port N   the port to serve on (8802 unless said; a real install uses 8801)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serve } from "../packages/core/src/server.ts";
import { unfit } from "./make.ts";
import { stage } from "./stage.ts";
import { PROJECTS, ROOT } from "./world.ts";

process.removeAllListeners("warning"); // node:sqlite still announces itself as experimental
const args = process.argv.slice(2);
const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 8802);
const dist = join(ROOT, "packages", "web", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("화면이 아직 빌드되지 않았습니다. npm run demo 로 시작하거나 npm run build 를 먼저 돌려 주세요.");
  process.exit(1);
}
const why = unfit();
if (why) {
  console.error(why);
  process.exit(1);
}
const made = await stage();

serve(port, dist);
const url = "http://127.0.0.1:" + port + "/?project=";
console.log([
  "",
  "맥락 흐름 데모: 가짜 기록으로 돕니다 (세션 " + made.sessions + "개, 내 Codex·Claude Code 기록은 읽지 않습니다)",
  "  한 프로젝트    " + url + PROJECTS.api.name,
  "  두 프로젝트    " + url + PROJECTS.api.name + "," + PROJECTS.web.name,
  "  따라 하기      docs/DEMO.md",
  "  세션의 '자기 창'에서 말하기 (다른 터미널에서)   npm run demo:say -- <세션> \"<할 말>\"",
  "  끝내기         Ctrl+C   (데모가 만든 것은 demo/home 에만 있고, 다시 시작하면 새로 만듭니다)",
  "",
].join("\n"));
