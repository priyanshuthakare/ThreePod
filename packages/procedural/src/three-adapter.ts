/**
 * The only file in the engine that knows Three.js exists.
 *
 * The core (`build.ts`) produces renderer-independent mesh data; this adapter
 * uploads it into BufferGeometries under a Group, one Mesh per scene node. The
 * world transform is already baked into the vertices, so every Mesh sits at the
 * identity — the adapter never re-applies transforms, which is what keeps the
 * rendered scene structurally identical to the built one rather than trusting
 * two transform implementations to agree.
 */

import * as THREE from "three";
import type { BuiltMesh, BuiltScene } from "./build.ts";
import { resolveMaterial } from "./material.ts";

/**
 * Color-space rules for the (future) texture path, stated where textures will
 * upload. Base color / albedo is color data and uploads as sRGB; roughness,
 * metalness, AO, normal and similar maps are data and upload linear. The core
 * carries no textures yet — these constants exist so the first texture upload
 * cannot pick the wrong default silently. See `material.ts` for the contract.
 */
export const ALBEDO_COLOR_SPACE = THREE.SRGBColorSpace;
export const DATA_COLOR_SPACE = THREE.NoColorSpace;

function meshToObject(mesh: BuiltMesh): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const resolved = resolveMaterial(mesh.material);
  const material = new THREE.MeshStandardMaterial({
    // A hex string enters `THREE.Color` as sRGB and converts to the linear
    // working space under the default-enabled ColorManagement — the single
    // conversion the pipeline performs, so colors match the spec exactly.
    color: resolved.colorHex,
    metalness: resolved.metalness,
    roughness: resolved.roughness,
    name: mesh.material.name,
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = mesh.nodeId;
  // The display name is for humans; the stable id is what selection addresses.
  object.userData = { nodeId: mesh.nodeId, displayName: mesh.name };
  // Every procedural mesh both casts and receives: the studio key light draws
  // contact shadows from these flags, and self-shadowing needs both sides.
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

/** Upload a built scene into a Group of identity-transformed meshes. */
export function builtSceneToGroup(built: BuiltScene): THREE.Group {
  const group = new THREE.Group();
  group.name = "threepod-scene";
  for (const mesh of built.meshes) {
    group.add(meshToObject(mesh));
  }
  return group;
}

/** Release everything the adapter allocated. Geometries and materials own GPU
 * resources; the group itself is just a container. */
export function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    geometry?.dispose();
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
    group.remove(child);
  }
}
