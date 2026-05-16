# ZyntriStudio

ZyntriStudio is an AI-powered mockup assistant that places your design, logo, or pattern onto any surface photo you provide to test out your design needs.
---

## What it does

Upload a design and a photo of the surface you want it applied to. A shirt, wall, mug, notebook, or other object works well. ZyntriStudio uses a multi-step AI pipeline to detect the surface, build a precise mask, and applies your design with matching lighting and perspective using gpt-image-1. Unlike a simple image generator, it edits your actual photo rather than generating a new scene, so the the original surface image remains the same
---

## Requirements

- Node.js 18 or later
- npm 9 or later
- An OpenAI API key with access to gpt-4o-mini, gpt-image-1, and dall-e-3

> Only `OPENAI_API_KEY` is required. No other services or API keys needed.

---

## Setup

### 1. Clone

```bash
git clone https://github.com/johnkyohannan/zyntri.git
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

Open `.env.local` and add your key:

```
OPENAI_API_KEY=sk-...
```

### 4. Run the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## How to use

1. Upload your design or artwork in the left panel (required)
2. Upload a surface photo and specify the object or room you want the design applied to (required)
3. Select a target surface from the dropdown, or leave it on Auto-detect
4. Click Generate or type a specific instruction first, like "put this on the wall above the TV"
5. View the result, quality score, and explanation in the chat panel
6. Refine with follow-up messages like "make it smaller" or "move it to the left"

---

## Running the evaluation

```bash
npm run eval

# For a specific version:
VERSION=v2 npm run eval
VERSION=v3 npm run eval
```
Note: Before running, place your test images in eval/assets/base/ (surface photos) and eval/assets/reference/ (design images) matching the filenames in test_cases.json. Images must be JPEG or PNG.

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key — the only required secret |
