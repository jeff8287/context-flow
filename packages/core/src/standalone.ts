// The screen and a bundle in one HTML file: opened by a double click, on any machine, with no server and nothing to
// install. The built screen's script and styles are put into the page, and the bundle beside them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";

export function standalonePage(webDir: string, bundle: Bundle): string {
  let page: string;
  try {
    page = readFileSync(join(webDir, "index.html"), "utf8");
  } catch {
    throw new Error("화면이 아직 빌드되지 않았습니다. npm run build 를 먼저 돌려 주세요");
  }
  const asset = (found: string) => readFileSync(join(webDir, found.replace(/^\//, "")), "utf8");
  // inside a page, a script ends at the first "</script" whatever it stands in, and "<!--" starts a stretch in which it does not end
  const script = page.match(/<script type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>/);
  const style = page.match(/<link rel="stylesheet"[^>]*\shref="([^"]+)"[^>]*>/);
  if (!script || !style || !readdirSync(webDir).includes("assets")) throw new Error("빌드된 화면의 꼴이 예상과 다릅니다");
  const code = asset(script[1]);
  if (code.includes("<!--")) throw new Error("화면의 스크립트를 한 파일에 넣을 수 없습니다 (<!-- 가 들어 있습니다)");
  const data = JSON.stringify(bundle).replace(/</g, "\\u003c"); // still the same JSON; no tag can begin in it
  const name = bundle.snapshot.project.name.replace(/[<>&]/g, " ");
  // replacements are given as functions: a "$" in the code or the data must stay a "$"
  return page
    .replace(script[0], () => '<script type="application/json" id="cf-bundle">' + data + "</script>\n  <script type=\"module\">" + code.replace(/<\/script/gi, "<\\/script") + "</script>")
    .replace(style[0], () => "<style>" + asset(style[1]).replace(/<\/style/gi, "<\\/style") + "</style>")
    .replace(/<title>[^<]*<\/title>/, () => "<title>맥락 흐름 · " + name + "</title>");
}
