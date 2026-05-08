/**
 * ZyntriStudio – Pipeline Step 6: Conversational Response Generation
 *
 * Generates a natural-language assistant message summarising what was done,
 * what issues were found, and what the user can try next.
 *
 * This step makes the app feel like a real conversational assistant rather
 * than a one-shot API wrapper.  It uses the full pipeline context to craft
 * a contextually appropriate reply.
 */

import { getOpenAIClient } from "../openai";
import type {
  InterpretationResult,
  EditPlan,
  QualityCheckResult,
  ChatMessage,
} from "../../types";

const SYSTEM_PROMPT = `You are ZyntriStudio, a friendly conversational surface-restyling assistant.
Your job is to write a short, helpful assistant message (2–4 sentences) that:
1. Confirms what you understood the user wanted.
2. Briefly describes what was done (or why it couldn't be done).
3. Mentions any quality issues or warnings if relevant.
4. Suggests a follow-up refinement the user could try.

Keep the tone warm, concise, and professional.
Do NOT use bullet points or headers – write in plain prose.
Do NOT mention internal pipeline steps or JSON structures.`;

export async function generateAssistantMessage(
  instruction: string,
  interpretation: InterpretationResult,
  plan: EditPlan | null,
  qualityCheck: QualityCheckResult | null,
  history: ChatMessage[],
  clarificationNeeded: boolean
): Promise<string> {
  const client = getOpenAIClient();

  const context = [
    `User instruction: "${instruction}"`,
    `Detected surface: ${interpretation.primarySurface ?? "none"}`,
    `Confidence: ${Math.round(interpretation.confidence * 100)}%`,
    plan ? `Edit applied: ${plan.editType} on ${plan.targetSurface}` : "No edit was applied.",
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
