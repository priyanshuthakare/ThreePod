/**
 * Semantic components: meaningful object parts with independent validation,
 * assembled into objects with assembly validation.
 *
 * A component compiles to an ordinary procedural leaf node and an assembly
 * compiles to an ordinary `SceneSpec` — validated by the existing
 * `validateSceneSpec` and built by the existing `buildScene`. Nothing here
 * duplicates schema, transform, budget, or material logic; this layer only
 * adds identity, per-part validation context, and the one genuinely new
 * cross-part check (conflicting material definitions under one id).
 *
 * What survives into canonical state: component identities survive exactly as
 * node ids do, because downstream they are nodes. What does not: the grouping
 * itself ("these parts form a desk") is procedural-side assembly metadata and
 * never enters the event log. A future canonical component schema would be a
 * migration with hash implications — deliberately not this task.
 *
 * Everything here is pure and Three-free: identical inputs build identical
 * outputs in Node tests, the workbench, or a future orchestrator.
 */

import {
  type BoxParams,
  type CylinderParams,
  type SceneMaterial,
  type SceneNode,
  type SceneSpec,
  type SceneTransform,
  validateSceneSpec,
} from "@nap/scene-spec/schema";
import type { Result } from "@nap/shared/result";
import { type Bounds, type BuiltMesh, buildScene } from "./build.ts";
import { resolveMaterial } from "./material.ts";

/**
 * A meaningful part: identity plus everything one procedural leaf needs.
 * Shapes mirror the scene schema field-for-field (`BoxParams`,
 * `SceneTransform`, `SceneMaterial`), so the synthetic scene below checks
 * the same invariants the canonical path checks — no duplicated rules here.
 */
export type ComponentSpec = {
  id: string;
  name: string;
  op: "box" | "cylinder";
  params: BoxParams | CylinderParams;
  transform: SceneTransform;
  material: SceneMaterial;
};

/** One validated part: spec, baked mesh, bounds, and triangle contribution. */
export type BuiltComponent = {
  spec: ComponentSpec;
  mesh: BuiltMesh;
  bounds: Bounds;
  triangleCount: number;
};

export type ComponentErrorCode =
  | "invalid_spec"
  | "duplicate_component"
  | "material_conflict"
  | "build_failed"
  | "budget_exceeded"
  | "empty_assembly";

export type ComponentError = {
  code: ComponentErrorCode;
  message: string;
  componentId?: string;
};

/** Seed for synthetic validation scenes. Inert — geometry never reads it — but required. */
const SYNTHETIC_SEED = 0;
/** Validation vehicles only, never logged: synthetic specs need uuid-shaped ids. */
const SYNTHETIC_SPEC_ID = "00000000-0000-4000-8000-000000000003";
const SYNTHETIC_ROOT_ID = "component-root";

const IDENTITY_TRANSFORM: SceneTransform = {
  position: [0, 0, 0],
  rotationEuler: [0, 0, 0],
  scale: [1, 1, 1],
};

function invalidSpec(componentId: string | undefined, message: string): ComponentError {
  // `componentId` is omitted rather than set to undefined: the project
  // compiles with `exactOptionalPropertyTypes`, so an explicit undefined is a
  // type error rather than an absent field.
  return componentId === undefined
    ? { code: "invalid_spec", message: `invalid component: ${message}` }
    : {
        code: "invalid_spec",
        message: `component "${componentId}" is invalid: ${message}`,
        componentId,
      };
}

/** The leaf a component compiles to: the component's own id, transform, and material. */
function componentLeaf(spec: ComponentSpec): SceneNode {
  const base = {
    kind: "procedural" as const,
    id: spec.id,
    name: spec.name,
    transform: spec.transform,
    seed: SYNTHETIC_SEED,
    materialId: spec.material.id,
  };
  // Params travel unchecked into the synthetic scene, which rejects an
  // op/params mismatch with the part named. Checking the correlation here as
  // well would duplicate the discriminated-union rule the schema owns.
  return spec.op === "box"
    ? { ...base, op: "box" as const, params: spec.params as BoxParams }
    : { ...base, op: "cylinder" as const, params: spec.params as CylinderParams };
}

/**
 * Validate and build one part independently. Only the component envelope is
 * checked here (object shape, known operation, present sub-objects); every
 * value invariant — dimensions, transform, material, id bounds — is checked
 * by the synthetic single-node scene through the existing validator, with the
 * part named in the message.
 */
export function buildComponent(input: unknown): Result<BuiltComponent, ComponentError> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: invalidSpec(undefined, "must be an object") };
  }
  const raw = input as Record<string, unknown>;
  const rawId = raw.id;
  const componentId = typeof rawId === "string" ? rawId : undefined;
  if (raw.op !== "box" && raw.op !== "cylinder") {
    return { ok: false, error: invalidSpec(componentId, `unknown operation "${String(raw.op)}"`) };
  }
  for (const field of ["params", "transform", "material"] as const) {
    if (typeof raw[field] !== "object" || raw[field] === null) {
      return { ok: false, error: invalidSpec(componentId, `missing "${field}"`) };
    }
  }
  const spec = input as ComponentSpec;
  const synthetic: SceneSpec = {
    version: 1,
    id: SYNTHETIC_SPEC_ID,
    seed: SYNTHETIC_SEED,
    units: "m",
    axes: "y-up",
    nodes: [
      {
        kind: "group",
        id: SYNTHETIC_ROOT_ID,
        name: "Component",
        transform: IDENTITY_TRANSFORM,
        children: [spec.id],
      },
      componentLeaf(spec),
    ],
    materials: [spec.material],
    root: SYNTHETIC_ROOT_ID,
  };
  const validated = validateSceneSpec(synthetic);
  if (!validated.ok) {
    return { ok: false, error: invalidSpec(spec.id, validated.error.message) };
  }
  const built = buildScene(validated.value);
  if (!built.ok) {
    if (built.error.code === "triangle_budget_exceeded") {
      return {
        ok: false,
        error: { code: "budget_exceeded", message: built.error.message, componentId: spec.id },
      };
    }
    return {
      ok: false,
      error: { code: "build_failed", message: built.error.message, componentId: spec.id },
    };
  }
  const mesh = built.value.meshes[0];
  if (mesh === undefined || built.value.meshes.length !== 1) {
    return {
      ok: false,
      error: {
        code: "build_failed",
        message: `component "${spec.id}" built no mesh`,
        componentId: spec.id,
      },
    };
  }
  // Resolve through the material seam so a bad material fails here, named,
  // rather than deep inside a later assembly or viewport.
  resolveMaterial(spec.material);
  return {
    ok: true,
    value: { spec, mesh, bounds: built.value.bounds, triangleCount: built.value.triangleCount },
  };
}

/** A validated assembly: parts, canonical-ready nodes, combined bounds and count. */
export type AssembledObject = {
  id: string;
  name: string;
  components: readonly BuiltComponent[];
  /** Root group plus one leaf per component: promotable to canonical spec as-is. */
  nodes: readonly SceneNode[];
  materials: readonly SceneMaterial[];
  bounds: Bounds;
  triangleCount: number;
};

function sameMaterial(left: SceneMaterial, right: SceneMaterial): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.color === right.color &&
    left.metalness === right.metalness &&
    left.roughness === right.roughness
  );
}

/**
 * Assemble validated parts. The signature takes built results, not raw specs:
 * an unvalidated part cannot arrive here without an explicit cast, so "every
 * component passed local validation" holds by construction rather than by
 * re-checking. The combined scene is still validated and built wholesale, so
 * cross-part conflicts, the aggregate budget, and combined bounds are proven,
 * not assumed.
 */
export function assembleComponents(args: {
  id: string;
  name: string;
  components: readonly BuiltComponent[];
}): Result<AssembledObject, ComponentError> {
  const { id, name, components } = args;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_spec", message: "assembly needs a non-empty id and name" },
    };
  }
  if (components.length === 0) {
    return {
      ok: false,
      error: { code: "empty_assembly", message: `assembly "${id}" names no components` },
    };
  }
  const seen = new Set<string>();
  for (const component of components) {
    if (seen.has(component.spec.id)) {
      return {
        ok: false,
        error: {
          code: "duplicate_component",
          message: `assembly "${id}" contains component "${component.spec.id}" twice`,
          componentId: component.spec.id,
        },
      };
    }
    seen.add(component.spec.id);
  }
  const materials: SceneMaterial[] = [];
  const materialOwners = new Map<string, string>();
  for (const component of components) {
    const material = component.spec.material;
    const owner = materialOwners.get(material.id);
    if (owner === undefined) {
      materialOwners.set(material.id, component.spec.id);
      materials.push(material);
    } else {
      const first = materials.find((entry) => entry.id === material.id);
      if (first !== undefined && !sameMaterial(first, material)) {
        return {
          ok: false,
          error: {
            code: "material_conflict",
            message: `material "${material.id}" is defined differently by "${owner}" and "${component.spec.id}"`,
            componentId: component.spec.id,
          },
        };
      }
    }
  }
  const rootId = `${id}-root`;
  const nodes: SceneNode[] = [
    {
      kind: "group",
      id: rootId,
      name,
      transform: IDENTITY_TRANSFORM,
      children: components.map((component) => component.spec.id),
    },
    ...components.map((component) => componentLeaf(component.spec)),
  ];
  const combined: SceneSpec = {
    version: 1,
    id: SYNTHETIC_SPEC_ID,
    seed: SYNTHETIC_SEED,
    units: "m",
    axes: "y-up",
    nodes,
    materials,
    root: rootId,
  };
  const validated = validateSceneSpec(combined);
  if (!validated.ok) {
    return {
      ok: false,
      error: {
        code: validated.error.code === "duplicate_node_id" ? "duplicate_component" : "invalid_spec",
        message: `assembly "${id}" is invalid: ${validated.error.message}`,
      },
    };
  }
  const built = buildScene(validated.value);
  if (!built.ok) {
    if (built.error.code === "triangle_budget_exceeded") {
      // The engine names the node that crossed the budget; surface it as the
      // component it is, since assembly nodes and components share ids.
      const match = /at node "([^"]+)"/.exec(built.error.message);
      const componentId = match?.[1];
      return {
        ok: false,
        error:
          componentId === undefined
            ? { code: "budget_exceeded", message: built.error.message }
            : { code: "budget_exceeded", message: built.error.message, componentId },
      };
    }
    return { ok: false, error: { code: "build_failed", message: built.error.message } };
  }
  return {
    ok: true,
    value: {
      id,
      name,
      components: [...components],
      nodes,
      materials,
      bounds: built.value.bounds,
      triangleCount: built.value.triangleCount,
    },
  };
}
