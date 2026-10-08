/**
 * The desk workflow end to end: a typed plan becomes a canonical scene
 * through `propose_desk`, and follow-up edits move through the same tool and
 * the ordinary patch machinery.
 *
 * Traffic is authored in the exact shape a model turn emits — the
 * `cases.test.ts` pattern — with a scripted caller standing in for the model.
 * What the model would decide (which parameters from which sentence) is not
 * asserted here; that is a live-model question. What is asserted is that once
 * parameters arrive, deterministic code builds, validates, emits, folds, and
 * rebuilds them with nothing hand-computed in between.
 */

import { buildScene } from "@nap/procedural/build";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { foldSceneSpec } from "@nap/scene-spec/fold";
import { hashSceneSpec } from "@nap/scene-spec/revisions";
import { sceneLogEvents } from "@nap/scene-spec/scene-events";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { executeTool, type ToolContext } from "./execute.ts";

const SESSION_ID = "9b4c5d6e-7f80-91a2-b3c4-d5e6f7081920";
const TURN_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const CREATED_AT = "2026-10-07T00:00:00.000Z";

const WALNUT_DESK = {
  plan: {
    topWidth: 1.6,
    topDepth: 0.8,
    topMaterial: { material: "walnut" },
    legMaterial: { material: "matte_black" },
  },
  rationale: "A walnut desk with black legs.",
};

async function runTraffic(
  traffic: { name: string; input: Record<string, unknown> }[],
  log: StoredEvent[] = [],
): Promise<{
  log: StoredEvent[];
  outcomes: { name: string; ok: boolean; output: string }[];
}> {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("desk-project");
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
    const call: LLMToolCall = { id: `toolu_desk_${callIndex}`, name: item.name, input: item.input };
    const outcome = await executeTool(call, ctx);
    outcomes.push({ name: item.name, ok: outcome.ok, output: outcome.output });
  }
  flush();
  return { log, outcomes };
}

function sceneEventCount(log: StoredEvent[], type: "scene.updated" | "scene.rejected"): number {
  return log.filter((event) => event.type === type).length;
}

describe("propose_desk end to end", () => {
  it("builds a validated desk from a typed plan through the real tool", async () => {
    const { log, outcomes } = await runTraffic([
      { name: "propose_desk", input: { ...WALNUT_DESK } },
    ]);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[0]?.output).toContain("168 triangles");
    expect(sceneEventCount(log, "scene.updated")).toBe(1);
    expect(sceneEventCount(log, "scene.rejected")).toBe(0);
    const head = foldSceneSpec(sceneLogEvents(log));
    expect(head).not.toBe(null);
    if (head === null) return;
    expect(head.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(head.hash).toBe(hashSceneSpec(head.spec));
    expect(buildScene(head.spec).ok).toBe(true);
    expect(head.spec.nodes).toHaveLength(12);
    const top = head.spec.nodes.find((node) => node.id === "desk-top");
    expect(top?.kind).toBe("procedural");
  });

  it("rejects an invalid plan with a rejection event and no revision", async () => {
    // Schema-valid (so it parses) but unbuildable: no legs fit under a
    // 10 cm top. This reaches validation — unlike a malformed shape, which
    // the tool refuses as invalid arguments with no scene event at all.
    const { log, outcomes } = await runTraffic([
      {
        name: "propose_desk",
        input: { plan: { topWidth: 0.1, topDepth: 0.8 }, rationale: "A broken desk." },
      },
    ]);

    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.output).toMatch(/fit/);
    expect(sceneEventCount(log, "scene.updated")).toBe(0);
    expect(sceneEventCount(log, "scene.rejected")).toBe(1);
    expect(foldSceneSpec(sceneLogEvents(log))).toBe(null);
  });

  it("widens the desk coherently through a follow-up edit", async () => {
    const genesis = await runTraffic([{ name: "propose_desk", input: { ...WALNUT_DESK } }]);
    expect(genesis.outcomes[0]?.ok).toBe(true);
    const hash = foldSceneSpec(sceneLogEvents(genesis.log))?.hash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    if (hash === undefined) return;

    const edited = await runTraffic(
      [
        {
          name: "propose_desk",
          input: {
            baseHash: hash,
            changes: { topWidth: 2.0 },
            rationale: "Make the desk wider.",
          },
        },
      ],
      genesis.log,
    );
    expect(edited.outcomes[0]?.ok).toBe(true);
    expect(sceneEventCount(edited.log, "scene.updated")).toBe(2);
    const head = foldSceneSpec(sceneLogEvents(edited.log));
    expect(head?.hash).not.toBe(hash);
    if (head === null) return;
    // Dependents followed: legs moved outward and aprons lengthened, and the
    // part count did not change.
    expect(buildScene(head.spec).ok).toBe(true);
    const top = head.spec.nodes.find((node) => node.id === "desk-top");
    expect(top?.kind).toBe("procedural");
    if (top?.kind === "procedural" && top.op === "box") {
      expect(top.params.width).toBe(2.0);
    }
    const leg = head.spec.nodes.find((node) => node.id === "desk-leg-front-left");
    expect(leg?.kind).toBe("procedural");
    if (leg?.kind === "procedural") {
      expect(leg.transform.position[0]).toBeCloseTo(-0.94, 9);
    }
    const apron = head.spec.nodes.find((node) => node.id === "desk-apron-front");
    expect(apron?.kind).toBe("procedural");
    if (apron?.kind === "procedural" && apron.op === "box") {
      expect(apron.params.width).toBeCloseTo(1.82, 9);
    }
    expect(head.spec.nodes).toHaveLength(12);
  });

  it("swaps leg material without touching unrelated geometry", async () => {
    const genesis = await runTraffic([{ name: "propose_desk", input: { ...WALNUT_DESK } }]);
    const hash = foldSceneSpec(sceneLogEvents(genesis.log))?.hash;
    if (hash === undefined) throw new Error("genesis failed");

    const edited = await runTraffic(
      [
        {
          name: "propose_desk",
          input: {
            baseHash: hash,
            changes: { legMaterial: { material: "walnut" } },
            rationale: "Match the legs to the top.",
          },
        },
      ],
      genesis.log,
    );
    expect(edited.outcomes[0]?.ok).toBe(true);
    const head = foldSceneSpec(sceneLogEvents(edited.log));
    if (head === null) throw new Error("edit left no head");
    const legs = head.spec.nodes.filter((node) => node.id.startsWith("desk-leg-"));
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      if (leg.kind === "procedural") expect(leg.materialId).toBe("walnut");
    }
    const top = head.spec.nodes.find((node) => node.id === "desk-top");
    if (top?.kind === "procedural" && top.op === "box") {
      expect(top.params.width).toBe(1.6);
    }
  });

  it("refuses an absent material by naming what is available", async () => {
    const genesis = await runTraffic([{ name: "propose_desk", input: { ...WALNUT_DESK } }]);
    const hash = foldSceneSpec(sceneLogEvents(genesis.log))?.hash;
    if (hash === undefined) throw new Error("genesis failed");

    const edited = await runTraffic(
      [
        {
          name: "propose_desk",
          input: {
            baseHash: hash,
            changes: { topMaterial: { material: "oak" } },
            rationale: "An oak top.",
          },
        },
      ],
      genesis.log,
    );
    expect(edited.outcomes[0]?.ok).toBe(false);
    expect(edited.outcomes[0]?.output).toMatch(/oak/);
    expect(sceneEventCount(edited.log, "scene.updated")).toBe(1);
    expect(foldSceneSpec(sceneLogEvents(edited.log))?.hash).toBe(hash);
  });

  it("keeps stale-base behavior unchanged on desk edits", async () => {
    const genesis = await runTraffic([{ name: "propose_desk", input: { ...WALNUT_DESK } }]);
    expect(genesis.outcomes[0]?.ok).toBe(true);

    const edited = await runTraffic(
      [
        {
          name: "propose_desk",
          input: {
            baseHash: "0".repeat(64),
            changes: { topWidth: 2.0 },
            rationale: "Stale widen.",
          },
        },
      ],
      genesis.log,
    );
    expect(edited.outcomes[0]?.ok).toBe(false);
    expect(edited.outcomes[0]?.output).toMatch(/stale base/);
    expect(sceneEventCount(edited.log, "scene.updated")).toBe(1);
  });
});
