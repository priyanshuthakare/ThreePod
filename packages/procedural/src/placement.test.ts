import { describe, expect, it } from "vitest";
import type { Bounds } from "./build.ts";
import { apronPair, restingHeight, tableLegCenters, verticalSpan } from "./placement.ts";

const TOP: Bounds = { min: [-0.8, 0.72, -0.4], max: [0.8, 0.78, 0.4] };
const WIDE_TOP: Bounds = { min: [-1, 0.72, -0.4], max: [1, 0.78, 0.4] };
const CUBE: Bounds = { min: [0, 0, 0], max: [1, 1, 1] };

describe("tableLegCenters", () => {
  const topBox = (width: number, depth: number): Bounds => ({
    min: [-width / 2, 0.72, -depth / 2],
    max: [width / 2, 0.78, depth / 2],
  });

  it("derives the fixture leg positions from top size and inset", () => {
    const centers = tableLegCenters(topBox(1.6, 0.8), 0.06, 0.06, 0.03);
    const expected = [
      [-0.74, 0.34],
      [0.74, 0.34],
      [-0.74, -0.34],
      [0.74, -0.34],
    ];
    expect(centers).toHaveLength(4);
    for (const [index, pair] of expected.entries()) {
      expect(centers[index]?.[0]).toBeCloseTo(pair[0] ?? 0, 10);
      expect(centers[index]?.[1]).toBeCloseTo(pair[1] ?? 0, 10);
    }
  });

  it("moves legs outward when the top widens", () => {
    const [wide] = tableLegCenters(topBox(2.0, 0.8), 0.06, 0.06, 0.03);
    expect(wide?.[0]).toBeCloseTo(-0.94, 10);
  });

  it("rejects non-finite, non-positive, and non-fitting inputs", () => {
    const bad: Bounds = { min: [Number.NaN, 0, 0], max: [1, 1, 1] };
    expect(() => tableLegCenters(bad, 0.06, 0.06, 0.03)).toThrow(/bounds/);
    expect(() => tableLegCenters(topBox(1.6, 0.8), -0.06, 0.06, 0.03)).toThrow(/post size/);
    expect(() => tableLegCenters(topBox(1.6, 0.8), 0.06, 0.06, -0.01)).toThrow(/inset/);
    // Legs would swallow each other past the middle.
    expect(() => tableLegCenters(topBox(0.15, 0.8), 0.06, 0.06, 0.03)).toThrow(/fit/);
    expect(() => tableLegCenters(topBox(1.6, 0.1), 0.06, 0.06, 0.03)).toThrow(/fit/);
  });
});

describe("apronPair", () => {
  it("derives the fixture apron span and placement", () => {
    const [front, back] = apronPair(TOP, 0.06, 0.06, 0.03, 0.09, 0.04);
    expect(front?.length).toBeCloseTo(1.42, 10);
    expect(front?.center[0]).toBeCloseTo(0, 10);
    expect(front?.center[1]).toBeCloseTo(0.675, 10);
    expect(front?.center[2]).toBeCloseTo(0.29, 10);
    expect(back?.center[2]).toBeCloseTo(-0.29, 10);
  });

  it("lengthens rails when the top widens", () => {
    const [front] = apronPair(WIDE_TOP, 0.06, 0.06, 0.03, 0.09, 0.04);
    expect(front?.length).toBeCloseTo(1.82, 10);
  });

  it("rejects bad rail sizes and insets", () => {
    expect(() => apronPair(TOP, 0.06, 0.06, 0.03, 0, 0.04)).toThrow(/railHeight/);
    expect(() => apronPair(TOP, 0.06, 0.06, -0.01, 0.09, 0.04)).toThrow(/inset/);
    expect(() => apronPair(TOP, 0.06, 0.06, 0.5, 0.09, 0.04)).toThrow(/fit/);
  });
});

describe("verticalSpan", () => {
  it("centers the fixture leg in its floor-to-top span", () => {
    expect(verticalSpan(0, 0.72)).toEqual({ centerY: 0.36, height: 0.72 });
  });

  it("rejects inverted and non-finite spans", () => {
    expect(() => verticalSpan(0.72, 0.72)).toThrow(/upperY/);
    expect(() => verticalSpan(1, 0)).toThrow(/upperY/);
    expect(() => verticalSpan(Number.NaN, 1)).toThrow(/lowerY/);
  });
});

describe("restingHeight", () => {
  it("centers a stacked item on a support top", () => {
    expect(restingHeight(TOP, 0.03)).toBeCloseTo(0.795, 10);
    expect(restingHeight(TOP, 0.03, 0.01)).toBeCloseTo(0.805, 10);
  });

  it("rejects bad heights and lifts", () => {
    expect(() => restingHeight(CUBE, 0)).toThrow(/itemHeight/);
    expect(() => restingHeight(CUBE, 0.03, -0.01)).toThrow(/lift/);
  });
});
