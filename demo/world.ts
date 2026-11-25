// The demo's made-up world: where its records are kept and what its sessions are called. Nothing here is anybody's
// real work. Everything the demo writes goes under demo/home, which can be deleted at any time.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Where the demo keeps everything. Another folder can be named (the demo's own test does), so that two never meet. */
export const HOME = process.env.CONTEXT_FLOW_DEMO_HOME || join(ROOT, "demo", "home");
/** Stand-ins for ~/.codex, ~/.claude and ~/.context-flow. */
export const CODEX = join(HOME, "codex");
export const CLAUDE = join(HOME, "claude");
export const FLOW = join(HOME, "flow");
/** The folders the made-up sessions work in. */
export const WORK = join(HOME, "work");

export const PROJECTS = {
  api: { id: "demo-seat-api", name: "seat-api", root: join(WORK, "seat-api") },
  web: { id: "demo-seat-web", name: "seat-web", root: join(WORK, "seat-web") },
};

const id = (n: number) => "0de00000-0000-4000-8000-" + String(n).padStart(12, "0");
/** The sessions, by the short names the walk-through and "npm run demo:say" use. */
export const SESSIONS: Record<string, { id: string; client: "codex" | "claude"; project: keyof typeof PROJECTS; title: string }> = {
  cause: { id: id(1), client: "codex", project: "api", title: "예약 중복 원인 찾기" },
  fix: { id: id(2), client: "codex", project: "api", title: "예약 중복 원인 찾기 (2)" },
  tests: { id: id(3), client: "claude", project: "api", title: "예약 API 테스트 보강" },
  batch: { id: id(4), client: "claude", project: "api", title: "만료된 예약 정리 배치" },
  docs: { id: id(5), client: "codex", project: "api", title: "API 문서 갱신" },
  dedupe: { id: id(6), client: "claude", project: "api", title: "기존 중복 예약 정리" },
  ci: { id: id(7), client: "codex", project: "api", title: "CI 캐시 설정" },
  logs: { id: id(8), client: "codex", project: "api", title: "로깅 형식 정리" },
  message: { id: id(11), client: "claude", project: "web", title: "예약 실패 안내 문구" },
  map: { id: id(12), client: "codex", project: "web", title: "좌석 배치도 컴포넌트" },
  form: { id: id(13), client: "claude", project: "web", title: "예약 폼 접근성 점검" },
};

export const MODEL = { codex: "demo-codex-1", claude: "claude-demo-1" };

/** Point this process, and whatever it starts, at the demo's records instead of the person's own. */
export function useDemoHomes(): void {
  process.env.CONTEXT_FLOW_CODEX_HOME = CODEX;
  process.env.CONTEXT_FLOW_CLAUDE_HOME = CLAUDE;
  process.env.CONTEXT_FLOW_HOME = FLOW;
}

export const line = (value: unknown) => JSON.stringify(value) + "\n";
export const iso = (at: number) => new Date(at).toISOString();
/** The file Codex keeps for a thread, and the one Claude Code keeps for a session that works in a folder. */
export const rolloutPath = (thread: string) => join(CODEX, "sessions", "rollout-" + thread + ".jsonl");
export const transcriptPath = (cwd: string, session: string) => join(CLAUDE, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), session + ".jsonl");

export const THREADS = "create table if not exists threads (id text primary key, rollout_path text, cwd text, title text, name text, model text, created_at_ms integer, updated_at_ms integer, thread_source text, source text, archived integer, first_user_message text, attached_thread_parent_id text);"
  + " create table if not exists thread_spawn_edges (parent_thread_id text, child_thread_id text);";
