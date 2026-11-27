// The shapes every part agrees on. A reader of one client's records turns them into these; the screen and the
// plugin see nothing else. Changing a field here is changing the stored form.

export type Client = "codex" | "claude";

/** A project as the Codex sidebar has it: a name and the folders it covers. A Claude Code session belongs by its folder. */
export interface Project {
  id: string;
  name: string;
  roots: string[];
}

/** How a session came to be. */
/** imported: a copy Codex made of a Claude Code session. */
export type Origin = "user" | "fork" | "spawned" | "subagent" | "side" | "imported";

/** What a session is doing: read from its record, and settled by what its client's live processes say (live.ts).
 *  running: a turn is under way. waiting: its last turn ended within a day, and it is the person's move. */
export type Activity = "running" | "waiting" | "idle" | "archived";

export interface Session {
  id: string;
  client: Client;
  projectId: string | null;
  cwd: string;
  title: string;
  model: string | null;
  startedAt: number;
  updatedAt: number;
  origin: Origin;
  parentId: string | null;
  activity: Activity;
  /** While running: what it waits on the person for. approval: to be allowed something. input: an answer to a question it put. */
  needs?: "approval" | "input";
  /** The file being changed most recently, when the session is running. */
  nowFile: string | null;
  recordPath: string | null;
  counts: { prompts: number; answers: number; changes: number };
}

/** One thing in a session that context can be cut from: what the user typed, what the agent said, what it changed. */
export type ItemKind = "prompt" | "answer" | "change";

export interface Item {
  /** <session id>:<number>. A number is never given to another item: a record is only ever added to, and where a
   *  Codex thread's record lies in several files (codex.ts), an item is numbered by its file and its place there. */
  id: string;
  sessionId: string;
  turnId: string | null;
  kind: ItemKind;
  at: number;
  text: string;
  /** For a change: the file. */
  path?: string;
  /** For an answer: whether it closed its turn. */
  final?: boolean;
  /** For a prompt: what a hook put with it. It reached the agent along with the prompt, but nobody typed it there. */
  added?: string;
  /** For a prompt: how many pictures came with it. They are not text, so no piece can be cut from them. */
  images?: number;
}

/** An item without its text, for drawing. */
export type ItemHead = Omit<Item, "text" | "added"> & { size: number; label: string };

/** Where on a session a link starts or ends. */
export interface End {
  sessionId: string;
  at: number;
  /** The item the link is about. For the line of a fork, at the parent's end: the request of the parent that the
   *  fork was made before (the fork knows what was said before it, and not it nor what followed). Left out when
   *  the parent has said nothing since the fork was made. */
  itemId?: string;
  /** Character range within the item's text, when the link is about a part of it. */
  start?: number;
  end?: number;
}

/** recorded: the record says so. paste: found by matching text. (Overlap is not a link; see Overlap.) */
export type Grade = "recorded" | "paste";
export type LinkKind = "fork" | "spawn" | "subagent" | "side" | "import" | "transfer" | "paste";

export interface Link {
  id: string;
  grade: Grade;
  kind: LinkKind;
  from: End;
  to: End;
  /** For a piece that was sent: how many characters. For a paste: how many of the prompt's letters were found in the source. */
  chars?: number;
  /** For a piece that was sent: its text, or the beginning of it. For a paste: the longest stretch that matches. */
  excerpt?: string;
  /** For a paste: the stretches that match, longest first, as ranges of the source item's text and of the prompt's. */
  parts?: { from: [number, number]; to: [number, number] }[];
}

/** One move of a piece along a link, found by following it: back towards where it first appeared, or onward to where it went. */
export interface TraceStep {
  dir: "back" | "onward";
  /** 1 is the move nearest the piece. */
  depth: number;
  link: Link;
  /** Set when the other end of this move is a session of a project that is not on the map: what that end is. The
   *  way stops there; with that project put on the map too, it is followed on. */
  far?: Place & { sessionId: string };
}

/** Which session an end of something is, said in full: for a project whose records do not hold that session. */
export interface Place {
  /** The project's id, and its name as the sidebar has it. */
  project: string;
  projectName: string;
  /** The session's name. */
  title: string;
  client: Client;
}

/** A piece of one item: the stretch of its text from start to end. */
export interface Piece {
  sessionId: string;
  itemId: string;
  start: number;
  end: number;
  /** Set when the piece goes to a session of another project: where it comes from, for that project. */
  where?: Place;
}

/** A piece this tool sent to another session along with a message. The tool keeps these; the link is drawn only
 *  when the receiving session's record holds the piece's mark, so that what is drawn is what the record says. */
export interface Transfer {
  id: string;
  at: number;
  from: Piece;
  /** where: set when the piece comes from a session of another project: where it goes, for that project. */
  to: { sessionId: string; where?: Place };
  /** The piece as it was when it was sent. */
  text: string;
  /** hook: it was set to wait, and the client's hook put it with the next thing said to the session. */
  via?: "hook";
}

/** A piece set to go with the next thing said to a session, wherever that is typed (the desktop app, a terminal,
 *  this screen). A hook in the session's client takes it then. Nothing has moved yet, so this is not a link. */
export interface Waiting {
  id: string;
  at: number;
  from: Piece;
  to: { sessionId: string; where?: Place };
  chars: number;
  excerpt: string;
  /** Something was said to the session after this was set and the piece did not go with it: the hook was not called there. */
  missed: boolean;
}

/** A piece that went between a session of this project and a session of another. It is not a line on the map (the
 *  other end is not on it); it is listed with the session of this project it belongs to.
 *  in: it arrived here (the receiving record holds its mark). out: it was sent from here; whether it arrived is for
 *  the other project's records to say. */
export interface FarLink {
  id: string;
  dir: "in" | "out";
  /** The session of this project, and the place in it: the prompt the piece came with, or the stretch it was cut from. */
  sessionId: string;
  itemId?: string;
  start?: number;
  end?: number;
  at: number;
  chars: number;
  excerpt: string;
  /** The other end. For a piece that came in: also the stretch it was cut from there. */
  other: Place & { sessionId: string; itemId?: string; start?: number; end?: number };
}

/** Whether a client has the hook that takes waiting pieces. untrusted: there, but the person has not approved it (Codex asks). */
export type HookState = "ready" | "untrusted" | "absent";

/** A file more than one session changed. Drawn as a tie, never as an arrow: it does not say context moved. */
export interface Overlap {
  path: string;
  touches: { sessionId: string; at: number; itemId: string }[];
}

/** What happens in a turn carried on from this tool, as the screen is told of it. Both clients are turned into these. */
export type TurnEvent =
  | { t: "prompt"; text: string }
  /** A piece of what the agent is saying. */
  | { t: "text"; d: string }
  /** The agent starts a new message. */
  | { t: "break" }
  /** Something the agent does between messages: a command, a change to a file, another tool. */
  | { t: "step"; kind: "command" | "change" | "tool"; label: string }
  /** The agent asks leave for something; it waits until the person answers. */
  | { t: "ask"; id: string; title: string; detail: string }
  | { t: "answered"; id: string; allow: boolean }
  | { t: "done"; ok: boolean; error?: string };

export interface Snapshot {
  version: 1;
  madeAt: number;
  /** What is on the screen. When several projects are put on one map: all of them as one (its id is their ids,
   *  joined by commas; its folders are all of theirs), and each session says which of them it is in. */
  project: Project;
  /** The projects on the map, when there is more than one. */
  projects?: Project[];
  sessions: Session[];
  items: ItemHead[];
  links: Link[];
  /** Pieces set to go and not yet gone. */
  waiting: Waiting[];
  /** Pieces that went between this project's sessions and other projects'. */
  far?: FarLink[];
  hooks: Record<Client, HookState>;
  overlaps: Overlap[];
  /** What could not be read, said plainly rather than left out silently. */
  notes: string[];
}

/** A stretch of a session's talk that was said and then taken back: a request of it was said again in another way
 *  (Codex, in the app), or the talk was taken back to before it (Claude Code). The agent no longer has it, so it is
 *  not of the talk: it ties nothing and no piece is cut from it. It is kept to be looked at where it was said.
 *  before: the request of the talk it is shown before, the first made after the stretch began; null when none was. */
export interface Gone {
  before: string | null;
  items: Item[];
}
