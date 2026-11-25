// Keeping the screen's server up apart from whatever started it. A server started from inside the Codex app ends
// when the app is quit; one that launchd keeps for the user does not, and is there again after a login. (macOS only.)
// What is installed is one file, ~/Library/LaunchAgents/<LABEL>.plist; removing the service removes it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const LABEL = "local.context-flow.server";
export const plistPath = () => join(homedir(), "Library", "LaunchAgents", LABEL + ".plist");
const target = () => "gui/" + userInfo().uid + "/" + LABEL;
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The PATH the server is given: launchd's own has neither node nor the clients on it. The folders of this node and
 *  of claude as they are found now, then the usual ones; nothing that belongs to a passing shell or to an app. */
export function servicePath(env: NodeJS.ProcessEnv = process.env, node = process.execPath): string {
  const now = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const claude = now.find((dir) => existsSync(join(dir, "claude")));
  const dirs = [dirname(node), claude, join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs.filter((dir): dir is string => Boolean(dir)))].join(delimiter);
}

export function servicePlist(options: { node: string; cli: string; port: number; cwd: string; path: string; log: string; lang?: string }): string {
  const args = [options.node, "--disable-warning=ExperimentalWarning", options.cli, "serve", "--port", String(options.port)];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key><string>" + LABEL + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...args.map((arg) => "    <string>" + xml(arg) + "</string>"),
    "  </array>",
    "  <key>WorkingDirectory</key><string>" + xml(options.cwd) + "</string>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key><string>" + xml(options.path) + "</string>",
    "    <key>LANG</key><string>" + xml(options.lang ?? "en_US.UTF-8") + "</string>",
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    // brought up again if it falls over, left alone when it was stopped on purpose
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ProcessType</key><string>Background</string>",
    "  <key>StandardOutPath</key><string>" + xml(options.log) + "</string>",
    "  <key>StandardErrorPath</key><string>" + xml(options.log) + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const launchctl = (...args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15_000 });

export function serviceStatus(): { installed: boolean; loaded: boolean; running: boolean; pid: number | null } {
  const printed = launchctl("print", target());
  const loaded = printed.status === 0;
  const text = String(printed.stdout ?? "");
  const pid = /^\s*pid = (\d+)/m.exec(text);
  return { installed: existsSync(plistPath()), loaded, running: loaded && /^\s*state = running/m.test(text), pid: pid ? Number(pid[1]) : null };
}

/** Write the agent's file and hand it to launchd. An agent of the same name that is already there is replaced. */
export function installService(cli: string, port: number): { ok: boolean; message: string } {
  if (process.platform !== "darwin") return { ok: false, message: "지금은 macOS(launchd)에서만 됩니다. 다른 곳에서는 npm run serve 를 직접 띄워 두세요." };
  const home = process.env.CONTEXT_FLOW_HOME ?? join(homedir(), ".context-flow");
  mkdirSync(home, { recursive: true });
  mkdirSync(dirname(plistPath()), { recursive: true });
  const cwd = join(dirname(cli), "..", "..", "..");
  writeFileSync(plistPath(), servicePlist({ node: process.execPath, cli, port, cwd, path: servicePath(), log: join(home, "server.log"), lang: process.env.LANG }));
  launchctl("bootout", target()); // the one that was there, if any
  const made = launchctl("bootstrap", "gui/" + userInfo().uid, plistPath());
  if (made.status !== 0) return { ok: false, message: "launchd가 받아 주지 않았습니다: " + String(made.stderr || made.stdout).trim() };
  return { ok: true, message: plistPath() };
}

export function uninstallService(): { ok: boolean; message: string } {
  if (process.platform !== "darwin") return { ok: false, message: "지금은 macOS(launchd)에서만 됩니다." };
  const was = serviceStatus();
  launchctl("bootout", target());
  rmSync(plistPath(), { force: true });
  return { ok: true, message: was.installed || was.loaded ? "내렸고 " + plistPath() + " 를 지웠습니다" : "올려 둔 것이 없었습니다" };
}

/** Stop it and let launchd start it again: after the code was changed. */
export function restartService(): { ok: boolean; message: string } {
  const done = launchctl("kickstart", "-k", target());
  return done.status === 0 ? { ok: true, message: "다시 띄웠습니다" } : { ok: false, message: "올려 둔 서비스가 없습니다. 먼저 install 하세요. " + String(done.stderr).trim() };
}
