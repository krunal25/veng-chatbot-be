import { Injectable } from '@nestjs/common';

export type PartsIntent = {
  isPartsQuery: boolean;
  brand?: string;
  model?: string;
  vehicleId?: string;
  partTerms: string[];
};

export type GroundedPartContext = {
  name: string;
  partNumber: string;
  brand?: string;
  model?: string;
  availability?: string;
  price?: number;
  fitment?: string;
};

@Injectable()
export class GeminiService {
  private static readonly MAX_PROMPT_LENGTH = 3500;
  private static readonly MAX_RESPONSE_LENGTH = 1200;
  private static readonly RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

  private readonly apiKey = (process.env.GEMINI_API_KEY || '').trim();
  private readonly model = (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim();
  private readonly enabled = (process.env.GEMINI_ENABLED || 'false').toLowerCase() === 'true' && !!this.apiKey;
  private readonly fallbackModels = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-001'];

  isEnabled(): boolean {
    return this.enabled;
  }

  async generateVengReply(userInput: string): Promise<string | null> {
    if (!this.enabled || !userInput?.trim()) return null;

    const prompt = [
      'You are VENG customer support assistant for car spare parts (catalog/search/pricing/availability/compatibility).',
      'Strict scope: part search help, part-number search, vehicle fitment guidance, parts availability and pricing (only after a part match), compatible accessory recommendations.',
      'Allowed intents: finding parts in the catalog, checking availability wording (In stock / On order / backorder), compatibility questions (need VIN/registration or vehicle details), and sourcing a part not listed (Ask Admin).',
      'Not in scope for this assistant: store policy questions (returns/refunds/coupons), general company/industry/history/ownership questions, and non-parts legal/policy questions.',
      'If the question is out of scope, clearly say it is outside VENG parts support scope and suggest using Google or Ask Admin.',
      'Keep answers concise (2-4 sentences), practical, and safe.',
      'Never invent prices, stock, or fitment certainty without required details.',
      'For fitment questions, ask for VIN/registration, make/model/year, and engine (if relevant) and side/front-rear when missing.',
      '',
      `User question: ${this.safePromptInput(userInput)}`,
    ].join('\n');

    const models = [this.model, ...this.fallbackModels].filter(Boolean);
    const tried = new Set<string>();

    for (const candidate of models) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);

      const text = await this.generateWithModel(candidate, prompt, {
        temperature: 0.2,
        maxOutputTokens: 220,
        timeoutMs: 7000,
      });

      if (text) return text;
    }

    return null;
  }

  async extractPartsIntent(userInput: string): Promise<PartsIntent | null> {
    if (!this.enabled || !userInput?.trim()) return null;

    const prompt = [
      'Extract structured fields from this auto-parts user query.',
      'Return JSON only. No markdown. No explanation.',
      'Schema:',
      '{"isPartsQuery":boolean,"brand":string|null,"model":string|null,"vehicleId":string|null,"partTerms":string[]}',
      'Rules:',
      '- brand should be canonical if clear (BMW, Audi, Toyota, Mercedes-Benz, etc).',
      '- model should preserve user model style when possible (X5, X4, Land Cruiser, Civic, etc).',
      '- vehicleId is a registration/vehicle code if present (example EV80744).',
      '- partTerms should contain specific part names, lower-case, deduplicated.',
      '- Set isPartsQuery=true if user asks for availability/price/fitment/search of car parts.',
      '',
      `User query: ${this.safePromptInput(userInput)}`,
    ].join('\n');

    const models = [this.model, ...this.fallbackModels].filter(Boolean);
    const tried = new Set<string>();

    for (const candidate of models) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);

      const raw = await this.generateWithModel(candidate, prompt, {
        temperature: 0,
        maxOutputTokens: 180,
        timeoutMs: 3500,
      });

      if (!raw) continue;

      const parsed = this.parsePartsIntent(raw);
      if (parsed) return parsed;
    }

    return null;
  }

  async generateGroundedReply(
    userInput: string,
    context: {
      parts?: GroundedPartContext[];
      knowledgeSnippets?: string[];
    },
  ): Promise<string | null> {
    if (!this.enabled || !userInput?.trim()) return null;

    const parts = Array.isArray(context.parts) ? context.parts.slice(0, 8) : [];
    const snippets = Array.isArray(context.knowledgeSnippets)
      ? context.knowledgeSnippets.map((s) => this.safePromptInput(s)).filter(Boolean).slice(0, 4)
      : [];

    const partContextText = parts.length > 0
      ? parts
          .map((p, i) => {
            const priceText = typeof p.price === 'number' ? `NOK ${p.price}` : 'N/A';
            return [
              `${i + 1}. ${p.name} (${p.partNumber})`,
              `brand/model: ${p.brand || '-'} / ${p.model || '-'}`,
              `availability: ${p.availability || '-'}`,
              `price: ${priceText}`,
              `fitment: ${p.fitment || '-'}`,
            ].join(' | ');
          })
          .join('\n')
      : 'No direct catalog matches found.';

    const kbText = snippets.length > 0
      ? snippets.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : 'No additional policy/document snippets found.';

    const prompt = [
      'You are VENG auto-parts assistant.',
      'Use ONLY the provided context for factual claims about parts, stock, pricing, and policy snippets.',
      'If data is missing, clearly say what details are needed (VIN/registration, make/model/year, engine, position).',
      'Never invent a part number, price, stock, or fitment.',
      'Keep answer concise and practical in 3-6 sentences.',
      'If the user asks outside auto-parts support, say it is out of scope and redirect to parts help.',
      '',
      `User question: ${this.safePromptInput(userInput)}`,
      '',
      'Catalog matches:',
      partContextText,
      '',
      'Knowledge snippets:',
      kbText,
    ].join('\n');

    const models = [this.model, ...this.fallbackModels].filter(Boolean);
    const tried = new Set<string>();

    for (const candidate of models) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);

      const text = await this.generateWithModel(candidate, prompt, {
        temperature: 0.15,
        maxOutputTokens: 320,
        timeoutMs: 7000,
      });

      if (text) return text;
    }

    return null;
  }

  private parsePartsIntent(raw: string): PartsIntent | null {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    const candidates = [cleaned];
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
    }

    for (const text of candidates) {
      try {
        const obj = JSON.parse(text);
        const isPartsQuery = Boolean(obj?.isPartsQuery);
        const brand = typeof obj?.brand === 'string' ? obj.brand.trim().slice(0, 60) : undefined;
        const model = typeof obj?.model === 'string' ? obj.model.trim().slice(0, 60) : undefined;
        const vehicleId = typeof obj?.vehicleId === 'string' ? obj.vehicleId.trim().slice(0, 40) : undefined;
        const partTerms = Array.isArray(obj?.partTerms)
          ? obj.partTerms
              .filter((x: unknown) => typeof x === 'string')
              .map((x: string) => x.trim().toLowerCase())
              .filter((x: string) => x.length > 1)
              .slice(0, 12)
          : [];

        return {
          isPartsQuery,
          brand: brand || undefined,
          model: model || undefined,
          vehicleId: vehicleId || undefined,
          partTerms: Array.from(new Set(partTerms)),
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private async generateWithModel(
    model: string,
    prompt: string,
    options: { temperature: number; maxOutputTokens: number; timeoutMs: number },
  ): Promise<string | null> {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const text = await this.generateWithModelAttempt(model, prompt, options);
      if (text) return text;

      if (attempt < maxAttempts) {
        // Small backoff on transient failures to reduce immediate retry pressure.
        await this.delay(160 * attempt);
      }
    }

    return null;
  }

  private async generateWithModelAttempt(
    model: string,
    prompt: string,
    options: { temperature: number; maxOutputTokens: number; timeoutMs: number },
  ): Promise<string | null> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: options.temperature,
            maxOutputTokens: options.maxOutputTokens,
          },
        }),
      });

      if (!response.ok) {
        if (GeminiService.RETRYABLE_STATUS.has(response.status)) return null;
        if (response.status === 404) return null;
        return null;
      }

      const data: unknown = await response.json();
      const text = this.extractTextFromResponse(data);

      if (!text) return null;
      return text.replace(/\s+/g, ' ').trim().slice(0, GeminiService.MAX_RESPONSE_LENGTH);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractTextFromResponse(data: unknown): string {
    if (!data || typeof data !== 'object') return '';

    const root = data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    if (root.promptFeedback?.blockReason) return '';
    const first = root.candidates?.[0];
    if (!first || first.finishReason === 'SAFETY') return '';

    const parts = Array.isArray(first.content?.parts) ? first.content?.parts : [];
    if (!parts || parts.length === 0) return '';

    return parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .join(' ')
      .trim();
  }

  private safePromptInput(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, GeminiService.MAX_PROMPT_LENGTH);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
