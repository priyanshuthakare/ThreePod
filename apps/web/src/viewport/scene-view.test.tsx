import { buildScene } from "@nap/procedural/build";
import { towerSpec } from "@nap/scene-spec/tower";
import { fireEvent, render, screen } from "@testing-library/react";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  configureRenderer,
  type RendererHandle,
  SceneView,
  VIEWPORT_EXPOSURE,
} from "./scene-view.tsx";

function towerBuilt() {
  const built = buildScene(towerSpec());
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  return built.value;
}

function fakeRenderer(): RendererHandle {
  return { render: () => {}, setSize: () => {}, dispose: () => {} };
}

function mountWithRect() {
  const onSelect = vi.fn();
  render(
    <SceneView
      built={towerBuilt()}
      selectedId={null}
      onSelect={onSelect}
      active={true}
      createRenderer={fakeRenderer}
    />,
  );
  const canvas = screen.getByLabelText("3D viewport. Use the scene tree to select objects.");
  // jsdom implements neither pointer capture nor layout: the former is stubbed
  // so OrbitControls' own pointerdown listener does not throw, the latter so the
  // raycast under test has a non-zero viewport to work with.
  (canvas as HTMLCanvasElement).setPointerCapture = () => {};
  (canvas as HTMLCanvasElement).releasePointerCapture = () => {};
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => {},
  });
  return { canvas, onSelect };
}

describe("configureRenderer", () => {
  function stubRenderer() {
    return {
      outputColorSpace: "",
      toneMapping: -1,
      toneMappingExposure: -1,
      shadowMap: { enabled: false, type: -1 },
    } as unknown as THREE.WebGLRenderer;
  }

  it("establishes the one color pipeline: sRGB out, ACES tone mapping, pinned exposure", () => {
    const renderer = stubRenderer();
    configureRenderer(renderer);

    expect(renderer.outputColorSpace).toBe(THREE.SRGBColorSpace);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.toneMappingExposure).toBe(VIEWPORT_EXPOSURE);
    expect(VIEWPORT_EXPOSURE).toBe(1.0);
  });

  it("enables soft shadow maps for the studio key light", () => {
    const renderer = stubRenderer();
    configureRenderer(renderer);

    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
  });
});

describe("SceneView picking", () => {
  it("selects the mesh under a completed primary click", () => {
    const { canvas, onSelect } = mountWithRect();
    // Canvas center looks straight at the tower middle.
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, button: 0 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(typeof onSelect.mock.calls[0]?.[0]).toBe("string");
  });

  it("ignores a drag: no selection when the pointer travels", () => {
    const { canvas, onSelect } = mountWithRect();
    fireEvent.pointerDown(canvas, { clientX: 20, clientY: 20, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 120, clientY: 120, button: 0 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores non-primary buttons", () => {
    const { canvas, onSelect } = mountWithRect();
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, button: 2 });
    fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100, button: 2 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("deselects on a completed click over empty space", () => {
    const { canvas, onSelect } = mountWithRect();
    // Top-left corner looks past the tower into the void.
    fireEvent.pointerDown(canvas, { clientX: 4, clientY: 4, button: 0 });
    fireEvent.pointerUp(canvas, { clientX: 4, clientY: 4, button: 0 });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe(null);
  });
});
