/**
 * What the model is told it can do.
 *
 * The SDK's built-in file and shell tools act on this API server's filesystem, not on the
 * user's sandbox, so they stay disabled and these nine take their place. Six of them
 * proxy to `SandboxManager`; the two scene tools read and validate 3D scene state
 * in-process instead, and the desk tool builds one object family deterministically —
 * nothing else reaches the project.
 *
 * Argument shapes are Zod schemas, and the JSON Schema the model sees is derived from them
 * rather than written beside them. That is the only way the thing validating a tool call and
 * the thing describing it cannot drift apart.
 *
 * The descriptions say *when* to reach for a tool, not only what it does. On this model a
 * trigger condition in the description moves how often a tool is chosen more than anything in
 * the system prompt does, and the schemas plus the prompt are the cached prefix of every
 * request — so wording here is paid for once and read on every turn.
 */

import { AnySceneProposalSchema } from "@nap/scene-spec/proposal";
import { TOOL_NAMES, type ToolName } from "@nap/shared/events";
import type { LLMToolDefinition } from "@nap/shared/ports/llm-provider";
import { z } from "zod";
import { ProposeDeskSchema } from "./desk.ts";

/**
 * Where the generated app lives inside the sandbox.
 *
 * Stated here rather than imported from the sandbox package, which is a sibling this one may
 * not depend on. It is the working directory the project template builds into, and the system
 * prompt tells the model the same thing; the three have to agree.
 */
export const PROJECT_ROOT = "/home/user/app";

const path = z.string().min(1).describe(`Absolute path, for example ${PROJECT_ROOT}/src/App.tsx`);

export const TOOL_SCHEMAS = {
  read_file: z.strictObject({ path }),
  write_file: z.strictObject({
    path,
    contents: z.string().describe("The complete new contents of the file"),
  }),
  edit_file: z.strictObject({
    path,
    old_string: z
      .string()
      .min(1)
      .describe("Exact text to replace, including whitespace. Must appear exactly once."),
    new_string: z.string().describe("Text to put in its place. Empty to delete."),
  }),
  list_files: z.strictObject({ path }),
  search_files: z.strictObject({
    pattern: z.string().min(1).describe("Basic regular expression, as grep accepts it"),
    path: z.string().min(1).optional().describe(`Directory to search. Defaults to ${PROJECT_ROOT}`),
  }),
  run_command: z.strictObject({
    command: z.string().min(1).describe(`Shell command, run in ${PROJECT_ROOT}`),
  }),
  get_scene: z.strictObject({}),
  // The proposal contract lives in scene-spec, not here: the schema the model sees,
  // the shape validation checks, and the patch it applies are one definition, so a
  // widened operation cannot reach the log while the tool still describes the old set.
  // The union covers edits and genesis creation alike; the validator routes by shape.
  propose_scene_patch: AnySceneProposalSchema,
  // Like the patch tool beside it, the contract lives with the thing that
  // validates it: the schema the model sees and the shapes the handler
  // accepts are one definition in desk.ts.
  propose_desk: ProposeDeskSchema,
} satisfies Record<ToolName, z.ZodType>;

const DESCRIPTIONS: Record<ToolName, string> = {
  read_file:
    "Read a file from the project. Call this before editing anything you have not already read this turn — the file may differ from what you expect.",
  write_file:
    "Create a file, or replace one entirely. Use this for new files; prefer edit_file when changing part of an existing one, because this overwrites everything.",
  edit_file:
    "Replace one exact stretch of text in a file. old_string must match the file byte for byte and appear exactly once, so include enough surrounding lines to be unambiguous.",
  list_files:
    "List the direct contents of one directory. Call this when you need to know what exists before reading or creating files.",
  search_files:
    "Search file contents across the project for a pattern. Call this to find where something is defined or used rather than reading files one by one.",
  run_command:
    "Run a shell command in the project directory. Use it for builds, tests, and package management. A non-zero exit is reported back to you, not treated as a failure of the tool.",
  get_scene:
    "Read the current 3D scene before proposing any geometry change. Call this first when the user asks about the model: it lists every node with its parameters and the revision hash your patch must cite.",
  propose_scene_patch:
    "Propose a 3D scene edit as a patch against the hash get_scene returned, or a complete new scene when get_scene reports no scene yet. Prefer this over describing geometry in prose: the proposal is validated before anything changes, and a rejection tells you exactly what to fix. Never invent a baseHash — re-read the scene when told yours is stale.",
  propose_desk:
    "Build a walnut, oak, or maple desk from typed dimensions when the user asks for a desk or table: tops, legs, and aprons are placed and validated deterministically, so prefer this over hand-computing scene coordinates. For follow-up desk edits — wider, taller, a material swap — call it again with the revision hash get_scene returned and only the changes; legs and aprons follow automatically.",
};

/** Strips the dialect marker: it is noise on every request and buys the model nothing. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const TOOL_DEFINITIONS: LLMToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: inputSchema(TOOL_SCHEMAS[name]),
}));
