# ZyntriStudio – CPSC 254 Final Project Report

**Student:** John Yohannan
**Course:** CPSC 254

---

## 1. What & Why
This app is a conversation mockup assistant that allows a user to upload a design and a surface photo that allows the AI to create a mockup of the design. This app is for designers and those who want to preview how their design looks before they print or order it themselves. Issues that the AI might have trouble with are as follows:
1. Surface detection: if multiple surfaces that seem the same are detected (ie: a wall and desk), the model might have issues classifying the right surfact to place the design on.
2. Design: The app must be able to use the design, exactly, and not invent a new one (this failed in early versions where the model generated a mountain mural instead of a Lakers logo) while making sure colors and such are the exact same, just warped to fit the surface. It must also remember the image it has so that it can be refined if prompted to
3. Quality control: If a certain placement is not specified, the model has to find the perfect placement that makes sense for the design

While OpenAI has a similar tool using the DALL-E model, this differentiates it as DALL-E creates a completely new image, thus hallucinating and changing what the user wishes to have. Using the gpt-image model allows editing of the original image while being able to keep the image for future editing.
---

## 2. Iterations
-
V1 - Baseline: Sharp Composite + DALL-E 3 model as a fallback
What I did: The initial implementation used the sharp library to overlay the design image on top of the surface photo at full resolution. That way, the risk of hallucination was reduced. However, when no surface photo was provided, DALL-E 3 generated a new scene from the text prompt, this led to no detection of a surface leading to designs being randomly put on the iamge

Example: Test Case 1 (floral pattern on shirt) scored 0%: The quality checker reported "Floral pattern was not applied to the shirt as instructed." Sharp compositing resized the design to match the full image dimensions and overlaid it across the entire photo, covering the background, person, and shirt equally with no surface awareness, leading the user unable to see their surface image at all. Test case 9 and 10 also failed at 0% because the model reported the target surface wasn't present — the full-image overlay produced results the quality checker couldn't recognize as a valid edit.

Results: 3/10 passing (30%), average quality score 43%.

Conclusion: Sharp compositing had no concept of surface boundaries, it puts the design right on top of the surface image at full resolution regardless of what's in the photo. The DALL-E 3 fallback generates a new scene from a text description rather than editing the original photo, so the user's actual surface is never used, thus useless. The fix was to switch to the OpenAI images.edit endpoint with a precise inpainting mask so only the target surface region is modified, with DALL-E remaining as a fall back.
---

V2 — gpt-image-1 Inpainting with Bounding Box Mask

What I did: Replaced sharp composites with gpt-image-1 inpainting via the images.edit endpoint, so that a brand new image was not created. Added a gpt-4o-mini bounding box detection step that identifies the target surface area. Built a mask PNG that was transparent over the detected surface area and fully opaque everywhere else, so that only the target region is edited. This passed both the surface photo and the design image to the API via FormData image[]. Also "combined:" Steps 2 and 4 and Steps 5 and 6 to reduce the run time by about 30 seconds.

Example: Test case 3 (artwork on wall) failed with surface_mismatch(got=poster, expected=wall): the instruction said "place as a flat poster on the blank wall" and the model latched onto the word "poster," returning primarySurface: "poster" even though the photo showed a plain wall. Test case 2 (logo on shirt) scored 50%: the quality checker reported the logo was not centered and text appeared distorted, because the edit plan chose blendMode: "normal" and opacity: 1.0 with preserveShading: false, producing a flat paste with no fabric texture integration.

Results: 7/10 passing (70%), average quality score 83%. Up from 30% in V1, 40% increase.

Conclusion: Switching to gpt-image-1 inpainting with a mask ended up working better than expected. The model now edits only the target region rather than replacing the whole imag, reducing the risk of hallucination. The remaining failures were caused by a wrong surface indentifying from instruction wording (Test Case 3) and bad blend settings for fabric surfaces (Test Case 2 and 6). The next step was to fix the interpretation prompt and enforce better blending.
---

V3 — Centred Sub-Region Mask + Improved Blend Settings

Change: Three fixes based on V2 failures. First, updated the Step 1 interpretation prompt to base primarySurface on what is visible in the photo rather than looking for keywords in the instruction prompt. Made sure the AI only returns "poster" if an actual framed poster is visible. Secondly, updated the Step 2 edit plan prompt to enforce blendMode: "overlay" and opacity to 0.85–0.95 for logos and stickers on fabric/curved surfaces, and preserveShading: true for shirts, mugs, and notebooks. Third, changed the Test Case 3 instruction from "place a flat poster on the blank wall" to "apply this artwork directly onto the wall surface" to remove confusion from the word "poster."

Example: Test case 2 (logo on shirt, 50% in V2): the quality checker reported "Logo is not centered on the shirt. Text appears distorted and unclear." The edit plan had chosen blendMode: "normal", opacity: 1.0, preserveShading: false — a flat paste with no surface integration. Test case 6 (sticker on notebook, 60% in V2) had the same root cause: "visible edges around the sticker that detract from the overall appearance."

Results: 8/10 passing (80%), average quality score 83.5%. Up from 70% in V2, 10% increase. Test case now passes (wall correctly identified). Test case 2 improved from 50% to 60% but still fails the 65% threshold — the overlay blend mode helped but centering remains inconsistent. tc06 also improved from 60% to 60% (no change): the blend mode update helped with edge integration but alignment issues continue.

Conclusion: The interpretation prompt fix resolved the Test case 3 surface mismatch completely. The blend mode and opacity changes improved surface integration scores across shirt and notebook cases. Test cases 2 and 6 remain the hardest cases: logo centering and sticker alignment are sensitive to the exact placement region computed by the bounding box step. But it is still close to the threshold

---

## 3. Code Walkthrough

When a user uploads a design, a living room photo, and clicks Generate, here is what the code runs with.

The button triggers handleSubmit() in index.ts, which POSTs both images and the instruction to /api/edit. The API route at edit.ts validates the request and calls runPipeline() in index.ts.

**Step 1** (step1_interpret.ts) sends both images to gpt-4o-mini. The design image is sent at detail:"low" since we only need to know what kind of design it is, not pixel-level detail, thus saving cost. The surface photo is sent at detail:"high" so the model can accurately identify the wall and distinguish it from the TV and furniture. It returns primarySurface: "wall", meaning surface is identified

**Step 2** (step2_plan.ts) runs in parallel with Step 4 via Promise.all() at index.ts. It asks gpt-4o-mini to produce a structured edit plan, which includes blend mode, opacity, whether or not to preserve shading based on the surface type and instruction.

**Step 4** (step4_composite.ts) does three different things in sequence: first it detects the wall bounding box using a 512px downscaled image, computes a centered subregion placement zone using designPlacementBox() on line 120, builds a 1024×1024 mask PNG where only the placement zone is transparent, then sends the surface photo, design image, and mask to gpt-image-1 via a raw FormData fetch at line 170. The model fills only the transparent region, leaving any other objects unchanged.

*Steps 5 and 6 run in parallel via Promise.allSettled() at index.ts*
**Step 5** (step5_validate.ts) sends the output image back to gpt-4o-mini and returns a quality score. 
**Step 6** (step6_respond.ts) generates the conversational explanation using the list of mockup steps as context.

One key design decision was running Steps 2 and 4 in parallel. The alternative was sequential execution, which is simpler to debug. It was rejected because the image edit takes 25–45 seconds and plan generation takes 1–2 seconds. Thus, running them together saves that time for free with no quality tradeoff, since the two steps are independent after Step 1.

---

## 4. AI Disclosure & Safety

I used Kiro as a coding assistant throughout this project, primarily for scaffolding, generating API integration code, and iterating on prompts. I directed the overall architecture, that is, the decision to use the 6-step chained pipeline (though originally 5, Kiro suggested the quality check), the choice to use inpainting over text-to-image generation so I could cost save from DALL-E, and the evaluation methodology while Kiro handled the implementation details.

Issues:
Kiro's initial sharp compositing approach applied the design at full image size, covering the entire photo. The design appeared as a full-screen overlay with no surface awareness. Recovery: I decided to switch to gpt-image-1 inpainting with a mask after recognizing that sharp has no concept of surface boundaries and DALL-E's model would not work and could cost a lot more

Kiro's LLM bounding box approach returned coordinates that covered the TV (the model guessed wrong and placed the design over the television). Recovery: added fallback boxes and shrunk the mask to a centered sub-region so that other objects are always outside the transparent region.

The first gpt-image-1 edit call didn't pass the design image to the API, rather the surface photo was sent. The model invented a mountain mural instead of using the uploaded logo. Recovery: switched to raw FormData fetch to pass both images via image[] array, since the typed SDK only accepts a single image.

Safety risks specific to this app:

Cost runaway: each request costs ~$0.012 (gpt-image-1 edit). A user could trigger many requests rapidly with no rate limiting. Fix: no rate limiting in v1 changed to accepted limit for a class project. Production would add per-user quotas.

Prompt injection via the instruction field: a user could type instructions designed to override the system prompt. Fix: the safety gate in Step 1 (src/lib/pipeline/step1_interpret.ts) checks isSafe before any image generation occurs. The gpt-image-1 model also has its own content filters as a second layer.

