/**
 * ZyntriStudio – Input sanitization and security utilities
 */

export const MAX_INSTRUCTION_LENGTH = 500;
export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_MSG_LENGTH = 300;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+(instructions?|prompts?|rules?|context)/i,
  /forget\s+(everything|all|previous|prior|your\s+instructions?)/i,
  /you\s+are\s+now\s+(a\s+)?(?!ZyntriStudio)/i,
  /act\s+as\s+(if\s+you\s+are\s+)?(?!a\s+designer|an?\s+assistant)/i,
  /system\s*:\s*you/i,
  /\[system\]/i,
  /<\s*system\s*>/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /override\s+(your\s+)?(safety|content|system)/i,
  /disregard\s+(your\s+)?(instructions?|guidelines?|rules?)/i,
];

export function sanitizeInstruction(raw: string): string {
  if (typeof raw !== "string") throw new Error("Instruction must be a string.");

  let cleaned = raw
    .replace(/\0/g, "")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .trim();

  if (cleaned.length === 0) cleaned = "Apply this design to the surface.";

  if (cleaned.length > MAX_INSTRUCTION_LENGTH) {
    throw new Error(`Instruction is too long (max ${MAX_INSTRUCTION_LENGTH} characters).`);
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      throw new Error(
        "Your instruction contains content that cannot be processed. Please describe the design edit you want."
      );
    }
  }

  return cleaned;
}

export function sanitizeHistory(
  history: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return [];

  return history
    .slice(-MAX_HISTORY_TURNS)
    .map((msg) => {
      if (typeof msg?.content !== "string") return null;
      let content = msg.content
        .replace(/\0/g, "")
        .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .slice(0, MAX_HISTORY_MSG_LENGTH);

      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(content)) {
          content = "[message removed for safety]";
          break;
        }
      }

      return { role: msg.role === "user" ? "user" : "assistant", content };
    })
    .filter(Boolean) as Array<{ role: string; content: string }>;
}

export function validateImageDataURL(dataUrl: string, fieldName: string): void {
  if (typeof dataUrl !== "string") throw new Error(`${fieldName} must be a string.`);

  const match = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,/i);
  if (!match) {
    throw new Error(`${fieldName} must be a valid base64 image data URL.`);
  }

  const mime = match[1].toLowerCase();
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  if (!allowed.includes(mime)) {
    throw new Error(`${fieldName} has unsupported format "${mime}". Use JPEG, PNG, GIF, or WebP.`);
  }

  const base64Data = dataUrl.split(",")[1] ?? "";
  const decodedBytes = Math.floor((base64Data.length * 3) / 4);
  if (decodedBytes > MAX_IMAGE_BYTES) {
    throw new Error(`${fieldName} exceeds the 10 MB size limit.`);
  }
}

export function wrapInstruction(instruction: string): string {
  const escaped = instruction.replace(/"/g, '\\"').replace(/`/g, "\\`");
  return `[USER_DESIGN_REQUEST_START]\n${escaped}\n[USER_DESIGN_REQUEST_END]`;
}
