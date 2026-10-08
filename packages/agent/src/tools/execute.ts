/**
 * Running one tool call against a sandbox.
 *
 * Everything the agent does to a project passes through here, so two properties matter more
 * than anything else in this file.
 *
 * **A tool never throws.** Every failure — a missing file, an edit that matched nothing, a
 * sandbox that is gone — comes back as a result the model can read and act on. A thrown
 * exception would end the turn over something the model could have fixed on the next step.
 *
 * **Events come out in a fixed order:** `tool.call`, then whatever the tool produced while
 * running, then `tool.result`. The result closes the pair, so anything replaying a session
 * sees an open call for exactly as long as the call was open. Sequence numbers are not
 * assigned here — the event store owns those, and an emitter that invented its own would
 * break replay ordering.
 *
 * The result is returned as well as emitted because the model has to be told what happened:
 * the caller feeds the same text back as a tool result block on the next request.
 */

import { buildDeskPlan, replanDesk } from "@nap/procedural/desk";
import { promoteAssemblyToCreation } from "@nap/procedural/promotion";
import type { SceneHead } from "@nap/scene-spec/fold";
import type { AnySceneProposal } from "@nap/scene-spec/proposal";
import { readSceneHead } from "@nap/scene-spec/scene-events";
import { type NapEvent, type NapEventOf, type ToolName, ToolNameSchema } from "@nap/shared/events";
import type { DistributiveOmit, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { shellQuote } from "@nap/shared/shell";
import type { z } from "zod";
import { inspectCommand } from "../safety/commands.ts";
import { PROJECT_ROOT, TOOL_SCHEMAS } from "./definitions.ts";
import type { ProposeDesk } from "./desk.ts";
import { fileChange } from "./diff.ts";
import { applySceneProposal, type ProposalApplication, summarizeScene } from "./scene.ts";

/**
 * How much text one tool may put into a turn.
 *
 * A build log has no natural size, and this string is stored in a jsonb column and then
 * replayed into the model's context on every subsequent request of the turn. Cutting it here
 * is cheaper than discovering the limit at either of those two places.
 */
export const MAX_TOOL_OUTPUT = 30_000;

/** Everything a tool needs beyond its own arguments. */
export type ToolContext = {
  sessionId: string;
  turnId: string;
  sandboxId: string;
  sandbox: SandboxManager;
  /** Receives each event as it happens, without a `seq`. */
  emit: (event: DistributiveOmit<NapEvent, "seq">) => void;
  /**
   * Reads this turn's session history for the scene tools. Optional because only
   * the runtime can supply it — anything else constructing a context (tests, the
   * harness) gets honest unavailability instead of a crash. Always called with
   * this context's own sessionId; the model never chooses what to read.
   */
  readSessionEvents?: ((sessionId: string) => Promise<readonly StoredEvent[]>) | undefined;
  /**
   * This turn's accepted proposals, ahead of the store. The sink appends
   * asynchronously, so a second proposal in one turn would otherwise validate
   * against a head its own predecessor has already moved. Owned per turn by the
   * agent service; starts null, grows only through validated application.
   */
  sceneState?: { head: SceneHead | null } | undefined;
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
};

/** What the model is told. `ok: false` becomes `is_error` on the tool result block. */
export type ToolOutcome = {
  ok: boolean;
  output: string;
};

type Payload<T extends NapEvent["type"]> = NapEventOf<T>["payload"];

/** Runs one tool call, emitting its events and reporting what to tell the model. */
export async function executeTool(call: LLMToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = ToolNameSchema.safeParse(call.name);
  if (!name.success) {
    // There is no honest `tool.call` to write: the event log accepts only the nine real
    // names, and inventing one would put a tool in the history that does not exist.
    return {
      ok: false,
      output: `No tool named ${call.name}. Available tools: ${ToolNameSchema.options.join(", ")}.`,
    };
  }

  emit(ctx, {
    type: "tool.call",
    payload: { toolCallId: call.id, toolName: name.data, input: call.input },
  });

  const outcome = await run(name.data, call, ctx);
  const capped = { ok: outcome.ok, output: truncate(outcome.output) };

  emit(ctx, {
    type: "tool.result",
    payload: {
      toolCallId: call.id,
      toolName: name.data,
      ok: capped.ok,
      output: capped.output,
    },
  });

  return capped;
}

/**
 * Validates one tool's arguments and hands them to its implementation.
 *
 * Each arm parses with its own schema rather than a shared one, so the arguments reaching a
 * handler are typed rather than asserted. Eight near-identical arms buy that; a single parse
 * would need a cast to correlate the tool's name with the shape of its arguments, and the
 * cast is exactly the thing that would go unnoticed when a schema changes.
 */
async function run(name: ToolName, call: LLMToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "read_file": {
      const args = TOOL_SCHEMAS.read_file.safeParse(call.input);
      return args.success ? readFile(args.data, ctx) : invalid(name, args.error);
    }
    case "write_file": {
      const args = TOOL_SCHEMAS.write_file.safeParse(call.input);
      return args.success ? writeFile(args.data, ctx) : invalid(name, args.error);
    }
    case "edit_file": {
      const args = TOOL_SCHEMAS.edit_file.safeParse(call.input);
      return args.success ? editFile(args.data, ctx) : invalid(name, args.error);
    }
    case "list_files": {
      const args = TOOL_SCHEMAS.list_files.safeParse(call.input);
      return args.success ? listFiles(args.data, ctx) : invalid(name, args.error);
    }
    case "search_files": {
      const args = TOOL_SCHEMAS.search_files.safeParse(call.input);
      return args.success ? searchFiles(args.data, ctx) : invalid(name, args.error);
    }
    case "run_command": {
      const args = TOOL_SCHEMAS.run_command.safeParse(call.input);
      return args.success ? runCommand(args.data, call, ctx) : invalid(name, args.error);
    }
    case "get_scene": {
      const args = TOOL_SCHEMAS.get_scene.safeParse(call.input);
      return args.success ? getScene(ctx) : invalid(name, args.error);
    }
    case "propose_scene_patch": {
      const args = TOOL_SCHEMAS.propose_scene_patch.safeParse(call.input);
      return args.success ? proposeScenePatch(args.data, ctx) : invalid(name, args.error);
    }
    case "propose_desk": {
      const args = TOOL_SCHEMAS.propose_desk.safeParse(call.input);
      return args.success ? proposeDesk(args.data, ctx) : invalid(name, args.error);
    }
  }
}

/** Reports bad arguments by field path — "invalid" alone tells the model nothing to fix. */
function invalid(name: ToolName, error: z.ZodError): ToolOutcome {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, output: `Invalid arguments for ${name} — ${issues}` };
}

async function readFile(args: { path: string }, ctx: ToolContext): Promise<ToolOutcome> {
  const read = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  return read.ok ? { ok: true, output: read.value } : failed(read.error);
}

async function writeFile(
  args: { path: string; contents: string },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // Read first, because whether this is a creation or a modification is only knowable
  // before the write, and the diff needs the old text either way.
  const existing = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  if (!existing.ok && existing.error.code !== "file_not_found") return failed(existing.error);
  const before = existing.ok ? existing.value : null;

  const written = await ctx.sandbox.writeFile(ctx.sandboxId, args.path, args.contents);
  if (!written.ok) return failed(written.error);

  emitChange(ctx, args.path, before, args.contents);
  return { ok: true, output: `Wrote ${args.path} (${args.contents.length} characters).` };
}

async function editFile(
  args: { path: string; old_string: string; new_string: string },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const read = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  if (!read.ok) return failed(read.error);

  const before = read.value;
  const occurrences = before.split(args.old_string).length - 1;

  if (occurrences === 0) {
    return {
      ok: false,
      output: `Nothing in ${args.path} matches:\n${args.old_string}\nRead the file and copy the text exactly, including whitespace.`,
    };
  }
  if (occurrences > 1) {
    // Editing the first of several is a coin flip on which one the model meant, and a
    // wrong edit is harder to notice than a refused one.
    return {
      ok: false,
      output: `That text appears ${occurrences} times in ${args.path}. Include enough surrounding lines to identify the one you mean.`,
    };
  }

  const after = before.replace(args.old_string, args.new_string);
  const written = await ctx.sandbox.writeFile(ctx.sandboxId, args.path, after);
  if (!written.ok) return failed(written.error);

  emitChange(ctx, args.path, before, after);
  return { ok: true, output: `Edited ${args.path}.` };
}

async function listFiles(args: { path: string }, ctx: ToolContext): Promise<ToolOutcome> {
  const listed = await ctx.sandbox.listFiles(ctx.sandboxId, args.path);
  if (!listed.ok) return failed(listed.error);

  if (listed.value.length === 0) return { ok: true, output: `${args.path} is empty.` };

  // A trailing slash is how every directory listing anyone has read marks a directory.
  return {
    ok: true,
    output: listed.value
      .map((node) => (node.type === "directory" ? `${node.path}/` : node.path))
      .join("\n"),
  };
}

async function searchFiles(
  // `| undefined` explicitly: under exactOptionalPropertyTypes an absent key and one set to
  // undefined are different types, and an omitted path is the normal case.
  args: { pattern: string; path?: string | undefined },
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const target = args.path ?? PROJECT_ROOT;
  // Both arguments are quoted: the pattern is written by a model relaying whatever a user
  // typed, and unquoted it is a command line rather than a search. `-I` skips binaries,
  // and node_modules is baked into the image, so a hit there is never the answer.
  const command = `grep -rnI --exclude-dir=node_modules -e ${shellQuote(args.pattern)} ${shellQuote(target)}`;

  const executed = await ctx.sandbox.exec(ctx.sandboxId, command);
  if (!executed.ok) return failed(executed.error);

  const { exitCode, stdout, stderr } = executed.value;
  // grep says "found nothing" with exit 1. That is an answer to the question asked.
  if (exitCode === 1) return { ok: true, output: `No matches for ${args.pattern} in ${target}.` };
  if (exitCode !== 0) return { ok: false, output: stderr || `grep exited ${exitCode}.` };

  return { ok: true, output: stdout };
}

async function runCommand(
  args: { command: string },
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // This is the one tool whose argument reaches a shell unquoted — quoting it would turn a
  // pipeline into a filename — so what may run is decided here instead, before anything is
  // sent. The rules live in ../safety/commands.ts; the check is made at this chokepoint so
  // no caller can reach the sandbox around it, and so a refusal comes back as an ordinary
  // failed result the model can read and work with.
  const verdict = inspectCommand(args.command);
  if (!verdict.allowed) return { ok: false, output: verdict.message };

  const command = `cd ${PROJECT_ROOT} && ${args.command}`;

  const executed = await ctx.sandbox.exec(ctx.sandboxId, command, (chunk) => {
    emit(ctx, {
      type: "command.output",
      payload: { toolCallId: call.id, stream: chunk.stream, chunk: chunk.data },
    });
  });
  if (!executed.ok) return failed(executed.error);

  const { exitCode, stdout, stderr } = executed.value;
  const body = [stdout, stderr].filter((part) => part !== "").join("\n");

  // A non-zero exit stays a success: a failing build is a fact the model has to read and
  // act on, not a malfunction of the tool that reported it.
  return { ok: true, output: `exit code ${exitCode}\n${body}` };
}

function emitChange(ctx: ToolContext, path: string, before: string | null, after: string): void {
  emit(ctx, {
    type: "file.changed",
    payload: { path, ...fileChange(path, before, after) },
  });
}

/**
 * Reads this turn's scene history, or explains why it cannot. The reader is the
 * runtime's — scoped to this context's session before the tool ever sees it —
 * so there is no session argument for the model to aim elsewhere.
 */
async function readSceneLog(ctx: ToolContext): Promise<readonly StoredEvent[] | undefined> {
  if (ctx.readSessionEvents === undefined) return undefined;
  try {
    return await ctx.readSessionEvents(ctx.sessionId);
  } catch {
    return undefined;
  }
}

/** The effective head: this turn's accepted proposals first, the store otherwise. */
function effectiveHead(
  ctx: ToolContext,
  events: readonly StoredEvent[] | undefined,
): SceneHead | null {
  return ctx.sceneState?.head ?? (events === undefined ? null : readSceneHead(events));
}

async function getScene(ctx: ToolContext): Promise<ToolOutcome> {
  const events = await readSceneLog(ctx);
  if (events === undefined) {
    return { ok: false, output: "Scene history is unavailable in this runtime." };
  }
  const head = effectiveHead(ctx, events);
  if (head === null) {
    return { ok: false, output: "There is no scene yet. Describe the object to create first." };
  }
  return { ok: true, output: summarizeScene(head) };
}

async function proposeScenePatch(
  proposal: AnySceneProposal,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const events = await readSceneLog(ctx);
  if (events === undefined) {
    return { ok: false, output: "Scene history is unavailable in this runtime." };
  }
  const applied = applySceneProposal(effectiveHead(ctx, events), proposal);
  if (!applied.ok) {
    return reportRejectedProposal(ctx, applied.code, applied.diagnostics);
  }
  return reportAppliedProposal(
    ctx,
    applied,
    "ops" in proposal ? `Applied ${proposal.ops.length} operation(s). ` : `Created scene. `,
  );
}

/**
 * The shared tail of every proposal-accepting tool: record the rejection, or
 * advance the turn head, emit the update, and tell the model the full hash to
 * cite next. Extracted so the desk tool reports exactly what the patch tool
 * reports — one wording, one ordering, two callers.
 */
function reportRejectedProposal(ctx: ToolContext, code: string, diagnostics: string): ToolOutcome {
  emit(ctx, {
    type: "scene.rejected",
    payload: { code, diagnostics },
  });
  return { ok: false, output: diagnostics };
}

function reportAppliedProposal(
  ctx: ToolContext,
  applied: Extract<ProposalApplication, { ok: true }>,
  summary: string,
): ToolOutcome {
  if (ctx.sceneState !== undefined) {
    ctx.sceneState.head = { spec: applied.spec, hash: applied.specHash };
  }
  emit(ctx, {
    type: "scene.updated",
    payload: { spec: applied.spec, parentHash: applied.parentHash, specHash: applied.specHash },
  });
  return {
    ok: true,
    output:
      summary +
      `Scene ${applied.specHash.slice(0, 12)} (${applied.nodeCount} nodes). ` +
      `Cite revision ${applied.specHash} as baseHash for the next patch.`,
  };
}

function deskError(error: { code: string; message: string }): string {
  return `${error.code}: ${error.message}`;
}

async function proposeDesk(args: ProposeDesk, ctx: ToolContext): Promise<ToolOutcome> {
  const events = await readSceneLog(ctx);
  if (events === undefined) {
    return { ok: false, output: "Scene history is unavailable in this runtime." };
  }
  if ("plan" in args) {
    const built = buildDeskPlan(args.plan);
    if (!built.ok) {
      return reportRejectedProposal(ctx, built.error.code, deskError(built.error));
    }
    const promoted = promoteAssemblyToCreation({
      assemblyId: "desk",
      assemblyName: "Desk",
      components: built.value.components.map((part) => part.spec),
      // Fresh identity per creation, following revisions.ts. The seed is a
      // fixed zero: identity lives in the uuid, and the engine ignores seeds.
      specId: crypto.randomUUID(),
      seed: 0,
    });
    if (!promoted.ok) {
      return reportRejectedProposal(ctx, promoted.error.code, deskError(promoted.error));
    }
    const applied = applySceneProposal(effectiveHead(ctx, events), {
      spec: promoted.value.spec,
      rationale: args.rationale,
    });
    if (!applied.ok) {
      return reportRejectedProposal(ctx, applied.code, applied.diagnostics);
    }
    return reportAppliedProposal(
      ctx,
      applied,
      `Built a desk (${built.value.triangleCount} triangles). `,
    );
  }
  const head = effectiveHead(ctx, events);
  if (head === null) {
    return { ok: false, output: "There is no scene yet. Describe the desk to create first." };
  }
  const replanned = replanDesk(head.spec, args.changes);
  if (!replanned.ok) {
    return reportRejectedProposal(ctx, replanned.error.code, deskError(replanned.error));
  }
  const applied = applySceneProposal(head, {
    baseHash: args.baseHash,
    ops: replanned.value.ops,
    rationale: args.rationale,
  });
  if (!applied.ok) {
    return reportRejectedProposal(ctx, applied.code, applied.diagnostics);
  }
  return reportAppliedProposal(
    ctx,
    applied,
    `Applied ${replanned.value.ops.length} operation(s). `,
  );
}

/**
 * Stamps an event with the envelope every event carries.
 *
 * Written as a generic over the discriminated union so that `type` and `payload` stay
 * correlated — the pair is the whole contract, and a helper that decoupled them would let
 * a `tool.call` carry a `file.changed` body.
 */
function emit<T extends NapEvent["type"]>(
  ctx: ToolContext,
  event: { type: T; payload: Payload<T> },
): void {
  ctx.emit({
    ...event,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    createdAt: (ctx.now ?? defaultNow)(),
  } as DistributiveOmit<NapEvent, "seq">);
}

const defaultNow = (): string => new Date().toISOString();

function failed(error: SandboxError): ToolOutcome {
  return { ok: false, output: `${error.code}: ${error.message}` };
}

function truncate(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT) return output;
  const omitted = output.length - MAX_TOOL_OUTPUT;
  // Keeping the head rather than the tail: the first error in a build log is the one that
  // caused the rest.
  return `${output.slice(0, MAX_TOOL_OUTPUT)}\n… truncated, ${omitted} characters omitted`;
}
