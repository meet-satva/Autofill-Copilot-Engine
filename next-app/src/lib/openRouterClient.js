import OpenAI from 'openai';

let client = null;

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_TEXT_MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4';
export const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash';

export function getOpenRouterClient() {
  if (client) return client;
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  client = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
  });
  return client;
}

export async function chatCompletion({ messages, model = OPENROUTER_TEXT_MODEL, maxTokens = 2000 }) {
  const openrouter = getOpenRouterClient();
  if (!openrouter) {
    throw new Error('OPENROUTER_API_KEY is not set in .env');
  }
  const response = await openrouter.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
  });
  return response.choices[0]?.message?.content || '';
}

export async function parseDocumentWithVision({ prompt, imageFiles = [], textParts = [], model = OPENROUTER_VISION_MODEL }) {
  const content = [{ type: 'text', text: prompt }];

  for (const file of imageFiles) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${file.mimeType};base64,${file.base64}` },
    });
  }

  if (textParts.length > 0) {
    content.push({
      type: 'text',
      text: `\n\n--- Additional extracted text content ---\n${textParts.join('\n\n')}`,
    });
  }

  return chatCompletion({
    model,
    maxTokens: 2000,
    messages: [{ role: 'user', content }],
  });
}
