/**
 * ZyntriStudio – OpenAI client singleton
 * Only OPENAI_API_KEY is required.
 */
import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Copy .env.example to .env.local and add your key."
      );
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}
