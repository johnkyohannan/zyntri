/**
 * ZyntriStudio – Main Page
 *
 * Conversational surface-restyling assistant.
 * Layout: left panel (inputs) + right panel (chat + output).
 */

import React, { useState, useRef, useCallback, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  ChatMessage,
  EditResponse,
  SurfaceCategory,
} from "../types";
import { SURFACE_LABELS, SUPPORTED_SURFACES } from "../types";
import styles from "../styles/Home.module.css";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ImageDropZoneProps {
  label: string;
  sublabel: string;
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  required?: boolean;
}

function ImageDropZone({ label, sublabel, value, onChange, required }: ImageDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const url = await fileToDataURL(file);
      onChange(url);
    },
    [onChange]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div className={styles.dropZoneWrapper}>
      <label className={styles.fieldLabel}>
        {label}
        {required && <span className={styles.required}>*</span>}
      </label>
      <p className={styles.fieldSub}>{sublabel}</p>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dropZoneDragging : ""} ${value ? styles.dropZoneFilled : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        aria-label={`Upload ${label}`}
        onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
      >
        {value ? (
          <div className={styles.dropZonePreview}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="Preview" className={styles.previewImg} />
            <button
              className={styles.removeBtn}
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
              aria-label="Remove image"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className={styles.dropZonePlaceholder}>
            <span className={styles.dropIcon}>⬆</span>
            <span>Drop image or click to upload</span>
            <span className={styles.dropHint}>PNG, JPG, WEBP · max 10 MB</span>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className={styles.hiddenInput}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ─── Quality badge ────────────────────────────────────────────────────────────

function QualityBadge({ score, passed }: { score: number; passed: boolean }) {
  const pct = Math.round(score * 100);
  const color = passed ? "var(--success)" : score > 0.4 ? "var(--warning)" : "var(--error)";
  return (
    <span className={styles.qualityBadge} style={{ color }}>
      {passed ? "✓" : "⚠"} Quality {pct}%
    </span>
  );
}

// ─── Chat message bubble ──────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant}`}>
      <div className={styles.bubbleHeader}>
        <span className={styles.bubbleRole}>{isUser ? "You" : "ZyntriStudio"}</span>
        <span className={styles.bubbleTime}>{formatTime(msg.timestamp)}</span>
      </div>
      <p className={styles.bubbleText}>{msg.content}</p>

      {msg.mockupSteps && msg.mockupSteps.length > 0 && (
        <details className={styles.planDetails}>
          <summary>Mockup steps</summary>
          <ol className={styles.mockupStepsList}>
            {msg.mockupSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      {msg.editPlan && (
        <details className={styles.planDetails}>
          <summary>Edit plan</summary>
          <div className={styles.planGrid}>
            <span>Surface</span><span>{msg.editPlan.targetSurface}</span>
            <span>Type</span><span>{msg.editPlan.editType}</span>
            <span>Blend</span><span>{msg.editPlan.blendMode}</span>
            <span>Opacity</span><span>{Math.round(msg.editPlan.opacity * 100)}%</span>
            <span>Difficulty</span><span>{msg.editPlan.estimatedDifficulty}</span>
          </div>
          {msg.editPlan.warningFlags.length > 0 && (
            <p className={styles.planWarning}>⚠ {msg.editPlan.warningFlags.join(" · ")}</p>
          )}
        </details>
      )}

      {msg.outputImageUrl && (
        <div className={styles.outputImageWrapper}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={msg.outputImageUrl} alt="Edited output" className={styles.outputImage} />
          <a
            href={msg.outputImageUrl}
            download="zyntristudio-output.png"
            className={styles.downloadBtn}
          >
            ↓ Download
          </a>
          {msg.qualityCheck && (
            <QualityBadge score={msg.qualityCheck.score} passed={msg.qualityCheck.passed} />
          )}
        </div>
      )}

      {msg.qualityCheck?.suggestions && msg.qualityCheck.suggestions.length > 0 && (
        <div className={styles.suggestions}>
          <p className={styles.suggestionsLabel}>Suggestions:</p>
          <ul>
            {msg.qualityCheck.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Home() {
  const [sessionId] = useState(() => uuidv4());
  const [baseImage, setBaseImage] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [surfaceHint, setSurfaceHint] = useState<SurfaceCategory>("auto");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(async () => {
    if (!instruction.trim() || !baseImage || loading) return;

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: "user",
      content: instruction.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInstruction("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          instruction: userMsg.content,
          surfaceHint,
          baseImageB64: baseImage,
          referenceImageB64: referenceImage ?? undefined,
          conversationHistory: messages,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error ?? `HTTP ${res.status}`);
      }

      const data: EditResponse = await res.json();

      const assistantMsg: ChatMessage = {
        id: uuidv4(),
        role: "assistant",
        content: data.assistantMessage,
        timestamp: Date.now(),
        editPlan: data.editPlan ?? undefined,
        outputImageUrl: data.outputImageB64 ?? undefined,
        qualityCheck: data.qualityCheck ?? undefined,
        mockupSteps: data.mockupSteps?.length ? data.mockupSteps : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);

      if (data.error && !data.outputImageB64) {
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setMessages((prev) => [
        ...prev,
        {
          id: uuidv4(),
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [instruction, baseImage, referenceImage, surfaceHint, sessionId, messages, loading]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit = !!baseImage && !!instruction.trim() && !loading;

  return (
    <div className={styles.layout}>
      {/* ── Left panel: inputs ── */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h1 className={styles.logo}>
            <span className={styles.logoAccent}>Zyntri</span>Studio
          </h1>
          <p className={styles.tagline}>Conversational surface-restyling assistant</p>
        </div>

        <div className={styles.sidebarBody}>
          <ImageDropZone
            label="Design / Pattern / Artwork"
            sublabel="The texture, pattern, or design you want to apply"
            value={baseImage}
            onChange={setBaseImage}
            required
          />

          <ImageDropZone
            label="Surface Photo"
            sublabel="Optional: the object or surface to apply the design onto"
            value={referenceImage}
            onChange={setReferenceImage}
          />

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="surface-select">
              Target Surface
            </label>
            <p className={styles.fieldSub}>Let AI decide, or pick a surface</p>
            <select
              id="surface-select"
              className={styles.select}
              value={surfaceHint}
              onChange={(e) => setSurfaceHint(e.target.value as SurfaceCategory)}
            >
              <option value="auto">Auto-detect</option>
              {SUPPORTED_SURFACES.map((s) => (
                <option key={s} value={s}>
                  {SURFACE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.supportedNote}>
            <p className={styles.supportedTitle}>Supported surfaces (v1)</p>
            <div className={styles.surfacePills}>
              {SUPPORTED_SURFACES.map((s) => (
                <span key={s} className={styles.pill}>{SURFACE_LABELS[s]}</span>
              ))}
            </div>
          </div>

          <div className={styles.disclaimer}>
            ⚠ Outputs are visual mockups, not physically accurate previews.
          </div>
        </div>
      </aside>

      {/* ── Right panel: chat ── */}
      <main className={styles.chatPanel}>
        <div className={styles.chatHeader}>
          <span className={styles.chatTitle}>Design Chat</span>
          {messages.length > 0 && (
            <button
              className={styles.clearBtn}
              onClick={() => { setMessages([]); setError(null); }}
            >
              Clear
            </button>
          )}
        </div>

        <div className={styles.chatMessages} role="log" aria-live="polite">
          {messages.length === 0 && !loading && (
            <div className={styles.emptyState}>
              <div className={styles.welcomeMessage}>
                <p className={styles.welcomeTitle}>Welcome to ZyntriStudio</p>
                <p className={styles.welcomeSub}>Your conversational surface-restyling assistant</p>
              </div>
              <p className={styles.emptyTitle}>Get started</p>
              <p className={styles.emptySub}>
                Upload your design or pattern, optionally add a surface photo,
                then describe how you want it applied.
              </p>
              <div className={styles.examplePrompts}>
                <p className={styles.examplesLabel}>Try asking:</p>
                {[
                  "Apply this floral pattern to a shirt",
                  "Put this design on a wall",
                  "Wrap this artwork around a mug",
                  "Paint this logo onto a grass field",
                ].map((p) => (
                  <button
                    key={p}
                    className={styles.exampleBtn}
                    onClick={() => setInstruction(p)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}

          {loading && (
            <div className={styles.loadingBubble}>
              <span className={styles.loadingDot} />
              <span className={styles.loadingDot} />
              <span className={styles.loadingDot} />
              <span className={styles.loadingText}>ZyntriStudio is working…</span>
            </div>
          )}

          {error && (
            <div className={styles.errorBanner} role="alert">
              <strong>Error:</strong> {error}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        <div className={styles.inputArea}>
          {!baseImage && (
            <p className={styles.inputHint}>Upload a design or pattern to get started</p>
          )}
          <div className={styles.inputRow}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder={
                baseImage
                  ? "Describe how to apply the design… (Enter to send, Shift+Enter for newline)"
                  : "Upload a design or pattern first"
              }
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!baseImage || loading}
              rows={2}
              aria-label="Edit instruction"
            />
            <button
              className={styles.sendBtn}
              onClick={handleSubmit}
              disabled={!canSubmit}
              aria-label="Send"
            >
              {loading ? (
                <span className={styles.sendSpinner} />
              ) : (
                <span>→</span>
              )}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
