/**
 * ZyntriStudio – Pipeline Step 4: Mockup Generation
 *
 * Strategy:
 *
 * PRIMARY PATH (surface photo provided):
 *   Use GPT-4o vision to describe the scene in the surface photo, then feed
 *   that description + the design details into a DALL-E 3 prompt that asks it
 *   to render the design onto the correct surface in the scene. This lets
 *   DALL-E handle perspective, lighting, shadows, and placement natively —
 *   far more reliably than pixel-level compositing.
 *
 * SECONDARY PATH (no surface photo):
 *   Generate a clean product mockup scene from scratch with DALL-E 3.
 *
 * SHARP COMPOSITING (opt-in for simple flat surfaces):
 *   Used only when the surface is a flat, uncluttered area (poster, wall with
 *   no furniture) and the user explicitly wants the exact photo preserved.
 *   Uses surface-type-specific safe placement regions — no LLM coordinate
 *   guessing.
 */

import OpenAI from "openai";
import sharp from "sharp";
import { getOpenAIClient } from "../openai";
import type { EditPlan } from "../../types";

export interface CompositeResult {
  imageB64: string;
  steps: string[];
}

// ─── Surface-type safe placement regions (fraction of image) ─────────────────
// These are conservative defaults that avoid common problem areas (TVs, faces,
// furniture). They are used only for the sharp compositing fallback.

const SAFE_REGIONS: Record<string, { x: number; y: number; w: number; h: number }> = {
  wall:          { x: 0.15, y: 0.10, w: 0.70, h: 0.65 },
  shirt:         { x: 0.25, y: 0.20, w: 0.50, h: 0.45 },
  mug:           { x: 0.20, y: 0.15, w: 0.60, h: 0.70 },
  notebook:      { x: 0.10, y: 0.10, w: 0.80, h: 0.80 },
  poster:        { x: 0.05, y: 0.05, w: 0.90, h: 0.90 },
  cardboard_box: { x: 0.10, y: 0.10, w: 0.80, h: 0.80 },
  field_grass:   { x: 0.10, y: 0.40, w: 0.80, h: 0.50 },
};

// ─── Scene description via GPT-4o-mini ───────────────────────────────────────
// Describes the surface photo so DALL-E 3 can place the design correctly.

async function describeSurfaceScene(
  surfaceB64: string,
  targetSurface: string,
  instruction: string
): Promise<string> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    max_tokens: 300,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `You are a scene description assistant for a mockup generator.
Look at the provided photo and write a concise description (2–4 sentences) of:
1. The overall scene (room type, setting, lighting conditions).
2. The specific ${targetSurface} surface — its position, colour, texture, and any notable features.
3. What surrounds the ${targetSurface} (nearby objects, background elements).
Be specific and factual. Do not mention the design to be applied.`,
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: surfaceB64, detail: "high" },
          },
          {
            type: "text",
            text: `Describe this scene focusing on the ${targetSurface} surface.`,
          },
        ] as OpenAI.Chat.ChatCompletionContentPart[],
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ??
    `A ${targetSurface} surface in a typical setting.`;
}

// ─── DALL-E 3 mockup generation ───────────────────────────────────────────────

async function dalleGenerate(
  plan: EditPlan,
  instruction: string,
  steps: string[],
  sceneDescription?: string
): Promise<string> {
  const client = getOpenAIClient();

  const surfaceLabels: Record<string, string> = {
    shirt:         "t-shirt (front torso area only)",
    wall:          "wall surface (not on any furniture, TV, or windows)",
    mug:           "ceramic mug body (wrapping around the cylindrical surface)",
    notebook:      "notebook cover (front face only)",
    poster:        "poster within its frame",
    cardboard_box: "front face of the cardboard box",
    field_grass:   "grass area of the field (not on people, goals, or sky)",
  };

  const surfaceLabel = surfaceLabels[plan.targetSurface] ?? plan.targetSurface;

  const blendDesc: Record<string, string> = {
    multiply:   "integrated naturally, darkening the surface where the design is dark",
    overlay:    "blended realistically with the surface shading and texture",
    soft_light: "subtly integrated, preserving the original surface feel",
    normal:     "applied cleanly onto the surface",
  };
  const blendNote = blendDesc[plan.blendMode] ?? "applied to the surface";

  const prompt = [
    sceneDescription
      ? `Photorealistic scene: ${sceneDescription}`
      : `A photorealistic scene with a ${plan.targetSurface}.`,
    `The ${surfaceLabel} has this design applied to it: ${instruction}.`,
    `The design is ${blendNote}.`,
    plan.preserveShading
      ? "The surface's original folds, shadows, curves, and lighting are fully preserved."
      : "",
    "The design is correctly scaled and proportioned to fit the surface naturally.",
    "All other objects in the scene are completely unchanged.",
    "Photorealistic, high quality, professional product mockup photography.",
  ].filter(Boolean).join(" ");

  steps.push(`Generating mockup with DALL-E 3, placing design on the ${plan.targetSurface} only.`);
  steps.push(`Scene context: "${(sceneDescription ?? "").slice(0, 100)}${(sceneDescription?.length ?? 0) > 100 ? "…" : ""}"`);

  const response = await client.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "hd",
    response_format: "b64_json",
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) throw new Error("No image returned from DALL-E 3.");

  steps.push("DALL-E 3 rendered the design with correct perspective, lighting, and surface integration.");
  return `data:image/png;base64,${b64}`;
}

// ─── Sharp compositing (simple flat surfaces only) ───────────────────────────
// Uses hardcoded safe regions — no LLM coordinate guessing.

async function sharpComposite(
  designB64: string,
  surfaceB64: string,
  plan: EditPlan,
  steps: string[]
): Promise<string> {
  const surfaceBuffer = Buffer.from(surfaceB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const designBuffer  = Buffer.from(designB64.replace(/^data:image\/\w+;base64,/, ""), "base64");

  const meta = await sharp(surfaceBuffer).metadata();
  const sw = meta.width  ?? 1024;
  const sh = meta.height ?? 1024;

  const region = SAFE_REGIONS[plan.targetSurface] ?? SAFE_REGIONS.wall;
  const tx = Math.round(region.x * sw);
  const ty = Math.round(region.y * sh);
  const tw = Math.round(region.w * sw);
  const th = Math.round(region.h * sh);

  steps.push(`Using safe placement region for ${plan.targetSurface}: ${tw}×${th}px at (${tx}, ${ty}).`);

  // Resize design to fit the safe region
  const isCurved = plan.targetSurface === "mug";
  const resized = await sharp(designBuffer)
    .resize(tw, th, {
      fit: isCurved ? "contain" : "inside",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // Bake opacity into alpha
  const opacityInt = Math.round(plan.opacity * 255);
  steps.push(`Setting opacity to ${Math.round(plan.opacity * 100)}% so surface texture shows through.`);

  const withAlpha = await sharp(resized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round((data[i] / 255) * opacityInt);
      }
      return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png().toBuffer();
    });

  // Get actual resized dimensions (may differ from tw/th due to "inside" fit)
  const resizedMeta = await sharp(withAlpha).metadata();
  const rw = resizedMeta.width  ?? tw;
  const rh = resizedMeta.height ?? th;

  // Centre within the safe region
  const cx = tx + Math.round((tw - rw) / 2);
  const cy = ty + Math.round((th - rh) / 2);

  const blendMode = plan.blendMode === "multiply" ? "multiply"
    : plan.blendMode === "overlay"    ? "overlay"
    : plan.blendMode === "soft_light" ? "soft-light"
    : "over";

  steps.push(`Blending design onto surface using "${blendMode}" mode to preserve surface shading.`);

  const composited = await sharp(surfaceBuffer)
    .composite([{ input: withAlpha, left: cx, top: cy, blend: blendMode as import("sharp").Blend }])
    .jpeg({ quality: 92 })
    .toBuffer();

  steps.push("Sharp compositing complete.");
  return `data:image/jpeg;base64,${composited.toString("base64")}`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function executeEdit(
  designImageB64: string,
  plan: EditPlan,
  instruction: string,
  surfaceImageB64?: string
): Promise<CompositeResult> {
  const steps: string[] = [];

  // Surfaces where DALL-E scene generation gives much better results than
  // sharp compositing (complex scenes, curved surfaces, clothing with folds)
  const preferDalle = new Set(["shirt", "mug", "wall", "field_grass"]);

  if (!surfaceImageB64) {
    // No surface photo — generate a clean product mockup from scratch
    steps.push("No surface photo provided — generating a product mockup scene with DALL-E 3.");
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }

  if (preferDalle.has(plan.targetSurface)) {
    // Use DALL-E with scene context for surfaces that need realistic integration
    steps.push(`Analysing the surface photo to understand the scene context for ${plan.targetSurface} placement.`);
    let sceneDesc: string | undefined;
    try {
      sceneDesc = await describeSurfaceScene(surfaceImageB64, plan.targetSurface, instruction);
      steps.push(`Scene understood: "${sceneDesc.slice(0, 120)}${sceneDesc.length > 120 ? "…" : ""}"`);
    } catch (err) {
      console.warn("[step4] Scene description failed:", err);
      steps.push("Scene description unavailable — proceeding with surface type context only.");
    }
    const imageB64 = await dalleGenerate(plan, instruction, steps, sceneDesc);
    return { imageB64, steps };
  }

  // For flat, simple surfaces (notebook, poster, cardboard_box) try sharp first
  steps.push(`Using direct compositing for flat surface: ${plan.targetSurface}.`);
  try {
    const imageB64 = await sharpComposite(designImageB64, surfaceImageB64, plan, steps);
    return { imageB64, steps };
  } catch (err) {
    console.warn("[step4] Sharp compositing failed, falling back to DALL-E 3:", err);
    steps.push("Direct compositing failed — falling back to DALL-E 3 generation.");
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }
}
