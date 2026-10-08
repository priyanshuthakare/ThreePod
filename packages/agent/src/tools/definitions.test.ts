import { TOOL_NAMES } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, TOOL_DEFINITIONS, TOOL_SCHEMAS } from "./definitions.ts";

/** The JSON Schema shape the model is handed, narrowed enough to assert on. */
type ObjectSchema = {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

function schemaFor(name: string): ObjectSchema {
  const definition = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (definition === undefined) throw new Error(`no definition for ${name}`);
  return definition.inputSchema as unknown as ObjectSchema;
}

describe("TOOL_DEFINITIONS", () => {
  // Structural rather than a hardcoded list: adding a seventh tool to the event union
  // fails here until it is given a definition, which is the point.
  it("covers exactly the tool names the event log accepts", () => {
    expect(TOOL_DEFINITIONS.map((d) => d.name).toSorted()).toEqual([...TOOL_NAMES].toSorted());
  });

  it("has a schema for every name", () => {
    expect(Object.keys(TOOL_SCHEMAS).toSorted()).toEqual([...TOOL_NAMES].toSorted());
  });

  it.each([...TOOL_NAMES])("%s describes when to reach for it, not just what it is", (name) => {
    const definition = TOOL_DEFINITIONS.find((d) => d.name === name);
    // A description that only names the tool gives the model nothing to trigger on.
    expect(definition?.description.length).toBeGreaterThan(40);
  });

  it.each(
    [...TOOL_NAMES].filter((name) => name !== "propose_scene_patch" && name !== "propose_desk"),
  )("%s is an object schema that rejects unknown keys", (name) => {
    const schema = schemaFor(name);
    expect(schema.type).toBe("object");
    // Without this the model can invent arguments and they arrive silently ignored.
    expect(schema.additionalProperties).toBe(false);
  });

  it("propose_scene_patch is a union of strict edit and creation variants", () => {
    const schema = schemaFor("propose_scene_patch") as unknown as {
      anyOf: { type: string; required?: string[]; additionalProperties?: boolean }[];
    };
    expect(Array.isArray(schema.anyOf)).toBe(true);
    expect(schema.anyOf).toHaveLength(2);
    // The edit arm keeps its exact previous shape; the creation arm carries a
    // complete spec instead of a base hash and operations. Both stay strict so
    // invented arguments arrive rejected, not silently ignored.
    const requiredSets = schema.anyOf.map((variant) => {
      expect(variant.type).toBe("object");
      expect(variant.additionalProperties).toBe(false);
      return [...(variant.required ?? [])].sort();
    });
    expect(requiredSets).toContainEqual(["baseHash", "ops", "rationale"]);
    expect(requiredSets).toContainEqual(["rationale", "spec"]);
  });

  it("propose_desk is a union of strict plan and changes variants", () => {
    const schema = schemaFor("propose_desk") as unknown as {
      anyOf: { type: string; required?: string[]; additionalProperties?: boolean }[];
    };
    expect(Array.isArray(schema.anyOf)).toBe(true);
    expect(schema.anyOf).toHaveLength(2);
    // Same discipline as the patch tool: a creation carries a plan, an edit
    // carries a base hash and changes, and both stay strict.
    const requiredSets = schema.anyOf.map((variant) => {
      expect(variant.type).toBe("object");
      expect(variant.additionalProperties).toBe(false);
      return [...(variant.required ?? [])].sort();
    });
    expect(requiredSets).toContainEqual(["plan", "rationale"]);
    expect(requiredSets).toContainEqual(["baseHash", "changes", "rationale"]);
  });

  it.each([
    ["read_file", ["path"]],
    ["write_file", ["path", "contents"]],
    ["edit_file", ["path", "old_string", "new_string"]],
    ["list_files", ["path"]],
    ["search_files", ["pattern"]],
    ["run_command", ["command"]],
  ] as const)("%s requires %j", (name, required) => {
    expect(schemaFor(name).required?.toSorted()).toEqual([...required].toSorted());
  });

  it("requires no arguments of get_scene", () => {
    // An argument-free tool has no `required` key at all — asserting the absence
    // rather than an empty list, so a future added argument fails here.
    expect(schemaFor("get_scene")).not.toHaveProperty("required");
  });

  it("offers search_files an optional path", () => {
    const schema = schemaFor("search_files");
    expect(Object.keys(schema.properties).toSorted()).toEqual(["path", "pattern"]);
    expect(schema.required).not.toContain("path");
  });

  it("does not leak the $schema dialect marker into the tool schema", () => {
    // Not an error, but it is noise on every request of every turn, and it is the kind
    // of key that quietly becomes a compatibility problem.
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.inputSchema).not.toHaveProperty("$schema");
    }
  });
});

describe("TOOL_SCHEMAS", () => {
  it("rejects an unknown argument", () => {
    expect(TOOL_SCHEMAS.read_file.safeParse({ path: "/a", mode: "r" }).success).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(TOOL_SCHEMAS.read_file.safeParse({ path: "" }).success).toBe(false);
  });

  it("accepts an empty string as new file contents", () => {
    // Emptying a file is a legitimate edit; only the path has to be non-empty.
    expect(TOOL_SCHEMAS.write_file.safeParse({ path: "/a", contents: "" }).success).toBe(true);
  });
});

describe("PROJECT_ROOT", () => {
  it("matches the directory the sandbox template builds the app in", () => {
    expect(PROJECT_ROOT).toBe("/home/user/app");
  });
});
