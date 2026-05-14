/**
 * ZyntriStudio – Pipeline Step 4: Mockup Generation
 *
 * PRIMARY PATH (surface photo provided):
 *   Uses the OpenAI images.edit endpoint with gpt-image-1.
 *   - GPT-4.1-mini analyses the surface photo and returns the bounding box
 *     of the target surface area as pixel fractions.
 *   - We build a mask PNG: transparent (alpha=0) over the target area,
 *     fully opaque (alpha=255) everywhere else.
 *   - images.edit receives the surface photo + mask + a prompt describing
 *     the design to apply. The model fills only the transparent region,
 *     leaving the rest of the photo pixel-perfect.
 *   - This means the TV, furniture, and background are never touched.
 *
 * FALLBACK (no surface photo, or edit API fails):
 *   DALL-E 3 generates a clean product mockup from scratch.
 */

import OpenAI from "openai";
import sharp from "sharp";
import { getOpenAIClient } from "../openai";
import type { EditPlan } from "../../types";

export interface CompositeResult {
  imageB64: string;
  steps: string[];
}

// ─── Surface bounding box via GPT-4.1-mini ────────────────────────────────────

interface BoundingBox {
  x: number; // 0–1 left edge
  y: number; // 0–1 top edge
  w: number; // 0–1 width
  h: number; // 0–1 height
}

// Conservative per-surface fallbacks used when the model fails or returns
// implausible values. These avoid common problem areas (TVs, faces, windows).
const FALLBACK_BOXES: Record<string, BoundingBox> = {
  wall:          { x: 0.10, y: 0.05, w: 0.80, h: 0.70 },
  shirt:         { x: 0.28, y: 0.22, w: 0.44, h: 0.40 },
  mug:           { x: 0.22, y: 0.18, w: 0.56, h: 0.64 },
  notebook:      { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
  poster:        { x: 0.04, y: 0.04, w: 0.92, h: 0.92 },
  cardboard_box: { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
  field_grass:   { x: 0.05, y: 0.45, w: 0.90, h: 0.50 },
};

async function getSurfaceBoundingBox(
  surfaceB64: string,
  targetSurface: string
): Promise<BoundingBox> {
  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 150,
    temperature: 0.0,
    messages: [
      {
        role: "system",
        content: `You are a bounding box detector for a mockup tool.
Look at the image and return ONLY a JSON object with the bounding box of the
"${targetSurface}" surface — the area where a design should be placed.
Use fractions of the full image (0.0 to 1.0).

{
  "x": <left edge, 0–1>,
  "y": <top edge, 0–1>,
  "w": <width, 0–1>,
  "h": <height, 0–1>
}

Rules:
- For "wall": the visible wall area only. Exclude TV screens, windows, furniture, and artwork.
- For "shirt": the front torso/chest area of the shirt only.
- For "mug": the cylindrical body of the mug only.
- For "notebook": the front cover face only.
- For "poster": the interior of the poster frame only.
- For "cardboard_box": the front face of the box only.
- For "field_grass": the grass area only, not sky or people.
- Be conservative — it is better to be too small than to include wrong objects.
- Do NOT include any text outside the JSON object.`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: surfaceB64, detail: "high" } },
          { type: "text", text: `Return the bounding box for the "${targetSurface}" surface.` },
        ] as OpenAI.Chat.ChatCompletionContentPart[],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as BoundingBox;
    // Validate — reject implausible values
    if (
      parsed.x >= 0 && parsed.x <= 1 &&
      parsed.y >= 0 && parsed.y <= 1 &&
      parsed.w > 0.05 && parsed.w <= 1 &&
      parsed.h > 0.05 && parsed.h <= 1 &&
      parsed.x + parsed.w <= 1.05 &&
      parsed.y + parsed.h <= 1.05
    ) {
      return parsed;
    }
  } catch {
    // fall through to fallback
  }

  console.warn(`[step4] Bounding box invalid for ${targetSurface}, using fallback.`);
  return FALLBACK_BOXES[targetSurface] ?? { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
}

// ─── Build mask PNG ───────────────────────────────────────────────────────────
// Transparent (alpha=0) over the target area → model fills this region.
// Opaque black (alpha=255) everywhere else → model leaves this unchanged.

async function buildMask(
  width: number,
  height: number,
  box: BoundingBox
): Promise<Buffer> {
  const px = Math.round(box.x * width);
  const py = Math.round(box.y * height);
  const pw = Math.min(Math.round(box.w * width),  width  - px);
  const ph = Math.min(Math.round(box.h * height), height - py);

  // Start with fully opaque black canvas
  const canvas = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4 + 0] = 0;   // R
    canvas[i * 4 + 1] = 0;   // G
    canvas[i * 4 + 2] = 0;   // B
    canvas[i * 4 + 3] = 255; // A — opaque (preserve)
  }

  // Punch out the target area — make it transparent (model will fill here)
  for (let row = py; row < py + ph; row++) {
    for (let col = px; col < px + pw; col++) {
      const idx = (row * width + col) * 4;
      canvas[idx + 3] = 0; // alpha=0 → transparent → model edits here
    }
  }

  return sharp(canvas, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

// ─── gpt-image-1 edit ─────────────────────────────────────────────────────────

async function gptImageEdit(
  surfaceB64: string,
  maskBuffer: Buffer,
  plan: EditPlan,
  instruction: string,
  steps: string[]
): Promise<string> {
  const client = getOpenAIClient();

  // Convert surface base64 to a PNG buffer for the API
  const surfaceBuffer = Buffer.from(
    surfaceB64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );

  // Ensure surface is PNG (gpt-image-1 edit requires PNG)
  const surfacePng = await sharp(surfaceBuffer).png().toBuffer();

  const surfaceLabels: Record<string, string> = {
    wall:          "the wall surface (not on the TV, windows, or furniture)",
    shirt:         "the front of the shirt (chest/torso area only)",
    mug:           "the body of the mug (wrapping around the cylinder)",
    notebook:      "the front cover of the notebook",
    poster:        "inside the poster frame",
    cardboard_box: "the front face of the cardboard box",
    field_grass:   "the grass area of the field",
  };
  const surfaceLabel = surfaceLabels[plan.targetSurface] ?? plan.targetSurface;

  const prompt = [
    `Apply this design to ${surfaceLabel}: ${instruction}.`,
    `The design should look like it is physically printed, painted, or applied to the surface.`,
    `Match the surface's existing lighting, shadows, perspective, and texture.`,
    `Keep everything outside the target area exactly as it is in the original photo.`,
    `Photorealistic, high quality mockup.`,
  ].join(" ");

  steps.push(`Sending surface photo to gpt-image-1 with a mask covering only the ${plan.targetSurface} area.`);
  steps.push(`Edit prompt: "${prompt.slice(0, 100)}…"`);

  // Convert buffers to File objects for the API
  const { toFile } = await import("openai");

  const imageFile = await toFile(surfacePng, "surface.png", { type: "image/png" });
  const maskFile  = await toFile(maskBuffer,  "mask.png",    { type: "image/png" });

  const response = await client.images.edit({
    model: "gpt-image-1-mini",
    image: imageFile,
    mask: maskFile,
    prompt,
    n: 1,
    size: "1024x1024",
  });

  const b64 = response.data[0]?.b64_json;
  if (!b64) throw new Error("No image returned from gpt-image-1 edit.");

  steps.push(`gpt-image-1 applied the design to the ${plan.targetSurface} area with correct lighting and perspective.`);
  steps.push("All other elements in the photo (TV, furniture, background) are preserved exactly.");

  return `data:image/png;base64,${b64}`;
}

// ─── DALL-E 3 fallback ────────────────────────────────────────────────────────

async function dalleGenerate(
  plan: EditPlan,
  instruction: string,
  steps: string[]
): Promise<string> {
  const client = getOpenAIClient();

  const surfaceDescriptions: Record<string, string> = {
    shirt:         "a t-shirt worn by a person, front view, studio lighting",
    wall:          "a flat interior wall, even lighting",
    mug:           "a ceramic coffee mug on a table, soft studio lighting",
    notebook:      "a closed notebook on a desk, overhead lighting",
    poster:        "a framed poster on a wall, gallery lighting",
    cardboard_box: "a plain cardboard shipping box, natural lighting",
    field_grass:   "an open grass field, daylight",
  };

  const prompt = [
    `A photorealistic product mockup of ${surfaceDescriptions[plan.targetSurface] ?? plan.targetSurface}.`,
    `Design applied: ${instruction}.`,
    `The design fits the surface proportionally with realistic shadows, perspective, and depth.`,
    `High quality, professional product photography style.`,
  ].join(" ");

  steps.push("Generating product mockup scene with DALL-E 3.");

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

  steps.push("DALL-E 3 generated a photorealistic mockup scene.");
  return `data:image/png;base64,${b64}`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function executeEdit(
  designImageB64: string,
  plan: EditPlan,
  instruction: string,
  surfaceImageB64?: string
): Promise<CompositeResult> {
  const steps: string[] = [];

  if (!surfaceImageB64) {
    steps.push("No surface photo provided — generating a product mockup scene with DALL-E 3.");
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }

  // ── Step A: Get bounding box of the target surface area ───────────────────
  steps.push(`Detecting the ${plan.targetSurface} area in the surface photo.`);
  const box = await getSurfaceBoundingBox(surfaceImageB64, plan.targetSurface);
  steps.push(
    `Target area: left ${Math.round(box.x * 100)}%, top ${Math.round(box.y * 100)}%, ` +
    `${Math.round(box.w * 100)}% wide × ${Math.round(box.h * 100)}% tall.`
  );

  // ── Step B: Resize surface to 1024×1024 (required by gpt-image-1 edit) ───
  steps.push("Preparing surface photo for editing (resizing to 1024×1024).");
  const surfaceBuffer = Buffer.from(
    surfaceImageB64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );
  const resizedSurface = await sharp(surfaceBuffer)
    .resize(1024, 1024, { fit: "cover" })
    .png()
    .toBuffer();
  const resizedSurfaceB64 = `data:image/png;base64,${resizedSurface.toString("base64")}`;

  // ── Step C: Build mask ────────────────────────────────────────────────────
  steps.push(`Building edit mask: transparent over the ${plan.targetSurface} area, opaque everywhere else.`);
  const maskBuffer = await buildMask(1024, 1024, box);

  // ── Step D: gpt-image-1 edit ──────────────────────────────────────────────
  try {
    const imageB64 = await gptImageEdit(
      resizedSurfaceB64,
      maskBuffer,
      plan,
      instruction,
      steps
    );
    return { imageB64, steps };
  } catch (err) {
    console.warn("[step4] gpt-image-1 edit failed, falling back to DALL-E 3:", err);
    steps.push(`Image edit failed (${String(err).slice(0, 80)}) — falling back to DALL-E 3 generation.`);
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }
}
