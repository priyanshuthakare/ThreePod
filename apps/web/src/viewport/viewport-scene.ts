"use client";

/**
 * Three.js scene assembly for the viewport, kept renderer-free.
 *
 * Everything here is pure scene-graph math — no WebGL context, no DOM beyond a
 * canvas element for OrbitControls — so it is unit-testable in jsdom. The
 * component in `scene-view.tsx` owns the renderer, the frame loop and cleanup;
 * this module owns what is drawn. Selection highlight mutates the per-mesh
 * materials the adapter already allocates one-per-mesh, and restores them on
 * deselect.
 */

import type { Bounds, BuiltScene } from "@nap/procedural/build";
import { builtSceneToGroup } from "@nap/procedural/three-adapter";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type ViewportScene = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls | null;
  group: THREE.Group;
};

const SELECTED_EMISSIVE = 0x7c5cff;

function frameCamera(camera: THREE.PerspectiveCamera, bounds: Bounds): void {
  const center = new THREE.Vector3(
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  );
  const size = new THREE.Vector3(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  );
  const radius = Math.max(size.length() / 2, 0.5);
  const direction = new THREE.Vector3(1, 0.62, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, radius * 2.6);
  camera.near = Math.max(radius / 100, 0.01);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
}

/**
 * Assemble lights, ground grid, axes and the built meshes. Controls are
 * best-effort: if the canvas cannot host them (headless test DOM), the scene
 * still builds and renders — orbit is a convenience, not a load-bearing wall.
 */
export function createViewportScene(built: BuiltScene, canvas: HTMLCanvasElement): ViewportScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  frameCamera(camera, built.bounds);

  // Three-point studio rig, sized to the scene rather than fixed: a fixed
  // light is right for exactly one scene size, and every other scene gets
  // either flat frontal light or blown-out hotspots. Ratios follow the studio
  // convention — the key dominates at roughly 4x the fill so form reads while
  // shadows stay open, and the rim separates edges from the background.
  const center = new THREE.Vector3(
    (built.bounds.min[0] + built.bounds.max[0]) / 2,
    (built.bounds.min[1] + built.bounds.max[1]) / 2,
    (built.bounds.min[2] + built.bounds.max[2]) / 2,
  );
  const maxDim = Math.max(
    built.bounds.max[0] - built.bounds.min[0],
    built.bounds.max[1] - built.bounds.min[1],
    built.bounds.max[2] - built.bounds.min[2],
    0.001,
  );
  const place = (direction: THREE.Vector3): THREE.Vector3 =>
    center.clone().addScaledVector(direction.normalize(), maxDim * 2);

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8b8f96, 0.5);
  scene.add(hemisphere);

  const key = new THREE.DirectionalLight(0xfff2e2, 2.4);
  key.position.copy(place(new THREE.Vector3(0.55, 0.75, 0.45)));
  // The target must be in the scene or its transform never updates and the
  // light silently aims at the origin instead of the scene center.
  key.target.position.copy(center);
  scene.add(key.target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -maxDim * 1.2;
  key.shadow.camera.right = maxDim * 1.2;
  key.shadow.camera.top = maxDim * 1.2;
  key.shadow.camera.bottom = -maxDim * 1.2;
  key.shadow.camera.near = maxDim * 0.5;
  key.shadow.camera.far = maxDim * 6;
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.55);
  fill.position.copy(place(new THREE.Vector3(-0.7, 0.35, -0.6)));
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.9);
  rim.position.copy(place(new THREE.Vector3(0.1, 0.6, -1)));
  scene.add(rim);

  const gridExtent = Math.max(
    built.bounds.max[0] - built.bounds.min[0],
    built.bounds.max[2] - built.bounds.min[2],
    4,
  );
  const grid = new THREE.GridHelper(Math.ceil(gridExtent * 2), 20, 0x3a4356, 0x232a3a);
  grid.position.y = Math.min(built.bounds.min[1], 0);
  scene.add(grid);

  // The contact shadow's floor: transparent everywhere except where the key
  // light is blocked, so form gains depth without adding a visible surface.
  // It sits a hair below the grid to never z-fight the grid lines.
  const catcher = new THREE.Mesh(
    new THREE.CircleGeometry(maxDim * 2, 48),
    new THREE.ShadowMaterial({ opacity: 0.18 }),
  );
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = Math.min(built.bounds.min[1], 0) - maxDim * 0.002;
  catcher.receiveShadow = true;
  scene.add(catcher);
  const axes = new THREE.AxesHelper(Math.max(gridExtent / 4, 1));
  scene.add(axes);

  const group = builtSceneToGroup(built);
  scene.add(group);

  let controls: OrbitControls | null = null;
  try {
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.target.set(
      (built.bounds.min[0] + built.bounds.max[0]) / 2,
      (built.bounds.min[1] + built.bounds.max[1]) / 2,
      (built.bounds.min[2] + built.bounds.max[2]) / 2,
    );
  } catch {
    controls = null;
  }
  return { scene, camera, controls, group };
}

/** Re-frame an existing camera after the scene rebuilds (edits change bounds). */
export function reframeViewport(viewport: ViewportScene, bounds: Bounds): void {
  frameCamera(viewport.camera, bounds);
  if (viewport.controls !== null) {
    viewport.controls.target.set(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
  }
}

/** Highlight the selected node; pass null to clear. Restores what it changed. */
export function applySelection(group: THREE.Group, selectedId: string | null): void {
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (material === undefined || !("emissive" in material)) continue;
    if (mesh.userData.nodeId === selectedId && selectedId !== null) {
      material.emissive.setHex(SELECTED_EMISSIVE);
      material.emissiveIntensity = 0.45;
    } else {
      material.emissive.setHex(0x000000);
      material.emissiveIntensity = 0;
    }
  }
}

/** Release GPU-side resources for a viewport scene. Idempotent. */
export function disposeViewportScene(viewport: ViewportScene): void {
  viewport.controls?.dispose();
  viewport.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    (mesh.geometry as THREE.BufferGeometry | undefined)?.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
  });
}
