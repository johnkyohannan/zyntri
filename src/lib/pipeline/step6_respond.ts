/**
 * ZyntriStudio – Pipeline Step 6: Conversational Response Generation
 *
 * Generates a natural-language assistant message explaining what was done
 * to make the mockup look realistic, using the mockupSteps list as context.
 */

import { getOpenAIClient } from "../openai";
import type {
  InterpretationResult,
  EditPlan,
  QualityCheckResult,
  ChatMessage,
} from "../../types";

const SYSTEM_PROMPT = `You are ZyntriStudio, a friendly conversational mockup assistant.
Your job is to write a short, helpful assistant message (3–5 sentences) that:
1. Confirms what the user wanted and what surface was targeted.
2. Explains in plain language what was done to make the mockup look realistic
   (e.g. how the design was scaled, what shadows were added, how it was blended
   with the surface texture). Use the mockupSteps list as your source of truth.
3. Mentions any quality issues or warnings if relevant.
4. Suggests a follow-up refinement the user could try.

Keep the tone warm, concise, and professional.
Do NOT use bullet points or headers — write in plain prose.
Do NOT mention internal pipeline steps, JSON structures, or technical variable names.
Speak as if you are a designer explaining your work to a client.`;

export async function generateAssistantMessage(
  instruction: string,
  interpretation: InterpretationResult,
  plan: EditPlan | null,
  qualityCheck: QualityCheckResult | null,
  history: ChatMessage[],
  clarificationNeeded: boolean,
  mockupSteps: string[] = []
): Promise<string> {
  const client = getOpenAIClient();

  const context = [
    `User instruction: "${instruction}"`,
    `Detected surface: ${interpretation.primarySurface ?? "none"}`,
    `Confidence: ${Math.round(interpretation.confidence * 100)}%`,
    plan ? `Edit applied: ${plan.editType} on ${plan.targetSurface}` : "No edit was applied.",
    mockupSteps.length > 0
      ? `Mockup steps performed:\n${mockupSteps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
      : "",
    qualityCheck
      ? `Quality score: ${Math.round(qualityCheck.score * 100)}% – ${qualityCheck.summary}`
      : "",
    qualityCheck?.issues?.length
      ? `Issues: ${qualityCheck.issues.join("; ")}`
      : "",
    qualityCheck?.suggestions?.length
      ? `Suggestions: ${qualityCheck.suggestions.join("; ")}`
      : "",
    clarificationNeeded
      ? `Clarification needed: ${interpretation.clarificationQuestion}`
      : "",
    interpretation.unsupportedReason
      ? `Unsupported: ${interpretation.unsupportedReason}`
      : "",
    !interpretation.isSafe
      ? `Safety note: ${interpretation.safetyNote}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const recentHistory = history.slice(-4).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 256,
    temperature: 0.7,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...recentHistory,
      { role: "user", content: context },
    ],
  });

  return (
    response.choices[0]?.message?.content?.trim() ??
    "I processed your request. Let me know if you'd like any adjustments."
  );
}
