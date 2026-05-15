# ZyntriStudio

> [ONE-SENTENCE PITCH: e.g. "A conversational AI mockup assistant that places your design onto any surface photo with realistic lighting and perspective."]

---

## Screenshots

<!-- Add screenshots here after running the app -->
| Input | Output |
|-------|--------|
| *(screenshot)* | *(screenshot)* |

---

## What it does

<!-- 2–3 sentences: what the app does, who it's for, what makes it different -->

---

## Requirements

- Node.js 18 or later
- npm 9 or later
- An OpenAI API key with access to **gpt-4o-mini**, **gpt-image-1**, and **dall-e-3**

> Only `OPENAI_API_KEY` is required. No other services, databases, or API keys needed.

---

## Setup (from a fresh clone)

### 1. Clone

```bash
git clone <repo-url>
cd zyntri-studio
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create your environment file

```bash
cp .env.example .env.local
```

Open `.env.local` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-...your-key-here...
```

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## How to use

1. Upload your **design / pattern / artwork** (required)
2. Upload a **surface photo** — the object or room you want the design applied to (optional)
3. Select a **target surface** or leave on Auto-detect
4. Type your instruction, e.g. *"Put this logo on the wall above the TV"*
5. Press Enter — ZyntriStudio will:
   - Interpret your request using GPT-4o-mini vision
   - Generate a structured edit plan
   - Ask a clarification question if the target is ambiguous
   - Detect the surface area and build a precise inpainting mask
   - Apply your design using gpt-image-1 (preserving everything outside the mask)
   - Run a quality check and show a score
   - Explain what was done in plain language
6. Follow up with refinements like *"make it smaller"* or *"move it to the left"*

---

## Supported surfaces (v1)

| Surface | Notes |
|---------|-------|
| Shirt / Clothing | Works best with plain, front-facing shirts |
| Wall | Works best with unobstructed wall sections |
| Mug / Cup | Works best with plain ceramic mugs |
| Notebook | Works best with closed notebooks, cover visible |
| Poster / Frame | Works best with clearly framed posters |
| Cardboard Box | Works best with front face visible |
| Field / Grass Area | Works best with open, flat grass fields |

---

## Common failures

- **Cluttered surface photos**: too many objects near the target surface can confuse placement
- **Very dark designs on dark surfaces**: low contrast makes the result hard to see
- **Unsupported surfaces**: cars, shoes, etc. are gracefully rejected with an explanation
- **Ambiguous targets**: ZyntriStudio will ask a clarification question before proceeding

---

## Running the evaluation

```bash
# Add your test images to eval/assets/base/ and eval/assets/reference/
# then run:

npm run eval

# For a specific version label:
VERSION=v2 npm run eval
VERSION=v3 npm run eval
```

Results are saved to `eval/results_<version>.json`. See `eval/summary.md` for methodology.

---

## Project structure

```
zyntri-studio/
├── src/
│   ├── pages/
│   │   ├── index.tsx              # Main UI
│   │   └── api/edit.ts            # POST /api/edit
│   ├── lib/
│   │   ├── openai.ts              # OpenAI client singleton
│   │   └── pipeline/
│   │       ├── index.ts           # Orchestrator (Steps 1–6)
│   │       ├── step1_interpret.ts # Vision interpretation
│   │       ├── step2_plan.ts      # Edit plan generation
│   │       ├── step4_composite.ts # Mockup compositing
│   │       ├── step5_validate.ts  # Quality control
│   │       └── step6_respond.ts   # Conversational response
│   ├── types/index.ts             # Shared TypeScript types
│   └── styles/
├── eval/
│   ├── test_cases.json            # 10 labeled test cases
│   ├── run_eval.ts                # Evaluation runner
│   ├── results_v1.json            # Eval results v1
│   ├── results_v2.json            # Eval results v2
│   ├── results_v3.json            # Eval results v3
│   ├── summary.md                 # Methodology and results table
│   └── assets/
│       ├── base/                  # Surface photos for eval
│       └── reference/             # Design images for eval
├── .env.example
├── package.json
├── README.md
└── REPORT.md
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key — the only required secret |
