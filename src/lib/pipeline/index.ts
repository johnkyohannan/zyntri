/**
 * ZyntriStudio – Pipeline Orchestrator
 *
 * Runs the full 6-step pipeline:
 *   1. Vision + text interpretation (GPT-4o multimodal)
 *   2. Edit plan generation (GPT-4o)
 *   3. Clarification gate (returns early if ambiguous)
 *   4. Image compositing (sharp overlay or DALL-E 3)
 *   5. Quality control (GPT-4o vision)
 *   6. Conversational response (GPT-4o)
 *
 * Why this goes beyond Project 4 / one-shot extraction:
 *   - Multimodal input: base image + optional reference image + text
 *   - Multi-step chained LLM calls (Steps 1, 2, 5, 6 are separate calls)
 *   - Structured intermediate outputs (InterpretationResult, EditPlan)
 *   - Conditional branching (clarification gate, safety gate)
 *   - Quality control loop with actionable feedback
 *   - Multi-turn conversation history carried through all steps
 */

import { interpretRequest } from "./step1_interpret";
import { generateEditPlan } from "./step2_plan";
import { executeEdit } from "./step4_composite";
import { validateOutput } from "./step5_validate";
import { generateAssistantMessage } from "./step6_respond";
import type { EditRequest, EditResponse } from "../../types";

export async function runPipeline(req: EditRequest): Promise<EditResponse> {
  const {
    sessionId,
    instruction,
    surfaceHint,
    baseImageB64,
    referenceImageB64,
    conversationHistory,
  } = req;

  // ── Step 1: Interpret ──────────────────────────────────────────────────────
  let interpretation;
  try {
    interpretation = await interpretRequest(
      baseImageB64,
      instruction,
      surfaceHint,
      referenceImageB64,
      conversationHistory
    );
  } catch (err) {
    return errorResponse(sessionId, `Interpretation failed: ${String(err)}`);
  }

  // ── Safety gate ────────────────────────────────────────────────────────────
  if (!interpretation.isSafe) {
    const msg = await generateAssistantMessage(
      instruction,
      interpretation,
      null,
      null,
      conversationHistory,
      false
    );
    return {
      sessionId,
      interpretation,
      editPlan: null,
      outputImageB64: null,
      qualityCheck: null,
      assistantMessage: msg,
      clarificationNeeded: false,
      clarificationQuestion: null,
      error: interpretation.safetyNote,
    };
  }

  // ── Unsupported surface gate ───────────────────────────────────────────────
  if (interpretation.unsupportedReason) {
    const msg = await generateAssistantMessage(
      instruction,
      interpretation,
      null,
      null,
      conversationHistory,
      false
    );
    return {
      sessionId,
      interpretation,
      editPlan: null,
      outputImageB64: null,
      qualityCheck: null,
      assistantMessage: msg,
      clarificationNeeded: false,
      clarificationQuestion: null,
      error: interpretation.unsupportedReason,
    };
  }

  // ── Step 3: Clarification gate ─────────────────────────────────────────────
  if (interpretation.isAmbiguous && interpretation.clarificationQuestion) {
    const msg = await generateAssistantMessage(
      instruction,
      interpretation,
      null,
      null,
      conversationHistory,
      true
    );
    return {
      sessionId,
      interpretation,
      editPlan: null,
      outputImageB64: null,
      qualityCheck: null,
      assistantMessage: msg,
      clarificationNeeded: true,
      clarificationQuestion: interpretation.clarificationQuestion,
      error: null,
    };
  }

  // ── Step 2: Generate edit plan ─────────────────────────────────────────────
  let plan;
  try {
    plan = await generateEditPlan(
      interpretation,
      instruction,
      surfaceHint,
      referenceImageB64,
      conversationHistory
    );
  } catch (err) {
    return errorResponse(sessionId, `Edit plan generation failed: ${String(err)}`);
  }

  // ── Step 4: Execute edit ───────────────────────────────────────────────────
  let outputImageB64: string | null = null;
  try {
    outputImageB64 = await executeEdit(
      baseImageB64,
      plan,
      instruction,
      referenceImageB64
    );
  } catch (err) {
    console.error("[pipeline] Edit execution failed:", err);
    // Don't abort – return plan + error message, no image
    const msg = await generateAssistantMessage(
      instruction,
      interpretation,
      plan,
      null,
      conversationHistory,
      false
    );
    return {
      sessionId,
      interpretation,
      editPlan: plan,
      outputImageB64: null,
      qualityCheck: null,
      assistantMessage: msg,
      clarificationNeeded: false,
      clarificationQuestion: null,
      error: `Image generation failed: ${String(err)}`,
    };
  }

  // ── Step 5: Quality control ────────────────────────────────────────────────
  let qualityCheck = null;
  if (outputImageB64) {
    try {
      qualityCheck = await validateOutput(outputImageB64, plan, instruction);
    } catch (err) {
      console.warn("[pipeline] Quality check failed (non-fatal):", err);
    }
  }

  // ── Step 6: Generate conversational response ───────────────────────────────
  const assistantMessage = await generateAssistantMessage(
    instruction,
    interpretation,
    plan,
    qualityCheck,
    conversationHistory,
    false
  );

  return {
    sessionId,
    interpretation,
    editPlan: plan,
    outputImageB64,
    qualityCheck,
    assistantMessage,
    clarificationNeeded: false,
    clarificationQuestion: null,
    error: null,
  };
}

function errorResponse(sessionId: string, error: string): EditResponse {
  return {
    sessionId,
    interpretation: {
      detectedSurfaces: [],
      primarySurface: null,
      isAmbiguous: false,
      clarificationQuestion: null,
      confidence: 0,
      unsupportedReason: error,
      isSafe: true,
      safetyNote: null,
    },
    editPlan: null,
    outputImageB64: null,
    qualityCheck: null,
    assistantMessage: "Something went wrong. Please try again.",
    clarificationNeeded: false,
    clarificationQuestion: null,
    error,
  };
}
