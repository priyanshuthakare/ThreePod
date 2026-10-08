import type { SceneMaterial } from "@nap/scene-spec/schema";
import { describe, expect, it } from "vitest";
import {
  assembleComponents,
  type BuiltComponent,
  buildComponent,
  type ComponentSpec,
} from "./component.ts";
import { semanticSceneMaterial } from "./material.ts";

function walnutTop(): ComponentSpec {
  return {
    id: "top",
    name: "Tabletop",
    op: "box",
    params: { width: 1.6, height: 0.06, depth: 0.8 },
    transform: { position: [0, 0.75, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: semanticSceneMaterial("walnut", "Walnut", "walnut"),
  };
}

function buildOk(spec: ComponentSpec): BuiltComponent {
  const built = buildComponent(spec);
  if (!built.ok) throw new Error(`fixture component failed: ${built.error.message}`);
  return built.value;
}

const CONCRETE: SceneMaterial = {
  id: "concrete",
  name: "Concrete",
  color: "#9aa0a6",
  metalness: 0,
  roughness: 0.9,
};

describe("buildComponent", () => {
  it("builds a valid component with baked transform and triangle count", () => {
    const built = buildOk(walnutTop());
    expect(built.triangleCount).toBe(12);
    expect(built.mesh.nodeId).toBe("top");
    // Transform baked by the existing engine: top face at 0.75 + 0.03.
    expect(built.bounds.max[1]).toBeCloseTo(0.78, 10);
  });

  it("rejects non-finite dimensions", () => {
    const result = buildComponent({
      ...walnutTop(),
      params: { width: Number.NaN, height: 0.06, depth: 0.8 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_spec");
  });

  it("rejects a zero scale", () => {
    const spec = walnutTop();
    const result = buildComponent({
      ...spec,
      transform: { ...spec.transform, scale: [1, 0, 1] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_spec");
  });

  it("rejects an unknown operation", () => {
    const result = buildComponent({ ...walnutTop(), op: "torus" as ComponentSpec["op"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_spec");
  });

  it("rejects a non-spec input without throwing", () => {
    for (const bad of [null, "top", 42, { id: "top" }]) {
      const result = buildComponent(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("rebuilds bit-identically", () => {
    const first = buildOk(walnutTop());
    const second = buildOk(walnutTop());
    expect(Array.from(first.mesh.positions)).toEqual(Array.from(second.mesh.positions));
    expect(first.triangleCount).toBe(second.triangleCount);
  });
});

describe("assembleComponents", () => {
  function leg(id: string, x: number, z: number): BuiltComponent {
    return buildOk({
      id,
      name: `Leg ${id}`,
      op: "box",
      params: { width: 0.06, height: 0.72, depth: 0.06 },
      transform: { position: [x, 0.36, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      material: semanticSceneMaterial("matte-black", "Matte black", "matte_black"),
    });
  }

  it("assembles validated components with combined bounds and count", () => {
    const top = buildOk(walnutTop());
    const assembled = assembleComponents({
      id: "desk",
      name: "Desk",
      components: [top, leg("leg-a", -0.74, 0.34), leg("leg-b", 0.74, -0.34)],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.value.triangleCount).toBe(36);
    expect(assembled.value.bounds.min[0]).toBeCloseTo(-0.8, 10);
    expect(assembled.value.bounds.max[0]).toBeCloseTo(0.8, 10);
    expect(assembled.value.components).toHaveLength(3);
  });

  it("rejects duplicate component ids", () => {
    const assembled = assembleComponents({
      id: "desk",
      name: "Desk",
      components: [buildOk(walnutTop()), buildOk(walnutTop())],
    });
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) {
      expect(assembled.error.code).toBe("duplicate_component");
      expect(assembled.error.componentId).toBe("top");
    }
  });

  it("rejects conflicting definitions under one material id", () => {
    const top = buildOk(walnutTop());
    const repainted = buildOk({
      ...walnutTop(),
      id: "top-2",
      material: { ...CONCRETE, id: "walnut" },
    });
    const assembled = assembleComponents({
      id: "desk",
      name: "Desk",
      components: [top, repainted],
    });
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) expect(assembled.error.code).toBe("material_conflict");
  });

  it("rejects an empty assembly", () => {
    const assembled = assembleComponents({ id: "desk", name: "Desk", components: [] });
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) expect(assembled.error.code).toBe("empty_assembly");
  });

  it("enforces the aggregate triangle budget across components", () => {
    const columns: BuiltComponent[] = [];
    for (let i = 0; i < 31; i++) {
      columns.push(
        buildOk({
          id: `column-${i}`,
          name: `Column ${i}`,
          op: "cylinder",
          params: {
            radiusTop: 0.5,
            radiusBottom: 0.5,
            height: 1,
            radialSegments: 128,
            heightSegments: 64,
            capped: true,
          },
          transform: {
            position: [i * 2, 0, 0],
            rotationEuler: [0, 0, 0],
            scale: [1, 1, 1],
          },
          material: CONCRETE,
        }),
      );
    }
    // Each column alone is ~16k triangles and builds fine; together they pass
    // the 500k budget at the 31st and the assembly must say which one.
    const assembled = assembleComponents({
      id: "colonnade",
      name: "Colonnade",
      components: columns,
    });
    expect(assembled.ok).toBe(false);
    if (!assembled.ok) {
      expect(assembled.error.code).toBe("budget_exceeded");
      expect(assembled.error.componentId).toBe("column-30");
    }
  });

  it("reassembles deterministically", () => {
    const parts = [buildOk(walnutTop()), leg("leg-a", -0.74, 0.34)];
    const first = assembleComponents({ id: "desk", name: "Desk", components: parts });
    const second = assembleComponents({ id: "desk", name: "Desk", components: parts });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.bounds).toEqual(second.value.bounds);
    expect(first.value.triangleCount).toBe(second.value.triangleCount);
  });
});
