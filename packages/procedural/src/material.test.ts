import type { SceneMaterial } from "@nap/scene-spec/schema";
import { describe, expect, it } from "vitest";
import {
  MATERIAL_DEFAULTS,
  type ResolvedMaterial,
  resolveMaterial,
  resolveSemanticMaterial,
  SEMANTIC_FINISHES,
  SEMANTIC_MATERIALS,
  type SemanticFinish,
  type SemanticMaterialId,
} from "./material.ts";

const SEMANTIC_IDS: readonly SemanticMaterialId[] = [
  "walnut",
  "oak",
  "maple",
  "brushed_aluminum",
  "stainless_steel",
  "brass",
  "copper",
  "matte_black",
  "satin_white",
  "rubber",
  "glass",
];

const CONCRETE: SceneMaterial = {
  id: "concrete",
  name: "Concrete",
  color: "#9aa0a6",
  metalness: 0,
  roughness: 0.9,
};

describe("resolveMaterial", () => {
  it("passes color, metalness and roughness through to renderer-neutral parameters", () => {
    expect(resolveMaterial(CONCRETE)).toEqual({
      colorHex: "#9aa0a6",
      metalness: 0,
      roughness: 0.9,
    } satisfies ResolvedMaterial);
  });

  it("is deterministic: equal inputs yield deeply equal outputs", () => {
    expect(resolveMaterial({ ...CONCRETE })).toEqual(resolveMaterial({ ...CONCRETE }));
  });

  it("rejects non-finite metalness rather than handing the renderer a NaN", () => {
    expect(() => resolveMaterial({ ...CONCRETE, metalness: Number.NaN })).toThrow(/metalness/);
  });

  it("rejects out-of-range roughness rather than handing the renderer garbage", () => {
    expect(() => resolveMaterial({ ...CONCRETE, roughness: 1.5 })).toThrow(/roughness/);
  });
});

describe("resolveSemanticMaterial", () => {
  it("covers exactly the constrained vocabulary, no more", () => {
    expect(Object.keys(SEMANTIC_MATERIALS).sort()).toEqual([...SEMANTIC_IDS].sort());
  });

  it("resolves every material to valid color, metalness and roughness", () => {
    for (const id of SEMANTIC_IDS) {
      const resolved = resolveSemanticMaterial(id);
      expect(resolved.colorHex).toMatch(/^#[0-9a-f]{6}$/);
      expect(resolved.metalness).toBeGreaterThanOrEqual(0);
      expect(resolved.metalness).toBeLessThanOrEqual(1);
      expect(resolved.roughness).toBeGreaterThanOrEqual(0);
      expect(resolved.roughness).toBeLessThanOrEqual(1);
    }
  });

  it("resolves metallic materials with metalness 1", () => {
    for (const id of ["brushed_aluminum", "stainless_steel", "brass", "copper"] as const) {
      expect(resolveSemanticMaterial(id).metalness).toBe(1);
    }
  });

  it("never resolves a dielectric as metallic", () => {
    for (const id of [
      "walnut",
      "oak",
      "maple",
      "matte_black",
      "satin_white",
      "rubber",
      "glass",
    ] as const) {
      expect(resolveSemanticMaterial(id).metalness).toBe(0);
    }
  });

  it("resolves the documented design intents", () => {
    // Dark warm brown dielectric, relatively high roughness.
    expect(resolveSemanticMaterial("walnut")).toEqual({
      colorHex: "#5a3a22",
      metalness: 0,
      roughness: 0.6,
    });
    // Neutral metallic, medium roughness for the brushed look.
    expect(resolveSemanticMaterial("brushed_aluminum").metalness).toBe(1);
    // Warm yellow-gold metallic, moderate roughness.
    expect(resolveSemanticMaterial("brass")).toEqual({
      colorHex: "#b98a2f",
      metalness: 1,
      roughness: 0.35,
    });
    // Scalar-only glass: smooth non-metal, no transmission flags in this phase.
    expect(resolveSemanticMaterial("glass")).toEqual({
      colorHex: "#e9f0ed",
      metalness: 0,
      roughness: 0.05,
    });
  });

  it("applies finishes as deterministic roughness overrides", () => {
    expect(resolveSemanticMaterial("walnut", "matte").roughness).toBe(SEMANTIC_FINISHES.matte);
    expect(resolveSemanticMaterial("walnut", "satin").roughness).toBe(SEMANTIC_FINISHES.satin);
    expect(resolveSemanticMaterial("brass", "polished").roughness).toBe(SEMANTIC_FINISHES.polished);
    // A finish never touches color or metalness.
    expect(resolveSemanticMaterial("brass", "polished").colorHex).toBe(
      resolveSemanticMaterial("brass").colorHex,
    );
    expect(resolveSemanticMaterial("brass", "polished").metalness).toBe(1);
  });

  it("rejects unknown material identifiers at the runtime boundary", () => {
    expect(() => resolveSemanticMaterial("unobtainium" as SemanticMaterialId)).toThrow(
      /unknown semantic material/,
    );
  });

  it("rejects unknown finishes and incompatible combinations", () => {
    expect(() => resolveSemanticMaterial("walnut", "polished")).toThrow(/not available for/);
    expect(() => resolveSemanticMaterial("rubber", "satin")).toThrow(/not available for/);
    expect(() => resolveSemanticMaterial("walnut", "gloss" as SemanticFinish)).toThrow(
      /unknown finish/,
    );
  });

  it("resolves byte-identically across repeated calls", () => {
    for (const id of SEMANTIC_IDS) {
      expect(resolveSemanticMaterial(id)).toEqual(resolveSemanticMaterial(id));
    }
    expect(resolveSemanticMaterial("walnut", "satin")).toEqual(
      resolveSemanticMaterial("walnut", "satin"),
    );
  });

  it("freezes the catalog so no caller can mutate a shared definition", () => {
    expect(Object.isFrozen(SEMANTIC_MATERIALS)).toBe(true);
  });

  it("freezes every catalog entry and the finish table, all the way down", () => {
    // A top-level freeze alone leaves each material's parameter object
    // writable through the exported handle — one stray assignment would
    // silently re-tint every future scene resolving that material.
    for (const id of SEMANTIC_IDS) {
      expect(Object.isFrozen(SEMANTIC_MATERIALS[id])).toBe(true);
    }
    expect(Object.isFrozen(SEMANTIC_FINISHES)).toBe(true);
  });

  it("keeps look-alike materials distinguishable in resolved parameters", () => {
    // Warm dark wood vs neutral dark dielectric.
    expect(resolveSemanticMaterial("walnut")).not.toEqual(resolveSemanticMaterial("matte_black"));
    // Two metals: same metalness, different base color and roughness.
    const aluminum = resolveSemanticMaterial("brushed_aluminum");
    const steel = resolveSemanticMaterial("stainless_steel");
    expect(aluminum.metalness).toBe(1);
    expect(steel.metalness).toBe(1);
    expect(aluminum).not.toEqual(steel);
    // Warm golden metal vs neutral metal.
    expect(resolveSemanticMaterial("brushed_aluminum")).not.toEqual(
      resolveSemanticMaterial("brass"),
    );
    // Two warm metals differ.
    expect(resolveSemanticMaterial("brass")).not.toEqual(resolveSemanticMaterial("copper"));
  });

  it("holds color and metalness fixed across a material's finishes", () => {
    for (const finish of ["matte", "satin"] as const) {
      const resolved = resolveSemanticMaterial("walnut", finish);
      expect(resolved.colorHex).toBe(resolveSemanticMaterial("walnut").colorHex);
      expect(resolved.metalness).toBe(0);
    }
  });
});

describe("MATERIAL_DEFAULTS", () => {
  it("pins dielectric defaults: no metalness, matte architectural roughness", () => {
    // Non-metals carry no metalness; 0.9 reads as unfinished concrete/plaster
    // under the studio rig rather than as plastic. When the schema grows
    // optional PBR fields, these are the values an absent field resolves to.
    expect(MATERIAL_DEFAULTS).toEqual({ metalness: 0, roughness: 0.9 });
  });
});
