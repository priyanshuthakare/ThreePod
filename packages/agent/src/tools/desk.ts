/**
 * The desk builder tool's arguments: a creation plan or a baseHash plus
 * changes, each with the model's rationale.
 *
 * Schemas live here, construction lives in `@nap/procedural/desk`, and the
 * split is load-bearing: this package describes what the model may ask for
 * (and its JSON Schema derives from these definitions, so wording here is
 * what the model actually reads), while validated numbers, placement, and
 * geometry stay in the deterministic engine. Field names match the
 * procedural `DeskPlan` exactly so the handler passes arguments straight
 * through with no translation layer to drift.
 *
 * Two strict variants like `propose_scene_patch`: a creation carries a plan
 * and no baseHash, an edit carries a baseHash and changes. A shape carrying
 * both (or neither) matches nothing.
 */

import { HashHexSchema } from "@nap/scene-spec/proposal";
import { z } from "zod";

const DeskMaterialSchema = z.strictObject({
  material: z
    .enum(["walnut", "oak", "maple", "matte_black"])
    .describe("Wood for tops and aprons: walnut, oak, or maple. Legs also admit matte_black."),
  finish: z
    .enum(["matte", "satin", "polished"])
    .optional()
    .describe(
      "Surface finish. Omit for the material default; not every finish suits every material.",
    ),
});

const DeskPlanSchema = z.strictObject({
  topWidth: z.number().positive().describe("Tabletop width in meters."),
  topDepth: z.number().positive().describe("Tabletop depth in meters."),
  height: z
    .number()
    .positive()
    .optional()
    .describe("Floor-to-top height in meters. Defaults to 0.78."),
  topThickness: z.number().positive().optional().describe("Tabletop thickness in meters."),
  legWidth: z.number().positive().optional().describe("Leg footprint width in meters."),
  legDepth: z.number().positive().optional().describe("Leg footprint depth in meters."),
  inset: z
    .number()
    .min(0)
    .optional()
    .describe("Leg inset from the tabletop edges in meters. Defaults to 0.03."),
  apronHeight: z.number().positive().optional().describe("Apron rail height in meters."),
  apronThickness: z.number().positive().optional().describe("Apron rail thickness in meters."),
  bevel: z.number().min(0).optional().describe("Tabletop edge bevel radius in meters."),
  topMaterial: DeskMaterialSchema.optional().describe(
    "Top and apron material. Defaults to walnut.",
  ),
  legMaterial: DeskMaterialSchema.optional().describe("Leg material. Defaults to matte black."),
});

const DeskChangesSchema = z.strictObject({
  topWidth: z
    .number()
    .positive()
    .optional()
    .describe("New tabletop width in meters; legs and aprons follow."),
  topDepth: z
    .number()
    .positive()
    .optional()
    .describe("New tabletop depth in meters; legs and aprons follow."),
  height: z.number().positive().optional().describe("New floor-to-top height in meters."),
  topMaterial: DeskMaterialSchema.optional().describe(
    "New top and apron material. Must already exist in the scene — the tool names what is available.",
  ),
  legMaterial: DeskMaterialSchema.optional().describe(
    "New leg material. Must already exist in the scene — the tool names what is available.",
  ),
});

const rationale = z
  .string()
  .min(1)
  .max(500)
  .describe("What this desk build or change does and why, in one or two sentences.");

export const ProposeDeskSchema = z.union([
  z.strictObject({ plan: DeskPlanSchema, rationale }),
  z.strictObject({ baseHash: HashHexSchema, changes: DeskChangesSchema, rationale }),
]);
export type ProposeDesk = z.infer<typeof ProposeDeskSchema>;
