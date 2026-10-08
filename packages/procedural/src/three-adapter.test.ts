import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildScene } from "./build.ts";
import { resolveSemanticMaterial } from "./material.ts";
import { builtSceneToGroup, disposeGroup } from "./three-adapter.ts";
import { vqStudioSpec } from "./vq-fixture.ts";

/**
 * The last mile of the semantic path: catalog values authored into the
 * fixture spec must arrive on real `MeshStandardMaterial`s undistorted.
 * Construction needs no GPU — only drawing does — so these run in Node
 * against the actual adapter, not a model of it.
 */

function fixtureGroup(): THREE.Group {
  const built = buildScene(vqStudioSpec());
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  return builtSceneToGroup(built.value);
}

function materialOf(group: THREE.Group, nodeId: string): THREE.MeshStandardMaterial {
  const mesh = group.children.find((child) => (child as THREE.Mesh).userData.nodeId === nodeId) as
    | THREE.Mesh
    | undefined;
  if (mesh === undefined) throw new Error(`fixture has no mesh "${nodeId}"`);
  return mesh.material as THREE.MeshStandardMaterial;
}

describe("semantic materials through the adapter", () => {
  it("uploads one mesh per fixture node", () => {
    const group = fixtureGroup();
    try {
      expect(group.children).toHaveLength(12);
    } finally {
      disposeGroup(group);
    }
  });

  it("lands polished brass with metalness 1 and finish roughness", () => {
    const group = fixtureGroup();
    try {
      const brass = materialOf(group, "vq-lamp-base");
      expect(brass.metalness).toBe(1);
      expect(brass.roughness).toBe(0.12);
      expect(brass.color.equals(new THREE.Color("#b98a2f"))).toBe(true);
    } finally {
      disposeGroup(group);
    }
  });

  it("lands walnut as a warm dielectric with converted sRGB color", () => {
    const group = fixtureGroup();
    try {
      const walnut = materialOf(group, "vq-desk-top");
      expect(walnut.metalness).toBe(0);
      expect(walnut.color.equals(new THREE.Color("#5a3a22"))).toBe(true);
    } finally {
      disposeGroup(group);
    }
  });

  it("keeps glass an opaque smooth dielectric: no transparency flags", () => {
    const group = fixtureGroup();
    try {
      const glass = materialOf(group, "vq-glass-cube");
      expect(glass.metalness).toBe(0);
      expect(glass.roughness).toBe(0.05);
      // Scalar-only glass by documented design: nothing here may pretend
      // otherwise by smuggling in transparency.
      expect(glass.transparent).toBe(false);
      expect(glass.opacity).toBe(1);
    } finally {
      disposeGroup(group);
    }
  });

  it("keeps rubber a rough non-metal", () => {
    // No rubber node in the fixture; the catalog value itself is the claim.
    const resolved = resolveSemanticMaterial("rubber");
    expect(resolved.metalness).toBe(0);
    expect(resolved.roughness).toBe(0.95);
  });
});
