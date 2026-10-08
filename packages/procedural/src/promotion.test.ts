import type { SceneSpec } from "@nap/scene-spec/schema";
import { describe, expect, it } from "vitest";
import type { ComponentSpec } from "./component.ts";
import { semanticSceneMaterial } from "./material.ts";
import { promoteAssemblyToCreation } from "./promotion.ts";

const SPEC_ID = "11111111-1111-4000-8000-000000000011";

function topSpec(): ComponentSpec {
  return {
    id: "top",
    name: "Tabletop",
    op: "box",
    params: { width: 1.6, height: 0.06, depth: 0.8 },
    transform: { position: [0, 0.75, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: semanticSceneMaterial("walnut", "Walnut", "walnut"),
  };
}

function legSpec(id: string, x: number): ComponentSpec {
  return {
    id,
    name: `Leg ${id}`,
    op: "box",
    params: { width: 0.06, height: 0.72, depth: 0.06 },
    transform: { position: [x, 0.36, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: semanticSceneMaterial("matte-black", "Matte black", "matte_black"),
  };
}

function promote(
  parts: ComponentSpec[],
  specId: string = SPEC_ID,
): ReturnType<typeof promoteAssemblyToCreation> {
  return promoteAssemblyToCreation({
    assemblyId: "desk",
    assemblyName: "Desk",
    components: parts,
    specId,
    seed: 11,
  });
}

describe("promoteAssemblyToCreation", () => {
  it("promotes validated parts to canonical-ready nodes and materials", () => {
    const promoted = promote([topSpec(), legSpec("leg-a", -0.74), legSpec("leg-b", 0.74)]);
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    const spec: SceneSpec = promoted.value.spec;
    expect(spec.id).toBe(SPEC_ID);
    expect(spec.root).toBe("desk-root");
    expect(spec.nodes.map((node) => node.id).sort()).toEqual(
      ["desk-root", "leg-a", "leg-b", "top"].sort(),
    );
    expect(spec.materials.map((material) => material.id).sort()).toEqual(
      ["matte-black", "walnut"].sort(),
    );
    const top = spec.nodes.find((node) => node.id === "top");
    expect(top?.kind).toBe("procedural");
  });

  it("rejects an invalid component specification", () => {
    const bad = { ...topSpec(), params: { width: Number.NaN, height: 0.06, depth: 0.8 } };
    const promoted = promote([bad, legSpec("leg-a", -0.74)]);
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) {
      expect(promoted.error.code).toBe("invalid_spec");
      expect(promoted.error.componentId).toBe("top");
    }
  });

  it("rejects duplicate component ids", () => {
    const promoted = promote([topSpec(), topSpec()]);
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) expect(promoted.error.code).toBe("duplicate_component");
  });

  it("rejects an oversized bevel before any canonical content exists", () => {
    const bad = { ...topSpec(), params: { width: 1.6, height: 0.06, depth: 0.8, bevel: 5 } };
    const promoted = promote([bad]);
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) expect(promoted.error.code).toBe("invalid_spec");
  });

  it("rejects a non-uuid envelope identity without touching geometry", () => {
    const promoted = promote([topSpec()], "not-a-uuid");
    expect(promoted.ok).toBe(false);
    if (!promoted.ok) expect(promoted.error.code).toBe("invalid_scene");
  });

  it("keeps geometry identical across envelope identities", () => {
    const first = promote([topSpec(), legSpec("leg-a", -0.74)]);
    const second = promote(
      [topSpec(), legSpec("leg-a", -0.74)],
      "22222222-2222-4000-8000-000000000022",
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.spec.nodes).toEqual(second.value.spec.nodes);
    expect(first.value.spec.materials).toEqual(second.value.spec.materials);
    expect(first.value.spec.id).not.toBe(second.value.spec.id);
  });
});
