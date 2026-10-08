import { towerSpec } from "@nap/scene-spec/tower";
import { describe, expect, it } from "vitest";
import { type Bounds, buildScene } from "./build.ts";

function boundsOf(spec: ReturnType<typeof towerSpec>): Bounds {
  const built = buildScene(spec);
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  return built.value.bounds;
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

describe("buildScene", () => {
  it("builds the tower with three meshes and 36 triangles", () => {
    const built = buildScene(towerSpec());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.meshes).toHaveLength(3);
    expect(built.value.triangleCount).toBe(36);
  });

  it("computes the tower bounds exactly", () => {
    const bounds = boundsOf(towerSpec());
    expect(bounds.min).toEqual([-1, 0, -1]);
    expect(bounds.max).toEqual([1, 4, 1]);
  });

  it("reflects a +20% base width in the bounds", () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params.width = 2.4;
    const bounds = boundsOf(spec);
    expect(bounds.min[0]).toBeCloseTo(-1.2, 10);
    expect(bounds.max[0]).toBeCloseTo(1.2, 10);
    expect(bounds.max[1]).toBe(4);
  });

  it("matches box vertices to exact decimal dimensions", () => {
    const built = buildScene(towerSpec());
    if (!built.ok) throw new Error("fixture failed to build");
    const base = built.value.meshes.find((mesh) => mesh.nodeId === "base");
    expect(base).toBeDefined();
    if (base === undefined) return;
    // 24 vertices, 36 indices, unit normals.
    expect(base.positions).toHaveLength(72);
    expect(base.indices).toHaveLength(36);
    for (let i = 0; i < base.normals.length; i += 3) {
      const length = Math.hypot(
        base.normals[i] ?? 0,
        base.normals[i + 1] ?? 0,
        base.normals[i + 2] ?? 0,
      );
      expect(length).toBeCloseTo(1, 6);
    }
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < base.positions.length; i += 3) {
      minX = Math.min(minX, base.positions[i] ?? 0);
      maxX = Math.max(maxX, base.positions[i] ?? 0);
    }
    expect(minX).toBe(-1);
    expect(maxX).toBe(1);
  });

  it("winds box faces outward: signed volume is positive", () => {
    const spec = towerSpec();
    // Cover curved geometry too: a capped cylinder rides along so a future edit
    // to cylinderGeometry cannot flip its winding silently.
    spec.nodes.push({
      kind: "procedural",
      id: "pole",
      name: "Pole",
      transform: { position: [5, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "cylinder",
      params: {
        radiusTop: 0.4,
        radiusBottom: 0.6,
        height: 2,
        radialSegments: 12,
        heightSegments: 2,
        capped: true,
      },
      seed: 7,
      materialId: "concrete",
    });
    const root = spec.nodes.find((node) => node.id === "tower");
    if (root?.kind === "group") root.children.push("pole");
    const built = buildScene(spec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.meshes).toHaveLength(4);
    for (const mesh of built.value.meshes) {
      let volume = 0;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = (mesh.indices[i] ?? 0) * 3;
        const b = (mesh.indices[i + 1] ?? 0) * 3;
        const c = (mesh.indices[i + 2] ?? 0) * 3;
        const ax = mesh.positions[a] ?? 0;
        const ay = mesh.positions[a + 1] ?? 0;
        const az = mesh.positions[a + 2] ?? 0;
        const bx = mesh.positions[b] ?? 0;
        const by = mesh.positions[b + 1] ?? 0;
        const bz = mesh.positions[b + 2] ?? 0;
        const cx = mesh.positions[c] ?? 0;
        const cy = mesh.positions[c + 1] ?? 0;
        const cz = mesh.positions[c + 2] ?? 0;
        volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      }
      // Negative volume would mean inward winding — FrontSide rendering inside-out.
      // This test fails if the corner order is ever reversed.
      expect(volume).toBeGreaterThan(0);
    }
  });

  it("rotates +X toward -Z under +90 degrees about Y, matching Three.js", () => {
    const spec = towerSpec();
    // Isolate: single box 2 long in X at the origin.
    const single = {
      ...spec,
      nodes: [
        {
          kind: "procedural" as const,
          id: "bar",
          name: "Bar",
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotationEuler: [0, Math.PI / 2, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          op: "box" as const,
          params: { width: 2, height: 1, depth: 1 },
          seed: 7,
          materialId: "concrete",
        },
      ],
      root: "bar",
    };
    const built = buildScene(single);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { min, max } = built.value.bounds;
    // The 2-long X axis now lies along Z (within float tolerance of trig).
    expect(closeTo(max[0] - min[0], 1, 1e-9)).toBe(true);
    expect(closeTo(max[2] - min[2], 2, 1e-9)).toBe(true);
    expect(min[2]).toBeLessThan(-0.99);
  });

  it("builds a beveled box with 48 triangles and exact outer bounds", () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params = { ...base.params, bevel: 0.1 };
    // The fixture base rides 0.5 m up the tower; recenter so the assertions
    // read raw geometry rather than the tower placement.
    base.transform = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
    const single = {
      ...spec,
      nodes: spec.nodes.filter((node) => node.id === "base"),
      root: "base",
    };
    const built = buildScene(single);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Six faces of 2x2 arc grids: 6 * 8. The bevel cuts inside, so the
    // 2x1x2 outer dimensions — and the tower bounds test above — cannot move.
    expect(built.value.triangleCount).toBe(48);
    expect(closeTo(built.value.bounds.min[0], -1, 1e-9)).toBe(true);
    expect(closeTo(built.value.bounds.max[0], 1, 1e-9)).toBe(true);
    expect(closeTo(built.value.bounds.min[1], -0.5, 1e-9)).toBe(true);
    expect(closeTo(built.value.bounds.max[1], 0.5, 1e-9)).toBe(true);
    const mesh = built.value.meshes[0];
    if (mesh === undefined) throw new Error("fixture built no mesh");
    for (let i = 0; i < mesh.positions.length; i += 3) {
      expect(Math.abs(mesh.positions[i] ?? 0)).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it("builds bevel 0 byte-identically to no bevel", () => {
    const plain = towerSpec();
    const zeroed = towerSpec();
    const base = zeroed.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params = { ...base.params, bevel: 0 };
    const a = buildScene(plain);
    const b = buildScene(zeroed);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.triangleCount).toBe(b.value.triangleCount);
    for (const [meshA, meshB] of a.value.meshes.map(
      (mesh, i) => [mesh, b.value.meshes[i]] as const,
    )) {
      expect(Array.from(meshA?.positions ?? [])).toEqual(Array.from(meshB?.positions ?? []));
    }
  });

  it("winds the bevel outward with unit normals", () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params = { ...base.params, bevel: 0.1 };
    base.transform = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
    const single = {
      ...spec,
      nodes: spec.nodes.filter((node) => node.id === "base"),
      root: "base",
    };
    const built = buildScene(single);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const mesh = built.value.meshes[0];
    if (mesh === undefined) throw new Error("fixture built no mesh");
    let volume = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = (mesh.indices[i] ?? 0) * 3;
      const b = (mesh.indices[i + 1] ?? 0) * 3;
      const c = (mesh.indices[i + 2] ?? 0) * 3;
      const ax = mesh.positions[a] ?? 0;
      const ay = mesh.positions[a + 1] ?? 0;
      const az = mesh.positions[a + 2] ?? 0;
      const bx = mesh.positions[b] ?? 0;
      const by = mesh.positions[b + 1] ?? 0;
      const bz = mesh.positions[b + 2] ?? 0;
      const cx = mesh.positions[c] ?? 0;
      const cy = mesh.positions[c + 1] ?? 0;
      const cz = mesh.positions[c + 2] ?? 0;
      volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    }
    expect(volume).toBeGreaterThan(0);
    const cx = (built.value.bounds.min[0] + built.value.bounds.max[0]) / 2;
    const cy = (built.value.bounds.min[1] + built.value.bounds.max[1]) / 2;
    const cz = (built.value.bounds.min[2] + built.value.bounds.max[2]) / 2;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const nx = mesh.normals[i] ?? 0;
      const ny = mesh.normals[i + 1] ?? 0;
      const nz = mesh.normals[i + 2] ?? 0;
      // float32 storage, so the same 1e-6 the sharp-box test allows.
      expect(closeTo(Math.hypot(nx, ny, nz), 1, 1e-6)).toBe(true);
      const outward =
        nx * ((mesh.positions[i] ?? 0) - cx) +
        ny * ((mesh.positions[i + 1] ?? 0) - cy) +
        nz * ((mesh.positions[i + 2] ?? 0) - cz);
      expect(outward).toBeGreaterThan(0.4);
    }
  });

  it("builds beveled geometry bit-identically across runs", () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
    base.params = { ...base.params, bevel: 0.1 };
    const first = buildScene(spec);
    const second = buildScene(spec);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.triangleCount).toBe(second.value.triangleCount);
    for (const [meshA, meshB] of first.value.meshes.map(
      (mesh, i) => [mesh, second.value.meshes[i]] as const,
    )) {
      expect(Array.from(meshA?.positions ?? [])).toEqual(Array.from(meshB?.positions ?? []));
      expect(Array.from(meshA?.normals ?? [])).toEqual(Array.from(meshB?.normals ?? []));
    }
  });

  it("applies group transforms to children", () => {
    const spec = towerSpec();
    const root = spec.nodes.find((node) => node.id === "tower");
    if (root === undefined) throw new Error("fixture changed shape");
    root.transform = { position: [10, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
    const bounds = boundsOf(spec);
    expect(bounds.min[0]).toBe(9);
    expect(bounds.max[0]).toBe(11);
    expect(bounds.max[1]).toBe(4);
  });

  it("scales geometry through node scale", () => {
    const spec = towerSpec();
    const base = spec.nodes.find((node) => node.id === "base");
    if (base === undefined) throw new Error("fixture changed shape");
    base.transform = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [2, 1, 1] };
    const single = {
      ...spec,
      nodes: spec.nodes.filter((node) => node.id === "base"),
      root: "base",
    };
    const bounds = boundsOf(single);
    expect(bounds.min[0]).toBe(-2);
    expect(bounds.max[0]).toBe(2);
  });

  it("builds cylinders with the expected triangle count", () => {
    const spec = towerSpec();
    spec.nodes.push({
      kind: "procedural",
      id: "pole",
      name: "Pole",
      transform: { position: [5, 1, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "cylinder",
      params: {
        radiusTop: 0.5,
        radiusBottom: 0.5,
        height: 2,
        radialSegments: 8,
        heightSegments: 1,
        capped: true,
      },
      seed: 7,
      materialId: "concrete",
    });
    const root = spec.nodes.find((node) => node.id === "tower");
    if (root?.kind === "group") root.children.push("pole");
    const built = buildScene(spec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const pole = built.value.meshes.find((mesh) => mesh.nodeId === "pole");
    expect(pole).toBeDefined();
    // Side 8*1*2 + caps 2*8 = 32 triangles.
    expect(pole?.indices.length).toBe(32 * 3);
    // Pole spans y 0..2 at x 5: tower bounds extend in x but not y.
    expect(built.value.bounds.max[0]).toBeCloseTo(5.5, 6);
    expect(built.value.bounds.max[1]).toBe(4);
  });

  it("builds open cylinders without caps", () => {
    const spec = towerSpec();
    spec.nodes.push({
      kind: "procedural",
      id: "tube",
      name: "Tube",
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "cylinder",
      params: {
        radiusTop: 0.5,
        radiusBottom: 0.5,
        height: 2,
        radialSegments: 8,
        heightSegments: 2,
        capped: false,
      },
      seed: 7,
      materialId: "concrete",
    });
    const tubeRoot = spec.nodes.find((node) => node.id === "tower");
    if (tubeRoot?.kind === "group") tubeRoot.children.push("tube");
    const built = buildScene(spec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const tube = built.value.meshes.find((mesh) => mesh.nodeId === "tube");
    expect(tube?.indices.length).toBe(8 * 2 * 2 * 3);
  });

  it("is bit-exact across repeat builds", () => {
    const first = buildScene(towerSpec());
    const second = buildScene(towerSpec());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.meshes[0]?.positions).toEqual(second.value.meshes[0]?.positions);
    expect(first.value.bounds).toEqual(second.value.bounds);
  });

  it("rejects scenes over the triangle budget", () => {
    const spec = towerSpec();
    // 128x64 cylinder: side 128*64*2 = 16384 tris, uncapped to stay under per-node sanity.
    spec.nodes.push({
      kind: "procedural",
      id: "huge",
      name: "Huge",
      transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "cylinder",
      params: {
        radiusTop: 1,
        radiusBottom: 1,
        height: 1,
        radialSegments: 128,
        heightSegments: 64,
        capped: false,
      },
      seed: 7,
      materialId: "concrete",
    });
    // One such node is 16384 tris — under budget. Thirty-one of them exceed 500k.
    for (let i = 1; i < 31; i++) {
      spec.nodes.push({ ...spec.nodes[spec.nodes.length - 1]!, id: `huge${i}`, name: `Huge ${i}` });
    }
    const root = spec.nodes.find((node) => node.id === "tower");
    if (root?.kind === "group")
      root.children.push(...spec.nodes.filter((n) => n.id.startsWith("huge")).map((n) => n.id));
    const built = buildScene(spec);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe("triangle_budget_exceeded");
  });

  it("skips unreachable staged nodes", () => {
    const spec = towerSpec();
    spec.nodes.push({
      kind: "procedural",
      id: "staged",
      name: "Staged",
      transform: { position: [100, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      op: "box",
      params: { width: 50, height: 50, depth: 50 },
      seed: 7,
      materialId: "concrete",
    });
    const built = buildScene(spec);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.meshes).toHaveLength(3);
    expect(built.value.bounds.max[0]).toBe(1);
  });

  it("carries material assignment per mesh", () => {
    const built = buildScene(towerSpec());
    if (!built.ok) throw new Error("fixture failed to build");
    for (const mesh of built.value.meshes) {
      expect(mesh.material.color).toBe("#9aa0a6");
    }
  });
});
