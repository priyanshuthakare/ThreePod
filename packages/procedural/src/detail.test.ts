import type { SceneMaterial } from "@nap/scene-spec/schema";
import { describe, expect, it } from "vitest";
import { assembleComponents, buildComponent } from "./component.ts";
import { collar, footedPost, panel } from "./detail.ts";
import { semanticSceneMaterial } from "./material.ts";

const WALNUT = (): SceneMaterial => semanticSceneMaterial("walnut", "Walnut", "walnut");
const BLACK = (): SceneMaterial =>
  semanticSceneMaterial("matte-black", "Matte black", "matte_black");
const BRASS = (): SceneMaterial => semanticSceneMaterial("brass", "Brass", "brass", "polished");

describe("panel", () => {
  it("builds a beveled slab as one component spec", () => {
    const parts = panel({
      id: "top",
      name: "Tabletop",
      x: 0,
      y: 0.75,
      z: 0,
      width: 1.6,
      height: 0.06,
      depth: 0.8,
      bevel: 0.01,
      material: WALNUT(),
    });
    expect(parts).toHaveLength(1);
    const spec = parts[0];
    expect(spec?.id).toBe("top");
    expect(spec?.op).toBe("box");
    if (spec?.op !== "box") return;
    expect(spec.params).toEqual({ width: 1.6, height: 0.06, depth: 0.8, bevel: 0.01 });
  });

  it("defaults to a sharp slab, matching the plain box path", () => {
    const parts = panel({
      id: "shelf",
      name: "Shelf",
      x: 0,
      y: 0,
      z: 0,
      width: 1,
      height: 0.05,
      depth: 0.4,
      material: WALNUT(),
    });
    const spec = parts[0];
    if (spec?.op !== "box" || !("width" in spec.params)) {
      throw new Error("panel must be a box");
    }
    expect(spec.params.bevel ?? 0).toBe(0);
  });

  it("rejects non-positive dimensions and bad bevels", () => {
    const good = {
      id: "top",
      name: "Tabletop",
      x: 0,
      y: 0.75,
      z: 0,
      width: 1.6,
      height: 0.06,
      depth: 0.8,
      bevel: 0.01,
      material: WALNUT(),
    };
    expect(() => panel({ ...good, width: 0 })).toThrow(/width/);
    expect(() => panel({ ...good, height: Number.NaN })).toThrow(/height/);
    // The 0.06 slab admits at most a 0.03 bevel — the schema's rule, checked
    // here with the part named instead of deep inside a build.
    expect(() => panel({ ...good, bevel: 0.05 })).toThrow(/bevel/);
    expect(() => panel({ ...good, bevel: -0.01 })).toThrow(/bevel/);
  });

  it("builds deterministically through the component path", () => {
    const args = {
      id: "top",
      name: "Tabletop",
      x: 0,
      y: 0.75,
      z: 0,
      width: 1.6,
      height: 0.06,
      depth: 0.8,
      bevel: 0.01,
      material: WALNUT(),
    };
    const first = panel(args);
    const second = panel(args);
    expect(first).toEqual(second);
    for (const spec of first) {
      expect(buildComponent(spec).ok).toBe(true);
    }
  });
});

describe("footedPost", () => {
  it("builds a post plus a wider foot with derived ids", () => {
    const parts = footedPost({
      id: "leg",
      name: "Leg",
      x: -0.74,
      z: 0.34,
      baseY: 0,
      postWidth: 0.06,
      postHeight: 0.72,
      postDepth: 0.06,
      footWidth: 0.1,
      footHeight: 0.04,
      footDepth: 0.1,
      material: BLACK(),
    });
    expect(parts.map((part) => part.id)).toEqual(["leg", "leg-foot"]);
    const [post, foot] = parts;
    if (post?.op !== "box" || foot?.op !== "box" || !("width" in foot.params)) {
      throw new Error("post parts must be boxes");
    }
    // The post spans the full height; the foot hugs the floor beneath it.
    expect(post.transform.position).toEqual([-0.74, 0.36, 0.34]);
    expect(foot.transform.position).toEqual([-0.74, 0.02, 0.34]);
    expect(foot.params.width).toBe(0.1);
  });

  it("rejects a foot that is not wider than its post", () => {
    const good = {
      id: "leg",
      name: "Leg",
      x: 0,
      z: 0,
      baseY: 0,
      postWidth: 0.06,
      postHeight: 0.72,
      postDepth: 0.06,
      footWidth: 0.1,
      footHeight: 0.04,
      footDepth: 0.1,
      material: BLACK(),
    };
    // A foot no wider than the post is just a segment, not a foot.
    expect(() => footedPost({ ...good, footWidth: 0.06 })).toThrow(/wider/);
    expect(() => footedPost({ ...good, footDepth: 0.05 })).toThrow(/wider/);
    expect(() => footedPost({ ...good, footHeight: 0 })).toThrow(/footHeight/);
    expect(() => footedPost({ ...good, postHeight: Number.NaN })).toThrow(/postHeight/);
  });

  it("assembles post and foot through validation", () => {
    const parts = footedPost({
      id: "leg",
      name: "Leg",
      x: 0,
      z: 0,
      baseY: 0,
      postWidth: 0.06,
      postHeight: 0.72,
      postDepth: 0.06,
      footWidth: 0.1,
      footHeight: 0.04,
      footDepth: 0.1,
      material: BLACK(),
    });
    const built = parts.map((spec) => {
      const result = buildComponent(spec);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    const assembled = assembleComponents({ id: "leg-set", name: "Leg set", components: built });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.value.triangleCount).toBe(24);
    expect(assembled.value.bounds.min[1]).toBeCloseTo(0, 10);
  });
});

describe("collar", () => {
  it("builds a fixed-segment transition ring", () => {
    const parts = collar({
      id: "base-collar",
      name: "Base collar",
      x: -0.55,
      y: 0.83,
      z: -0.2,
      radius: 0.03,
      height: 0.04,
      material: BRASS(),
    });
    expect(parts).toHaveLength(1);
    const spec = parts[0];
    expect(spec?.op).toBe("cylinder");
    if (spec?.op !== "cylinder") return;
    // Segment counts are engine-fixed like bevel arcs, never caller-chosen.
    expect(spec.params).toEqual({
      radiusTop: 0.03,
      radiusBottom: 0.03,
      height: 0.04,
      radialSegments: 16,
      heightSegments: 1,
      capped: true,
    });
    expect(buildComponent(spec).ok).toBe(true);
  });

  it("rejects non-positive dimensions", () => {
    const good = {
      id: "c",
      name: "Collar",
      x: 0,
      y: 0,
      z: 0,
      radius: 0.03,
      height: 0.04,
      material: BRASS(),
    };
    expect(() => collar({ ...good, radius: 0 })).toThrow(/radius/);
    expect(() => collar({ ...good, height: Number.NaN })).toThrow(/height/);
  });
});
