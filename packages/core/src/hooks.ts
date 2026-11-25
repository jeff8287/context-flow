// Whether each client has this tool's plugin, whose hook takes the pieces set to wait (plugin/context-flow).
// Read from the clients' own files; nothing is written. Codex calls a plugin's hook only after the person approved it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "./claude.ts";
import { codexHome } from "./codex.ts";
import type { Client, HookState } from "./model.ts";

export const PLUGIN = "context-flow";

export function hookStates(codex = codexHome(), claude = claudeHome()): Record<Client, HookState> {
  const state: Record<Client, HookState> = { codex: "absent", claude: "absent" };
  try {
    const cache = join(codex, "plugins", "cache");
    if (readdirSync(cache).some((market) => existsSync(join(cache, market, PLUGIN)))) {
      // an approval is kept as [hooks.state."<plugin>@<marketplace>:hooks/hooks.json:user_prompt_submit:0:0"]
      const config = readFileSync(join(codex, "config.toml"), "utf8");
      state.codex = new RegExp('^\\[hooks\\.state\\."' + PLUGIN + '@[^"]*:user_prompt_submit:', "m").test(config) ? "ready" : "untrusted";
    }
  } catch { /* no Codex here, or no plugins */ }
  try {
    const installed = JSON.parse(readFileSync(join(claude, "plugins", "installed_plugins.json"), "utf8"));
    if (Object.keys(installed?.plugins ?? {}).some((name) => name.startsWith(PLUGIN + "@"))) state.claude = "ready";
  } catch { /* no Claude Code here, or no plugins */ }
  return state;
}
