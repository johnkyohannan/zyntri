/**
 * ZyntriStudio – /api/edit
 *
 * POST endpoint that accepts an EditRequest and runs the full pipeline.
 * Security: input validation, sanitization, and rate limiting applied here
 * before any data reaches the pipeline.
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { runPipeline } from "../../lib/pipeline";
import type { EditRequest, EditResponse } from "../../types";
import {
  sanitizeInstruction,
  sanitizeHistory,
  validateImageDataURL,
} from "../../lib/security";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

// ─── Simple in-memory rate limiter ───────────────────────────────────────────
// Limits each IP to 10 requests per minute. Resets on a rolling window.
// For a class project this is sufficient; production would use Redis.

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) return false;

  entry.count += 1;
  return true;
}

// Clean up stale entries every 5 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<EditResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
  }

  const body = req.body as Record<string, unknown>;

  // ── Validate and sanitize instruction ──────────────────────────────────────
  if (!body.instruction || typeof body.instruction !== "string") {
    return res.status(400).json({ error: "instruction is required" });
  }

  let instruction: string;
  try {
    instruction = sanitizeInstruction(body.instruction);
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid instruction",
    });
  }

  // ── Validate required fields ───────────────────────────────────────────────
  if (!body.baseImageB64 || typeof body.baseImageB64 !== "string") {
    return res.status(400).json({ error: "baseImageB64 is required" });
  }
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  // Validate sessionId is a reasonable UUID-like string (no injection)
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(body.sessionId)) {
    return res.status(400).json({ error: "Invalid sessionId format" });
  }

  // ── Validate images ────────────────────────────────────────────────────────
  try {
    validateImageDataURL(body.baseImageB64, "Design image");
    if (body.referenceImageB64 && typeof body.referenceImageB64 === "string") {
      validateImageDataURL(body.referenceImageB64, "Surface photo");
    }
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid image",
    });
  }

  // ── Validate surfaceHint ───────────────────────────────────────────────────
  const validSurfaces = ["auto", "shirt", "wall", "mug", "notebook", "poster", "cardboard_box", "field_grass"];
  const surfaceHint = validSurfaces.includes(body.surfaceHint as string)
    ? (body.surfaceHint as string)
    : "auto";

  // ── Sanitize conversation history ──────────────────────────────────────────
  const rawHistory = Array.isArray(body.conversationHistory)
    ? body.conversationHistory
    : [];
  const conversationHistory = sanitizeHistory(
    rawHistory as Array<{ role: string; content: string }>
  );

  const editRequest: EditRequest = {
    sessionId: body.sessionId,
    instruction,
    surfaceHint: surfaceHint as EditRequest["surfaceHint"],
    baseImageB64: body.baseImageB64,
    referenceImageB64:
      typeof body.referenceImageB64 === "string"
        ? body.referenceImageB64
        : undefined,
    conversationHistory: conversationHistory as EditRequest["conversationHistory"],
  };

  try {
    const result = await runPipeline(editRequest);
    return res.status(200).json(result);
  } catch (err) {
    // Don't leak internal error details to the client
    console.error("[api/edit] Unhandled error:", err);
    return res.status(500).json({ error: "An error occurred processing your request." });
  }
}
