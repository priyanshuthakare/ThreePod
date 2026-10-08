import { describe, expect, it } from "vitest";
import { MAX_DEPTH, MAX_NODES } from "./limits.ts";
import { validateSceneSpec } from "./schema.ts";
import { TOWER_MID_ID, TOWER_ROOT_ID, towerSpec } from "./tower.ts";

describe("validateSceneSpec", () => {
  it("accepts the tower fixture", () => {
    expect(validateSceneSpec(towerSpec()).ok).toBe(true);
  });

  it("rejects an unknown operation", () => {
    const spec = towerSpec();
    const mid = spec.nodes.find((node) => node.id === TOWER_MID_ID);
    expect(mid?.kind).toBe("procedural");
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) => (node.id === TOWER_MID_ID ? { ...node, op: "torus" } : node)),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
  });

  it("accepts an absent or zero box bevel as sharp", () => {
    const plain = validateSceneSpec(towerSpec());
    expect(plain.ok).toBe(true);
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_MID_ID && node.kind === "procedural" && node.op === "box"
          ? { ...node, params: { ...node.params, bevel: 0.1 } }
          : node,
      ),
    };
    expect(validateSceneSpec(tampered).ok).toBe(true);
  });

  it("rejects a negative box bevel", () => {
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_MID_ID && node.kind === "procedural" && node.op === "box"
          ? { ...node, params: { ...node.params, bevel: -0.1 } }
          : node,
      ),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_schema");
  });

  it("rejects a bevel larger than half the smallest box dimension", () => {
    // The middle slab is 1.4 x 1 x 1.4: a 0.6 bevel would swallow the 1 m
    // height twice over and invert the corner patches.
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_MID_ID && node.kind === "procedural" && node.op === "box"
          ? { ...node, params: { ...node.params, bevel: 0.6 } }
          : node,
      ),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_schema");
      expect(result.error.message).toMatch(/bevel/);
    }
  });

  it("rejects non-finite dimensions", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const spec = towerSpec();
      const tampered = {
        ...spec,
        nodes: spec.nodes.map((node) =>
          node.id === TOWER_MID_ID && node.kind === "procedural" && node.op === "box"
            ? { ...node, params: { ...node.params, width: bad } }
            : node,
        ),
      };
      expect(validateSceneSpec(tampered).ok).toBe(false);
    }
  });

  it("rejects zero and negative scale", () => {
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_MID_ID
          ? {
              ...node,
              transform: { ...node.transform, scale: [1, 0, 1] as [number, number, number] },
            }
          : node,
      ),
    };
    expect(validateSceneSpec(tampered).ok).toBe(false);
  });

  it("rejects a root that names no node", () => {
    expect(validateSceneSpec({ ...towerSpec(), root: "missing" }).ok).toBe(false);
  });

  it("rejects a group child that names no node", () => {
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_ROOT_ID && node.kind === "group"
          ? { ...node, children: [...node.children, "ghost"] }
          : node,
      ),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_child");
  });

  it("rejects duplicate node ids", () => {
    const spec = towerSpec();
    const mid = spec.nodes.find((node) => node.id === TOWER_MID_ID);
    const result = validateSceneSpec({ ...spec, nodes: [...spec.nodes, mid!] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate_node_id");
  });

  it("rejects an unknown material reference", () => {
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.kind === "procedural" ? { ...node, materialId: "nope" } : node,
      ),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_material");
  });

  it("rejects a hierarchy cycle", () => {
    const spec = towerSpec();
    const tampered = {
      ...spec,
      nodes: spec.nodes.map((node) =>
        node.id === TOWER_ROOT_ID && node.kind === "group"
          ? { ...node, children: [...node.children, TOWER_ROOT_ID] }
          : node,
      ),
    };
    const result = validateSceneSpec(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("cycle");
  });

  it("rejects hierarchies deeper than the limit", () => {
    const nodes: ReturnType<typeof towerSpec>["nodes"] = [];
    for (let depth = 0; depth <= MAX_DEPTH + 1; depth++) {
      nodes.push({
        kind: "group",
        id: `g${depth}`,
        name: `Level ${depth}`,
        transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        children: depth === MAX_DEPTH + 1 ? [] : [`g${depth + 1}`],
      });
    }
    const result = validateSceneSpec({ ...towerSpec(), nodes, root: "g0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_deep");
  });

  it("rejects scenes larger than the node limit", () => {
    const nodes: ReturnType<typeof towerSpec>["nodes"] = [];
    for (let i = 0; i < MAX_NODES + 1; i++) {
      nodes.push({
        kind: "procedural",
        id: `box${i}`,
        name: `Box ${i}`,
        transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        op: "box",
        params: { width: 1, height: 1, depth: 1 },
        seed: 1,
        materialId: "concrete",
      });
    }
    expect(validateSceneSpec({ ...towerSpec(), nodes }).ok).toBe(false);
  });

  it("rejects a malformed color", () => {
    const spec = towerSpec();
    const tampered = { ...spec, materials: [{ ...spec.materials[0]!, color: "red" }] };
    expect(validateSceneSpec(tampered).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateSceneSpec(null).ok).toBe(false);
    expect(validateSceneSpec("tower").ok).toBe(false);
  });
});
