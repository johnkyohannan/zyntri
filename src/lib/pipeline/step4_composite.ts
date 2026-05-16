/**
 * ZyntriStudio – Pipeline Step 4: Mockup Generation
 *
 * PRIMARY PATH (surface photo provided):
 *   1. gpt-4o-mini detects the bounding box of the target surface area.
 *   2. A centred sub-region mask is built (transparent = edit here,
 *      opaque = preserve exactly). Using a sub-region rather than the full
 *      surface box ensures wall edges, clocks, and other objects are never
 *      touched by the model.
 *   3. gpt-image-1 receives the surface photo + design image + mask and
 *      fills only the transparent region with the design, matching the
 *      surface's lighting, shadows, and perspective.
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

// ─── Bounding box types ───────────────────────────────────────────────────────

interface BoundingBox {
  x: number; // 0–1 left edge
  y: number; // 0–1 top edge
  w: number; // 0–1 width
  h: number; // 0–1 height
}

// Conservative per-surface fallbacks — avoid TVs, faces, windows
const FALLBACK_BOXES: Record<string, BoundingBox> = {
  wall:          { x: 0.10, y: 0.05, w: 0.80, h: 0.70 },
  shirt:         { x: 0.28, y: 0.22, w: 0.44, h: 0.40 },
  mug:           { x: 0.22, y: 0.18, w: 0.56, h: 0.64 },
  notebook:      { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
  poster:        { x: 0.04, y: 0.04, w: 0.92, h: 0.92 },
  cardboard_box: { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
  field_grass:   { x: 0.05, y: 0.45, w: 0.90, h: 0.50 },
};

// ─── Surface bounding box detection ──────────────────────────────────────────

async function getSurfaceBoundingBox(
  surfaceB64: string,
  targetSurface: string
): Promise<BoundingBox> {
  const client = getOpenAIClient();

  // Downscale to 512px before sending for bbox detection — we only need
  // rough coordinates, not full resolution. Saves ~60% of image token cost.
  const surfaceBuffer = Buffer.from(surfaceB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const smallBuffer = await sharp(surfaceBuffer)
    .resize(512, 512, { fit: "inside" })
    .jpeg({ quality: 70 })
    .toBuffer();
  const smallB64 = `data:image/jpeg;base64,${smallBuffer.toString("base64")}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 80,   // bbox JSON is tiny — {"x":0.1,"y":0.05,"w":0.8,"h":0.7}
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
          { type: "image_url", image_url: { url: smallB64, detail: "low" } },
          { type: "text", text: `Return the bounding box for the "${targetSurface}" surface.` },
        ] as OpenAI.Chat.ChatCompletionContentPart[],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as BoundingBox;
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

// ─── Design placement sub-region ─────────────────────────────────────────────
// Returns a centred sub-region of the surface box sized for the design.
// Smaller than the full surface box so wall edges, clocks, and other objects
// that sit on the surface but outside the design zone are never touched.

function designPlacementBox(surfaceBox: BoundingBox, targetSurface: string): BoundingBox {
  const scaleFactors: Record<string, { sw: number; sh: number }> = {
    wall:          { sw: 0.55, sh: 0.55 },
    shirt:         { sw: 0.70, sh: 0.70 },
    mug:           { sw: 0.80, sh: 0.80 },
    notebook:      { sw: 0.85, sh: 0.85 },
    poster:        { sw: 0.90, sh: 0.90 },
    cardboard_box: { sw: 0.85, sh: 0.85 },
    field_grass:   { sw: 0.70, sh: 0.60 },
  };

  const { sw, sh } = scaleFactors[targetSurface] ?? { sw: 0.60, sh: 0.60 };
  const dw = surfaceBox.w * sw;
  const dh = surfaceBox.h * sh;
  const dx = surfaceBox.x + (surfaceBox.w - dw) / 2;
  const dy = surfaceBox.y + (surfaceBox.h - dh) / 2;

  return { x: dx, y: dy, w: dw, h: dh };
}

// ─── Mask builder ─────────────────────────────────────────────────────────────
// Transparent (alpha=0) over placement area → model fills here.
// Opaque black (alpha=255) everywhere else → pixel-perfect preservation.

async function buildMask(
  width: number,
  height: number,
  box: BoundingBox
): Promise<Buffer> {
  const px = Math.max(0, Math.round(box.x * width));
  const py = Math.max(0, Math.round(box.y * height));
  const pw = Math.min(Math.round(box.w * width),  width  - px);
  const ph = Math.min(Math.round(box.h * height), height - py);

  const canvas = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    canvas[i * 4 + 0] = 0;
    canvas[i * 4 + 1] = 0;
    canvas[i * 4 + 2] = 0;
    canvas[i * 4 + 3] = 255; // opaque = preserve
  }

  for (let row = py; row < py + ph; row++) {
    for (let col = px; col < px + pw; col++) {
      const idx = (row * width + col) * 4;
      canvas[idx + 3] = 0; // transparent = model edits here
    }
  }

  return sharp(canvas, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

// ─── gpt-image-1 inpainting edit ─────────────────────────────────────────────

async function gptImageEdit(
  surfaceB64: string,
  designB64: string,
  maskBuffer: Buffer,
  plan: EditPlan,
  steps: string[]
): Promise<string> {
  const surfaceBuffer = Buffer.from(surfaceB64.replace(/^data:image\/\w+;base64,/, ""), "base64");
  const designBuffer  = Buffer.from(designB64.replace(/^data:image\/\w+;base64,/, ""), "base64");

  const surfacePng = await sharp(surfaceBuffer).png().toBuffer();
  const designPng  = await sharp(designBuffer).resize(512, 512, { fit: "inside" }).png().toBuffer();

  const surfaceLabels: Record<string, string> = {
    wall:          "the wall (in the transparent masked area only)",
    shirt:         "the shirt chest area (in the transparent masked area only)",
    mug:           "the mug body (in the transparent masked area only)",
    notebook:      "the notebook cover (in the transparent masked area only)",
    poster:        "inside the poster frame (in the transparent masked area only)",
    cardboard_box: "the box face (in the transparent masked area only)",
    field_grass:   "the grass (in the transparent masked area only)",
  };
  const surfaceLabel = surfaceLabels[plan.targetSurface] ?? `the ${plan.targetSurface} (in the transparent masked area only)`;

  const prompt = [
    `Place the design from the second image onto ${surfaceLabel}.`,
    `Use the exact design from the second image — do not invent, replace, or alter it.`,
    `The design should appear physically applied to the surface: adapt its lighting, shadows, and perspective to match the surface.`,
    `Blend the edges of the design naturally into the surface so there are no harsh borders or visible cutlines.`,
    `The wall color, wall texture, and all existing objects (furniture, clock, TV, artwork, decorations) must remain completely unchanged.`,
    `Only fill the transparent masked region. Every opaque pixel outside the mask must be pixel-perfect identical to the original photo.`,
    `Photorealistic, high quality mockup.`,
  ].join(" ");

  steps.push(`Sending surface photo + design to gpt-image-1. Only the masked placement area will be edited.`);
  steps.push(`Wall color, texture, and all objects outside the mask are preserved exactly.`);

  const apiKey = process.env.OPENAI_API_KEY!;
  const formData = new FormData();
  formData.append("model", "gpt-image-1");
  formData.append("prompt", prompt);
  formData.append("n", "1");
  formData.append("size", "1024x1024");
  formData.append("image[]", new Blob([new Uint8Array(surfacePng)], { type: "image/png" }), "surface.png");
  formData.append("image[]", new Blob([new Uint8Array(designPng)],  { type: "image/png" }), "design.png");
  formData.append("mask",    new Blob([new Uint8Array(maskBuffer)], { type: "image/png" }), "mask.png");

  const fetchResponse = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!fetchResponse.ok) {
    const errText = await fetchResponse.text();
    throw new Error(`gpt-image-1 edit API error ${fetchResponse.status}: ${errText.slice(0, 200)}`);
  }

  const json = await fetchResponse.json() as { data: Array<{ b64_json?: string }> };
  const b64 = json.data[0]?.b64_json;
  if (!b64) throw new Error("No image returned from gpt-image-1 edit.");

  steps.push(`Design placed on the ${plan.targetSurface} with matching lighting and perspective.`);
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
  });

  const url = response.data[0]?.url;
  if (!url) throw new Error("No image returned from DALL-E 3.");

  // Fetch the image and convert to base64
  const imgResponse = await fetch(url);
  const arrayBuffer = await imgResponse.arrayBuffer();
  const b64 = Buffer.from(arrayBuffer).toString("base64");

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

  // Step A: detect surface bounding box
  steps.push(`Detecting the ${plan.targetSurface} area in the surface photo.`);
  const box = await getSurfaceBoundingBox(surfaceImageB64, plan.targetSurface);
  steps.push(
    `Surface area: left ${Math.round(box.x * 100)}%, top ${Math.round(box.y * 100)}%, ` +
    `${Math.round(box.w * 100)}% wide × ${Math.round(box.h * 100)}% tall.`
  );

  // Step B: resize surface to 1024×1024 (required by gpt-image-1)
  steps.push("Preparing surface photo (resizing to 1024×1024).");
  const surfaceBuffer = Buffer.from(
    surfaceImageB64.replace(/^data:image\/\w+;base64,/, ""), "base64"
  );
  const resizedSurface = await sharp(surfaceBuffer)
    .resize(1024, 1024, { fit: "cover" })
    .png()
    .toBuffer();
  const resizedSurfaceB64 = `data:image/png;base64,${resizedSurface.toString("base64")}`;

  // Step C: build centred sub-region mask
  const placementBox = designPlacementBox(box, plan.targetSurface);
  steps.push(
    `Design placement: centred ${Math.round(placementBox.w * 100)}% × ${Math.round(placementBox.h * 100)}% of the image. ` +
    `Everything outside this area is preserved exactly.`
  );
  const maskBuffer = await buildMask(1024, 1024, placementBox);

  // Step D: gpt-image-1 inpainting
  try {
    const imageB64 = await gptImageEdit(
      resizedSurfaceB64,
      designImageB64,
      maskBuffer,
      plan,
      steps
    );
    return { imageB64, steps };
  } catch (err) {
    console.warn("[step4] gpt-image-1 edit failed, falling back to DALL-E 3:", err);
    steps.push(`Image edit failed — falling back to DALL-E 3 generation.`);
    const imageB64 = await dalleGenerate(plan, instruction, steps);
    return { imageB64, steps };
  }
}
