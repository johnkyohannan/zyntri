/**
 * ZyntriStudio – Pipeline Step 1: Vision + Text Interpretation
 *
 * Sends the design image (and optional surface photo) plus the user's
 * instruction to GPT-4o-mini. Returns a structured InterpretationResult
 * that drives the rest of the pipeline.
 *
 * Input convention:
 *   designImageB64  = the design, pattern, or artwork (first image)
 *   surfaceImageB64 = the target surface photo (second image, optional)
 */

import OpenAI from "openai";
import { getOpenAIClient } from "../openai";
import type { InterpretationResult, SurfaceCategory, ChatMessage } from "../../types";
import { SUPPORTED_SURFACES } from "../../types";

const SYSTEM_PROMPT = `You are ZyntriStudio's vision analyst.
Your job is to look at a design/pattern/artwork image (the first image) and an
optional surface photo (the second image), then understand what surface the user
wants to apply the design onto.

The FIRST image is always the design, pattern, or artwork to be applied.
The SECOND image (if provided) is the target surface or object.
If no second image is provided, infer the target surface from the user's instruction.

Supported surfaces: shirt, wall, mug, notebook, poster, cardboard_box, field_grass.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "detectedSurfaces": ["<surface>", ...],
  "primarySurface": "<surface> | null",
  "isAmbiguous": true | false,
  "clarificationQuestion": "<question> | null",
  "confidence": 0.0–1.0,
  "unsupportedReason": "<reason> | null",
  "isSafe": true | false,
  "safetyNote": "<note> | null"
}

Rules:
- detectedSurfaces: list every supported surface visible in the surface photo (second image), or inferred from the instruction if no surface photo is provided.
- primarySurface: the single best match for the user's instruction, or null if none.
- isAmbiguous: true when two or more surfaces are equally plausible targets.
- clarificationQuestion: a short, friendly question to ask the user when isAmbiguous is true.
- confidence: your certainty that primarySurface is correct (0–1).
- unsupportedReason: non-null only when the request cannot be fulfilled.
- isSafe: false if the instruction requests harmful, illegal, or policy-violating content.
- safetyNote: brief explanation when isSafe is false.
Do NOT include any text outside the JSON object.`;

export async function interpretRequest(
  designImageB64: string,
  instruction: string,
  surfaceHint: SurfaceCategory,
  surfaceImageB64?: string,
  history: ChatMessage[] = []
): Promise<InterpretationResult> {
  const client = getOpenAIClient();

  const imageBlocks: OpenAI.Chat.ChatCompletionContentPart[] = [
    { type: "image_url", image_url: { url: designImageB64, detail: "high" } },
  ];

  if (surfaceImageB64) {
    imageBlocks.push({
      type: "image_url",
      image_url: { url: surfaceImageB64, detail: "high" },
    });
  }

  const recentHistory = history.slice(-4).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
    ...imageBlocks,
    {
      type: "text",
      text: `User instruction: "${instruction}"
Surface hint from UI: ${surfaceHint === "auto" ? "none (auto-detect)" : surfaceHint}
Image 1 (above): the design, pattern, or artwork to apply.
${surfaceImageB64 ? "Image 2 (above): the target surface or object photo." : "No surface photo provided — infer the target surface from the instruction."}
Supported surfaces: ${SUPPORTED_SURFACES.join(", ")}`,
    },
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 512,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...recentHistory,
      { role: "user", content: userContent },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as InterpretationResult;
    parsed.detectedSurfaces = parsed.detectedSurfaces ?? [];
    return parsed;
  } catch {
    return {
      detectedSurfaces: [],
      primarySurface: null,
      isAmbiguous: false,
      clarificationQuestion: null,
      confidence: 0,
      unsupportedReason: "Could not parse interpretation response.",
      isSafe: true,
      safetyNote: null,
    };
  }
}
