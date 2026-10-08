/**
 * The versioned, renderer-independent scene specification.
 *
 * A SceneSpec describes *what to build* — nodes, operations, parameters, materials —
 * never *how it is rendered*. No Three.js objects, no mesh buffers, no model SDKs may
 * appear here; the procedural engine interprets this contract and a thin adapter turns
 * the result into renderer objects. That split is what lets the browser preview and a
 * future backend build agree on one hash for one scene.
 *
 * Conventions, fixed for version 1:
 * - Units are SI meters (`units: "m"`).
 * - Coordinates are Y-up, right-handed (`axes: "y-up"`).
 * - Transforms are translation / Euler rotation (radians, XYZ order) / scale.
 * - Every node carries a stable id; hierarchy is by reference, validated for
 *   existence, acyclicity and depth.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import {
  finiteNumber,
  MAX_CHILDREN,
  MAX_DEPTH,
  MAX_DIMENSION_M,
  MAX_HEIGHT_SEGMENTS,
  MAX_MATERIALS,
  MAX_NODES,
  MAX_RADIAL_SEGMENTS,
  MIN_DIMENSION_M,
  MIN_HEIGHT_SEGMENTS,
  MIN_RADIAL_SEGMENTS,
  positiveSize,
  SCENE_SPEC_VERSION,
} from "./limits.ts";

export const NodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, { message: "must be 1-64 of [A-Za-z0-9_-]" });
export type NodeId = z.infer<typeof NodeIdSchema>;

const Vec3Schema = z.tuple([finiteNumber(), finiteNumber(), finiteNumber()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/**
 * Translation / rotation / scale. Rotation is Euler radians in XYZ order; scale must
 * be strictly positive so no axis collapses or mirrors — mirroring, when wanted,
 * arrives as an explicit future operation rather than a negative number.
 */
export const TransformSchema = z.strictObject({
  position: Vec3Schema,
  rotationEuler: Vec3Schema,
  scale: z.tuple([positiveSize(), positiveSize(), positiveSize()]),
});
export type SceneTransform = z.infer<typeof TransformSchema>;

function dimension() {
  return z
    .number()
    .refine((n) => Number.isFinite(n) && n >= MIN_DIMENSION_M && n <= MAX_DIMENSION_M, {
      message: `must be a finite dimension in [${MIN_DIMENSION_M}, ${MAX_DIMENSION_M}] meters`,
    });
}

export const BoxParamsSchema = z
  .strictObject({
    width: dimension(),
    height: dimension(),
    depth: dimension(),
    /**
     * Edge bevel radius in meters, cut *inside* the stated dimensions: a
     * beveled box occupies exactly the same bounds as a sharp one, so edits
     * never move a wall by softening its edge. Absent or 0 is sharp. Capped
     * at half the smallest dimension — past that the corner patches would
     * swallow each other and invert.
     */
    bevel: finiteNumber().min(0).max(MAX_DIMENSION_M).optional(),
  })
  // `superRefine` rather than `refine`, because the message has to name the
  // bound it was checked against, and only this form is handed the value.
  .superRefine((params, ctx) => {
    const bevel = params.bevel ?? 0;
    const limit = Math.min(params.width, params.height, params.depth) / 2;
    if (bevel > limit) {
      ctx.addIssue({
        code: "custom",
        message: `bevel must be at most half the smallest dimension (${limit} m)`,
        path: ["bevel"],
      });
    }
  });
export type BoxParams = z.infer<typeof BoxParamsSchema>;

export const CylinderParamsSchema = z.strictObject({
  radiusTop: dimension(),
  radiusBottom: dimension(),
  height: dimension(),
  radialSegments: z.int().min(MIN_RADIAL_SEGMENTS).max(MAX_RADIAL_SEGMENTS),
  heightSegments: z.int().min(MIN_HEIGHT_SEGMENTS).max(MAX_HEIGHT_SEGMENTS),
  capped: z.boolean(),
});
export type CylinderParams = z.infer<typeof CylinderParamsSchema>;

const NodeBaseSchema = z.strictObject({
  id: NodeIdSchema,
  name: z.string().min(1).max(80),
  transform: TransformSchema,
});

/**
 * Procedural geometry leaves. One schema per operation, discriminated on `op`, so a
 * `box` node can never carry cylinder parameters and an unknown `op` string fails
 * closed. Procedural nodes are leaves: `children` is absent by construction, which
 * keeps hierarchy reasoning (depth, cycles) to group nodes alone.
 */
export const BoxNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("procedural"),
  op: z.literal("box"),
  params: BoxParamsSchema,
  seed: z.int(),
  materialId: z.string().min(1).max(64),
});

export const CylinderNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("procedural"),
  op: z.literal("cylinder"),
  params: CylinderParamsSchema,
  seed: z.int(),
  materialId: z.string().min(1).max(64),
});

export const GroupNodeSchema = NodeBaseSchema.extend({
  kind: z.literal("group"),
  children: z.array(NodeIdSchema).max(MAX_CHILDREN),
});

/**
 * Two-level discrimination: `op` separates the procedural leaves, then the node
 * union separates procedural leaves from groups. A single discriminated union on
 * `kind` cannot work because both leaves share `kind: "procedural"`.
 */
export const ProceduralNodeSchema = z.discriminatedUnion("op", [BoxNodeSchema, CylinderNodeSchema]);
export const SceneNodeSchema = z.union([ProceduralNodeSchema, GroupNodeSchema]);
export type SceneNode = z.infer<typeof SceneNodeSchema>;
export type ProceduralNode = z.infer<typeof ProceduralNodeSchema>;
export type GroupNode = z.infer<typeof GroupNodeSchema>;

export const MaterialSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: "must be #rrggbb" }),
  metalness: z.number().min(0).max(1),
  roughness: z.number().min(0).max(1),
});
export type SceneMaterial = z.infer<typeof MaterialSchema>;

export const SceneSpecSchema = z.strictObject({
  version: z.literal(SCENE_SPEC_VERSION),
  id: z.uuid(),
  seed: z.int(),
  units: z.literal("m"),
  axes: z.literal("y-up"),
  nodes: z.array(SceneNodeSchema).min(1).max(MAX_NODES),
  materials: z.array(MaterialSchema).max(MAX_MATERIALS),
  root: NodeIdSchema,
});
export type SceneSpec = z.infer<typeof SceneSpecSchema>;

export type SceneValidationError = {
  code:
    | "invalid_schema"
    | "duplicate_node_id"
    | "unknown_root"
    | "unknown_child"
    | "unknown_material"
    | "cycle"
    | "too_deep";
  message: string;
};

/**
 * Full validation: Zod shape first, then the cross-node invariants Zod cannot see —
 * unique ids, resolvable root/children/materials, acyclic groups, bounded depth.
 * Returns a typed error rather than throwing: a bad spec from a user edit or an AI
 * patch is an expected outcome, not a programmer error.
 */
export function validateSceneSpec(input: unknown): Result<SceneSpec, SceneValidationError> {
  const parsed = SceneSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_schema",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      },
    };
  }
  const spec = parsed.data;

  const byId = new Map<string, SceneNode>();
  for (const node of spec.nodes) {
    if (byId.has(node.id)) {
      return {
        ok: false,
        error: { code: "duplicate_node_id", message: `duplicate node id "${node.id}"` },
      };
    }
    byId.set(node.id, node);
  }

  const root = byId.get(spec.root);
  if (root === undefined) {
    return {
      ok: false,
      error: { code: "unknown_root", message: `root "${spec.root}" names no node` },
    };
  }

  const materialIds = new Set(spec.materials.map((material) => material.id));
  for (const node of spec.nodes) {
    if (node.kind === "procedural" && !materialIds.has(node.materialId)) {
      return {
        ok: false,
        error: {
          code: "unknown_material",
          message: `node "${node.id}" names unknown material "${node.materialId}"`,
        },
      };
    }
    if (node.kind === "group") {
      const seen = new Set(node.children);
      if (seen.size !== node.children.length) {
        return {
          ok: false,
          error: { code: "unknown_child", message: `group "${node.id}" names a child twice` },
        };
      }
      for (const childId of node.children) {
        if (!byId.has(childId)) {
          return {
            ok: false,
            error: {
              code: "unknown_child",
              message: `group "${node.id}" names unknown child "${childId}"`,
            },
          };
        }
      }
    }
  }

  // Depth-first from the root over group edges: unreachable leftovers are allowed
  // (an editor may stage nodes before attaching them), but reachable cycles and
  // over-deep chains are not. Depth counts edges below the root.
  const visiting = new Set<string>();
  const visit = (id: string, depth: number): SceneValidationError | undefined => {
    if (depth > MAX_DEPTH) {
      return { code: "too_deep", message: `hierarchy below "${id}" exceeds depth ${MAX_DEPTH}` };
    }
    if (visiting.has(id)) {
      return { code: "cycle", message: `hierarchy cycle through "${id}"` };
    }
    const node = byId.get(id);
    if (node === undefined || node.kind !== "group") return undefined;
    visiting.add(id);
    for (const childId of node.children) {
      const failure = visit(childId, depth + 1);
      if (failure !== undefined) return failure;
    }
    visiting.delete(id);
    return undefined;
  };
  const failure = visit(spec.root, 0);
  if (failure !== undefined) return { ok: false, error: failure };

  return { ok: true, value: spec };
}
