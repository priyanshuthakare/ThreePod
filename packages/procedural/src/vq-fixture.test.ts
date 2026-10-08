import { validateSceneSpec } from "@nap/scene-spec/schema";
import { describe, expect, it } from "vitest";
import { buildScene } from "./build.ts";
import { resolveMaterial } from "./material.ts";
import {
  VQ_MATERIAL_IDS,
  VQ_ROOT_ID,
  vqDeskAssembly,
  vqDetailedDeskAssembly,
  vqPlacedDesk,
  vqStudioSpec,
} from "./vq-fixture.ts";

describe("vqPlacedDesk", () => {
  it("reproduces the detailed desk from derived coordinates", () => {
    const placed = vqPlacedDesk();
    const detailed = vqDetailedDeskAssembly();
    expect(placed.components).toHaveLength(detailed.components.length);
    expect(placed.triangleCount).toBe(detailed.triangleCount);
    for (const axis of [0, 1, 2] as const) {
      expect(placed.bounds.min[axis]).toBeCloseTo(detailed.bounds.min[axis] ?? 0, 9);
      expect(placed.bounds.max[axis]).toBeCloseTo(detailed.bounds.max[axis] ?? 0, 9);
    }
  });

  it("repositions and resizes dependents when the top widens, changing nothing else", () => {
    const placed = vqPlacedDesk(2.0, 0.9);
    // Same parts, same count: the wider top moves legs outward and lengthens
    // aprons instead of adding or removing geometry.
    expect(placed.components).toHaveLength(11);
    expect(placed.triangleCount).toBe(168);
    expect(placed.bounds.min[0]).toBeCloseTo(-1, 9);
    expect(placed.bounds.max[0]).toBeCloseTo(1, 9);
    expect(placed.bounds.max[1]).toBeCloseTo(0.78, 9);
    const leg = placed.components.find(
      (component) => component.spec.id === "placed-leg-front-left",
    );
    expect(leg?.bounds.min[0]).toBeCloseTo(-0.97, 9);
    expect(leg?.bounds.max[0]).toBeCloseTo(-0.91, 9);
    const apron = placed.nodes.find((node) => node.id === "placed-apron-front");
    expect(apron?.kind).toBe("procedural");
    if (apron?.kind === "procedural" && apron.op === "box") {
      expect(apron.params.width).toBeCloseTo(1.82, 9);
    }
  });

  it("refuses absurd sizes with the placement rule named", () => {
    expect(() => vqPlacedDesk(0.1, 0.8)).toThrow(/fit/);
    expect(() => vqPlacedDesk(Number.NaN, 0.8)).toThrow();
  });
});

describe("vqDetailedDeskAssembly", () => {
  it("assembles eleven detailed parts with a pinned triangle count", () => {
    const desk = vqDetailedDeskAssembly();
    expect(desk.components).toHaveLength(11);
    // Beveled top (48) + two sharp aprons (24) + four sharp posts and feet (96).
    expect(desk.triangleCount).toBe(48 + 24 + 96);
  });

  it("keeps the desk footprint on the floor with two shared materials", () => {
    const desk = vqDetailedDeskAssembly();
    expect(desk.bounds.min[1]).toBeCloseTo(0, 10);
    expect(desk.bounds.max[1]).toBeCloseTo(0.78, 10);
    expect(desk.bounds.min[0]).toBeCloseTo(-0.8, 10);
    expect(desk.bounds.max[0]).toBeCloseTo(0.8, 10);
    expect(desk.materials.map((material) => material.id).sort()).toEqual([
      "vq-detail-black",
      "vq-detail-walnut",
    ]);
  });

  it("reassembles deterministically", () => {
    const first = vqDetailedDeskAssembly();
    const second = vqDetailedDeskAssembly();
    expect(first.bounds).toEqual(second.bounds);
    expect(first.triangleCount).toBe(second.triangleCount);
  });
});

describe("vqDeskAssembly", () => {
  it("assembles seven meaningful parts with assembly validation", () => {
    const desk = vqDeskAssembly();
    expect(desk.components).toHaveLength(7);
    // Seven sharp boxes at 12 triangles each.
    expect(desk.triangleCount).toBe(84);
  });

  it("merges shared materials instead of duplicating them", () => {
    const desk = vqDeskAssembly();
    expect(desk.materials.map((material) => material.id).sort()).toEqual([
      "vq-desk-black",
      "vq-desk-walnut",
    ]);
  });

  it("stands on the floor with the desk footprint", () => {
    const desk = vqDeskAssembly();
    expect(desk.bounds.min[1]).toBeCloseTo(0, 10);
    expect(desk.bounds.max[1]).toBeCloseTo(0.78, 10);
    expect(desk.bounds.min[0]).toBeCloseTo(-0.8, 10);
    expect(desk.bounds.max[0]).toBeCloseTo(0.8, 10);
  });

  it("reassembles deterministically", () => {
    const first = vqDeskAssembly();
    const second = vqDeskAssembly();
    expect(first.bounds).toEqual(second.bounds);
    expect(first.triangleCount).toBe(second.triangleCount);
  });
});

describe("vqStudioSpec", () => {
  it("is a valid spec with its own root, not the tower fixture", () => {
    const spec = vqStudioSpec();
    expect(spec.root).toBe(VQ_ROOT_ID);
    expect(validateSceneSpec(spec).ok).toBe(true);
    expect(spec.nodes.some((node) => node.id === "tower" || node.id === "base")).toBe(false);
  });

  it("builds successfully with a pinned deterministic triangle count", () => {
    const built = buildScene(vqStudioSpec());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // 10 boxes at 12 triangles plus two capped cylinders: lamp base at 12
    // radial segments (24 side + 24 caps) and lamp pole at 8 (16 + 16).
    expect(built.value.triangleCount).toBe(10 * 12 + 48 + 32);
  });

  it("carries the five fixture materials, every one resolving valid", () => {
    const spec = vqStudioSpec();
    expect(spec.materials.map((material) => material.id).sort()).toEqual(
      [...VQ_MATERIAL_IDS].sort(),
    );
    for (const material of spec.materials) {
      const resolved = resolveMaterial(material);
      expect(resolved.colorHex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("rebuilds bit-identically", () => {
    const first = buildScene(vqStudioSpec());
    const second = buildScene(vqStudioSpec());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.triangleCount).toBe(second.value.triangleCount);
    for (const [meshA, meshB] of first.value.meshes.map(
      (mesh, i) => [mesh, second.value.meshes[i]] as const,
    )) {
      expect(Array.from(meshA?.positions ?? [])).toEqual(Array.from(meshB?.positions ?? []));
    }
  });
});
