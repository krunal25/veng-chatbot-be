import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from '../entities/message.entity';
import { Part } from '../entities/part.entity';
import { GeminiService, QueryExtractionResult } from './gemini.service';

export type QueryWidgetContext = {
  brand?: string;
  model?: string;
  variant?: string;
  year?: string;
  category?: string;
  part?: string;
};

export type StructuredQueryContext = {
  brand?: string;
  model?: string;
  variant?: string;
  year?: string;
  category?: string;
  part?: string;
  intent: string;
  language?: string;
  confidence: {
    overall: number;
    brand?: number;
    model?: number;
    variant?: number;
    year?: number;
    part?: number;
    intent?: number;
  };
  source: {
    brand?: 'widget' | 'gemini' | 'memory' | 'heuristic';
    model?: 'widget' | 'gemini' | 'memory' | 'heuristic';
    variant?: 'widget' | 'gemini' | 'memory' | 'heuristic';
    year?: 'widget' | 'gemini' | 'memory' | 'heuristic';
    part?: 'widget' | 'gemini' | 'memory' | 'heuristic';
    intent?: 'gemini' | 'heuristic';
  };
  validation: {
    brandMatched: boolean;
    modelMatched: boolean;
    variantMatched: boolean;
    partMatched: boolean;
  };
  fallbacks: string[];
  metadata: {
    alternateTerms: string[];
    notes: string[];
    previousUserMessages: string[];
  };
};

type MasterCatalog = {
  brands: string[];
  modelsByBrand: Map<string, string[]>;
  variantsByBrandModel: Map<string, string[]>;
};

@Injectable()
export class QueryUnderstandingService {
  private static readonly MASTER_DATA_TTL_MS = 60_000;

  private masterDataCache: { value: MasterCatalog; expiresAt: number } | null = null;

  constructor(
    @InjectRepository(Part)
    private readonly partRepo: Repository<Part>,
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
    private readonly geminiService: GeminiService,
  ) {}

  async understandQuery(params: {
    conversationId: string;
    userInput: string;
    widgetContext?: QueryWidgetContext;
  }): Promise<StructuredQueryContext> {
    const userInput = this.cleanText(params.userInput);
    const widgetContext = this.normalizeWidgetContext(params.widgetContext);
    const previousUserMessages = await this.getRecentUserMessages(params.conversationId);
    const memoryContext = await this.getContextFromHistory(params.conversationId);

    const extraction = this.geminiService.isEnabled()
      ? await this.geminiService.extractQueryMetadata(userInput, {
          previousUserMessages,
          widgetHints: widgetContext,
        })
      : null;

    const masterData = await this.getMasterCatalog();

    const resolvedBrand = this.resolveField({
      widgetValue: widgetContext.brand,
      aiValue: extraction?.brand,
      memoryValue: memoryContext.brand,
      validator: (value) => this.findBestMasterMatch(value, masterData.brands),
      fieldConfidence: extraction?.confidence.brand,
    });

    const modelsForBrand = resolvedBrand.value
      ? masterData.modelsByBrand.get(this.key(resolvedBrand.value)) || []
      : this.flattenMapValues(masterData.modelsByBrand);
    const resolvedModel = this.resolveField({
      widgetValue: widgetContext.model,
      aiValue: extraction?.model,
      memoryValue: memoryContext.model,
      validator: (value) => this.findBestMasterMatch(value, modelsForBrand),
      fieldConfidence: extraction?.confidence.model,
    });

    const variantsForScope = resolvedBrand.value && resolvedModel.value
      ? masterData.variantsByBrandModel.get(this.variantKey(resolvedBrand.value, resolvedModel.value)) || []
      : this.flattenMapValues(masterData.variantsByBrandModel);
    const resolvedVariant = this.resolveField({
      widgetValue: widgetContext.variant,
      aiValue: extraction?.variant,
      memoryValue: memoryContext.variant,
      validator: (value) => this.findBestMasterMatch(value, variantsForScope),
      fieldConfidence: extraction?.confidence.variant,
    });

    const resolvedPart = this.resolveField({
      widgetValue: widgetContext.part,
      aiValue: extraction?.part,
      memoryValue: memoryContext.part,
      validator: (value) => this.findBestPartHint(value),
      fieldConfidence: extraction?.confidence.part,
    });

    const resolvedYear = this.resolveField({
      widgetValue: widgetContext.year,
      aiValue: extraction?.year,
      memoryValue: memoryContext.year,
      validator: (value) => {
        const year = this.extractYear(value);
        return year ? { value: year, confidence: 0.88 } : null;
      },
      fieldConfidence: extraction?.confidence.year,
    });

    const heurIntent = this.inferIntentHeuristically(userInput);
    const intent = this.pickIntent(extraction, heurIntent);

    const confidenceOverall = this.computeOverallConfidence([
      resolvedBrand.confidence,
      resolvedModel.confidence,
      resolvedVariant.confidence,
      resolvedPart.confidence,
      resolvedYear.confidence,
      extraction?.confidence.intent,
      extraction?.confidence.overall,
    ]);

    const fallbacks: string[] = [];
    if (!resolvedBrand.value && !resolvedModel.value) {
      fallbacks.push('missing_vehicle_context');
    }
    if (!resolvedPart.value && !this.looksLikePartSearch(userInput)) {
      fallbacks.push('missing_part_context');
    }
    if (confidenceOverall < 0.55) {
      fallbacks.push('low_overall_confidence');
    }

    return {
      brand: resolvedBrand.value,
      model: resolvedModel.value,
      variant: resolvedVariant.value,
      year: resolvedYear.value,
      part: resolvedPart.value,
      category: widgetContext.category,
      intent,
      language: extraction?.language,
      confidence: {
        overall: confidenceOverall,
        brand: resolvedBrand.confidence,
        model: resolvedModel.confidence,
        variant: resolvedVariant.confidence,
        year: resolvedYear.confidence,
        part: resolvedPart.confidence,
        intent: extraction?.confidence.intent,
      },
      source: {
        brand: resolvedBrand.source,
        model: resolvedModel.source,
        variant: resolvedVariant.source,
        year: resolvedYear.source,
        part: resolvedPart.source,
        intent: extraction?.intent ? 'gemini' : 'heuristic',
      },
      validation: {
        brandMatched: resolvedBrand.matched,
        modelMatched: resolvedModel.matched,
        variantMatched: resolvedVariant.matched,
        partMatched: resolvedPart.matched,
      },
      fallbacks,
      metadata: {
        alternateTerms: extraction?.alternateTerms || [],
        notes: extraction?.notes || [],
        previousUserMessages,
      },
    };
  }

  private async getMasterCatalog(): Promise<MasterCatalog> {
    if (this.masterDataCache && Date.now() < this.masterDataCache.expiresAt) {
      return this.masterDataCache.value;
    }

    const rows = await this.partRepo
      .createQueryBuilder('part')
      .select(['part.brand AS brand', 'part.model AS model', 'part.variant AS variant'])
      .where('part.brand IS NOT NULL')
      .andWhere('part.model IS NOT NULL')
      .take(15000)
      .getRawMany<{ brand?: string; model?: string; variant?: string }>();

    const brandSet = new Set<string>();
    const modelsByBrand = new Map<string, Set<string>>();
    const variantsByBrandModel = new Map<string, Set<string>>();

    for (const row of rows) {
      const brand = this.cleanText(row.brand);
      const model = this.cleanText(row.model);
      const variant = this.cleanText(row.variant);
      if (!brand || !model) continue;

      brandSet.add(brand);
      const bKey = this.key(brand);
      if (!modelsByBrand.has(bKey)) modelsByBrand.set(bKey, new Set<string>());
      modelsByBrand.get(bKey)!.add(model);

      if (variant) {
        const vmKey = this.variantKey(brand, model);
        if (!variantsByBrandModel.has(vmKey)) variantsByBrandModel.set(vmKey, new Set<string>());
        variantsByBrandModel.get(vmKey)!.add(variant);
      }
    }

    const toArrayMap = (input: Map<string, Set<string>>): Map<string, string[]> => {
      const out = new Map<string, string[]>();
      for (const [k, values] of input.entries()) {
        out.set(k, Array.from(values));
      }
      return out;
    };

    const value: MasterCatalog = {
      brands: Array.from(brandSet),
      modelsByBrand: toArrayMap(modelsByBrand),
      variantsByBrandModel: toArrayMap(variantsByBrandModel),
    };

    this.masterDataCache = {
      value,
      expiresAt: Date.now() + QueryUnderstandingService.MASTER_DATA_TTL_MS,
    };

    return value;
  }

  private resolveField(params: {
    widgetValue?: string;
    aiValue?: string;
    memoryValue?: string;
    validator: (value: string) => { value: string; confidence: number } | null;
    fieldConfidence?: number;
  }): {
    value?: string;
    confidence?: number;
    matched: boolean;
    source?: 'widget' | 'gemini' | 'memory' | 'heuristic';
  } {
    const tryResolve = (
      value: string | undefined,
      source: 'widget' | 'gemini' | 'memory' | 'heuristic',
      confidenceBoost: number,
    ) => {
      if (!value) return null;
      const matched = params.validator(value);
      if (!matched) return null;
      return {
        value: matched.value,
        confidence: this.clampConfidence((params.fieldConfidence || 0.65) * matched.confidence * confidenceBoost),
        matched: true,
        source,
      };
    };

    const widgetResolved = tryResolve(params.widgetValue, 'widget', 1.25);
    if (widgetResolved) return widgetResolved;

    const aiResolved = tryResolve(params.aiValue, 'gemini', 1);
    if (aiResolved) return aiResolved;

    const memoryResolved = tryResolve(params.memoryValue, 'memory', 0.92);
    if (memoryResolved) return memoryResolved;

    return { value: undefined, confidence: 0, matched: false, source: undefined };
  }

  private findBestPartHint(value: string): { value: string; confidence: number } | null {
    const cleaned = this.cleanText(value);
    if (!cleaned) return null;

    const normalized = this.norm(cleaned);
    const fromDictionary = [
      'brake pad', 'brake disc', 'brake caliper', 'shock absorber', 'wheel bearing',
      'control arm', 'steering rack', 'radiator', 'alternator', 'starter motor',
      'oil filter', 'air filter', 'fuel filter', 'timing belt', 'water pump',
    ];

    const exact = fromDictionary.find((entry) => this.norm(entry) === normalized);
    if (exact) return { value: exact, confidence: 0.95 };

    let best: { value: string; confidence: number } | null = null;
    for (const entry of fromDictionary) {
      const score = this.stringSimilarity(normalized, this.norm(entry));
      if (score >= 0.66 && (!best || score > best.confidence)) {
        best = { value: entry, confidence: score };
      }
    }

    if (best) return best;
    if (cleaned.length > 2) return { value: cleaned, confidence: 0.55 };
    return null;
  }

  private findBestMasterMatch(value: string, candidates: string[]): { value: string; confidence: number } | null {
    const cleaned = this.cleanText(value);
    if (!cleaned || candidates.length === 0) return null;

    const normalized = this.norm(cleaned);
    let bestValue: string | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const cNorm = this.norm(candidate);
      let score = 0;
      if (normalized === cNorm) {
        score = 1;
      } else if (cNorm.startsWith(normalized) || normalized.startsWith(cNorm)) {
        score = 0.88;
      } else if (cNorm.includes(normalized) || normalized.includes(cNorm)) {
        score = 0.8;
      } else {
        score = this.stringSimilarity(normalized, cNorm);
      }

      if (score > bestScore) {
        bestScore = score;
        bestValue = candidate;
      }
    }

    if (!bestValue || bestScore < 0.62) return null;
    return { value: bestValue, confidence: bestScore };
  }

  private async getRecentUserMessages(conversationId: string): Promise<string[]> {
    if (!conversationId) return [];

    const recent = await this.msgRepo.find({
      where: { conversationId, senderType: 'user' },
      order: { createdAt: 'DESC' },
      take: 3,
    });

    return recent
      .map((msg) => this.cleanText(msg.content))
      .filter(Boolean)
      .reverse();
  }

  private async getContextFromHistory(conversationId: string): Promise<QueryWidgetContext> {
    if (!conversationId) return {};

    const recent = await this.msgRepo.find({
      where: { conversationId },
      order: { createdAt: 'DESC' },
      take: 20,
    });

    const context: QueryWidgetContext = {};

    for (const msg of recent) {
      const widgetPayload = msg.widgetPayload && typeof msg.widgetPayload === 'object'
        ? msg.widgetPayload as Record<string, unknown>
        : null;
      const metadata = msg.metadata && typeof msg.metadata === 'object'
        ? msg.metadata as Record<string, unknown>
        : null;
      const queryContext = metadata?.queryContext && typeof metadata.queryContext === 'object'
        ? metadata.queryContext as Record<string, unknown>
        : null;

      context.brand = context.brand || this.cleanText((queryContext?.brand || widgetPayload?.brand) as string);
      context.model = context.model || this.cleanText((queryContext?.model || widgetPayload?.model) as string);
      context.variant = context.variant || this.cleanText((queryContext?.variant || widgetPayload?.variant) as string);
      context.category = context.category || this.cleanText((queryContext?.category || widgetPayload?.category) as string);

      if (context.brand && context.model && context.variant) break;
    }

    return context;
  }

  private normalizeWidgetContext(input?: QueryWidgetContext): QueryWidgetContext {
    return {
      brand: this.cleanText(input?.brand),
      model: this.cleanText(input?.model),
      variant: this.cleanText(input?.variant),
      year: this.extractYear(input?.year),
      category: this.cleanText(input?.category),
      part: this.cleanText(input?.part),
    };
  }

  private pickIntent(extraction: QueryExtractionResult | null, heurIntent: string): string {
    const aiIntent = this.cleanText(extraction?.intent);
    if (aiIntent) return aiIntent;
    return heurIntent;
  }

  private inferIntentHeuristically(input: string): string {
    const q = input.toLowerCase();
    if (/\b(price|cost|how much)\b/i.test(q)) return 'price_check';
    if (/\b(available|availability|in stock|stock|supply)\b/i.test(q)) return 'availability_check';
    if (/\b(compatible|fit|fits|fitment)\b/i.test(q)) return 'compatibility_check';
    if (/\b(order|delivery|tracking|refund|return|damaged|warranty)\b/i.test(q)) return 'order_support';
    if (/\b(part|parts|oem|aftermarket)\b/i.test(q)) return 'find_part';
    return 'general_parts_query';
  }

  private looksLikePartSearch(input: string): boolean {
    return /\b(part|brake|filter|bearing|suspension|steering|radiator|alternator|engine|oem|aftermarket)\b/i.test(input);
  }

  private extractYear(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const match = value.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/);
    return match?.[1];
  }

  private computeOverallConfidence(values: Array<number | undefined>): number {
    const filtered = values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v) && v > 0);
    if (filtered.length === 0) return 0.35;
    const avg = filtered.reduce((acc, value) => acc + value, 0) / filtered.length;
    return this.clampConfidence(avg);
  }

  private clampConfidence(value: number): number {
    return Math.max(0, Math.min(1, Number(value.toFixed(3))));
  }

  private flattenMapValues(input: Map<string, string[]>): string[] {
    const merged: string[] = [];
    for (const values of input.values()) {
      merged.push(...values);
    }
    return Array.from(new Set(merged));
  }

  private cleanText(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  private key(value: string): string {
    return this.norm(value);
  }

  private variantKey(brand: string, model: string): string {
    return `${this.key(brand)}::${this.key(model)}`;
  }

  private norm(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stringSimilarity(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const distance = this.levenshtein(a, b);
    const longest = Math.max(a.length, b.length) || 1;
    return 1 - distance / longest;
  }

  private levenshtein(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }
}
