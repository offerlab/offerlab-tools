/**
 * The Gemini call behind "Pitch them": one request through the finder's /api/gemini proxy,
 * answered as JSON matching the schema in pitch-prompt.js.
 */
import { jsonrepair } from '$lib/shared/vendor/jsonrepair/regular/jsonrepair.js';
import { CONFIG } from './util.js';
import { PITCH_SYSTEM_PROMPT, buildPitchUserPrompt } from './pitch-prompt.js';

export const PITCH_MODELS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Fast)' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Best)' }
];

export async function generatePitchContent(brand1, brand2, model, context, { signal } = {}) {
  const requestBody = {
    system_instruction: {
      parts: [{ text: PITCH_SYSTEM_PROMPT }]
    },
    contents: [{
      parts: [{ text: buildPitchUserPrompt(brand1, brand2, context) }]
    }],
    generationConfig: {
      temperature: 0.8,
      topP: 0.95,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  };

  const response = await fetch(`${CONFIG.GEMINI_PROXY}?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `API request failed (${response.status})`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.find(p => p.text)?.text;
  if (!text) {
    console.error('[Pitch] No text found in parts:', JSON.stringify(parts).substring(0, 300));
    throw new Error('No response from Gemini');
  }

  // Gemini sometimes wraps the JSON in markdown fences even with responseMimeType set.
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(jsonrepair(cleaned));
    } catch {
      console.error('[Pitch] Failed to parse JSON:', cleaned.substring(0, 300));
      throw new Error('Failed to parse Gemini response as JSON');
    }
  }
}
