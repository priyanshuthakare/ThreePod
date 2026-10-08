/**
 * Viewport scene assembly tests: real Three.js math, no GPU.
 *
 * `createViewportScene` never creates a renderer — that is the component's job —
 * so these tests run the actual scene graph construction (adapter meshes, lights,
 * camera framing, selection) in jsdom with a plain canvas element.
 */

import { buildScene } from "@nap/procedural/build";
import { ALBEDO_COLOR_SPACE, DATA_COLOR_SPACE } from "@nap/procedural/three-adapter";
import { towerSpec } from "@nap/scene-spec/tower";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applySelection, createViewportScene, disposeViewportScene } from "./viewport-scene.ts";

function towerBuilt() {
  const built = buildScene(towerSpec());
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  return built.value;
}

describe("createViewportScene", () => {
  it("assembles three meshes under one group", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      expect(viewport.group.children).toHaveLength(3);
      expect(viewport.scene.children).toContain(viewport.group);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("frames the tower in the camera", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      // The camera stands off from the tower center along a fixed diagonal.
      expect(viewport.camera.position.length()).toBeGreaterThan(4);
      const direction = viewport.camera.position.clone().normalize();
      expect(direction.x).toBeGreaterThan(0);
      expect(direction.y).toBeGreaterThan(0);
      expect(direction.z).toBeGreaterThan(0);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("highlights the selected node and restores on deselect", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      applySelection(viewport.group, "base");
      const base = viewport.group.children.find(
        (child) => (child as THREE.Mesh).userData.nodeId === "base",
      ) as THREE.Mesh;
      const mid = viewport.group.children.find(
        (child) => (child as THREE.Mesh).userData.nodeId === "mid",
      ) as THREE.Mesh;
      expect((base.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
      expect((mid.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);

      applySelection(viewport.group, null);
      expect((base.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("wires adapter meshes for the studio rig: sRGB color, shadows on", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      for (const child of viewport.group.children) {
        const mesh = child as THREE.Mesh;
        const material = mesh.material as THREE.MeshStandardMaterial;
        // The spec hex enters THREE.Color as sRGB and converts once to the
        // linear working space — pin the converted value, not the hex.
        expect(material.color.equals(new THREE.Color("#9aa0a6"))).toBe(true);
        expect(mesh.castShadow).toBe(true);
        expect(mesh.receiveShadow).toBe(true);
      }
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("pins the color-management assumptions the adapter relies on", () => {
    // THREE.Color(hex) converts sRGB to linear only while ColorManagement is
    // enabled. It defaults on; this pins the default so an upgrade cannot
    // silently double-convert every material.
    expect(THREE.ColorManagement.enabled).toBe(true);
    // Albedo uploads as sRGB; data maps (roughness/metalness/AO/normal) upload
    // linear. The core carries no textures yet — these pin the rule the first
    // texture upload must follow.
    expect(ALBEDO_COLOR_SPACE).toBe(THREE.SRGBColorSpace);
    expect(DATA_COLOR_SPACE).toBe(THREE.NoColorSpace);
  });

  it("lights a three-point studio rig keyed to the scene extent", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      const directionals = viewport.scene.children.filter(
        (child): child is THREE.DirectionalLight => child instanceof THREE.DirectionalLight,
      );
      const hemispheres = viewport.scene.children.filter(
        (child): child is THREE.HemisphereLight => child instanceof THREE.HemisphereLight,
      );
      expect(hemispheres).toHaveLength(1);
      expect(directionals).toHaveLength(3);
      const intensities = directionals.map((light) => light.intensity).sort((a, b) => a - b);
      // Fill, rim, key: the key dominates at roughly 4x the fill so form reads
      // while shadows stay open.
      expect(intensities).toEqual([0.55, 0.9, 2.4]);
      const key = directionals.find((light) => light.castShadow);
      expect(key).toBeDefined();
      // The key aims at the scene from a distance scaled to it, not from a
      // fixed point that is right for exactly one scene size.
      expect(key?.position.length()).toBeGreaterThan(4);
      expect(key?.shadow.mapSize.width).toBe(2048);
      expect(key?.shadow.camera.left).toBeLessThan(0);
      expect(key?.shadow.camera.right).toBeGreaterThan(0);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("catches contact shadows on an invisible floor under the scene", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      const catchers = viewport.scene.children.filter(
        (child) =>
          (child as THREE.Mesh).isMesh &&
          (child as THREE.Mesh).material instanceof THREE.ShadowMaterial,
      );
      expect(catchers).toHaveLength(1);
      const catcher = catchers[0] as THREE.Mesh;
      expect((catcher.material as THREE.ShadowMaterial).opacity).toBe(0.18);
      expect(catcher.receiveShadow).toBe(true);
      // At the tower's foot, not through it: the tower base sits at y 0.
      expect(catcher.position.y).toBeLessThanOrEqual(0.01);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("disposal fires dispose on every geometry and material", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    let disposed = 0;
    viewport.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      (mesh.geometry as THREE.BufferGeometry | undefined)?.addEventListener("dispose", () => {
        disposed += 1;
      });
      const material = mesh.material as THREE.Material | undefined;
      material?.addEventListener("dispose", () => {
        disposed += 1;
      });
    });
    disposeViewportScene(viewport);
    // 3 geometries + 3 mesh materials. Lights/grid/axes materials are covered
    // too, so this is a lower bound, not an exact count.
    expect(disposed).toBeGreaterThanOrEqual(6);
  });
});
