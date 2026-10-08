/**
 * The deterministic procedural geometry engine.
 *
 * Pure TypeScript with no renderer import: given a validated SceneSpec it produces
 * mesh data (positions, normals, indices) with world transforms baked in. The same
 * code runs in Node tests, the browser viewport (via `three-adapter.ts`) and a
 * future backend build — one implementation, one hash, no preview/authoritative
 * drift by construction.
 *
 * Matrix convention matches Three.js exactly: column-vector matrices stored
 * column-major (translation in elements 12-14), local matrix M = T * R * S, world
 * matrix W = parent * local, Euler order 'XYZ' meaning R = Rx * Ry * Rz. Winding
 * is counter-clockwise seen from outside (Three.js `FrontSide`). The adapter
 * never re-applies transforms — it uploads baked vertices — so agreement is
 * structural rather than trusted.
 *
 * Determinism contract: builds are exactly reproducible within one JavaScript
 * engine for identical input. Box geometry is exact decimal arithmetic; cylinder
 * walls use Math.sin/cos, whose last-ulp behavior the language leaves to the
 * engine — so cylinder goldens assert within tolerance while determinism tests
 * assert bit-exact repeat builds. No cross-engine float identity is claimed.
 */

import { MAX_TRIANGLES } from "@nap/scene-spec/limits";
import type { SceneMaterial, SceneNode, SceneSpec, Vec3 } from "@nap/scene-spec/schema";
import type { Result } from "@nap/shared/result";

/** Axis-aligned bounds in meters: [minX, minY, minZ] / [maxX, maxY, maxZ]. */
export type Bounds = { min: Vec3; max: Vec3 };

/** One node's geometry with its world transform baked into the vertices. */
export type BuiltMesh = {
  nodeId: string;
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  material: SceneMaterial;
};

/** The complete build: every mesh reachable from the root, plus totals. */
export type BuiltScene = {
  meshes: BuiltMesh[];
  triangleCount: number;
  bounds: Bounds;
};

export type BuildError = {
  code: "triangle_budget_exceeded" | "unreachable_root" | "unsupported_node";
  message: string;
};

/** Column-major 4x4, Three.js layout: translation lives in elements 12-14. */
type Mat4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const a00 = a[0] ?? 0;
  const a01 = a[4] ?? 0;
  const a02 = a[8] ?? 0;
  const a03 = a[12] ?? 0;
  const a10 = a[1] ?? 0;
  const a11 = a[5] ?? 0;
  const a12 = a[9] ?? 0;
  const a13 = a[13] ?? 0;
  const a20 = a[2] ?? 0;
  const a21 = a[6] ?? 0;
  const a22 = a[10] ?? 0;
  const a23 = a[14] ?? 0;
  const a30 = a[3] ?? 0;
  const a31 = a[7] ?? 0;
  const a32 = a[11] ?? 0;
  const a33 = a[15] ?? 0;
  const b00 = b[0] ?? 0;
  const b01 = b[4] ?? 0;
  const b02 = b[8] ?? 0;
  const b03 = b[12] ?? 0;
  const b10 = b[1] ?? 0;
  const b11 = b[5] ?? 0;
  const b12 = b[9] ?? 0;
  const b13 = b[13] ?? 0;
  const b20 = b[2] ?? 0;
  const b21 = b[6] ?? 0;
  const b22 = b[10] ?? 0;
  const b23 = b[14] ?? 0;
  const b30 = b[3] ?? 0;
  const b31 = b[7] ?? 0;
  const b32 = b[11] ?? 0;
  const b33 = b[15] ?? 0;
  return [
    a00 * b00 + a01 * b10 + a02 * b20 + a03 * b30,
    a10 * b00 + a11 * b10 + a12 * b20 + a13 * b30,
    a20 * b00 + a21 * b10 + a22 * b20 + a23 * b30,
    a30 * b00 + a31 * b10 + a32 * b20 + a33 * b30,
    a00 * b01 + a01 * b11 + a02 * b21 + a03 * b31,
    a10 * b01 + a11 * b11 + a12 * b21 + a13 * b31,
    a20 * b01 + a21 * b11 + a22 * b21 + a23 * b31,
    a30 * b01 + a31 * b11 + a32 * b21 + a33 * b31,
    a00 * b02 + a01 * b12 + a02 * b22 + a03 * b32,
    a10 * b02 + a11 * b12 + a12 * b22 + a13 * b32,
    a20 * b02 + a21 * b12 + a22 * b22 + a23 * b32,
    a30 * b02 + a31 * b12 + a32 * b22 + a33 * b32,
    a00 * b03 + a01 * b13 + a02 * b23 + a03 * b33,
    a10 * b03 + a11 * b13 + a12 * b23 + a13 * b33,
    a20 * b03 + a21 * b13 + a22 * b23 + a23 * b33,
    a30 * b03 + a31 * b13 + a32 * b23 + a33 * b33,
  ];
}

/**
 * Local matrix M = T * R * S with R = Rx * Ry * Rz (Three.js 'XYZ'). Column-vector
 * convention: the scale lands on the columns of R, and the translation drops into
 * elements 12-14. The rotation-direction test in `build.test.ts` pins +X rotating
 * to -Z under +90° about Y, matching Three.js exactly.
 */
function composeTransform(position: Vec3, eulerXYZ: Vec3, scale: Vec3): Mat4 {
  const [px, py, pz] = position;
  const [sx, sy, sz] = scale;
  const cx = Math.cos(eulerXYZ[0]);
  const sxx = Math.sin(eulerXYZ[0]);
  const cy = Math.cos(eulerXYZ[1]);
  const syx = Math.sin(eulerXYZ[1]);
  const cz = Math.cos(eulerXYZ[2]);
  const szx = Math.sin(eulerXYZ[2]);
  const rx: Mat4 = [1, 0, 0, 0, 0, cx, sxx, 0, 0, -sxx, cx, 0, 0, 0, 0, 1];
  const ry: Mat4 = [cy, 0, -syx, 0, 0, 1, 0, 0, syx, 0, cy, 0, 0, 0, 0, 1];
  const rz: Mat4 = [cz, szx, 0, 0, -szx, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const rotation = multiply(multiply(rx, ry), rz);
  return [
    (rotation[0] ?? 0) * sx,
    (rotation[1] ?? 0) * sx,
    (rotation[2] ?? 0) * sx,
    rotation[3] ?? 0,
    (rotation[4] ?? 0) * sy,
    (rotation[5] ?? 0) * sy,
    (rotation[6] ?? 0) * sy,
    rotation[7] ?? 0,
    (rotation[8] ?? 0) * sz,
    (rotation[9] ?? 0) * sz,
    (rotation[10] ?? 0) * sz,
    rotation[11] ?? 0,
    px,
    py,
    pz,
    1,
  ];
}

/** Normal matrix: cofactor matrix over determinant (inverse-transpose), normalized. */
function transformNormal(matrix: Mat4, normal: Vec3): Vec3 {
  const a = matrix[0] ?? 0;
  const b = matrix[4] ?? 0;
  const c = matrix[8] ?? 0;
  const d = matrix[1] ?? 0;
  const e = matrix[5] ?? 0;
  const f = matrix[9] ?? 0;
  const g = matrix[2] ?? 0;
  const h = matrix[6] ?? 0;
  const i = matrix[10] ?? 0;
  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;
  const c10 = -(b * i - c * h);
  const c11 = a * i - c * g;
  const c12 = -(a * h - b * g);
  const c20 = b * f - c * e;
  const c21 = -(a * f - c * d);
  const c22 = a * e - b * d;
  const det = a * c00 + b * c01 + c * c02;
  const inv = det === 0 ? 0 : 1 / det;
  const [nx, ny, nz] = normal;
  const x = (c00 * nx + c01 * ny + c02 * nz) * inv;
  const y = (c10 * nx + c11 * ny + c12 * nz) * inv;
  const z = (c20 * nx + c21 * ny + c22 * nz) * inv;
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function transformPoint(matrix: Mat4, point: Vec3): Vec3 {
  const [x, y, z] = point;
  return [
    (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0),
    (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0),
    (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0),
  ];
}

type RawMesh = { positions: number[]; normals: number[]; indices: number[] };

/**
 * 24 vertices, 12 triangles, outward per-face normals. Corners wind
 * counter-clockwise seen from outside along each face normal — verified per face
 * in `build.test.ts` through signed-volume and normal assertions.
 */
function boxGeometry(width: number, height: number, depth: number): RawMesh {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const faces: { normal: Vec3; corners: [Vec3, Vec3, Vec3, Vec3] }[] = [
    {
      normal: [1, 0, 0],
      corners: [
        [hx, -hy, hz],
        [hx, -hy, -hz],
        [hx, hy, -hz],
        [hx, hy, hz],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [-hx, -hy, -hz],
        [-hx, -hy, hz],
        [-hx, hy, hz],
        [-hx, hy, -hz],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [-hx, hy, hz],
        [hx, hy, hz],
        [hx, hy, -hz],
        [-hx, hy, -hz],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [-hx, -hy, -hz],
        [hx, -hy, -hz],
        [hx, -hy, hz],
        [-hx, -hy, hz],
      ],
    },
    {
      normal: [0, 0, 1],
      corners: [
        [-hx, -hy, hz],
        [hx, -hy, hz],
        [hx, hy, hz],
        [-hx, hy, hz],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [hx, -hy, -hz],
        [-hx, -hy, -hz],
        [-hx, hy, -hz],
        [hx, hy, -hz],
      ],
    },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(face.normal[0], face.normal[1], face.normal[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

/**
 * Arc resolution of the bevel, fixed by the engine rather than the scene: bevel
 * quality is an implementation detail the agent never addresses, so every
 * beveled box costs the same 48 triangles (six faces of 2x2 arc grids) and an
 * LLM cannot propose a degenerate 200-segment edge.
 */
const BEVEL_ARC_SEGMENTS = 2;

/**
 * Rounded box with the bevel cut *inside* the stated dimensions: the outer
 * bounds are exactly width/height/depth, so softening an edge never moves a
 * wall. Each face is the same corner-ordered quad `boxGeometry` uses,
 * subdivided into arc grids and projected onto the inner box
 * (half-extents shrunk by the bevel) plus a bevel-radius offset along the
 * projection normal. The projection is the closest-point map onto a convex
 * set, which cannot fold — orientation, and therefore winding, survives it.
 *
 * Normals are analytic (projection direction, unit by construction) rather
 * than averaged, so the highlight rolls smoothly across the arc instead of
 * faceting. Only called with bevel > 0: at exactly 0 the projection
 * degenerates (zero-length direction), which is why sharp boxes keep the
 * 24-vertex path above byte-identically.
 */
function roundedBoxGeometry(width: number, height: number, depth: number, bevel: number): RawMesh {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;
  const ix = hx - bevel;
  const iy = hy - bevel;
  const iz = hz - bevel;
  // Same corner order as boxGeometry, so the same triangulation winds outward.
  const faces: [Vec3, Vec3, Vec3, Vec3][] = [
    [
      [hx, -hy, hz],
      [hx, -hy, -hz],
      [hx, hy, -hz],
      [hx, hy, hz],
    ],
    [
      [-hx, -hy, -hz],
      [-hx, -hy, hz],
      [-hx, hy, hz],
      [-hx, hy, -hz],
    ],
    [
      [-hx, hy, hz],
      [hx, hy, hz],
      [hx, hy, -hz],
      [-hx, hy, -hz],
    ],
    [
      [-hx, -hy, -hz],
      [hx, -hy, -hz],
      [hx, -hy, hz],
      [-hx, -hy, hz],
    ],
    [
      [-hx, -hy, hz],
      [hx, -hy, hz],
      [hx, hy, hz],
      [-hx, hy, hz],
    ],
    [
      [hx, -hy, -hz],
      [-hx, -hy, -hz],
      [-hx, hy, -hz],
      [hx, hy, -hz],
    ],
  ];
  const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(hi, Math.max(lo, value));
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [c0, c1, c2, c3] of faces) {
    const base = positions.length / 3;
    for (let j = 0; j <= BEVEL_ARC_SEGMENTS; j++) {
      for (let i = 0; i <= BEVEL_ARC_SEGMENTS; i++) {
        const s = i / BEVEL_ARC_SEGMENTS;
        const t = j / BEVEL_ARC_SEGMENTS;
        const px =
          c0[0] * (1 - s) * (1 - t) + c1[0] * s * (1 - t) + c2[0] * s * t + c3[0] * (1 - s) * t;
        const py =
          c0[1] * (1 - s) * (1 - t) + c1[1] * s * (1 - t) + c2[1] * s * t + c3[1] * (1 - s) * t;
        const pz =
          c0[2] * (1 - s) * (1 - t) + c1[2] * s * (1 - t) + c2[2] * s * t + c3[2] * (1 - s) * t;
        const qx = clamp(px, -ix, ix);
        const qy = clamp(py, -iy, iy);
        const qz = clamp(pz, -iz, iz);
        const dx = px - qx;
        const dy = py - qy;
        const dz = pz - qz;
        // Never zero: the face plane stands a full bevel outside the inner box
        // along its own axis, so the direction always has that component.
        const length = Math.hypot(dx, dy, dz);
        const nx = dx / length;
        const ny = dy / length;
        const nz = dz / length;
        positions.push(qx + nx * bevel, qy + ny * bevel, qz + nz * bevel);
        normals.push(nx, ny, nz);
      }
    }
    for (let j = 0; j < BEVEL_ARC_SEGMENTS; j++) {
      for (let i = 0; i < BEVEL_ARC_SEGMENTS; i++) {
        const a = base + j * (BEVEL_ARC_SEGMENTS + 1) + i;
        const b = a + 1;
        const c = a + BEVEL_ARC_SEGMENTS + 1;
        const d = c + 1;
        indices.push(a, b, d, a, d, c);
      }
    }
  }
  return { positions, normals, indices };
}

/** Capped or open cylinder along Y, centered at the origin. */
function cylinderGeometry(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  heightSegments: number,
  capped: boolean,
): RawMesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const half = height / 2;

  for (let row = 0; row <= heightSegments; row++) {
    const v = row / heightSegments;
    const y = -half + v * height;
    const radius = radiusBottom + (radiusTop - radiusBottom) * v;
    const slope = (radiusBottom - radiusTop) / height;
    const normalLength = Math.hypot(1, slope);
    for (let col = 0; col <= radialSegments; col++) {
      const theta = (col / radialSegments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      positions.push(radius * cos, y, radius * sin);
      normals.push(cos / normalLength, slope / normalLength, sin / normalLength);
    }
  }
  const stride = radialSegments + 1;
  for (let row = 0; row < heightSegments; row++) {
    for (let col = 0; col < radialSegments; col++) {
      const a = row * stride + col;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  if (capped) {
    const cap = (y: number, radius: number, up: boolean) => {
      const center = positions.length / 3;
      positions.push(0, y, 0);
      normals.push(0, up ? 1 : -1, 0);
      for (let col = 0; col <= radialSegments; col++) {
        const theta = (col / radialSegments) * Math.PI * 2;
        positions.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
        normals.push(0, up ? 1 : -1, 0);
      }
      for (let col = 0; col < radialSegments; col++) {
        if (up) indices.push(center, center + 2 + col, center + 1 + col);
        else indices.push(center, center + 1 + col, center + 2 + col);
      }
    };
    cap(half, radiusTop, true);
    cap(-half, radiusBottom, false);
  }
  return { positions, normals, indices };
}

function localMatrix(node: SceneNode): Mat4 {
  return composeTransform(
    node.transform.position,
    node.transform.rotationEuler,
    node.transform.scale,
  );
}

/**
 * Build every mesh reachable from the root. Unreachable staged nodes are skipped —
 * the validator allows them, but a build renders the live scene, not the staging
 * area. Triangle budget is enforced before the exceeding mesh is appended.
 */
export function buildScene(spec: SceneSpec): Result<BuiltScene, BuildError> {
  const byId = new Map<string, SceneNode>(spec.nodes.map((node) => [node.id, node]));
  const materials = new Map(spec.materials.map((material) => [material.id, material]));
  if (!byId.has(spec.root)) {
    return {
      ok: false,
      error: { code: "unreachable_root", message: `root "${spec.root}" names no node` },
    };
  }

  const meshes: BuiltMesh[] = [];
  let triangleCount = 0;
  const bounds: Bounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };

  const visit = (id: string, parentMatrix: Mat4): BuildError | undefined => {
    const node = byId.get(id);
    if (node === undefined) {
      return { code: "unsupported_node", message: `reachable node "${id}" names no node` };
    }
    const world = multiply(parentMatrix, localMatrix(node));
    if (node.kind === "group") {
      for (const childId of node.children) {
        const failure = visit(childId, world);
        if (failure !== undefined) return failure;
      }
      return undefined;
    }

    let raw: RawMesh;
    if (node.op === "box") {
      // A missing or zero bevel keeps the sharp 24-vertex path, so every
      // existing scene builds byte-identically to before bevels existed.
      const bevel = node.params.bevel ?? 0;
      raw =
        bevel > 0
          ? roundedBoxGeometry(node.params.width, node.params.height, node.params.depth, bevel)
          : boxGeometry(node.params.width, node.params.height, node.params.depth);
    } else if (node.op === "cylinder") {
      raw = cylinderGeometry(
        node.params.radiusTop,
        node.params.radiusBottom,
        node.params.height,
        node.params.radialSegments,
        node.params.heightSegments,
        node.params.capped,
      );
    } else {
      return { code: "unsupported_node", message: `unsupported operation on node "${id}"` };
    }

    const triangles = raw.indices.length / 3;
    if (triangleCount + triangles > MAX_TRIANGLES) {
      return {
        code: "triangle_budget_exceeded",
        message: `scene exceeds the ${MAX_TRIANGLES}-triangle budget at node "${id}"`,
      };
    }
    triangleCount += triangles;

    const material = materials.get(node.materialId);
    if (material === undefined) {
      return { code: "unsupported_node", message: `node "${id}" names unknown material` };
    }

    const positions = new Float32Array(raw.positions.length);
    const normals = new Float32Array(raw.normals.length);
    for (let i = 0; i < raw.positions.length; i += 3) {
      const p = transformPoint(world, [
        raw.positions[i] ?? 0,
        raw.positions[i + 1] ?? 0,
        raw.positions[i + 2] ?? 0,
      ]);
      positions[i] = p[0];
      positions[i + 1] = p[1];
      positions[i + 2] = p[2];
      const n = transformNormal(world, [
        raw.normals[i] ?? 0,
        raw.normals[i + 1] ?? 0,
        raw.normals[i + 2] ?? 0,
      ]);
      normals[i] = n[0];
      normals[i + 1] = n[1];
      normals[i + 2] = n[2];
      bounds.min[0] = Math.min(bounds.min[0], p[0]);
      bounds.min[1] = Math.min(bounds.min[1], p[1]);
      bounds.min[2] = Math.min(bounds.min[2], p[2]);
      bounds.max[0] = Math.max(bounds.max[0], p[0]);
      bounds.max[1] = Math.max(bounds.max[1], p[1]);
      bounds.max[2] = Math.max(bounds.max[2], p[2]);
    }
    meshes.push({
      nodeId: node.id,
      name: node.name,
      positions,
      normals,
      indices: new Uint32Array(raw.indices),
      material,
    });
    return undefined;
  };

  const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const failure = visit(spec.root, identity);
  if (failure !== undefined) return { ok: false, error: failure };
  if (meshes.length === 0) {
    bounds.min = [0, 0, 0];
    bounds.max = [0, 0, 0];
  }
  return { ok: true, value: { meshes, triangleCount, bounds } };
}
