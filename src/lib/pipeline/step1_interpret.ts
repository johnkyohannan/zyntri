/**
 * ZyntriStudio – Pipeline Step 1: Vision + Text Interpretation
 *
 * Sends the base image (and optional reference image) plus the user's
 * instruction to GPT-4o.  Returns a structured InterpretationResult that
 * drives the rest of the pipeline.
 *
 * Why this goes beyond one-shot extraction:
 *   - It reasons about multiple possible surfaces and picks the most likely.
 *   - It flags ambiguity and generates a clarification question when needed.
 *   - It performs a safety check before any editing begins.
 *   - Its output feeds Steps 2–5, making it part of a chained pipeline.
 */

import { getOpenAIClient } from "../openai";
import type {
  InterpretationResult,
  SurfaceCategory,
  ChatMessage,
} from "../../types";
import { SUPPORTED_SURFACES } from "../../types";

const SYSTEM_PROMPT = `You are ZyntriStudio's vision analyst.
Your job is to look at a base photo (and an optional reference image) and
understand what surface the user wants to restyle.

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
- detectedSurfaces: list every supported surface visible in the image.
- primarySurface: the single best match for the user's instruction, or null if none.
- isAmbiguous: true when two or more surfaces are equally plausible targets.
- clarificationQuestion: a short, friendly question to ask the user when isAmbiguous is true.
- confidence: your certainty that primarySurface is correct (0–1).
- unsupportedReason: non-null only when the request cannot be fulfilled (unsupported surface, no clear target, etc.).
- isSafe: false if the instruction requests harmful, illegal, or policy-violating content.
- safetyNote: brief explanation when isSafe is false.
Do NOT include any text outside the JSON object.`;

export async function interpretRequest(
  baseImageB64: string,
  instruction: string,
  surfaceHint: SurfaceCategory,
  referenceImageB64?: string,
  history: ChatMessage[] = []
): Promise<InterpretationResult> {
  const client = getOpenAIClient();

  // Build the image content blocks
  const imageBlocks: OpenAI.Chat.ChatCompletionContentPart[] = [
    {
      type: "image_url",
      image_url: { url: baseImageB64, detail: "high" },
    },
  ];

  if (referenceImageB64) {
    imageBlocks.push({
      type: "image_url",
      image_url: { url: referenceImageB64, detail: "high" },
    });
  }

  // Include recent conversation context (last 4 turns)
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
${referenceImageB64 ? "A reference image has been provided (second image above)." : "No reference image provided."}
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

  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as InterpretationResult;
    // Normalise: ensure arrays exist
    parsed.detectedSurfaces = parsed.detectedSurfaces ?? [];
    return parsed;
  } catch {
    // Fallback if JSON is malformed
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

// Need OpenAI namespace for type usage above
import OpenAI from "openai";
