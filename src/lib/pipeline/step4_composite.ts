/**
 * ZyntriStudio – Pipeline Step 4: Image Editing / Compositing
 *
 * Strategy (OpenAI-only, no extra keys):
 *   We use GPT-4o's image generation capability via the DALL-E 3 / GPT-image-1
 *   edit endpoint when a mask can be derived, or we fall back to a
 *   prompt-driven generation approach using the edit plan.
 *
 *   For the MVP we use the openai.images.generate endpoint with a carefully
 *   constructed prompt derived from the edit plan.  This is honest about the
 *   approach and produces visually compelling results for the supported surfaces.
 *
 *   A sharp-based compositing fallback is also included for cases where the
 *   reference image should be directly overlaid (e.g., poster swap).
 */

import OpenAI from "openai";
import sharp from "sharp";
import { getOpenAIClient } from "../openai";
import type { EditPlan } from "../../types";

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildGenerationPrompt(
  plan: EditPlan,
  instruction: string,
  hasReference: boolean
): string {
  const surfaceDescriptions: Record<string, string> = {
    shirt: "a t-shirt worn by a person",
    wall: "a flat interior wall",
    mug: "a ceramic coffee mug",
    notebook: "a closed notebook or journal",
    poster: "a framed poster on a wall",
    cardboard_box: "a plain cardboard shipping box",
    field_grass: "an open grass field or lawn",
  };

  const surfaceDesc = surfaceDescriptions[plan.targetSurface] ?? plan.targetSurface;

  const blendDesc: Record<string, string> = {
    multiply: "with the pattern darkening the surface naturally",
    overlay: "blended realistically with the surface texture and shading",
    soft_light: "subtly integrated, preserving the original surface feel",
    normal: "applied directly onto the surface",
  };

  const blendNote = blendDesc[plan.blendMode] ?? "applied to the surface";

  return [
    `A photorealistic image of ${surfaceDesc}.`,
    `The surface has been restyled: ${instruction}.`,
    hasReference
      ? `The design from the reference image is applied ${blendNote}.`
      : `The requested style is applied ${blendNote}.`,
    plan.preserveShading
      ? "The original folds, shadows, and lighting of the surface are preserved."
      : "",
    plan.colorAdjustment ? `Color adjustment: ${plan.colorAdjustment}.` : "",
    "The rest of the scene is unchanged.",
    "High quality, studio lighting, sharp details.",
    "This is a visual mockup for design preview purposes.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ─── Sharp-based overlay (used when reference image is provided) ──────────────

async function sharpOverlay(
  baseB64: string,
  referenceB64: string,
  plan: EditPlan
): Promise<string> {
  // Strip data URL prefix
  const baseBuffer = Buffer.from(baseB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const refBuffer = Buffer.from(referenceB64.replace(/^data:image\/\w+;base64,/, ""), "base64");

  const baseMeta = await sharp(baseBuffer).metadata();
  const baseWidth = baseMeta.width ?? 512;
  const baseHeight = baseMeta.height ?? 512;

  // Resize reference to match base dimensions
  const resizedRef = await sharp(refBuffer)
    .resize(baseWidth, baseHeight, { fit: "cover" })
    .toBuffer();

  // Apply opacity by creating a semi-transparent version of the reference.
  // sharp's composite does not accept an opacity parameter directly;
  // we bake the opacity into the alpha channel instead.
  const opacityInt = Math.round(plan.opacity * 255);

  const refWithAlpha = await sharp(resizedRef)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      // Multiply every alpha byte by the desired opacity
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round((data[i] / 255) * opacityInt);
      }
      return sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      })
        .png()
        .toBuffer();
    });

  const blendMode = plan.blendMode === "multiply"
    ? "multiply"
    : plan.blendMode === "overlay"
    ? "overlay"
    : plan.blendMode === "soft_light"
    ? "soft-light"
    : "over";

  // Composite: base image + reference overlay
  const composited = await sharp(baseBuffer)
    .composite([
      {
        input: refWithAlpha,
        blend: blendMode as import("sharp").Blend,
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return `data:image/jpeg;base64,${composited.toString("base64")}`;
}

// ─── Main composite function ──────────────────────────────────────────────────

export async function executeEdit(
  baseImageB64: string,
  plan: EditPlan,
  instruction: string,
  referenceImageB64?: string
): Promise<string> {
  const client = getOpenAIClient();

  // If we have a reference image, try sharp compositing first (fast, no extra API cost)
  if (referenceImageB64) {
    try {
      const composited = await sharpOverlay(baseImageB64, referenceImageB64, plan);
      return composited;
    } catch (err) {
      console.warn("[step4] Sharp compositing failed, falling back to generation:", err);
    }
  }

  // Fall back to DALL-E 3 generation
  const prompt = buildGenerationPrompt(plan, instruction, !!referenceImageB64);

  const response = await client.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    response_format: "b64_json",
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) {
    throw new Error("No image returned from DALL-E 3.");
  }

  return `data:image/png;base64,${b64}`;
}
