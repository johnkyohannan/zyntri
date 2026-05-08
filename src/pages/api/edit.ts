/**
 * ZyntriStudio – /api/edit
 *
 * POST endpoint that accepts an EditRequest and runs the full pipeline.
 * Returns an EditResponse.
 *
 * Body size limit is set in next.config.js (10 MB).
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { runPipeline } from "../../lib/pipeline";
import type { EditRequest, EditResponse } from "../../types";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "20mb",
    },
  },
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<EditResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = req.body as Partial<EditRequest>;

  // Basic validation
  if (!body.instruction || typeof body.instruction !== "string") {
    return res.status(400).json({ error: "instruction is required" });
  }
  if (!body.baseImageB64 || typeof body.baseImageB64 !== "string") {
    return res.status(400).json({ error: "baseImageB64 is required" });
  }
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }

  const editRequest: EditRequest = {
    sessionId: body.sessionId,
    instruction: body.instruction.trim(),
    surfaceHint: body.surfaceHint ?? "auto",
    baseImageB64: body.baseImageB64,
    referenceImageB64: body.referenceImageB64,
    conversationHistory: body.conversationHistory ?? [],
  };

  try {
    const result = await runPipeline(editRequest);
    return res.status(200).json(result);
  } catch (err) {
    console.error("[api/edit] Unhandled error:", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
}
