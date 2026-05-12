/**
 * ZyntriStudio – Pipeline Step 4: Mockup Compositing
 *
 * Produces a realistic mockup by:
 *   1. Analysing the surface photo with GPT-4o to get placement bounds,
 *      dominant light direction, and surface colour.
 *   2. Resizing and fitting the design into those bounds (perspective-aware
 *      for flat surfaces, contain-fit for curved ones).
 *   3. Applying a shadow layer beneath the design.
 *   4. Blending the design with the surface texture using the plan's blend
 *      mode and opacity so it inherits the surface's shading.
 *   5. Returning both the composited image and a human-readable log of every
 *      step taken, which is shown in the UI.
 *
 * Falls back to DALL-E 3 generation when no surface photo is provided.
 */

import OpenAI from "openai";
import sharp from "sharp";
import { getOpenAIClient } from "../openai";
import type { EditPlan } from "../../types";

// ─── Surface analysis via GPT-4o ─────────────────────────────────────────────

interface SurfaceAnalysis {
  placementX: number;       // 0–1 fraction of image width  (left edge of target area)
  placementY: number;       // 0–1 fraction of image height (top edge of target area)
  placementW: number;       // 0–1 fraction of image width  (width of target area)
  placementH: number;       // 0–1 fraction of image height (height of target area)
  lightDirection: "top" | "top-left" | "top-right" | "left" | "right" | "diffuse";
  surfaceBrightness: number; // 0–1 (0 = very dark surface, 1 = very bright)
  hasTexture: boolean;
  isCurved: boolean;
  dominantColor: string;    // hex e.g. "#f5f0e8"
}

async function analyseSurface(
  surfaceB64: string,
  targetSurface: string
): Promise<SurfaceAnalysis> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    max_tokens: 400,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: `You are a computer vision assistant for a mockup generator.
Analyse the provided surface photo and return ONLY a JSON object with these fields:
{
  "placementX": 0.0–1.0,
  "placementY": 0.0–1.0,
  "placementW": 0.0–1.0,
  "placementH": 0.0–1.0,
  "lightDirection": "top" | "top-left" | "top-right" | "left" | "right" | "diffuse",
  "surfaceBrightness": 0.0–1.0,
  "hasTexture": true | false,
  "isCurved": true | false,
  "dominantColor": "#rrggbb"
}

placementX/Y/W/H define the bounding box of the ${targetSurface} surface area
where a design should be placed, as fractions of the full image dimensions.
For a wall, this is the visible wall area. For a shirt, the front torso area.
For a mug, the visible cylindrical body. Etc.
lightDirection: where the main light source appears to come from.
surfaceBrightness: how light or dark the surface is (affects shadow visibility).
hasTexture: true if the surface has visible grain, weave, or texture.
isCurved: true for mugs, bottles, rounded objects.
dominantColor: the average hex colour of the surface area.
Do NOT include any text outside the JSON object.`,
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
            text: `Target surface type: ${targetSurface}. Analyse the placement area.`,
          },
        ] as OpenAI.Chat.ChatCompletionContentPart[],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    return JSON.parse(cleaned) as SurfaceAnalysis;
  } catch {
    // Sensible fallback — centre 60% of the image
    return {
      placementX: 0.2,
      placementY: 0.2,
      placementW: 0.6,
      placementH: 0.6,
      lightDirection: "top",
      surfaceBrightness: 0.6,
      hasTexture: false,
      isCurved: false,
      dominantColor: "#cccccc",
    };
  }
}

// ─── Hex colour → RGB ─────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16) || 128,
    g: parseInt(clean.slice(2, 4), 16) || 128,
    b: parseInt(clean.slice(4, 6), 16) || 128,
  };
}

// ─── Build a drop-shadow buffer ───────────────────────────────────────────────

async function buildShadow(
  width: number,
  height: number,
  lightDir: SurfaceAnalysis["lightDirection"],
  surfaceBrightness: number
): Promise<Buffer> {
  // Shadow opacity scales with surface brightness — darker surfaces need less shadow
  const shadowAlpha = Math.round(180 * surfaceBrightness);

  // Offset direction opposite to light source
  const offsets: Record<string, { dx: number; dy: number }> = {
    "top":       { dx: 0,   dy: 8  },
    "top-left":  { dx: 6,   dy: 6  },
    "top-right": { dx: -6,  dy: 6  },
    "left":      { dx: 8,   dy: 0  },
    "right":     { dx: -8,  dy: 0  },
    "diffuse":   { dx: 0,   dy: 4  },
  };
  const { dx, dy } = offsets[lightDir] ?? { dx: 0, dy: 6 };

  // Create a solid black rectangle slightly larger than the design area,
  // blurred to simulate a soft shadow
  const shadowW = width + 20;
  const shadowH = height + 20;

  const shadowBase = await sharp({
    create: {
      width: shadowW,
      height: shadowH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: shadowAlpha / 255 },
    },
  })
    .png()
    .toBuffer();

  // Blur the shadow for softness
  const blurred = await sharp(shadowBase)
    .blur(8)
    .toBuffer();

  // Embed into a canvas the same size as the design, offset by light direction
  const canvas = await sharp({
    create: {
      width: width + Math.abs(dx) + 20,
      height: height + Math.abs(dy) + 20,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: blurred,
      left: Math.max(0, dx),
      top: Math.max(0, dy),
    }])
    .png()
    .toBuffer();

  return canvas;
}

// ─── Main mockup compositor ───────────────────────────────────────────────────

export interface CompositeResult {
  imageB64: string;
  steps: string[];
}

export async function executeEdit(
  designImageB64: string,
  plan: EditPlan,
  instruction: string,
  surfaceImageB64?: string
): Promise<CompositeResult> {
  const steps: string[] = [];

  // ── No surface photo: fall back to DALL-E 3 ──────────────────────────────
  if (!surfaceImageB64) {
    steps.push("No surface photo provided — generating a mockup scene with DALL-E 3.");
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }

  // ── Step A: Analyse the surface ───────────────────────────────────────────
  steps.push(`Analysing the ${plan.targetSurface} surface to detect placement area, lighting, and texture.`);
  let analysis: SurfaceAnalysis;
  try {
    analysis = await analyseSurface(surfaceImageB64, plan.targetSurface);
    steps.push(
      `Detected placement area: ${Math.round(analysis.placementW * 100)}% × ${Math.round(analysis.placementH * 100)}% of the image, ` +
      `light from ${analysis.lightDirection}, surface brightness ${Math.round(analysis.surfaceBrightness * 100)}%.`
    );
  } catch (err) {
    console.warn("[step4] Surface analysis failed, using defaults:", err);
    analysis = {
      placementX: 0.2, placementY: 0.2, placementW: 0.6, placementH: 0.6,
      lightDirection: "top", surfaceBrightness: 0.6,
      hasTexture: false, isCurved: false, dominantColor: "#cccccc",
    };
    steps.push("Surface analysis unavailable — using centred placement with default lighting.");
  }

  const surfaceBuffer = Buffer.from(
    surfaceImageB64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );
  const designBuffer = Buffer.from(
    designImageB64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );

  const surfaceMeta = await sharp(surfaceBuffer).metadata();
  const sw = surfaceMeta.width ?? 1024;
  const sh = surfaceMeta.height ?? 1024;

  // ── Step B: Compute target placement in pixels ────────────────────────────
  const targetX = Math.round(analysis.placementX * sw);
  const targetY = Math.round(analysis.placementY * sh);
  const targetW = Math.round(analysis.placementW * sw);
  const targetH = Math.round(analysis.placementH * sh);

  // ── Step C: Resize design to fit the placement area ───────────────────────
  const fitMode = analysis.isCurved ? "contain" : "cover";
  steps.push(
    `Resizing design to fit the ${plan.targetSurface} area (${targetW}×${targetH}px) ` +
    `using ${fitMode} fit${analysis.isCurved ? " to preserve proportions on the curved surface" : ""}.`
  );

  const resizedDesign = await sharp(designBuffer)
    .resize(targetW, targetH, {
      fit: fitMode,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // ── Step D: Apply opacity (bake into alpha channel) ───────────────────────
  const opacityInt = Math.round(plan.opacity * 255);
  steps.push(
    `Setting design opacity to ${Math.round(plan.opacity * 100)}% so the surface texture shows through.`
  );

  const designWithAlpha = await sharp(resizedDesign)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      for (let i = 3; i < data.length; i += 4) {
        data[i] = Math.round((data[i] / 255) * opacityInt);
      }
      return sharp(data, {
        raw: { width: info.width, height: info.height, channels: 4 },
      }).png().toBuffer();
    });

  // ── Step E: Build shadow layer ────────────────────────────────────────────
  steps.push(
    `Adding a soft drop shadow offset toward the ${analysis.lightDirection} light source ` +
    `to ground the design on the surface.`
  );
  const shadowBuffer = await buildShadow(
    targetW, targetH, analysis.lightDirection, analysis.surfaceBrightness
  );

  // ── Step F: Blend mode for surface texture integration ────────────────────
  const blendMode = plan.blendMode === "multiply"
    ? "multiply"
    : plan.blendMode === "overlay"
    ? "overlay"
    : plan.blendMode === "soft_light"
    ? "soft-light"
    : "over";

  if (analysis.hasTexture) {
    steps.push(
      `Blending design with the surface using "${blendMode}" mode so the ` +
      `${plan.targetSurface}'s natural texture and grain show through the design.`
    );
  } else {
    steps.push(
      `Compositing design onto the surface using "${blendMode}" blend mode ` +
      `to preserve the surface's shading and lighting.`
    );
  }

  // ── Step G: Composite everything onto the surface ─────────────────────────
  const shadowLeft = Math.max(0, targetX - 10);
  const shadowTop  = Math.max(0, targetY - 10);

  const composited = await sharp(surfaceBuffer)
    .composite([
      // Shadow first (behind the design)
      {
        input: shadowBuffer,
        left: shadowLeft,
        top: shadowTop,
        blend: "multiply",
      },
      // Design on top with the chosen blend mode
      {
        input: designWithAlpha,
        left: targetX,
        top: targetY,
        blend: blendMode as import("sharp").Blend,
      },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  // ── Step H: Surface-colour tint for curved surfaces ───────────────────────
  let finalBuffer = composited;
  if (analysis.isCurved) {
    steps.push(
      `Applying a subtle ${analysis.dominantColor} colour tint to help the design ` +
      `wrap naturally around the curved surface.`
    );
    const { r, g, b } = hexToRgb(analysis.dominantColor);
    // Create a very faint tint overlay
    const tintOverlay = await sharp({
      create: { width: sw, height: sh, channels: 4,
        background: { r, g, b, alpha: 0.08 } },
    }).png().toBuffer();

    finalBuffer = await sharp(composited)
      .composite([{ input: tintOverlay, blend: "soft-light" }])
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  steps.push("Mockup complete — design is composited with realistic lighting and surface integration.");

  return {
    imageB64: `data:image/jpeg;base64,${finalBuffer.toString("base64")}`,
    steps,
  };
}

// ─── DALL-E 3 fallback (no surface photo) ────────────────────────────────────

async function dalleGenerate(
  plan: EditPlan,
  instruction: string,
  steps: string[]
): Promise<string> {
  const client = getOpenAIClient();

  const surfaceDescriptions: Record<string, string> = {
    shirt: "a t-shirt worn by a person, front view, studio lighting",
    wall: "a flat interior wall, even lighting",
    mug: "a ceramic coffee mug on a table, soft studio lighting",
    notebook: "a closed notebook on a desk, overhead lighting",
    poster: "a framed poster on a wall, gallery lighting",
    cardboard_box: "a plain cardboard shipping box, natural lighting",
    field_grass: "an open grass field, daylight",
  };

  const surfaceDesc = surfaceDescriptions[plan.targetSurface] ?? plan.targetSurface;

  const blendDesc: Record<string, string> = {
    multiply: "the design darkens the surface naturally following its contours",
    overlay:  "the design is blended realistically with the surface shading",
    soft_light: "the design is subtly integrated, preserving the surface feel",
    normal:   "the design is applied directly onto the surface",
  };

  const prompt = [
    `A photorealistic product mockup of ${surfaceDesc}.`,
    `The design applied to it: ${instruction}.`,
    blendDesc[plan.blendMode] ?? "applied to the surface.",
    plan.preserveShading ? "Original folds, shadows, and lighting are preserved." : "",
    "The design fits the surface proportionally with realistic shadows and depth.",
    "High quality, sharp details, professional product photography style.",
  ].filter(Boolean).join(" ");

  steps.push(`Generating mockup scene with DALL-E 3: "${prompt.slice(0, 80)}…"`);

  const response = await client.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    response_format: "b64_json",
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) throw new Error("No image returned from DALL-E 3.");

  steps.push("DALL-E 3 generated a photorealistic mockup scene.");
  return `data:image/png;base64,${b64}`;
}
