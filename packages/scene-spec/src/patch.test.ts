import { describe, expect, it } from "vitest";
import { applyPatch, type ScenePatch, ScenePatchSchema } from "./patch.ts";
import { hashSceneSpec } from "./revisions.ts";
import { validateSceneSpec } from "./schema.ts";
import { TOWER_BASE_ID, TOWER_MID_ID, TOWER_ROOT_ID, towerSpec } from "./tower.ts";

function patchFor(baseHash: string, ops: ScenePatch["ops"]): ScenePatch {
  const parsed = ScenePatchSchema.safeParse({ baseRevision: baseHash, ops });
  if (!parsed.success) throw new Error(`test patch invalid: ${parsed.error.message}`);
  return parsed.data;
}

describe("applyPatch", () => {
  it("edits a box width", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.nodes.find((node) => node.id === TOWER_BASE_ID);
    expect(base?.kind).toBe("procedural");
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.width).toBe(2.4);
    }
  });

  it("edits a box bevel", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: 0.1 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base = result.value.nodes.find((node) => node.id === TOWER_BASE_ID);
    expect(base?.kind).toBe("procedural");
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.bevel).toBe(0.1);
    }
  });

  it("rejects a bevel past half the smallest dimension", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor(hashSceneSpec(spec), [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "bevel", value: 5 },
      ]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_result");
  });

  it("rejects a stale base revision", () => {
    const spec = towerSpec();
    const result = applyPatch(
      spec,
      patchFor("0".repeat(64), [{ op: "rename", nodeId: TOWER_BASE_ID, name: "X" }]),
      hashSceneSpec(spec),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stale_base");
  });

  it("rejects more than 64 operations at parse time", () => {
    const ops = Array.from({ length: 65 }, () => ({
      op: "rename" as const,
      nodeId: TOWER_BASE_ID,
      name: "X",
    }));
    expect(ScenePatchSchema.safeParse({ baseRevision: "0".repeat(64), ops }).success).toBe(false);
  });

  it("rejects an empty operation list", () => {
    expect(ScenePatchSchema.safeParse({ baseRevision: "0".repeat(64), ops: [] }).success).toBe(
      false,
    );
  });

  it("rejects unknown nodes without touching the scene", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "rename", nodeId: "ghost", name: "X" }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_node");
    expect(hashSceneSpec(spec)).toBe(before);
  });

  it("is atomic: a failing later op discards the earlier ones", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        { op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 },
        { op: "rename", nodeId: "ghost", name: "X" },
      ]),
      before,
    );
    expect(result.ok).toBe(false);
    // The input is untouched and no partial spec escapes: there is no result to inspect.
    expect(hashSceneSpec(spec)).toBe(before);
    const base = spec.nodes.find((node) => node.id === TOWER_BASE_ID);
    if (base?.kind === "procedural" && base.op === "box") {
      expect(base.params.width).toBe(2);
    }
  });

  it("rejects parameters the operation does not expose", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "radius", value: 1 }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_param");
  });

  it("rejects out-of-range values at the patch boundary", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: -2 }]),
      before,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects removing the root", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "remove_node", nodeId: TOWER_ROOT_ID }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cannot_remove_root");
  });

  it("removes a leaf and detaches it from its group", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "remove_node", nodeId: TOWER_MID_ID }]),
      before,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.some((node) => node.id === TOWER_MID_ID)).toBe(false);
    const root = result.value.nodes.find((node) => node.id === TOWER_ROOT_ID);
    expect(root?.kind).toBe("group");
    if (root?.kind === "group") expect(root.children).not.toContain(TOWER_MID_ID);
    expect(validateSceneSpec(result.value).ok).toBe(true);
  });

  it("adds a node to a group", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const result = applyPatch(
      spec,
      patchFor(before, [
        {
          op: "add_node",
          parentId: TOWER_ROOT_ID,
          node: {
            kind: "procedural",
            id: "antenna",
            name: "Antenna",
            transform: { position: [0, 4.5, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
            op: "cylinder",
            params: {
              radiusTop: 0.05,
              radiusBottom: 0.05,
              height: 1,
              radialSegments: 12,
              heightSegments: 1,
              capped: true,
            },
            seed: 7,
            materialId: "concrete",
          },
        },
      ]),
      before,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.some((node) => node.id === "antenna")).toBe(true);
  });

  it("rejects adding a duplicate node id", () => {
    const spec = towerSpec();
    const before = hashSceneSpec(spec);
    const mid = spec.nodes.find((node) => node.id === TOWER_MID_ID);
    const result = applyPatch(
      spec,
      patchFor(before, [{ op: "add_node", parentId: TOWER_ROOT_ID, node: mid }]),
      before,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_node_id");
  });
});
