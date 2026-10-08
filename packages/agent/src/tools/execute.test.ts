import { execFileSync } from "node:child_process";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { MAX_SCENE_EVENT_BYTES } from "@nap/scene-spec/limits";
import { hashSceneSpec } from "@nap/scene-spec/revisions";
import { towerSpec } from "@nap/scene-spec/tower";
import { NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool, MAX_TOOL_OUTPUT, type ToolContext } from "./execute.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const APP = `${PROJECT_ROOT}/src/App.tsx`;

/** Collects what a tool emitted, in order, so ordering can be asserted rather than inferred. */
class Recorder {
  readonly events: PendingEvent[] = [];

  readonly emit = (event: PendingEvent): void => {
    this.events.push(event);
  };

  get types(): NapEventType[] {
    return this.events.map((event) => event.type);
  }

  payloadsOf<T extends NapEventType>(type: T): unknown[] {
    return this.events.filter((event) => event.type === type).map((event) => event.payload);
  }
}

let manager: InMemorySandboxManager;
let sandboxId: string;
let recorder: Recorder;

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  recorder = new Recorder();
});

function context(): ToolContext {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    emit: recorder.emit,
    // Fixed so the events are byte-identical run to run; nothing here depends on real time.
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

function call(name: string, input: Record<string, unknown>, id = "toolu_1"): LLMToolCall {
  return { id, name, input };
}

/** The six sandbox happy paths, each with whatever the sandbox needs for it to succeed. */
const HAPPY_PATHS = [
  {
    name: "read_file",
    input: { path: APP },
    setUp: async () => {
      await manager.writeFile(sandboxId, APP, "export default function App() {}\n");
    },
  },
  { name: "write_file", input: { path: APP, contents: "new\n" }, setUp: async () => {} },
  {
    name: "edit_file",
    input: { path: APP, old_string: "old", new_string: "new" },
    setUp: async () => {
      await manager.writeFile(sandboxId, APP, "an old line\n");
    },
  },
  {
    name: "list_files",
    input: { path: PROJECT_ROOT },
    setUp: async () => {
      await manager.writeFile(sandboxId, APP, "x\n");
    },
  },
  {
    name: "search_files",
    input: { pattern: "useState" },
    setUp: async () => {
      manager.script(/^grep /, { stdout: `${APP}:3:  const [n] = useState(0)\n` });
    },
  },
  {
    name: "run_command",
    input: { command: "bun run build" },
    setUp: async () => {
      manager.script(/bun run build/, { stdout: "built\n" });
    },
  },
] as const;

/** The six sandbox failure paths. Each is a real outcome, not a thrown exception. */
const FAILURE_PATHS = [
  { name: "read_file", input: { path: `${PROJECT_ROOT}/missing.ts` }, setUp: async () => {} },
  { name: "write_file", input: { path: 42 }, setUp: async () => {} },
  {
    name: "edit_file",
    input: { path: APP, old_string: "absent", new_string: "x" },
    setUp: async () => {
      await manager.writeFile(sandboxId, APP, "nothing matching here\n");
    },
  },
  { name: "list_files", input: {}, setUp: async () => {} },
  {
    name: "search_files",
    input: { pattern: "x" },
    setUp: async () => {
      manager.script(/^grep /, { exitCode: 2, stderr: "grep: no such directory\n" });
    },
  },
  { name: "run_command", input: { command: "" }, setUp: async () => {} },
] as const;

describe("executeTool — the call/result pair", () => {
  it.each(HAPPY_PATHS)("$name emits tool.call then tool.result on success", async (path) => {
    await path.setUp();

    const result = await executeTool(call(path.name, path.input), context());

    expect(result.ok).toBe(true);
    expect(recorder.types[0]).toBe("tool.call");
    expect(recorder.types.at(-1)).toBe("tool.result");
  });

  it.each(FAILURE_PATHS)("$name reports failure as a result rather than throwing", async (path) => {
    await path.setUp();

    // The rejection this guards against is the whole point: a thrown tool aborts the turn,
    // where an error result is something the model can read and recover from.
    await expect(executeTool(call(path.name, path.input), context())).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(recorder.types).toContain("tool.result");
    expect(recorder.payloadsOf("tool.result")).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("carries the model's tool call id onto both halves", async () => {
    await manager.writeFile(sandboxId, APP, "x\n");

    await executeTool(call("read_file", { path: APP }, "toolu_abc"), context());

    for (const payload of [
      ...recorder.payloadsOf("tool.call"),
      ...recorder.payloadsOf("tool.result"),
    ]) {
      expect(payload).toEqual(expect.objectContaining({ toolCallId: "toolu_abc" }));
    }
  });

  it("emits nothing for a tool name the event log cannot represent", async () => {
    // `tool.call` requires one of the nine names, so there is no honest event to write.
    const result = await executeTool(call("delete_everything", {}), context());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("read_file");
    expect(recorder.events).toEqual([]);
  });

  it("still records the call when the arguments do not parse", async () => {
    const result = await executeTool(call("read_file", { pth: APP }), context());

    expect(result.ok).toBe(false);
    // The path of the offending field, not just "it failed" — the model has to fix it.
    expect(result.output).toContain("path");
    expect(recorder.types).toEqual(["tool.call", "tool.result"]);
    expect(recorder.payloadsOf("tool.call")).toEqual([
      expect.objectContaining({ input: { pth: APP } }),
    ]);
  });

  it("emits events the log accepts", async () => {
    await manager.writeFile(sandboxId, APP, "before\n");
    manager.script(/^grep /, { stdout: "hit\n" });
    manager.script(/echo hi/, { stdout: "hi\n" });

    await executeTool(call("write_file", { path: APP, contents: "after\n" }), context());
    await executeTool(call("search_files", { pattern: "hit" }), context());
    await executeTool(call("run_command", { command: "echo hi" }), context());

    expect(recorder.events.length).toBeGreaterThan(0);
    for (const [index, event] of recorder.events.entries()) {
      const parsed = NapEventSchema.safeParse({ ...event, seq: index });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });
});

describe("read_file", () => {
  it("returns the file contents", async () => {
    await manager.writeFile(sandboxId, APP, "line one\nline two\n");

    const result = await executeTool(call("read_file", { path: APP }), context());

    expect(result.output).toBe("line one\nline two\n");
  });

  it("names the missing path when the file is not there", async () => {
    const result = await executeTool(call("read_file", { path: APP }), context());

    expect(result.ok).toBe(false);
    expect(result.output).toContain(APP);
  });
});

describe("write_file", () => {
  it("writes the contents to the sandbox", async () => {
    await executeTool(call("write_file", { path: APP, contents: "hello\n" }), context());

    const read = await manager.readFile(sandboxId, APP);
    expect(read.ok && read.value).toBe("hello\n");
  });

  it("emits file.changed between the call and the result", async () => {
    await executeTool(call("write_file", { path: APP, contents: "hello\n" }), context());

    // Between, not after: the change happened during the call, and the result closes the pair.
    expect(recorder.types).toEqual(["tool.call", "file.changed", "tool.result"]);
  });

  it("reports a new file as created, with a diff of every line added", async () => {
    await executeTool(call("write_file", { path: APP, contents: "alpha\nbeta\n" }), context());

    expect(recorder.payloadsOf("file.changed")).toEqual([
      expect.objectContaining({ path: APP, changeType: "created" }),
    ]);
    const [changed] = recorder.payloadsOf("file.changed") as [{ diff: string }];
    expect(changed.diff).toContain("+alpha");
    expect(changed.diff).toContain("+beta");
  });

  it("reports an existing file as modified, with both sides in the diff", async () => {
    await manager.writeFile(sandboxId, APP, "before\n");

    await executeTool(call("write_file", { path: APP, contents: "after\n" }), context());

    const [changed] = recorder.payloadsOf("file.changed") as [{ changeType: string; diff: string }];
    expect(changed.changeType).toBe("modified");
    expect(changed.diff).toContain("-before");
    expect(changed.diff).toContain("+after");
  });
});

describe("edit_file", () => {
  it("replaces the one occurrence and writes it back", async () => {
    await manager.writeFile(sandboxId, APP, "const count = 0\n");

    const result = await executeTool(
      call("edit_file", { path: APP, old_string: "count = 0", new_string: "count = 1" }),
      context(),
    );

    expect(result.ok).toBe(true);
    const read = await manager.readFile(sandboxId, APP);
    expect(read.ok && read.value).toBe("const count = 1\n");
    expect(recorder.types).toEqual(["tool.call", "file.changed", "tool.result"]);
  });

  it("fails usefully when the text is not in the file", async () => {
    await manager.writeFile(sandboxId, APP, "const count = 0\n");

    const result = await executeTool(
      call("edit_file", { path: APP, old_string: "count = 9", new_string: "x" }),
      context(),
    );

    expect(result.ok).toBe(false);
    // The message has to say what was looked for, or the model cannot tell which of its
    // several edits was the one that missed.
    expect(result.output).toContain("count = 9");
    expect(recorder.types).not.toContain("file.changed");
  });

  it("refuses an ambiguous match and says how many there were", async () => {
    await manager.writeFile(sandboxId, APP, "let x = 1\nlet x = 1\nlet x = 1\n");

    const result = await executeTool(
      call("edit_file", { path: APP, old_string: "let x = 1", new_string: "let x = 2" }),
      context(),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("3");
    // Nothing was written: a partial edit is worse than a refused one.
    const read = await manager.readFile(sandboxId, APP);
    expect(read.ok && read.value).toBe("let x = 1\nlet x = 1\nlet x = 1\n");
  });

  it("deletes the text when the replacement is empty", async () => {
    await manager.writeFile(sandboxId, APP, "keep\ndrop\n");

    await executeTool(
      call("edit_file", { path: APP, old_string: "drop\n", new_string: "" }),
      context(),
    );

    const read = await manager.readFile(sandboxId, APP);
    expect(read.ok && read.value).toBe("keep\n");
  });
});

describe("list_files", () => {
  it("lists direct children, marking directories", async () => {
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/index.html`, "");
    await manager.writeFile(sandboxId, APP, "");

    const result = await executeTool(call("list_files", { path: PROJECT_ROOT }), context());

    expect(result.output.split("\n").toSorted()).toEqual([
      `${PROJECT_ROOT}/index.html`,
      `${PROJECT_ROOT}/src/`,
    ]);
  });

  it("says so plainly when the directory is empty", async () => {
    const result = await executeTool(call("list_files", { path: PROJECT_ROOT }), context());

    expect(result.ok).toBe(true);
    expect(result.output).not.toBe("");
  });
});

describe("search_files", () => {
  it("searches the project root when no path is given", async () => {
    manager.script(/^grep /, { stdout: "hit\n" });

    await executeTool(call("search_files", { pattern: "useState" }), context());

    expect(manager.commands(sandboxId)[0]).toContain(PROJECT_ROOT);
  });

  it("skips node_modules, which is baked into the image and never interesting", async () => {
    manager.script(/^grep /, { stdout: "" });

    await executeTool(call("search_files", { pattern: "x" }), context());

    expect(manager.commands(sandboxId)[0]).toContain("--exclude-dir=node_modules");
  });

  it("treats grep's no-match exit as a successful empty search", async () => {
    // grep exits 1 for "found nothing", which is an answer, not a failure.
    manager.script(/^grep /, { exitCode: 1, stdout: "" });

    const result = await executeTool(call("search_files", { pattern: "nope" }), context());

    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/no match/i);
  });

  it("treats a grep exit above 1 as an error", async () => {
    manager.script(/^grep /, { exitCode: 2, stderr: "grep: bad pattern\n" });

    const result = await executeTool(call("search_files", { pattern: "[" }), context());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("bad pattern");
  });

  it("passes a hostile pattern to the shell as one literal argument", async () => {
    // The pattern comes from a model, and the model is repeating what a user typed into a
    // chat box. Asserting the payload is absent would be wrong — it is present, quoted.
    // Only a real shell can settle whether it survives as text or runs as code.
    const hostile = "'; touch /tmp/pwned; echo '";
    manager.script(/^grep /, { stdout: "" });

    await executeTool(call("search_files", { pattern: hostile }), context());

    const command = manager.commands(sandboxId)[0] ?? "";
    const argument = execFileSync(
      "sh",
      ["-c", command.replace(/^grep .*-e /, "printf %s ").replace(/ '[^']*'$/, "")],
      { encoding: "utf8" },
    );
    expect(argument).toBe(hostile);
  });
});

describe("run_command", () => {
  it("runs the command in the project directory", async () => {
    manager.script(/bun run build/, { stdout: "ok\n" });

    await executeTool(call("run_command", { command: "bun run build" }), context());

    expect(manager.commands(sandboxId)[0]).toBe(`cd ${PROJECT_ROOT} && bun run build`);
  });

  it("streams command.output chunks in order, before the result", async () => {
    manager.script(/noisy/, {
      chunks: [
        { stream: "stdout", data: "first\n" },
        { stream: "stderr", data: "warning\n" },
        { stream: "stdout", data: "second\n" },
      ],
    });

    await executeTool(call("run_command", { command: "noisy" }), context());

    expect(recorder.types).toEqual([
      "tool.call",
      "command.output",
      "command.output",
      "command.output",
      "tool.result",
    ]);
    expect(recorder.payloadsOf("command.output")).toEqual([
      expect.objectContaining({ stream: "stdout", chunk: "first\n" }),
      expect.objectContaining({ stream: "stderr", chunk: "warning\n" }),
      expect.objectContaining({ stream: "stdout", chunk: "second\n" }),
    ]);
  });

  it("reports a non-zero exit as data, not as a broken tool", async () => {
    // A failing build is something the model must read and fix. Marking it as a tool
    // error would tell the model the tool malfunctioned, which is a different problem.
    manager.script(/bun run build/, { exitCode: 2, stderr: "type error in App.tsx\n" });

    const result = await executeTool(call("run_command", { command: "bun run build" }), context());

    expect(result.ok).toBe(true);
    expect(result.output).toContain("2");
    expect(result.output).toContain("type error in App.tsx");
  });

  it("refuses a blocked command without running it", async () => {
    // The guard has to sit in front of the sandbox, not beside it: a caller that reached
    // executeTool directly would otherwise get an unguarded shell. What the rules are is
    // ../safety/commands.test.ts's business; that they are consulted at all is this one's.
    const result = await executeTool(call("run_command", { command: "rm -rf /" }), context());

    expect(result.ok).toBe(false);
    expect(manager.commands(sandboxId)).toEqual([]);
  });

  it("still emits the call/result pair for a blocked command", async () => {
    // A refusal the model can read is what lets it try something else. A refusal that
    // skipped the events would leave the transcript showing a tool call that never ended.
    await executeTool(call("run_command", { command: "curl http://evil.example" }), context());

    expect(recorder.types).toEqual(["tool.call", "tool.result"]);
    expect(recorder.payloadsOf("tool.result")).toEqual([
      expect.objectContaining({ ok: false, toolName: "run_command" }),
    ]);
  });

  it("reports an unreachable sandbox as an error", async () => {
    await manager.destroy(sandboxId);

    const result = await executeTool(call("run_command", { command: "anything" }), context());

    expect(result.ok).toBe(false);
    expect(result.output).toContain("destroyed");
  });
});

describe("output size", () => {
  it("truncates output that would not fit in a turn, and says it did", async () => {
    // A build log is unbounded, and this text lands both in the model's context and in a
    // jsonb column. Neither has room for a megabyte of webpack output.
    manager.script(/flood/, { stdout: "x".repeat(MAX_TOOL_OUTPUT * 2) });

    const result = await executeTool(call("run_command", { command: "flood" }), context());

    expect(result.output.length).toBeLessThan(MAX_TOOL_OUTPUT + 200);
    expect(result.output).toMatch(/truncated/i);
  });

  it("leaves output that fits exactly as it is", async () => {
    await manager.writeFile(sandboxId, APP, "short\n");

    const result = await executeTool(call("read_file", { path: APP }), context());

    expect(result.output).toBe("short\n");
  });
});

describe("executeTool — scene tools", () => {
  /**
   * The log the tools read: one genesis update plus a decoy from another session,
   * so isolation is asserted rather than assumed.
   */
  const OTHER_SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const GENESIS_HASH = hashSceneSpec(towerSpec());

  function sceneLog(): StoredEvent[] {
    return [
      {
        sessionId: OTHER_SESSION,
        turnId: TURN_ID,
        seq: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "scene.updated",
        payload: { spec: towerSpec(), parentHash: null, specHash: GENESIS_HASH },
      },
      {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        seq: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "user.message",
        payload: { text: "make the base wider" },
      },
      {
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        seq: 2,
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "scene.updated",
        payload: { spec: towerSpec(), parentHash: null, specHash: GENESIS_HASH },
      },
    ];
  }

  function sceneContext(events: StoredEvent[] = sceneLog()): ToolContext {
    const seen: string[] = [];
    return {
      ...context(),
      readSessionEvents: async (sessionId: string) => {
        seen.push(sessionId);
        return events.filter((event) => event.sessionId === sessionId);
      },
      // Owned per turn by the agent service in production; one cell per test here.
      sceneState: { head: null },
    };
  }

  it("get_scene reports no scene when the log holds none", async () => {
    const result = await executeTool(call("get_scene", {}), sceneContext([]));

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/no scene/i);
  });

  it("get_scene returns the folded head hash and its nodes", async () => {
    const result = await executeTool(call("get_scene", {}), sceneContext());

    expect(result.ok).toBe(true);
    expect(result.output).toContain(GENESIS_HASH.slice(0, 12));
    expect(result.output).toContain("base");
  });

  it("get_scene exposes the full revision hash beside the short display hash", async () => {
    const result = await executeTool(call("get_scene", {}), sceneContext());

    expect(result.ok).toBe(true);
    expect(result.output).toContain(GENESIS_HASH);
  });

  it("a proposal citing the hash get_scene returned validates and emits one update", async () => {
    const ctx = sceneContext();
    const read = await executeTool(call("get_scene", {}), ctx);

    expect(read.ok).toBe(true);
    const cited = /revision ([0-9a-f]{64})/.exec(read.output)?.[1];
    expect(cited).toBe(GENESIS_HASH);

    const result = await executeTool(
      call("propose_scene_patch", {
        baseHash: cited,
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.2 }],
        rationale: "Cite the displayed revision.",
      }),
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(recorder.types).toEqual([
      "tool.call",
      "tool.result",
      "tool.call",
      "scene.updated",
      "tool.result",
    ]);
    const [updated] = recorder.payloadsOf("scene.updated");
    expect(updated).toMatchObject({ parentHash: GENESIS_HASH });
  });

  it("a proposal citing only the 12-character prefix is refused before validation", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        baseHash: GENESIS_HASH.slice(0, 12),
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.2 }],
        rationale: "Cite the short hash.",
      }),
      sceneContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid arguments/);
    expect(recorder.types).not.toContain("scene.updated");
    expect(recorder.types).not.toContain("scene.rejected");
  });

  it("get_scene reads only its own session", async () => {
    const seen: string[] = [];
    const ctx = sceneContext();
    const reader = ctx.readSessionEvents;
    await executeTool(call("get_scene", {}), {
      ...ctx,
      readSessionEvents: async (sessionId: string) => {
        seen.push(sessionId);
        return reader === undefined ? [] : reader(sessionId);
      },
    });

    expect(seen).toEqual([SESSION_ID]);
  });

  it("get_scene fails honestly without a reader", async () => {
    const result = await executeTool(call("get_scene", {}), context());

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/unavailable/i);
  });

  it("propose_scene_patch applies a valid proposal between call and result", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        baseHash: GENESIS_HASH,
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
        rationale: "Widen the base by twenty percent.",
      }),
      sceneContext(),
    );

    expect(result.ok).toBe(true);
    expect(recorder.types).toEqual(["tool.call", "scene.updated", "tool.result"]);
    const [updated] = recorder.payloadsOf("scene.updated");
    expect(updated).toMatchObject({ parentHash: GENESIS_HASH });
    expect(typeof (updated as { specHash: string }).specHash).toBe("string");
    expect((updated as { specHash: string }).specHash).not.toBe(GENESIS_HASH);
  });

  it("propose_scene_patch rejects a stale base without mutating, emitting scene.rejected", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        baseHash: "0".repeat(64),
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
        rationale: "Widen the base.",
      }),
      sceneContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/stale/i);
    expect(recorder.types).toEqual(["tool.call", "scene.rejected", "tool.result"]);
    expect(recorder.types).not.toContain("scene.updated");
  });

  it("propose_scene_patch rejects no-ops without emitting scene.updated", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        baseHash: GENESIS_HASH,
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2 }],
        rationale: "Same width again.",
      }),
      sceneContext(),
    );

    expect(result.ok).toBe(false);
    expect(recorder.types).not.toContain("scene.updated");
  });

  it("propose_scene_patch rejects malformed input through the schema", async () => {
    const result = await executeTool(
      call("propose_scene_patch", { baseHash: GENESIS_HASH, ops: [] }),
      sceneContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid arguments for propose_scene_patch/);
  });

  it("a second proposal in one turn validates against the first result", async () => {
    const ctx = sceneContext();
    const first = await executeTool(
      call(
        "propose_scene_patch",
        {
          baseHash: GENESIS_HASH,
          ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
          rationale: "Widen the base.",
        },
        "toolu_1",
      ),
      ctx,
    );
    expect(first.ok).toBe(true);

    // The store has not been rewritten — the turn's own append is still in flight —
    // yet the second proposal must see the first one's result, not a stale head.
    const second = await executeTool(
      call(
        "propose_scene_patch",
        {
          baseHash: GENESIS_HASH,
          ops: [{ op: "set_param", nodeId: "mid", key: "width", value: 1.5 }],
          rationale: "Narrow the middle.",
        },
        "toolu_2",
      ),
      ctx,
    );
    expect(second.ok).toBe(false);
    expect(second.output).toMatch(/stale/i);
  });

  it("the emitted scene.updated stays within the payload limit once serialized", async () => {
    await executeTool(
      call("propose_scene_patch", {
        baseHash: GENESIS_HASH,
        ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
        rationale: "Widen the base.",
      }),
      sceneContext(),
    );

    const [updated] = recorder.payloadsOf("scene.updated");
    expect(JSON.stringify(updated).length).toBeLessThan(MAX_SCENE_EVENT_BYTES);
  });

  it("propose_scene_patch creates the genesis scene from an empty log", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        spec: towerSpec(),
        rationale: "Model a squat tower.",
      }),
      sceneContext([]),
    );

    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/Created scene/);
    expect(recorder.types).toEqual(["tool.call", "scene.updated", "tool.result"]);
    const [updated] = recorder.payloadsOf("scene.updated");
    expect(updated).toMatchObject({ parentHash: null, specHash: GENESIS_HASH });
  });

  it("propose_scene_patch rejects creation when a scene already exists", async () => {
    const result = await executeTool(
      call("propose_scene_patch", {
        spec: towerSpec(),
        rationale: "Model another tower.",
      }),
      sceneContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/already exists/);
    expect(recorder.types).toEqual(["tool.call", "scene.rejected", "tool.result"]);
    expect(recorder.types).not.toContain("scene.updated");
  });

  it("propose_scene_patch rejects malformed creation payloads through the schema", async () => {
    const result = await executeTool(
      call("propose_scene_patch", { spec: { version: 1 }, rationale: "Broken." }),
      sceneContext([]),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid arguments for propose_scene_patch/);
    expect(recorder.types).not.toContain("scene.updated");
  });
});
