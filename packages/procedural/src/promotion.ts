/**
 * Promoting a validated assembly into canonical scene creation.
 *
 * The assembly layer proves parts and their combination; this is the step
 * that hands the result to the canonical pipeline. It builds every component
 * through the existing component path, assembles them, wraps the resulting
 * nodes and materials in a creation envelope, and re-validates that envelope
 * through the existing SceneSpec validation. The caller submits the returned
 * spec as an ordinary genesis `CreateScene` proposal through
 * `propose_scene_patch` — no new tool, no new event type, no parallel
 * pipeline.
 *
 * Identity versus geometry, kept apart on purpose: `specId` and `seed` are
 * the caller-supplied identity envelope (a production caller generates a
 * fresh UUID per creation, following `revisions.ts`), while nodes, materials,
 * and parameters are deterministic assembly content. Two promotions of one
 * assembly under different ids carry identical geometry under different
 * identities — the test pins exactly that.
 *
 * Pure throughout: no store, no bus, no `seq`. Atomicity comes from the
 * proposal path downstream — a rejected promotion returns before any tool
 * call exists to emit from, so failures leave no events and no revision.
 */

import { type SceneSpec, validateSceneSpec } from "@nap/scene-spec/schema";
import type { Result } from "@nap/shared/result";
import {
  assembleComponents,
  type BuiltComponent,
  buildComponent,
  type ComponentError,
  type ComponentSpec,
} from "./component.ts";

export type PromotionError = {
  code: ComponentError["code"] | "invalid_scene";
  message: string;
  componentId?: string;
};

/**
 * Validate parts, assemble them, and wrap the result as a creation-ready
 * spec. Component and assembly failures pass through with their codes and
 * part names intact; only the final envelope re-check — caller-supplied
 * identity the assembly never saw — carries the promotion's own code.
 */
export function promoteAssemblyToCreation(input: {
  assemblyId: string;
  assemblyName: string;
  components: readonly ComponentSpec[];
  specId: string;
  seed: number;
}): Result<{ spec: SceneSpec }, PromotionError> {
  const { assemblyId, assemblyName, components, specId, seed } = input;
  const built: BuiltComponent[] = [];
  for (const part of components) {
    const result = buildComponent(part);
    if (!result.ok) return { ok: false, error: { ...result.error } };
    built.push(result.value);
  }
  const assembled = assembleComponents({ id: assemblyId, name: assemblyName, components: built });
  if (!assembled.ok) return { ok: false, error: { ...assembled.error } };

  const root = assembled.value.nodes.find((node) => node.kind === "group");
  if (root === undefined) {
    return {
      ok: false,
      error: { code: "invalid_scene", message: `assembly "${assemblyId}" has no root group` },
    };
  }
  const spec: SceneSpec = {
    version: 1,
    id: specId,
    seed,
    units: "m",
    axes: "y-up",
    nodes: [...assembled.value.nodes],
    materials: [...assembled.value.materials],
    root: root.id,
  };
  // The envelope fields are the only content the assembly never saw, so this
  // is the one genuinely new check: a malformed caller identity fails here,
  // named as promotion rather than as any part. Geometry needs no second
  // build — the assembly already proved this exact node set, and neither a
  // spec id nor a seed alters a vertex.
  const validated = validateSceneSpec(spec);
  if (!validated.ok) {
    return { ok: false, error: { code: "invalid_scene", message: validated.error.message } };
  }
  return { ok: true, value: { spec: validated.value } };
}
