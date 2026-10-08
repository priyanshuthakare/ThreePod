/**
 * Deterministic material resolution: `SceneMaterial` in, renderer-neutral PBR
 * parameters out.
 *
 * This module is the seam a future semantic-material layer will target:
 * `wood/walnut/satin` and friends will resolve to `SceneMaterial`-shaped data,
 * and this function turns that data into the parameters the Three.js adapter
 * consumes. Today it is a validated passthrough — the schema already bounds
 * every field — so existing scenes resolve byte-identically to before.
 *
 * Color-space contract (enforced where the values are consumed, documented
 * here because this is the one place every material passes through):
 *
 * - `colorHex` is **color data** in sRGB (`#rrggbb`). The adapter hands it to
 *   `THREE.Color`, which converts to the linear working space under the
 *   default-enabled `ColorManagement`. Never pre-convert it here: a converted
 *   value converted again is the classic double-gamma washout.
 * - Roughness, metalness, AO, normal and similar maps are **data, not color**.
 *   The procedural core carries no textures yet; when it does, those maps
 *   must upload with a linear (non-sRGB) color space. Treating every texture
 *   as sRGB is the matching classic failure in the other direction.
 *
 * This file stays free of Three.js imports: the core produces
 * renderer-independent data, and the adapter in `three-adapter.ts` owns the
 * three.js enums. See `docs/PLAN.md §0` for why the seam sits here.
 */

import type { SceneMaterial } from "@nap/scene-spec/schema";

/** Renderer-neutral PBR parameters: what the adapter needs, nothing it doesn't. */
export type ResolvedMaterial = {
  /** sRGB hex, verbatim from the spec — conversion happens in the adapter. */
  colorHex: string;
  metalness: number;
  roughness: number;
};

/**
 * What an absent PBR field means, once the schema grows optional fields.
 * Non-metals carry no metalness; 0.9 roughness reads as unfinished
 * concrete/plaster under the studio rig rather than as plastic. Pinned by
 * test so a future edit has to defend a new number, not just type one.
 */
export const MATERIAL_DEFAULTS = {
  metalness: 0,
  roughness: 0.9,
} as const;

/**
 * The constrained semantic vocabulary: design intent the procedural layer
 * understands, as a closed union rather than free-form strings. Eleven
 * entries is deliberate — a material earns a place here by being resolvable
 * to stable scalar parameters today, not by sounding desirable.
 *
 * Values are stable conveniences, not measured references: dark warm browns
 * for the woods, neutral-to-warm metallics at metalness 1, near-black matte
 * and near-white satin, near-black rubber, and a near-white smooth dielectric
 * standing in for glass. Glass is scalar-only in this phase — true
 * transparency needs transmission/transparent flags that `ResolvedMaterial`
 * does not carry yet, so that work stays explicitly deferred rather than
 * half-expressed.
 */
const SEMANTIC_MATERIAL_DEFINITIONS = {
  walnut: { color: "#5a3a22", metalness: 0, roughness: 0.6 },
  oak: { color: "#b08d57", metalness: 0, roughness: 0.65 },
  maple: { color: "#d9bd8a", metalness: 0, roughness: 0.6 },
  brushed_aluminum: { color: "#b9bdc2", metalness: 1, roughness: 0.45 },
  stainless_steel: { color: "#c9ced3", metalness: 1, roughness: 0.3 },
  brass: { color: "#b98a2f", metalness: 1, roughness: 0.35 },
  copper: { color: "#b0663a", metalness: 1, roughness: 0.35 },
  matte_black: { color: "#1b1b1e", metalness: 0, roughness: 0.9 },
  satin_white: { color: "#f2f0eb", metalness: 0, roughness: 0.5 },
  rubber: { color: "#232327", metalness: 0, roughness: 0.95 },
  glass: { color: "#e9f0ed", metalness: 0, roughness: 0.05 },
} as const;

/**
 * Deep-frozen: shared definitions no caller may mutate into another scene's
 * palette. A top-level `Object.freeze` alone would leave each material's
 * parameter object writable through the exported handle, so a single stray
 * assignment anywhere in the process would silently re-tint every future
 * scene resolving that material. Freeze the entries too.
 */
function freezeCatalog<T extends Record<string, object>>(catalog: T): T {
  for (const entry of Object.values(catalog)) Object.freeze(entry);
  return Object.freeze(catalog);
}

/** Frozen entries under a frozen handle: the catalog is read-only all the way down. */
export const SEMANTIC_MATERIALS: Record<
  keyof typeof SEMANTIC_MATERIAL_DEFINITIONS,
  { readonly color: string; readonly metalness: number; readonly roughness: number }
> = freezeCatalog({ ...SEMANTIC_MATERIAL_DEFINITIONS });

export type SemanticMaterialId = keyof typeof SEMANTIC_MATERIALS;

/**
 * Finishes are roughness overrides and nothing else: a finish never touches
 * color or metalness, so `brass + polished` is still brass. Three entries —
 * a finish earns its place the same way a material does.
 */
export const SEMANTIC_FINISHES = Object.freeze({
  matte: 0.85,
  satin: 0.45,
  polished: 0.12,
});

export type SemanticFinish = keyof typeof SEMANTIC_FINISHES;

/**
 * Which finishes each material admits. Rubber polished or glass matte would
 * be nonsense a typo could produce silently, so the pairing is allow-listed
 * rather than open: an incompatible request is a loud error, not a strange
 * render.
 */
const SEMANTIC_FINISH_ALLOWANCE: Record<SemanticMaterialId, readonly SemanticFinish[]> = {
  walnut: ["matte", "satin"],
  oak: ["matte", "satin"],
  maple: ["matte", "satin"],
  brushed_aluminum: ["satin", "polished"],
  stainless_steel: ["satin", "polished"],
  brass: ["satin", "polished"],
  copper: ["satin", "polished"],
  matte_black: ["matte"],
  satin_white: ["matte", "satin"],
  rubber: ["matte"],
  glass: ["polished"],
};

/**
 * Resolve a semantic request to the same `ResolvedMaterial` the adapter
 * consumes for explicit materials — one render-parameter shape downstream no
 * matter which vocabulary authored it. Pure table lookup plus the existing
 * validation: deterministic by construction, three-free, and safe to call
 * from Node tests, the workbench, or a future agent tool.
 *
 * Semantic names never enter `SceneSpec`: scenes carry the resolved explicit
 * values, so canonical serialization, hashes, and revisions cannot tell a
 * semantic-authored material from a hand-specified one — which is the point.
 * Unknown ids or finishes (reachable only past the types, from plain
 * JavaScript callers) throw rather than resolving to a surprise default.
 */
export function resolveSemanticMaterial(
  id: SemanticMaterialId,
  finish?: SemanticFinish,
): ResolvedMaterial {
  const definition = SEMANTIC_MATERIALS[id];
  if (definition === undefined) {
    throw new Error(`unknown semantic material "${String(id)}"`);
  }
  let roughness = definition.roughness;
  if (finish !== undefined) {
    if (!(finish in SEMANTIC_FINISHES)) {
      throw new Error(`unknown finish "${String(finish)}"`);
    }
    const allowed = SEMANTIC_FINISH_ALLOWANCE[id] ?? [];
    if (!allowed.includes(finish)) {
      throw new Error(
        `"${finish}" finish is not available for "${id}" (available: ${allowed.join(", ")})`,
      );
    }
    roughness = SEMANTIC_FINISHES[finish];
  }
  return resolveMaterial({
    id: `semantic:${id}`,
    name: id,
    color: definition.color,
    metalness: definition.metalness,
    roughness,
  });
}

/**
 * Author an explicit `SceneMaterial` from the catalog: how shared code (and,
 * later, agent tooling) turns a semantic request into spec-carried values
 * without hand-copying hex codes. The spec holds the resolved numbers, so
 * this helper's output validates, folds, hashes, and renders exactly like
 * any hand-authored material.
 */
export function semanticSceneMaterial(
  materialId: string,
  name: string,
  id: SemanticMaterialId,
  finish?: SemanticFinish,
): SceneMaterial {
  const resolved = resolveSemanticMaterial(id, finish);
  return {
    id: materialId,
    name,
    color: resolved.colorHex,
    metalness: resolved.metalness,
    roughness: resolved.roughness,
  };
}

/**
 * Validate and project a spec material to adapter parameters. Out-of-range or
 * non-finite values throw: the Zod schema is the boundary that rejects bad
 * input with a typed error, so anything reaching here is a programmer error,
 * never a user edit — and a NaN handed to a shader is silent corruption.
 */
export function resolveMaterial(material: SceneMaterial): ResolvedMaterial {
  for (const [name, value] of [
    ["metalness", material.metalness],
    ["roughness", material.roughness],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`material "${material.id}" has non-finite ${name}`);
    }
    if (value < 0 || value > 1) {
      throw new Error(`material "${material.id}" has out-of-range ${name}: ${value}`);
    }
  }
  return {
    colorHex: material.color,
    metalness: material.metalness,
    roughness: material.roughness,
  };
}
