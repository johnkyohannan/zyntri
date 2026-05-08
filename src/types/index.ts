// ─────────────────────────────────────────────
//  ZyntriStudio – shared type definitions
// ─────────────────────────────────────────────

/** Surfaces supported in v1 */
export type SurfaceCategory =
  | "shirt"
  | "wall"
  | "mug"
  | "notebook"
  | "poster"
  | "cardboard_box"
  | "field_grass"
  | "auto"; // let the AI decide

export const SURFACE_LABELS: Record<SurfaceCategory, string> = {
  shirt: "Shirt / Clothing",
  wall: "Wall / Surface",
  mug: "Mug / Cup",
  notebook: "Notebook / Book",
  poster: "Poster / Frame",
  cardboard_box: "Cardboard Box",
  field_grass: "Field / Grass Area",
  auto: "Auto-detect",
};

export const SUPPORTED_SURFACES: SurfaceCategory[] = [
  "shirt",
  "wall",
  "mug",
  "notebook",
  "poster",
  "cardboard_box",
  "field_grass",
];

// ─── Pipeline step results ────────────────────

/** Step 1 – Vision interpretation */
export interface InterpretationResult {
  detectedSurfaces: SurfaceCategory[];
  primarySurface: SurfaceCategory | null;
  isAmbiguous: boolean;
  clarificationQuestion: string | null;
  confidence: number; // 0–1
  unsupportedReason: string | null;
  isSafe: boolean;
  safetyNote: string | null;
}

/** Step 2 – Edit plan */
export interface EditPlan {
  targetSurface: SurfaceCategory;
  editType: "texture_overlay" | "pattern_apply" | "color_restyle" | "artwork_transfer";
  blendMode: "normal" | "multiply" | "overlay" | "soft_light";
  opacity: number; // 0–1
  preserveShading: boolean;
  perspectiveAware: boolean;
  colorAdjustment: string | null;
  additionalNotes: string;
  estimatedDifficulty: "easy" | "medium" | "hard";
  warningFlags: string[];
}

/** Step 5 – Quality control */
export interface QualityCheckResult {
  passed: boolean;
  score: number; // 0–1
  issues: string[];
  suggestions: string[];
  summary: string;
}

// ─── Conversation ─────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  // optional structured data attached to assistant messages
  editPlan?: EditPlan;
  outputImageUrl?: string;
  qualityCheck?: QualityCheckResult;
}

// ─── API request / response shapes ───────────

export interface EditRequest {
  sessionId: string;
  instruction: string;
  surfaceHint: SurfaceCategory;
  baseImageB64: string;       // base64 data URL
  referenceImageB64?: string; // optional
  conversationHistory: ChatMessage[];
}

export interface EditResponse {
  sessionId: string;
  interpretation: InterpretationResult;
  editPlan: EditPlan | null;
  outputImageB64: string | null;
  qualityCheck: QualityCheckResult | null;
  assistantMessage: string;
  clarificationNeeded: boolean;
  clarificationQuestion: string | null;
  error: string | null;
}

// ─── Eval types ───────────────────────────────

export interface EvalTestCase {
  id: string;
  base_image: string;
  reference_image: string | null;
  instruction: string;
  expected_surface: SurfaceCategory;
  expected_behavior: string;
  pass_criteria: string[];
  notes: string;
}

export interface EvalResult {
  id: string;
  passed: boolean;
  score: number;
  interpretation: InterpretationResult | null;
  editPlan: EditPlan | null;
  qualityCheck: QualityCheckResult | null;
  assistantMessage: string;
  failureReason: string | null;
  durationMs: number;
}

export interface EvalSummary {
  version: string;
  timestamp: string;
  totalCases: number;
  passed: number;
  failed: number;
  accuracy: number;
  avgScore: number;
  avgDurationMs: number;
  results: EvalResult[];
}
