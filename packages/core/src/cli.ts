// node packages/core/src/cli.ts scan [project]     what the records hold for one project, in numbers
// node packages/core/src/cli.ts serve [--port N]    the local API and the screen
// node packages/core/src/cli.ts export <project> --out FILE [--sessions ID,ID,…] [--mask] [--mask-words WORD,WORD,…]
//                                                   some sessions of a project in one file, for an experiment: a
//                                                   bundle (FILE.json), or the screen with the bundle in it (FILE.html).
//                                                   <project> may be several, with commas between: one map of them all.
//                                                   --mask covers the name of this machine's user wherever it stands
//                                                   (and the words given besides) with as many marks as it has letters
// node packages/core/src/cli.ts service install|uninstall|restart|status [--port N]
//                                                   keep the server up by itself (macOS, launchd): it then outlives
//                                                   the app or the terminal it was started from, and a login
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBundle, maskBundle } from "./bundle.ts";
import { HOME } from "./home.ts";
import { serve } from "./server.ts";
import { installService, plistPath, restartService, serviceStatus, uninstallService } from "./service.ts";
import { standalonePage } from "./standalone.ts";
import { buildSnapshot, findProject, findProjects, readCodexProjects } from "./snapshot.ts";

process.removeAllListeners("warning"); // node:sqlite still announces itself as experimental on every start

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);

if (command === "scan") {
  const { projects, assigned } = readCodexProjects();
  const wanted = rest.find((value) => !value.startsWith("--")) ?? process.cwd();
  const project = findProject(wanted, projects);
  if (!project) {
    console.error("프로젝트를 찾지 못했습니다: " + wanted + "\n있는 것: " + projects.map((item) => item.name).join(", "));
    process.exit(1);
  }
  const began = Date.now();
  const { snapshot } = await buildSnapshot(project, assigned);
  const count = <T>(list: T[], key: (item: T) => string) => Object.fromEntries([...Map.groupBy(list, key)].map(([name, group]) => [name, group.length]));
  console.log(JSON.stringify({
    project: project.name,
    roots: project.roots,
    sessions: snapshot.sessions.length,
    byClient: count(snapshot.sessions, (session) => session.client),
    byOrigin: count(snapshot.sessions, (session) => session.origin),
    byActivity: count(snapshot.sessions, (session) => session.activity),
    items: count(snapshot.items, (item) => item.kind),
    links: count(snapshot.links, (link) => link.kind),
    overlaps: snapshot.overlaps.length,
    topOverlaps: snapshot.overlaps.slice(0, 5).map((overlap) => overlap.path + " (" + new Set(overlap.touches.map((touch) => touch.sessionId)).size + ")"),
    notes: snapshot.notes,
    ms: Date.now() - began,
  }, null, 1));
} else if (command === "export") {
  const { projects, assigned } = readCodexProjects();
  const taken = new Set(["--out", "--sessions", "--mask-words"].map((name) => flag(name)));
  const wanted = rest.find((value) => !value.startsWith("--") && !taken.has(value)) ?? process.cwd();
  const chosen = findProjects(wanted, projects);
  const out = flag("--out");
  if (!chosen.length || !out) {
    console.error(chosen.length ? "어디에 쓸지 --out FILE.html 또는 FILE.json 으로 알려 주세요" : "프로젝트를 찾지 못했습니다: " + wanted);
    process.exit(1);
  }
  const { snapshot, bodies } = await buildSnapshot(chosen.length === 1 ? chosen[0] : chosen, assigned);
  // a session can be named by the beginning of its id
  const named = (flag("--sessions") ?? "").split(",").filter(Boolean);
  const ids = named.map((name) => snapshot.sessions.filter((session) => session.id.startsWith(name)));
  const unclear = named.filter((_, at) => ids[at].length !== 1);
  if (unclear.length) {
    console.error("세션을 하나로 정하지 못했습니다: " + unclear.join(", "));
    process.exit(1);
  }
  const whole = makeBundle(snapshot, bodies, { sessions: named.length ? ids.map((found) => found[0].id) : undefined });
  const masked = rest.includes("--mask") || flag("--mask-words") ? maskBundle(whole, [...(rest.includes("--mask") ? [basename(HOME), userInfo().username] : []), ...(flag("--mask-words") ?? "").split(",")]) : null;
  const bundle = masked?.bundle ?? whole;
  const here = dirname(fileURLToPath(import.meta.url));
  const text = out.endsWith(".html") ? standalonePage(join(here, "..", "..", "web", "dist"), bundle) : JSON.stringify(bundle);
  writeFileSync(out, text);
  const kinds = Object.fromEntries([...Map.groupBy(bundle.snapshot.links, (link) => link.kind)].map(([kind, group]) => [kind, group.length]));
  console.log(JSON.stringify({ out, bytes: Buffer.byteLength(text), ...(masked ? { covered: masked.covered } : {}), sessions: bundle.snapshot.sessions.length, items: bundle.items.length, chars: bundle.items.reduce((sum, item) => sum + item.text.length, 0), links: kinds, titles: bundle.snapshot.sessions.filter((session) => session.origin !== "subagent" && session.origin !== "side").map((session) => session.title) }, null, 1));
} else if (command === "serve") {
  const here = dirname(fileURLToPath(import.meta.url));
  serve(Number(flag("--port") ?? 8801), join(here, "..", "..", "web", "dist"));
} else if (command === "service") {
  const port = Number(flag("--port") ?? 8801);
  const up = async () => {
    // the server answers once it has read what it needs: give it a few seconds
    for (let tries = 0; tries < 24; tries += 1) {
      try {
        if ((await fetch("http://127.0.0.1:" + port + "/api/projects")).ok) return true;
      } catch { /* not listening yet */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };
  const what = rest[0];
  if (what === "install" || what === "restart") {
    const done = what === "install" ? installService(fileURLToPath(import.meta.url), port) : restartService();
    if (!done.ok) {
      console.error(done.message);
      process.exit(1);
    }
    const answers = await up();
    console.log(JSON.stringify({ ...serviceStatus(), plist: plistPath(), url: "http://127.0.0.1:" + port, answers, log: "~/.context-flow/server.log" }, null, 1));
    if (!answers) process.exit(1);
  } else if (what === "uninstall") {
    console.log(uninstallService().message);
  } else if (what === "status") {
    let answers = false;
    try {
      answers = (await fetch("http://127.0.0.1:" + port + "/api/projects")).ok;
    } catch { /* nothing listens there */ }
    console.log(JSON.stringify({ ...serviceStatus(), plist: plistPath(), url: "http://127.0.0.1:" + port, answers }, null, 1));
  } else {
    console.error("usage: cli.ts service install|uninstall|restart|status [--port N]");
    process.exit(1);
  }
} else {
  console.error("usage: cli.ts scan [project] | serve [--port N] | export <project[,project]> --out FILE.html|FILE.json [--sessions ID,ID] [--mask] [--mask-words W,W] | service install|uninstall|restart|status");
  process.exit(1);
}
