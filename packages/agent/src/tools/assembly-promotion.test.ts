/**
 * Assembly promotion through the real agent tool path.
 *
 * A validated procedural assembly is promoted to a genesis `CreateScene`
 * proposal and driven through `executeTool(propose_scene_patch)` — the same
 * tool, validation, fold, and rebuild path a model turn uses, with authored
 * traffic standing in for the model (the `cases.test.ts` pattern). No
 * network, no credentials; the sandbox is in-memory and the scene tools never
 * touch it.
 *
 * What this proves and nothing more: promotion participates in the canonical
 * pipeline without bypassing it. Failures stop before the tool runs, so a
 * rejected promotion leaves no scene events and no revision behind.
 */

import { buildScene } from "@nap/procedural/build";
import type { ComponentSpec } from "@nap/procedural/component";
import { semanticSceneMaterial } from "@nap/procedural/material";
import { promoteAssemblyToCreation } from "@nap/procedural/promotion";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { foldSceneSpec } from "@nap/scene-spec/fold";
import { hashSceneSpec } from "@nap/scene-spec/revisions";
import { sceneLogEvents } from "@nap/scene-spec/scene-events";
import type { SceneSpec } from "@nap/scene-spec/schema";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, type ToolContext } from "./execute.ts";

const SESSION_ID = "7a3f1c52-9d4b-4f6e-8a1b-2c3d4e5f6071";
const TURN_ID = "1b2c3d4e-5f60-7081-92a3-b4c5d6e7f809";
const CREATED_AT = "2026-10-06T00:00:00.000Z";
const SPEC_ID = "33333333-3333-4000-8000-000000000033";

function deskParts(): ComponentSpec[] {
  const top: ComponentSpec = {
    id: "top",
    name: "Tabletop",
    op: "box",
    params: { width: 1.6, height: 0.06, depth: 0.8 },
    transform: { position: [0, 0.75, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: semanticSceneMaterial("walnut", "Walnut", "walnut"),
  };
  const leg = (id: string, x: number): ComponentSpec => ({
    id,
    name: `Leg ${id}`,
    op: "box",
    params: { width: 0.06, height: 0.72, depth: 0.06 },
    transform: { position: [x, 0.36, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    material: semanticSceneMaterial("matte-black", "Matte black", "matte_black"),
  });
  return [top, leg("leg-a", -0.74), leg("leg-b", 0.74)];
}

function promote(parts: ComponentSpec[]): SceneSpec {
  const promoted = promoteAssemblyToCreation({
    assemblyId: "desk",
    assemblyName: "Desk",
    components: parts,
    specId: SPEC_ID,
    seed: 11,
  });
  if (!promoted.ok) throw new Error(`fixture promotion failed: ${promoted.error.message}`);
  return promoted.value.spec;
}

type TrafficItem = { name: string; input: Record<string, unknown> };

async function runTraffic(
  traffic: TrafficItem[],
  log: StoredEvent[] = [],
): Promise<{
  log: StoredEvent[];
  outcomes: { name: string; ok: boolean; output: string }[];
}> {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("promotion-project");
  if (!created.ok) throw new Error(created.error.message);
  const pending: PendingEvent[] = [];
  const flush = (): void => {
    for (const event of pending.splice(0)) {
      log.push({
        ...event,
        sessionId: SESSION_ID,
        turnId: TURN_ID,
        seq: log.length,
      } as StoredEvent);
    }
  };
  const ctx: ToolContext = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId: created.value.id,
    sandbox,
    emit: (event) => {
      pending.push(event);
    },
    readSessionEvents: async () => {
      flush();
      return log;
    },
    now: () => CREATED_AT,
  };
  const outcomes: { name: string; ok: boolean; output: string }[] = [];
  let callIndex = 0;
  for (const item of traffic) {
    callIndex += 1;
    const call: LLMToolCall = {
      id: `toolu_promo_${callIndex}`,
      name: item.name,
      input: item.input,
    };
    const outcome = await executeTool(call, ctx);
    outcomes.push({ name: item.name, ok: outcome.ok, output: outcome.output });
  }
  flush();
  return { log, outcomes };
}

function sceneEventCount(log: StoredEvent[], type: "scene.updated" | "scene.rejected"): number {
  return log.filter((event) => event.type === type).length;
}

describe("assembly promotion through propose_scene_patch", () => {
  let promoted: SceneSpec;
  let specHash: string;

  beforeEach(() => {
    promoted = promote(deskParts());
    specHash = hashSceneSpec(promoted);
  });

  it("promotes a valid assembly to a scene.updated event with a full-hash revision", async () => {
    const { log, outcomes } = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    expect(sceneEventCount(log, "scene.updated")).toBe(1);
    expect(sceneEventCount(log, "scene.rejected")).toBe(0);
    const updated = log.find((event) => event.type === "scene.updated");
    expect(updated?.type).toBe("scene.updated");
    if (updated?.type !== "scene.updated") return;
    // The full revision hash, not a display prefix — the same contract the
    // M6.1 suite pins for model-proposed scenes.
    expect(updated.payload.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updated.payload.specHash).toBe(specHash);
    expect(updated.payload.parentHash).toBe(null);
  });

  it("folds to a head that validates, builds, and carries the assembly", async () => {
    const { log } = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
    ]);

    const head = foldSceneSpec(sceneLogEvents(log));
    expect(head?.hash).toBe(specHash);
    if (head === null) return;
    expect(buildScene(head.spec).ok).toBe(true);
    expect(head.spec.nodes.map((node) => node.id).sort()).toEqual(
      ["desk-root", "leg-a", "leg-b", "top"].sort(),
    );
    expect(head.spec.materials.map((material) => material.id).sort()).toEqual(
      ["matte-black", "walnut"].sort(),
    );
  });

  it("refuses a second genesis against the promoted head", async () => {
    const { outcomes } = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
    ]);
    // A second genesis against a non-empty log is refused, never merged.
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
  });

  it("edits the promoted scene using the returned full hash", async () => {
    const genesis = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
    ]);
    expect(genesis.outcomes[0]?.ok).toBe(true);

    const edited = await runTraffic(
      [
        {
          name: "propose_scene_patch",
          input: {
            baseHash: specHash,
            ops: [{ op: "set_param", nodeId: "top", key: "width", value: 2.0 }],
            rationale: "Widen the tabletop.",
          },
        },
      ],
      genesis.log,
    );
    expect(edited.outcomes[0]?.ok).toBe(true);
    expect(sceneEventCount(edited.log, "scene.updated")).toBe(2);
    const head = foldSceneSpec(sceneLogEvents(edited.log));
    expect(head?.hash).not.toBe(specHash);
    const top = head?.spec.nodes.find((node) => node.id === "top");
    expect(top?.kind).toBe("procedural");
    if (top?.kind === "procedural" && top.op === "box") {
      expect(top.params.width).toBe(2.0);
    }
  });

  it("refuses a stale base without moving the head", async () => {
    const { log, outcomes } = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
      {
        name: "propose_scene_patch",
        input: {
          baseHash: "0".repeat(64),
          ops: [{ op: "set_param", nodeId: "top", key: "width", value: 2.0 }],
          rationale: "Widen the tabletop from a stale read.",
        },
      },
    ]);

    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    expect(sceneEventCount(log, "scene.updated")).toBe(1);
    expect(sceneEventCount(log, "scene.rejected")).toBe(1);
    expect(foldSceneSpec(sceneLogEvents(log))?.hash).toBe(specHash);
  });

  it("leaves no scene events behind a failed promotion", async () => {
    const { log, outcomes } = await runTraffic([
      {
        name: "propose_scene_patch",
        input: { spec: promoted, rationale: "Walnut desk top on legs." },
      },
    ]);
    expect(outcomes[0]?.ok).toBe(true);
    const updatesBefore = sceneEventCount(log, "scene.updated");

    // The promotion itself rejects before any tool call exists to emit from.
    const bad = deskParts();
    const first = bad[0];
    if (first !== undefined && first.op === "box") {
      first.params = { width: Number.NaN, height: 0.06, depth: 0.8 };
    }
    const rejected = promoteAssemblyToCreation({
      assemblyId: "desk",
      assemblyName: "Desk",
      components: bad,
      specId: SPEC_ID,
      seed: 11,
    });
    expect(rejected.ok).toBe(false);

    expect(sceneEventCount(log, "scene.updated")).toBe(updatesBefore);
    expect(sceneEventCount(log, "scene.rejected")).toBe(0);
    expect(foldSceneSpec(sceneLogEvents(log))?.hash).toBe(specHash);
  });

  it("still guards a tampered spec at the tool boundary", async () => {
    // Shape-valid (so it parses) but semantically broken: the top references
    // a material the spec does not define. This reaches validation — unlike a
    // malformed shape, which the tool refuses as invalid arguments with no
    // scene event at all — and is rejected with an event.
    const tampered = { ...promoted, materials: [] };
    const { log, outcomes } = await runTraffic([
      { name: "propose_scene_patch", input: { spec: tampered, rationale: "Tampered." } },
    ]);

    expect(outcomes[0]?.ok).toBe(false);
    expect(sceneEventCount(log, "scene.updated")).toBe(0);
    expect(sceneEventCount(log, "scene.rejected")).toBe(1);
    expect(foldSceneSpec(sceneLogEvents(log))).toBe(null);
  });
});
