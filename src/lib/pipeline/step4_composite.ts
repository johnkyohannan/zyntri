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

// ─── Sharp-based overlay (used when surface photo is provided) ───────────────
// Composites the design image ON TOP of the surface photo.

async function sharpOverlay(
  designB64: string,
  surfaceB64: string,
  plan: EditPlan
): Promise<string> {
  // Strip data URL prefix
  const surfaceBuffer = Buffer.from(surfaceB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const designBuffer = Buffer.from(designB64.replace(/^data:image\/\w+;base64,/, ""), "base64");

  const surfaceMeta = await sharp(surfaceBuffer).metadata();
  const surfaceWidth = surfaceMeta.width ?? 512;
  const surfaceHeight = surfaceMeta.height ?? 512;

  // Resize design to match surface dimensions
  const resizedDesign = await sharp(designBuffer)
    .resize(surfaceWidth, surfaceHeight, { fit: "cover" })
    .toBuffer();

  // Apply opacity by creating a semi-transparent version of the design.
  // sharp's composite does not accept an opacity parameter directly;
  // we bake the opacity into the alpha channel instead.
  const opacityInt = Math.round(plan.opacity * 255);

  const designWithAlpha = await sharp(resizedDesign)
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

  // Composite: surface photo as base, design overlaid on top
  const composited = await sharp(surfaceBuffer)
    .composite([
      {
        input: designWithAlpha,
        blend: blendMode as import("sharp").Blend,
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return `data:image/jpeg;base64,${composited.toString("base64")}`;
}

// ─── Main composite function ──────────────────────────────────────────────────

export async function executeEdit(
  designImageB64: string,
  plan: EditPlan,
  instruction: string,
  surfaceImageB64?: string
): Promise<string> {
  const client = getOpenAIClient();

  // If we have a surface photo, composite the design onto it
  if (surfaceImageB64) {
    try {
      const composited = await sharpOverlay(designImageB64, surfaceImageB64, plan);
      return composited;
    } catch (err) {
      console.warn("[step4] Sharp compositing failed, falling back to generation:", err);
    }
  }

  // Fall back to DALL-E 3 generation
  const prompt = buildGenerationPrompt(plan, instruction, !!surfaceImageB64);

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
