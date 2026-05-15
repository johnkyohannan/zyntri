/**
 * ZyntriStudio – Evaluation Runner
 *
 * Usage:
 *   npm run eval
 *   # or with a specific version label:
 *   VERSION=v2 npm run eval
 *
 * What it does:
 *   1. Loads test cases from eval/test_cases.json
 *   2. For each test case, runs the full ZyntriStudio pipeline
 *      (Steps 1–6) using the real OpenAI API
 *   3. Applies pass/fail criteria:
 *      - interpretation correctly identifies the expected surface
 *      - quality check score >= 0.65 (when an image is produced)
 *      - no safety or unsupported-surface errors for valid cases
 *   4. Writes results to eval/results_<version>.json
 *   5. Prints a summary table to stdout
 *
 * Metric:
 *   accuracy = (# passing edits) / (# test cases)
 *
 * A test case "passes" when ALL of the following are true:
 *   - interpretation.primarySurface === expected_surface
 *   - outputImageB64 is not null (an image was produced)
 *   - qualityCheck.score >= 0.65
 *   - no error field in the response
 *
 * Note: test cases with null base_image paths are skipped with a
 * "missing_asset" status so the runner doesn't crash during grading
 * when placeholder images haven't been provided yet.
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load .env.local or .env from project root
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });
dotenv.config({ path: path.resolve(__dirname, "../.env") }); // fallback

// Import pipeline (CommonJS-compatible via tsconfig.eval.json)
import { runPipeline } from "../src/lib/pipeline";
import type {
  EvalTestCase,
  EvalResult,
  EvalSummary,
  EditRequest,
} from "../src/types";

// ─── Config ───────────────────────────────────────────────────────────────────

const VERSION = process.env.VERSION ?? "v1";
const TEST_CASES_PATH = path.resolve(__dirname, "test_cases.json");
const RESULTS_PATH = path.resolve(__dirname, `results_${VERSION}.json`);
const ASSETS_DIR = path.resolve(__dirname, "assets");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadImageAsDataURL(imagePath: string): string | null {
  const absPath = path.resolve(__dirname, "..", imagePath);
  if (!fs.existsSync(absPath)) {
    return null;
  }
  const ext = path.extname(absPath).toLowerCase().replace(".", "");
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] ?? "image/jpeg";
  const data = fs.readFileSync(absPath).toString("base64");
  return `data:${mime};base64,${data}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printTable(results: EvalResult[]): void {
  const header = ["ID", "Pass", "Score", "Surface", "Duration(ms)", "Failure"].join(" | ");
  const sep = "-".repeat(header.length);
  console.log("\n" + sep);
  console.log(header);
  console.log(sep);
  for (const r of results) {
    const row = [
      r.id.padEnd(8),
      (r.passed ? "✓ PASS" : "✗ FAIL").padEnd(6),
      String(Math.round(r.score * 100) + "%").padEnd(5),
      (r.interpretation?.primarySurface ?? "—").padEnd(14),
      String(r.durationMs).padEnd(12),
      (r.failureReason ?? "").slice(0, 40),
    ].join(" | ");
    console.log(row);
  }
  console.log(sep + "\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🎨 ZyntriStudio Evaluation Runner — ${VERSION}\n`);

  if (!process.env.OPENAI_API_KEY) {
    console.error("ERROR: OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  // Load test cases
  const testCases: EvalTestCase[] = JSON.parse(
    fs.readFileSync(TEST_CASES_PATH, "utf-8")
  );
  console.log(`Loaded ${testCases.length} test cases.\n`);

  const results: EvalResult[] = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`[${i + 1}/${testCases.length}] Running ${tc.id}: "${tc.instruction}"`);

    const start = Date.now();

    // Load images
    const baseImageB64 = loadImageAsDataURL(tc.base_image);
    if (!baseImageB64) {
      console.log(`  ⚠ Skipped – base image not found: ${tc.base_image}`);
      results.push({
        id: tc.id,
        passed: false,
        score: 0,
        interpretation: null,
        editPlan: null,
        qualityCheck: null,
        assistantMessage: "",
        failureReason: `missing_asset: ${tc.base_image}`,
        durationMs: 0,
      });
      continue;
    }

    const referenceImageB64 = tc.reference_image
      ? loadImageAsDataURL(tc.reference_image)
      : undefined;

    const request: EditRequest = {
      sessionId: `eval_${tc.id}`,
      instruction: tc.instruction,
      surfaceHint: "auto",
      baseImageB64,
      referenceImageB64: referenceImageB64 ?? undefined,
      conversationHistory: [],
    };

    let result: EvalResult;

    try {
      const response = await runPipeline(request);
      const durationMs = Date.now() - start;

      // ── Pass/fail logic ──────────────────────────────────────────────────
      const surfaceMatch =
        response.interpretation.primarySurface === tc.expected_surface;
      const hasImage = !!response.outputImageB64;
      const qualityOk =
        response.qualityCheck != null
          ? response.qualityCheck.score >= 0.65
          : false;
      const noError = !response.error;

      const passed = surfaceMatch && hasImage && qualityOk && noError;

      let failureReason: string | null = null;
      if (!passed) {
        const reasons: string[] = [];
        if (!surfaceMatch)
          reasons.push(
            `surface_mismatch(got=${response.interpretation.primarySurface},expected=${tc.expected_surface})`
          );
        if (!hasImage) reasons.push("no_image_produced");
        if (!qualityOk)
          reasons.push(
            `quality_too_low(${Math.round((response.qualityCheck?.score ?? 0) * 100)}%)`
          );
        if (!noError) reasons.push(`error: ${response.error}`);
        failureReason = reasons.join("; ");
      }

      result = {
        id: tc.id,
        passed,
        score: response.qualityCheck?.score ?? 0,
        interpretation: response.interpretation,
        editPlan: response.editPlan,
        qualityCheck: response.qualityCheck,
        assistantMessage: response.assistantMessage,
        failureReason,
        durationMs,
      };

      console.log(
        `  ${passed ? "✓ PASS" : "✗ FAIL"} | score=${Math.round(result.score * 100)}% | ${durationMs}ms`
      );
      if (failureReason) console.log(`  Reason: ${failureReason}`);
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ERROR: ${errMsg}`);
      result = {
        id: tc.id,
        passed: false,
        score: 0,
        interpretation: null,
        editPlan: null,
        qualityCheck: null,
        assistantMessage: "",
        failureReason: `exception: ${errMsg}`,
        durationMs,
      };
    }

    results.push(result);

    // Rate-limit: wait 2s between calls to avoid hitting OpenAI limits
    if (i < testCases.length - 1) {
      await sleep(2000);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const accuracy = passed / results.length;
  const avgScore =
    results.reduce((sum, r) => sum + r.score, 0) / results.length;
  const avgDurationMs =
    results.reduce((sum, r) => sum + r.durationMs, 0) / results.length;

  const summary: EvalSummary = {
    version: VERSION,
    timestamp: new Date().toISOString(),
    totalCases: results.length,
    passed,
    failed,
    accuracy,
    avgScore,
    avgDurationMs,
    results,
  };

  // Write results file
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2));

  // Print table
  printTable(results);

  console.log("═".repeat(50));
  console.log(`  Version:    ${VERSION}`);
  console.log(`  Total:      ${results.length}`);
  console.log(`  Passed:     ${passed}`);
  console.log(`  Failed:     ${failed}`);
  console.log(`  Accuracy:   ${(accuracy * 100).toFixed(1)}%`);
  console.log(`  Avg Score:  ${(avgScore * 100).toFixed(1)}%`);
  console.log(`  Avg Time:   ${Math.round(avgDurationMs)}ms`);
  console.log("═".repeat(50));
  console.log(`\nResults saved to: ${RESULTS_PATH}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
