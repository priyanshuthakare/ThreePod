/**
 * Deterministic placement: deriving part positions from dimensions instead of
 * hand-computing every coordinate.
 *
 * Composite objects used to carry their derivation in the author's head — leg
 * centers, apron spans, stacked heights written as literals in every fixture
 * and test, drifting the moment a top grew wider. These helpers write the
 * rules down once, with named offsets and checked fits, and return plain
 * numbers the detail factories and fixtures build `ComponentSpec`s from.
 * Validation still happens at build time through the schema; what fails here
 * fails early, with the rule named.
 *
 * Coordinate conventions (the engine's own — Y-up meters, as `SceneSpec`):
 *
 * - Y is vertical. Bounds are world-space; dimensions are full extents.
 * - Helpers return *centers* unless named otherwise, matching how component
 *   transforms place boxes and cylinders.
 * - Placement is axis-aligned throughout: no helper rotates anything, and
 *   oriented parts bypass this module for raw `ComponentSpec`s.
 * - Front is +z by convention: leg order is front-left, front-right,
 *   back-left, back-right, and aprons come as a front/back pair.
 *
 * Pure arithmetic, Three-free, no randomness: identical inputs place
 * identical parts, in Node or in a browser.
 */

import type { Bounds } from "./build.ts";

/** An [x, z] point on the floor plane. */
export type GroundPoint = [number, number];

/** One apron rail: its length along X plus its center. */
export type ApronRail = { length: number; center: [number, number, number] };

function requireFinite(value: unknown, name: string, helper: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${helper} needs a finite ${name}`);
  }
  return value;
}

function requirePositive(value: unknown, name: string, helper: string): number {
  const finite = requireFinite(value, name, helper);
  if (finite <= 0) {
    throw new Error(`${helper} needs a positive ${name}`);
  }
  return finite;
}

function requireBounds(top: Bounds, helper: string): void {
  const axes = ["x", "y", "z"] as const;
  for (let axis = 0; axis < 3; axis++) {
    const lo = top.min[axis] ?? Number.NaN;
    const hi = top.max[axis] ?? Number.NaN;
    requireFinite(lo, `bounds.min[${axes[axis] ?? "?"}]`, helper);
    requireFinite(hi, `bounds.max[${axes[axis] ?? "?"}]`, helper);
    if (hi < lo) {
      throw new Error(`${helper} needs ordered bounds`);
    }
  }
}

/**
 * One axis of leg placement: the distance from the top's center to a leg
 * center, given the top extent, the post footprint, and the inset from the
 * top edge to the leg's outer face. Refuses fits where legs would cross the
 * middle — overlapping corner posts are a degenerate intent, not a layout.
 */
function legCenter1D(topSize: number, postSize: number, inset: number, helper: string): number {
  requirePositive(topSize, "top size", helper);
  requirePositive(postSize, "post size", helper);
  requireFinite(inset, "inset", helper);
  if (inset < 0 || 2 * (inset + postSize) > topSize) {
    throw new Error(
      `${helper}: legs do not fit — inset ${inset} with ${postSize} posts on a ${topSize} top`,
    );
  }
  return topSize / 2 - inset - postSize / 2;
}

/**
 * Four leg centers from a top's bounds: symmetric about the top center, inset
 * from its edges. Order is front-left, front-right, back-left, back-right.
 */
export function tableLegCenters(
  top: Bounds,
  postWidth: number,
  postDepth: number,
  inset: number,
): [GroundPoint, GroundPoint, GroundPoint, GroundPoint] {
  const helper = "tableLegCenters";
  requireBounds(top, helper);
  const centerX = (top.min[0] + top.max[0]) / 2;
  const centerZ = (top.min[2] + top.max[2]) / 2;
  const topWidth = top.max[0] - top.min[0];
  const topDepth = top.max[2] - top.min[2];
  const offX = legCenter1D(topWidth, postWidth, inset, helper);
  const offZ = legCenter1D(topDepth, postDepth, inset, helper);
  return [
    [centerX - offX, centerZ + offZ],
    [centerX + offX, centerZ + offZ],
    [centerX - offX, centerZ - offZ],
    [centerX + offX, centerZ - offZ],
  ];
}

/**
 * The front/back apron pair hanging under a top: rails spanning inner leg
 * face to inner leg face, outer faces flush with those legs, hung from the
 * top's underside. Length derives from the top width, so a wider top grows
 * its aprons rather than stranding them.
 */
export function apronPair(
  top: Bounds,
  postWidth: number,
  postDepth: number,
  inset: number,
  railHeight: number,
  railThickness: number,
): [ApronRail, ApronRail] {
  const helper = "apronPair";
  requireBounds(top, helper);
  const railH = requirePositive(railHeight, "railHeight", helper);
  const railT = requirePositive(railThickness, "railThickness", helper);
  const topWidth = top.max[0] - top.min[0];
  const topDepth = top.max[2] - top.min[2];
  const centerX = (top.min[0] + top.max[0]) / 2;
  const centerZ = (top.min[2] + top.max[2]) / 2;
  const legOffX = legCenter1D(topWidth, postWidth, inset, helper);
  const legOffZ = legCenter1D(topDepth, postDepth, inset, helper);
  const length = 2 * legOffX - postWidth;
  const railZ = legOffZ - postDepth / 2 - railT / 2;
  const y = top.min[1] - railH / 2;
  return [
    { length, center: [centerX, y, centerZ + railZ] },
    { length, center: [centerX, y, centerZ - railZ] },
  ];
}

/**
 * A vertical span between two heights: the center and height of a post
 * standing on `lowerY` and ending flush under `upperY`. Legs derive from the
 * tabletop underside through this, so a thicker top shortens its legs rather
 * than intersecting them.
 */
export function verticalSpan(lowerY: number, upperY: number): { centerY: number; height: number } {
  const helper = "verticalSpan";
  requireFinite(lowerY, "lowerY", helper);
  requireFinite(upperY, "upperY", helper);
  if (!(upperY > lowerY)) {
    throw new Error(`${helper} needs upperY (${upperY}) above lowerY (${lowerY})`);
  }
  return { centerY: (lowerY + upperY) / 2, height: upperY - lowerY };
}

/**
 * The center height of an item of `itemHeight` resting on a support's top,
 * plus an optional named lift. The x/z placement stays a design decision for
 * the caller — this answers only the stacking question.
 */
export function restingHeight(support: Bounds, itemHeight: number, lift = 0): number {
  const helper = "restingHeight";
  requireBounds(support, helper);
  const height = requirePositive(itemHeight, "itemHeight", helper);
  const clearance = requireFinite(lift, "lift", helper);
  if (clearance < 0) {
    throw new Error(`${helper} needs a non-negative lift`);
  }
  return support.max[1] + clearance + height / 2;
}
