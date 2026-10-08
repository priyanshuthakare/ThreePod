"use client";

/**
 * The Three.js canvas: renderer, frame loop, picking and teardown.
 *
 * The renderer arrives through `createRenderer` so tests can inject a fake and
 * verify the lifecycle — RAF pause, resize, disposal — without a GPU. When the
 * real WebGLRenderer cannot be constructed (headless DOM, blocked context), the
 * pane says so instead of mounting a dead canvas: the tree and inspector remain
 * fully usable, and selection state is shared, so nothing is lost but the image.
 *
 * Hidden tabs pause: the workbench keeps every face mounted, and a 3D loop
 * running behind `hidden` is GPU rent for nobody. `active` stops the loop; the
 * scene graph stays put, so switching back resumes on the next frame.
 */

import type { BuiltScene } from "@nap/procedural/build";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  applySelection,
  createViewportScene,
  disposeViewportScene,
  reframeViewport,
  type ViewportScene,
} from "./viewport-scene.ts";

export type RendererHandle = {
  render: (scene: THREE.Scene, camera: THREE.Camera) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

/**
 * The workbench exposure, pinned by test. Neutral 1.0: the studio rig's light
 * levels are authored against it, so drifting here would silently re-grade
 * every scene. (The landing hero uses its own brighter presentation value;
 * that page is not this workbench.)
 */
export const VIEWPORT_EXPOSURE = 1.0;

/**
 * The one color pipeline, established in one place: linear working space in,
 * sRGB with ACES tone mapping out, soft shadows on. Every viewport that draws
 * a built scene calls this — the adapter's sRGB material colors only read
 * correctly when the output end holds up its half of the contract.
 */
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = VIEWPORT_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

export function defaultCreateRenderer(canvas: HTMLCanvasElement): RendererHandle | null {
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    configureRenderer(renderer);
    return {
      render: (scene, camera) => renderer.render(scene, camera),
      setSize: (width, height) => renderer.setSize(width, height, false),
      dispose: () => renderer.dispose(),
    };
  } catch {
    return null;
  }
}

export function SceneView({
  built,
  selectedId,
  onSelect,
  active,
  createRenderer = defaultCreateRenderer,
}: {
  built: BuiltScene | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  active: boolean;
  createRenderer?: (canvas: HTMLCanvasElement) => RendererHandle | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<ViewportScene | null>(null);
  const rendererRef = useRef<RendererHandle | null>(null);
  const pausedRef = useRef(false);
  const kickRef = useRef(() => {});
  const downAtRef = useRef<{ x: number; y: number; button: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // Mount once: renderer, scene, loop, resize. Everything allocated here is
  // released in the cleanup below — geometries, materials, controls, renderer,
  // listeners and the frame callback.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return;
    let renderer: RendererHandle | null = null;
    try {
      renderer = createRenderer(canvas);
    } catch {
      renderer = null;
    }
    if (renderer === null) {
      setUnavailable(true);
      return;
    }
    setUnavailable(false);
    rendererRef.current = renderer;

    const resize = () => {
      const rect = container.getBoundingClientRect();
      renderer?.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1));
    };
    resize();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(container);

    let frame = 0;
    let stopped = false;
    const renderFrame = () => {
      const viewport = viewportRef.current;
      if (viewport !== null) renderer?.render(viewport.scene, viewport.camera);
    };
    const kick = () => {
      // One loop at a time: a frame already scheduled or a paused/unmounted view
      // never schedules another.
      if (frame !== 0 || stopped || pausedRef.current) return;
      frame = requestAnimationFrame(loop);
    };
    const loop = () => {
      frame = 0;
      if (stopped || pausedRef.current) return;
      renderFrame();
      frame = requestAnimationFrame(loop);
    };
    kickRef.current = kick;
    kick();

    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else {
        kick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      kickRef.current = () => {};
      cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
      if (viewportRef.current !== null) {
        disposeViewportScene(viewportRef.current);
        viewportRef.current = null;
      }
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [createRenderer]);

  // Rebuild the scene graph when the build changes. Selection is applied
  // separately below, so picking an object never snaps the camera.
  useEffect(() => {
    if (built === null || rendererRef.current === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (viewportRef.current !== null) disposeViewportScene(viewportRef.current);
    const viewport = createViewportScene(built, canvas);
    viewportRef.current = viewport;
    const container = containerRef.current;
    if (container !== null) {
      const rect = container.getBoundingClientRect();
      rendererRef.current.setSize(Math.max(rect.width, 1), Math.max(rect.height, 1));
    }
  }, [built]);

  // Selection highlight plus re-framing on new bounds.
  useEffect(() => {
    if (built !== null && viewportRef.current !== null) {
      applySelection(viewportRef.current.group, selectedId);
      reframeViewport(viewportRef.current, built.bounds);
    }
  }, [built, selectedId]);

  // Pause the loop while another tab shows — the scene stays mounted, the GPU rests.
  useEffect(() => {
    pausedRef.current = !active;
    if (active) kickRef.current();
  }, [active]);

  /**
   * Selection commits on click — pointer down and up with barely any travel —
   * never on pointer down alone. Committing at down-time would fire at the start
   * of every orbit/pan drag and clear the selection while the user navigates.
   */
  const armPick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    downAtRef.current = { x: event.clientX, y: event.clientY, button: event.button };
  };

  const pick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const downAt = downAtRef.current;
    downAtRef.current = null;
    // A drag is navigation, not a selection: only the primary button released
    // near where it went down counts as a click.
    if (downAt === null || downAt.button !== 0) return;
    if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (viewport === null || canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(pointer, viewport.camera);
    const hits = raycaster.intersectObjects(viewport.group.children, false);
    const first = hits[0]?.object as THREE.Mesh | undefined;
    const nodeId = first?.userData.nodeId;
    selectRef.current(typeof nodeId === "string" ? nodeId : null);
  };

  if (built === null) {
    return <p role="status">Scene failed to build.</p>;
  }

  return (
    <div ref={containerRef} className="relative min-h-0 min-w-0 flex-1">
      <canvas
        ref={canvasRef}
        aria-label="3D viewport. Use the scene tree to select objects."
        className="block h-full w-full"
        onPointerDown={armPick}
        onPointerUp={pick}
      />
      {unavailable && (
        <p role="status" className="absolute inset-0 grid place-items-center text-muted text-sm">
          3D preview is unavailable here — the scene tree and inspector still work.
        </p>
      )}
    </div>
  );
}
