/**
 * ZyntriStudio – Pipeline Step 2: LLM Edit Plan Generation
 *
 * Given the interpretation result and the user's instruction, the LLM
 * produces a structured EditPlan that guides the image-compositing step.
 */

import OpenAI from "openai";
import { getOpenAIClient } from "../openai";
import type { EditPlan, InterpretationResult, SurfaceCategory, ChatMessage } from "../../types";

const SYSTEM_PROMPT = `You are ZyntriStudio's edit planner.
Given a surface type, a user instruction, and optional design image context,
produce a precise JSON edit plan for the compositing engine.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "targetSurface": "<surface>",
  "editType": "texture_overlay" | "pattern_apply" | "color_restyle" | "artwork_transfer",
  "blendMode": "normal" | "multiply" | "overlay" | "soft_light",
  "opacity": 0.0–1.0,
  "preserveShading": true | false,
  "perspectiveAware": true | false,
  "colorAdjustment": "<description> | null",
  "additionalNotes": "<brief notes for the compositor>",
  "estimatedDifficulty": "easy" | "medium" | "hard",
  "warningFlags": ["<flag>", ...]
}

Guidelines:
- blendMode "multiply" works well for dark patterns on light surfaces.
- blendMode "overlay" works well for textures that should respect surface shading.
- blendMode "soft_light" is good for subtle color shifts.
- opacity 0.7–0.9 is typical; lower for subtle effects.
- preserveShading: true when the surface has visible folds, curves, or shadows.
- perspectiveAware: true for flat surfaces like walls, posters, boxes.
- warningFlags: list any concerns (e.g., "surface partially occluded", "low contrast reference").
Do NOT include any text outside the JSON object.`;

export async function generateEditPlan(
  interpretation: InterpretationResult,
  instruction: string,
  surfaceHint: SurfaceCategory,
  designImageB64?: string,
  history: ChatMessage[] = []
): Promise<EditPlan> {
  const client = getOpenAIClient();

  const targetSurface = interpretation.primarySurface ?? surfaceHint;
  const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [];

  if (designImageB64) {
    contentParts.push({
      type: "image_url",
      image_url: { url: designImageB64, detail: "low" },
    });
  }

  contentParts.push({
    type: "text",
    text: `Target surface: ${targetSurface}
User instruction: "${instruction}"
Detected surfaces: ${interpretation.detectedSurfaces.join(", ") || "none"}
Confidence: ${interpretation.confidence}
${designImageB64 ? "Design/pattern image provided (see above) — this is what gets applied to the surface." : "No design image."}
${history.length > 0 ? `This is a refinement turn. Previous conversation context:\n${history.slice(-3).map(m => `${m.role}: ${m.content}`).join("\n")}` : ""}`,
  });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 512,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: contentParts },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as EditPlan;
    parsed.warningFlags = parsed.warningFlags ?? [];
    return parsed;
  } catch {
    return {
      targetSurface: targetSurface as SurfaceCategory,
      editType: "texture_overlay",
      blendMode: "overlay",
      opacity: 0.8,
      preserveShading: true,
      perspectiveAware: false,
      colorAdjustment: null,
      additionalNotes: "Fallback plan – JSON parse failed.",
      estimatedDifficulty: "medium",
      warningFlags: ["plan_parse_error"],
    };
  }
}
