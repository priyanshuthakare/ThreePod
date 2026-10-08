/**
 * The visual-quality fixture: a small deterministic desk scene exercising the
 * semantic material vocabulary.
 *
 * A walnut desk with matte-black legs, a brushed-aluminum monitor stand, a
 * matte-black keyboard, a brass lamp, and a glass cube — composed from plain
 * boxes and cylinders with explicit materials authored from the semantic
 * catalog. Deliberately separate from the tower fixture: the tower pins
 * geometry goldens, this scene pins material behavior and will anchor future
 * visual-regression work.
 *
 * Everything here is fixed data: stable ids, a fixed seed, hand-placed
 * transforms. Two builds of this spec are bit-identical, and the triangle
 * count is pinned by test.
 */

import type { SceneMaterial, SceneNode, SceneSpec } from "@nap/scene-spec/schema";
import type { Bounds } from "./build.ts";
import {
  type AssembledObject,
  assembleComponents,
  type BuiltComponent,
  buildComponent,
  type ComponentSpec,
} from "./component.ts";
import { footedPost, panel } from "./detail.ts";
import { semanticSceneMaterial } from "./material.ts";
import { apronPair, tableLegCenters, verticalSpan } from "./placement.ts";

export const VQ_ROOT_ID = "studio";
export const VQ_MATERIAL_IDS = [
  "vq-walnut",
  "vq-matte-black",
  "vq-brushed-aluminum",
  "vq-brass",
  "vq-glass",
] as const;

function boxNode(
  id: string,
  name: string,
  position: [number, number, number],
  width: number,
  height: number,
  depth: number,
  materialId: string,
): SceneNode {
  return {
    kind: "procedural",
    id,
    name,
    transform: { position, rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    op: "box",
    params: { width, height, depth },
    seed: 11,
    materialId,
  };
}

function cylinderNode(
  id: string,
  name: string,
  position: [number, number, number],
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments: number,
  materialId: string,
): SceneNode {
  return {
    kind: "procedural",
    id,
    name,
    transform: { position, rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    op: "cylinder",
    params: {
      radiusTop,
      radiusBottom,
      height,
      radialSegments,
      heightSegments: 1,
      capped: true,
    },
    seed: 11,
    materialId,
  };
}

/**
 * The component desk: tabletop, four legs, and two aprons as meaningful
 * parts, each validated independently and assembled with assembly validation.
 * Fixed data like the studio scene — a fixture that fails to assemble is a
 * broken fixture (programmer error), so construction throws rather than
 * returning a result nobody checks in a test.
 */
export function vqDeskAssembly(): AssembledObject {
  const walnut = semanticSceneMaterial("vq-desk-walnut", "Walnut", "walnut");
  const black = semanticSceneMaterial("vq-desk-black", "Matte black", "matte_black");
  const parts: ComponentSpec[] = [
    {
      id: "desk-top",
      name: "Tabletop",
      op: "box",
      params: { width: 1.6, height: 0.06, depth: 0.8 },
      transform: { position: [0, 0.75, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      material: walnut,
    },
    {
      id: "desk-apron-front",
      name: "Apron front",
      op: "box",
      params: { width: 1.42, height: 0.09, depth: 0.04 },
      transform: { position: [0, 0.675, 0.29], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      material: walnut,
    },
    {
      id: "desk-apron-back",
      name: "Apron back",
      op: "box",
      params: { width: 1.42, height: 0.09, depth: 0.04 },
      transform: { position: [0, 0.675, -0.29], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      material: walnut,
    },
  ];
  for (const [leg, x, z] of [
    ["front-left", -0.74, 0.34],
    ["front-right", 0.74, 0.34],
    ["back-left", -0.74, -0.34],
    ["back-right", 0.74, -0.34],
  ] as const) {
    parts.push({
      id: `desk-leg-${leg}`,
      name: `Leg ${leg}`,
      op: "box",
      params: { width: 0.06, height: 0.72, depth: 0.06 },
      transform: { position: [x, 0.36, z], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      material: black,
    });
  }
  const components = parts.map((part) => {
    const built = buildComponent(part);
    if (!built.ok) throw new Error(`desk fixture part failed: ${built.error.message}`);
    return built.value;
  });
  const assembled = assembleComponents({ id: "vq-desk", name: "Desk", components });
  if (!assembled.ok) throw new Error(`desk fixture assembly failed: ${assembled.error.message}`);
  return assembled.value;
}

/**
 * The detailed desk: the component desk rebuilt through the detail
 * primitives — a softly beveled tabletop, set-back aprons, and legs standing
 * on flared feet. A separate fixture with its own pinned count, so the plain
 * desk (84) and studio (200) baselines never move underneath it.
 */
export function vqDetailedDeskAssembly(): AssembledObject {
  const walnut = semanticSceneMaterial("vq-detail-walnut", "Walnut", "walnut");
  const black = semanticSceneMaterial("vq-detail-black", "Matte black", "matte_black");
  const parts: ComponentSpec[] = [
    ...panel({
      id: "detail-top",
      name: "Tabletop",
      x: 0,
      y: 0.75,
      z: 0,
      width: 1.6,
      height: 0.06,
      depth: 0.8,
      bevel: 0.01,
      material: walnut,
    }),
    ...panel({
      id: "detail-apron-front",
      name: "Apron front",
      x: 0,
      y: 0.675,
      z: 0.29,
      width: 1.42,
      height: 0.09,
      depth: 0.04,
      material: walnut,
    }),
    ...panel({
      id: "detail-apron-back",
      name: "Apron back",
      x: 0,
      y: 0.675,
      z: -0.29,
      width: 1.42,
      height: 0.09,
      depth: 0.04,
      material: walnut,
    }),
  ];
  for (const [leg, x, z] of [
    ["front-left", -0.74, 0.34],
    ["front-right", 0.74, 0.34],
    ["back-left", -0.74, -0.34],
    ["back-right", 0.74, -0.34],
  ] as const) {
    parts.push(
      ...footedPost({
        id: `detail-leg-${leg}`,
        name: `Leg ${leg}`,
        x,
        z,
        baseY: 0,
        postWidth: 0.06,
        postHeight: 0.72,
        postDepth: 0.06,
        footWidth: 0.1,
        footHeight: 0.04,
        footDepth: 0.1,
        material: black,
      }),
    );
  }
  const components: BuiltComponent[] = parts.map((part) => {
    const built = buildComponent(part);
    if (!built.ok) throw new Error(`detailed desk fixture part failed: ${built.error.message}`);
    return built.value;
  });
  const assembled = assembleComponents({ id: "vq-detail-desk", name: "Detailed desk", components });
  if (!assembled.ok) throw new Error(`detailed desk fixture failed: ${assembled.error.message}`);
  return assembled.value;
}

/**
 * The placed desk: the detailed desk with every derived coordinate computed
 * from the tabletop size instead of written literally. Legs, aprons, and leg
 * heights all follow the top through `placement.ts`, so widening the top
 * repositions and resizes its dependents without touching anything else.
 * Defaults reproduce the detailed desk exactly (see the equivalence test);
 * absurd sizes fail in the placement helpers with the rule named.
 */
export function vqPlacedDesk(topWidth = 1.6, topDepth = 0.8): AssembledObject {
  const top: Bounds = {
    min: [-topWidth / 2, 0.72, -topDepth / 2],
    max: [topWidth / 2, 0.78, topDepth / 2],
  };
  const centerX = (top.min[0] + top.max[0]) / 2;
  const walnut = semanticSceneMaterial("vq-placed-walnut", "Walnut", "walnut");
  const black = semanticSceneMaterial("vq-placed-black", "Matte black", "matte_black");
  const parts: ComponentSpec[] = [
    ...panel({
      id: "placed-top",
      name: "Tabletop",
      x: centerX,
      y: 0.75,
      z: (top.min[2] + top.max[2]) / 2,
      width: topWidth,
      height: 0.06,
      depth: topDepth,
      bevel: 0.01,
      material: walnut,
    }),
  ];
  const rails = apronPair(top, 0.06, 0.06, 0.03, 0.09, 0.04);
  const railNames = ["Apron front", "Apron back"] as const;
  const railIds = ["placed-apron-front", "placed-apron-back"] as const;
  rails.forEach((rail, index) => {
    parts.push(
      ...panel({
        id: railIds[index] ?? `placed-apron-${index}`,
        name: railNames[index] ?? `Apron ${index}`,
        x: rail.center[0],
        y: rail.center[1],
        z: rail.center[2],
        width: rail.length,
        height: 0.09,
        depth: 0.04,
        material: walnut,
      }),
    );
  });
  const span = verticalSpan(0, top.min[1]);
  const legNames = ["front-left", "front-right", "back-left", "back-right"] as const;
  tableLegCenters(top, 0.06, 0.06, 0.03).forEach(([x, z], index) => {
    parts.push(
      ...footedPost({
        id: `placed-leg-${legNames[index] ?? index}`,
        name: `Leg ${legNames[index] ?? index}`,
        x,
        z,
        baseY: 0,
        postWidth: 0.06,
        postHeight: span.height,
        postDepth: 0.06,
        footWidth: 0.1,
        footHeight: 0.04,
        footDepth: 0.1,
        material: black,
      }),
    );
  });
  const components: BuiltComponent[] = parts.map((part) => {
    const built = buildComponent(part);
    if (!built.ok) throw new Error(`placed desk fixture part failed: ${built.error.message}`);
    return built.value;
  });
  const assembled = assembleComponents({ id: "vq-placed-desk", name: "Placed desk", components });
  if (!assembled.ok) throw new Error(`placed desk fixture failed: ${assembled.error.message}`);
  return assembled.value;
}

export function vqStudioSpec(): SceneSpec {
  const materials: SceneMaterial[] = [
    semanticSceneMaterial("vq-walnut", "Walnut", "walnut"),
    semanticSceneMaterial("vq-matte-black", "Matte black", "matte_black"),
    semanticSceneMaterial("vq-brushed-aluminum", "Brushed aluminum", "brushed_aluminum"),
    semanticSceneMaterial("vq-brass", "Brass", "brass", "polished"),
    semanticSceneMaterial("vq-glass", "Glass", "glass"),
  ];
  const nodes: SceneNode[] = [
    {
      kind: "group",
      id: VQ_ROOT_ID,
      name: "Studio",
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      children: [
        "vq-desk-top",
        "vq-leg-fl",
        "vq-leg-fr",
        "vq-leg-bl",
        "vq-leg-br",
        "vq-stand-base",
        "vq-stand-column",
        "vq-keyboard",
        "vq-lamp-base",
        "vq-lamp-pole",
        "vq-lamp-head",
        "vq-glass-cube",
      ],
    },
    boxNode("vq-desk-top", "Desk top", [0, 0.75, 0], 1.6, 0.06, 0.8, "vq-walnut"),
    boxNode("vq-leg-fl", "Leg front left", [-0.74, 0.36, 0.34], 0.06, 0.72, 0.06, "vq-matte-black"),
    boxNode("vq-leg-fr", "Leg front right", [0.74, 0.36, 0.34], 0.06, 0.72, 0.06, "vq-matte-black"),
    boxNode("vq-leg-bl", "Leg back left", [-0.74, 0.36, -0.34], 0.06, 0.72, 0.06, "vq-matte-black"),
    boxNode("vq-leg-br", "Leg back right", [0.74, 0.36, -0.34], 0.06, 0.72, 0.06, "vq-matte-black"),
    boxNode("vq-stand-base", "Stand base", [0, 0.8, -0.15], 0.5, 0.04, 0.3, "vq-brushed-aluminum"),
    boxNode(
      "vq-stand-column",
      "Stand column",
      [0, 1.02, -0.15],
      0.08,
      0.4,
      0.08,
      "vq-brushed-aluminum",
    ),
    boxNode("vq-keyboard", "Keyboard", [0, 0.795, 0.15], 0.45, 0.03, 0.15, "vq-matte-black"),
    cylinderNode(
      "vq-lamp-base",
      "Lamp base",
      [-0.55, 0.795, -0.2],
      0.09,
      0.11,
      0.03,
      12,
      "vq-brass",
    ),
    cylinderNode(
      "vq-lamp-pole",
      "Lamp pole",
      [-0.55, 1.05, -0.2],
      0.015,
      0.015,
      0.5,
      8,
      "vq-brass",
    ),
    boxNode("vq-lamp-head", "Lamp head", [-0.55, 1.32, -0.2], 0.16, 0.06, 0.1, "vq-brass"),
    boxNode("vq-glass-cube", "Glass cube", [0.55, 0.84, 0.1], 0.12, 0.12, 0.12, "vq-glass"),
  ];
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000002",
    seed: 11,
    units: "m",
    axes: "y-up",
    materials,
    nodes,
    root: VQ_ROOT_ID,
  };
}
