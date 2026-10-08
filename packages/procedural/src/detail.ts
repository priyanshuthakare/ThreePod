/**
 * Semantic detail primitives: small construction details that make components
 * read as designed rather than assembled from raw solids.
 *
 * These are spec factories, not a second geometry engine: every detail
 * compiles to one or two ordinary `ComponentSpec`s built from the existing
 * box/cylinder ops, so bounds, normals, winding, budget, and determinism all
 * come from the engine and are proven by building. Factories check their own
 * parameters early with the part named; the schema stays authoritative and
 * re-checks everything at build time.
 *
 * Three deliberate constraints keep details honest:
 *
 * - Axis-aligned placement only. Oriented parts bypass these helpers and use
 *   raw `ComponentSpec`s — a rotated foot would silently misplace the
 *   derived flare this module positions for the caller.
 * - Fixed tessellation (bevel arcs, collar segments) is engine-chosen, like
 *   `BEVEL_ARC_SEGMENTS`: a caller cannot propose a degenerate 200-segment
 *   collar any more than a degenerate bevel.
 * - A detail never hides surprise parts: `panel` and `collar` return exactly
 *   one spec, `footedPost` exactly two with documented derived ids.
 */

import type { SceneMaterial } from "@nap/scene-spec/schema";
import type { ComponentSpec } from "./component.ts";

/** Collar tessellation: smooth enough to read round, fixed like bevel arcs. */
const COLLAR_RADIAL_SEGMENTS = 16;

function requireDimension(value: unknown, name: string, partId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`detail "${partId}" needs a positive finite ${name}`);
  }
  return value;
}

function requireIdentity(id: unknown, name: unknown, what: string): { id: string; name: string } {
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || name.length === 0) {
    throw new Error(`${what} needs a non-empty id and name`);
  }
  return { id, name };
}

function requireMaterial(material: unknown, partId: string): SceneMaterial {
  if (typeof material !== "object" || material === null) {
    throw new Error(`detail "${partId}" needs a material`);
  }
  return material as SceneMaterial;
}

function at(
  x: number,
  y: number,
  z: number,
): {
  position: [number, number, number];
  rotationEuler: [number, number, number];
  scale: [number, number, number];
} {
  return { position: [x, y, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
}

export type PanelArgs = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  bevel?: number;
  material: SceneMaterial;
};

/**
 * A slab with an optional edge treatment: tabletops, shelves, keyboard decks.
 * The bevel follows the schema's own bound (at most half the smallest
 * dimension) so a panel factory can never propose what validation refuses.
 */
export function panel(args: PanelArgs): ComponentSpec[] {
  const { id, name } = requireIdentity(args.id, args.name, "panel");
  const width = requireDimension(args.width, "width", id);
  const height = requireDimension(args.height, "height", id);
  const depth = requireDimension(args.depth, "depth", id);
  const bevel = args.bevel ?? 0;
  if (!Number.isFinite(bevel) || bevel < 0 || bevel > Math.min(width, height, depth) / 2) {
    throw new Error(`detail "${id}" needs a bevel within [0, half the smallest dimension]`);
  }
  return [
    {
      id,
      name,
      op: "box",
      params: { width, height, depth, bevel },
      transform: at(args.x, args.y, args.z),
      material: requireMaterial(args.material, id),
    },
  ];
}

export type FootedPostArgs = {
  id: string;
  name: string;
  x: number;
  z: number;
  baseY: number;
  postWidth: number;
  postHeight: number;
  postDepth: number;
  footWidth: number;
  footHeight: number;
  footDepth: number;
  material: SceneMaterial;
};

/**
 * A post standing on a flared foot: table and desk legs that read grounded.
 * The post spans the full height and the foot hugs the floor beneath it with
 * a small overlap — the same intentional overlap the fixtures use wherever
 * two opaque solids meet, which keeps coplanar faces from flickering. The
 * foot must strictly exceed the post in plan: a flare that isn't wider is a
 * segment, not a foot, and is refused rather than rendered confusingly.
 */
export function footedPost(args: FootedPostArgs): ComponentSpec[] {
  const { id, name } = requireIdentity(args.id, args.name, "footed post");
  const postWidth = requireDimension(args.postWidth, "postWidth", id);
  const postHeight = requireDimension(args.postHeight, "postHeight", id);
  const postDepth = requireDimension(args.postDepth, "postDepth", id);
  const footWidth = requireDimension(args.footWidth, "footWidth", id);
  const footHeight = requireDimension(args.footHeight, "footHeight", id);
  const footDepth = requireDimension(args.footDepth, "footDepth", id);
  if (!(Number.isFinite(args.baseY) && Number.isFinite(args.x) && Number.isFinite(args.z))) {
    throw new Error(`detail "${id}" needs a finite placement`);
  }
  if (footWidth <= postWidth || footDepth <= postDepth) {
    throw new Error(
      `detail "${id}" needs a foot wider than its post in plan (post ${postWidth}x${postDepth}, foot ${footWidth}x${footDepth})`,
    );
  }
  const material = requireMaterial(args.material, id);
  return [
    {
      id,
      name,
      op: "box",
      params: { width: postWidth, height: postHeight, depth: postDepth },
      transform: at(args.x, args.baseY + postHeight / 2, args.z),
      material,
    },
    {
      id: `${id}-foot`,
      name: `${name} foot`,
      op: "box",
      params: { width: footWidth, height: footHeight, depth: footDepth },
      transform: at(args.x, args.baseY + footHeight / 2, args.z),
      material,
    },
  ];
}

export type CollarArgs = {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  material: SceneMaterial;
};

/**
 * A short transition ring between cylindrical parts: lamp base to pole, pole
 * to shade. The visual transition is the caller's placement; this builds a
 * clean capped cylinder and nothing else.
 */
export function collar(args: CollarArgs): ComponentSpec[] {
  const { id, name } = requireIdentity(args.id, args.name, "collar");
  const radius = requireDimension(args.radius, "radius", id);
  const height = requireDimension(args.height, "height", id);
  if (!(Number.isFinite(args.x) && Number.isFinite(args.y) && Number.isFinite(args.z))) {
    throw new Error(`detail "${id}" needs a finite placement`);
  }
  return [
    {
      id,
      name,
      op: "cylinder",
      params: {
        radiusTop: radius,
        radiusBottom: radius,
        height,
        radialSegments: COLLAR_RADIAL_SEGMENTS,
        heightSegments: 1,
        capped: true,
      },
      transform: at(args.x, args.y, args.z),
      material: requireMaterial(args.material, id),
    },
  ];
}
