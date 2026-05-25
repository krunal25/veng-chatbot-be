/**
 * RAG (Retrieval-Augmented Generation) Service — v7
 * Enhancements over v6:
 *  - Expanded FAQ knowledge base (8 → 16 topics)
 *  - Synonym expansion for better recall
 *  - Multi-result blending: top-K with context boost
 *  - Admin-context RAG: answers admin queries too
 *  - Context-aware re-ranking using conversation keywords
 *  - Dynamic threshold auto-tuning per query length
 *  - Spell-normalization for common typos
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Part } from '../entities/part.entity';
import { ClientDocument } from '../entities/client-document.entity';
import { RagKnowledgeDocument } from '../entities/rag-knowledge-document.entity';

export interface RagDocument {
  id: string;
  content: string;
  metadata: Record<string, any>;
  tfidfVector?: Map<string, number>;
}

export interface RagResult {
  document: RagDocument;
  score: number;
  answer: string;
}

const SYNONYMS: Record<string, string[]> = {
  delivery: ['shipping', 'dispatch', 'arrive', 'sent', 'transit', 'tracking'],
  shipping: ['delivery', 'dispatch', 'arrive'],
  return: ['refund', 'exchange', 'send back', 'wrong part', 'cancel'],
  refund: ['return', 'money back'],
  damaged: ['broken', 'defective', 'faulty', 'cracked'],
  price: ['cost', 'how much', 'nok', 'amount', 'fee', 'charge'],
  compatible: ['fits', 'fitment', 'work', 'suitable', 'match'],
  payment: ['pay', 'checkout', 'invoice', 'vipps', 'klarna', 'card'],
  contact: ['support', 'help', 'phone', 'email', 'speak', 'human', 'agent'],
  warranty: ['guarantee', 'defect', 'coverage', 'claims'],
  installation: ['install', 'fit', 'fitting', 'how to', 'guide', 'diy', 'mechanic'],
  bulk: ['wholesale', 'fleet', 'business', 'large order', 'discount'],
  availability: ['in stock', 'out of stock', 'stock', 'backorder'],
};

const TYPO_MAP: Record<string, string> = {
  shiping: 'shipping',
  delivry: 'delivery',
  refudn: 'refund',
  waranty: 'warranty',
  compatble: 'compatible',
  paymnet: 'payment',
  contcat: 'contact',
  instalation: 'installation',
};

@Injectable()
export class RagService implements OnModuleInit {
  private documents: RagDocument[] = [];
  private idfScores: Map<string, number> = new Map();
  private isIndexed = false;
  private clientDocuments: Map<string, RagDocument> = new Map(); // Track client docs separately

  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Used only for one-time DB seeding. After seeding, DB is the source of truth. */
  private readonly faqSeedData: RagDocument[] = [
    {
      id: 'faq-delivery',
      content: 'delivery shipping dispatch arrive sent transit tracking order status when will my order arrive',
      metadata: {
        type: 'faq',
        question: 'Delivery & Shipping',
        answer: '🚚 **Delivery & Shipping:**\n• **In Stock** parts: 1–3 business days\n• **2-3 Days** parts: typically 2–3 business days\n• **On Order** parts: usually 5–10 business days\n\nOnce dispatched, you receive a tracking link by email. If you need urgent order help, click **Ask Admin**.',
        tags: ['delivery', 'shipping', 'tracking'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-return',
      content: 'return refund wrong part does not fit incorrect exchange policy cancel order send back money back 30 days',
      metadata: {
        type: 'faq',
        question: 'Returns & Refunds',
        answer: '🔄 **Return Policy:**\n• Returns accepted within **30 days** of delivery\n• Part must be in original packaging, unused\n• Wrong part? We cover return shipping\n• Refunds processed within 5–7 business days\n\nContact support with your order number and photos, or click **Ask Admin** to speak with us directly.',
        tags: ['return', 'refund', 'exchange'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-damaged',
      content: 'damaged broken defective arrived damaged faulty part warranty claim cracked bent quality issue',
      metadata: {
        type: 'faq',
        question: 'Damaged or Defective Parts',
        answer: '⚠️ **Damaged Part?**\n1. Take clear photos of the damage\n2. Contact support with your order number + photos\n3. We will send a replacement within 1–2 business days at no cost\n\nAll parts carry a **12-month warranty**. Click **Ask Admin** to connect immediately.',
        tags: ['damaged', 'warranty', 'defective'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-price',
      content: 'price cost how much total nok currency vat tax discount coupon promo moms mva fee charge amount inclusive',
      metadata: {
        type: 'faq',
        question: 'Pricing & Currency',
        answer: '💰 **Pricing Info:**\n• All prices in **NOK (Norwegian Krone)** including 25% VAT\n• Price shown is final — no hidden fees\n• Bulk order discounts available — contact us\n• We do not currently offer coupon codes',
        tags: ['price', 'vat', 'nok'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-compatibility',
      content: 'compatible fits my car vehicle check compatibility year model variant registration number reg fitment suitable match correct works',
      metadata: {
        type: 'faq',
        question: 'Part Compatibility',
        answer: '🔍 **Checking Compatibility:**\n• Use our **Find a Part** flow — select your brand, model, and variant\n• Each part listing shows exact fitment info\n• Have your **registration number** or **VIN** ready for fastest results\n• Not sure? Click **Ask Admin** — we verify compatibility for free',
        tags: ['compatibility', 'fitment', 'vehicle'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-payment',
      content: 'payment pay credit card invoice bank transfer vipps klarna checkout visa mastercard secure ssl',
      metadata: {
        type: 'faq',
        question: 'Payment Methods',
        answer: '💳 **Payment Options:**\n• Credit/Debit Card (Visa, Mastercard)\n• **Vipps** (Norway)\n• **Klarna** — buy now, pay later\n• Bank Transfer (invoice on request for business orders)\n\nAll transactions are SSL-encrypted and secure.',
        tags: ['payment', 'vipps', 'klarna'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-account',
      content: 'account login register sign up password forgot reset profile business invoice guest checkout',
      metadata: {
        type: 'faq',
        question: 'Account & Registration',
        answer: '👤 **Account Info:**\n• You can order as a **guest** (no account required)\n• Create an account to track orders and save vehicles\n• Business accounts get net-30 invoicing — contact us to apply\n• Forgot password? Use the reset link on the login page',
        tags: ['account', 'login', 'register'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-contact',
      content: 'contact phone email support help speak human agent customer service opening hours live chat response time',
      metadata: {
        type: 'faq',
        question: 'Contact & Support',
        answer: '📞 **Contact Veng:**\n• **Email:** support@veng.no\n• **Phone:** +47 XX XX XX XX (Mon–Fri 08:00–16:00 CET)\n• **Live Chat:** Click **Ask Admin** in this chatbot\n• **Response time:** Email within 24h, chat within minutes',
        tags: ['contact', 'support', 'help'],
      },
      tfidfVector: new Map(),
    },
    // ── NEW v7 FAQ topics ───────────────────────────────────────────────────
    {
      id: 'faq-warranty',
      content: 'warranty guarantee coverage defect 12 months claim how long covered faulty replacement parts',
      metadata: {
        type: 'faq',
        question: 'Warranty Policy',
        answer: '🛡️ **Warranty Coverage:**\n• All parts carry a **12-month warranty** from date of delivery\n• Covers manufacturing defects and premature failure\n• Does NOT cover: installation damage, wear-and-tear, incorrect fitment\n• To make a claim: take photos, contact support with your order number\n• Replacement dispatched within 1–2 business days at no cost',
        tags: ['warranty', 'guarantee', 'defect'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-installation',
      content: 'install installation fit fitting how to guide diy mechanic professional workshop technical steps procedure',
      metadata: {
        type: 'faq',
        question: 'Installation Help',
        answer: '🔧 **Installation Guidance:**\n• We recommend professional installation for safety-critical parts (brakes, steering, suspension)\n• Basic how-to guides available on our website\n• Our team can recommend trusted workshops — click **Ask Admin**\n• Incorrect installation voids warranty, so always use a qualified technician',
        tags: ['installation', 'fitting', 'guide'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-bulk-order',
      content: 'bulk order wholesale fleet business large quantity discount price negotiation multiple parts enterprise',
      metadata: {
        type: 'faq',
        question: 'Bulk & Business Orders',
        answer: '🏢 **Bulk & Business Orders:**\n• Volume discounts available for orders of 10+ units\n• Dedicated account manager for fleet and workshop accounts\n• Net-30 payment terms for approved business accounts\n• Contact us at business@veng.no or click **Ask Admin** to discuss\n• Lead time for large orders: 3–7 business days',
        tags: ['bulk', 'wholesale', 'business'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-tracking',
      content: 'track tracking order where is my package shipment status link number carrier parcel',
      metadata: {
        type: 'faq',
        question: 'Order Tracking',
        answer: '📦 **Tracking Your Order:**\n• A tracking link is sent to your email once dispatched\n• Check your **spam/junk** folder if not received\n• Tracking updates every 12–24 hours\n• For same-day dispatch: orders placed before 14:00 CET\n• If your tracking link is not working, click **Ask Admin** and provide your order number',
        tags: ['tracking', 'order status', 'shipment'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-cancellation',
      content: 'cancel cancellation order cancel before shipping stop order not dispatched yet change order modify',
      metadata: {
        type: 'faq',
        question: 'Order Cancellation',
        answer: '❌ **Cancelling an Order:**\n• Orders can be cancelled **before dispatch** (within 1–2 hours of placing)\n• After dispatch, use our return process (free return shipping if wrong part)\n• To cancel: click **Ask Admin** immediately with your order number\n• Refunds for cancellations are processed within 3–5 business days',
        tags: ['cancel', 'cancellation', 'modify'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-oem-aftermarket',
      content: 'oem original equipment manufacturer aftermarket brand quality difference genuine factory spare parts',
      metadata: {
        type: 'faq',
        question: 'OEM vs Aftermarket Parts',
        answer: '⚙️ **OEM vs Aftermarket:**\n• **OEM:** Made by or for the carmaker — exact fit, higher price\n• **Aftermarket:** Made by independent manufacturers — same quality, often 30–50% cheaper\n• All our aftermarket parts are tested to OEM standards\n• Not sure which to choose? Click **Ask Admin** for a recommendation',
        tags: ['oem', 'aftermarket', 'quality'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-part-not-listed',
      content: 'part not found not listed not in catalog special order request custom sourcing cannot find need specific part',
      metadata: {
        type: 'faq',
        question: 'Part Not in Catalog',
        answer: "🔎 **Can't Find the Part?**\n• Our catalog covers 500+ common parts — some rare parts may not be listed\n• We can **source-check and special-order** parts on request\n• Click **Ask Admin** and provide: vehicle details (make/model/year) + part name or number\n• Estimated turnaround for special orders: 7–14 business days",
        tags: ['not found', 'special order', 'custom'],
      },
      tfidfVector: new Map(),
    },
    {
      id: 'faq-international',
      content: 'international shipping outside norway europe eu countries abroad overseas worldwide delivery',
      metadata: {
        type: 'faq',
        question: 'International Shipping',
        answer: "🌍 **International Orders:**\n• We currently ship within **Norway and select EU countries**\n• International orders may incur customs duties (buyer's responsibility)\n• Delivery times: 5–14 business days depending on destination\n• For EU shipping inquiries, click **Ask Admin**",
        tags: ['international', 'eu', 'shipping abroad'],
      },
      tfidfVector: new Map(),
    },
  ];

  constructor(
    @InjectRepository(Part)
    private partRepo: Repository<Part>,
    @InjectRepository(ClientDocument)
    private clientDocRepo: Repository<ClientDocument>,
    @InjectRepository(RagKnowledgeDocument)
    private ragKnowledgeRepo: Repository<RagKnowledgeDocument>,
  ) {}

  async onModuleInit() {
    setTimeout(() => this.buildIndex(), 3000);
  }

  async buildIndex() {
    try {
      // ── Step 1: Seed FAQ docs to DB (one-time migration) ─────────────────
      await this.seedFaqDocs();

      // ── Step 2: Migrate legacy client_documents → rag_knowledge_documents ─
      await this.migrateClientDocuments();

      // ── Step 3: Load ALL knowledge docs from DB ───────────────────────────
      const knowledgeDocs = await this.ragKnowledgeRepo.find({
        where: { isActive: true, status: 'indexed' },
        order: { createdAt: 'ASC' },
      });

      // ── Step 4: Load parts catalog (too large to store in knowledge table) ─
      const parts = await this.partRepo.find({ take: 500 });
      const partDocs: RagDocument[] = parts.map((p) => ({
        id: `part-${p.id}`,
        content: [p.name, p.brand, p.model, p.variant, p.category, p.subCategory, p.partNumber, p.fitment]
          .filter(Boolean).join(' ').toLowerCase(),
        metadata: { type: 'part', part: p },
        tfidfVector: new Map(),
      }));

      // ── Step 5: Convert knowledge docs → RagDocuments ────────────────────
      const ragKnowledgeDocs: RagDocument[] = knowledgeDocs.map((kd) => ({
        id: `rag-${kd.id}`,
        content: kd.content.toLowerCase(),
        metadata: { ...(kd.metadata || {}), originalContent: kd.content, fileName: kd.title },
        tfidfVector: new Map(),
      }));

      // ── Step 6: Build TF-IDF for all documents ────────────────────────────
      this.documents = [...ragKnowledgeDocs, ...partDocs];
      this.buildTfIdf();

      // ── Step 7: Persist embeddings to DB (async, non-blocking) ────────────
      this.persistEmbeddings(knowledgeDocs, ragKnowledgeDocs).catch((err) =>
        console.warn('Embeddings persistence skipped:', this.getErrorMessage(err)),
      );

      this.isIndexed = true;
      const faqCount = knowledgeDocs.filter((kd) => kd.docType === 'faq').length;
      const uploadCount = knowledgeDocs.filter((kd) => kd.docType === 'admin-upload').length;
      console.log(
        `✅ RAG index built from DB: ${this.documents.length} docs ` +
        `(${faqCount} FAQ, ${uploadCount} admin uploads, ${partDocs.length} parts)`,
      );
    } catch (err) {
      console.warn('RAG index build failed:', this.getErrorMessage(err));
      this.isIndexed = true;
    }
  }

  /** One-time migration: seed hardcoded FAQ docs into rag_knowledge_documents */
  private async seedFaqDocs() {
    const faqCount = await this.ragKnowledgeRepo.count({ where: { docType: 'faq' } });
    if (faqCount > 0) return;

    console.log('🌱 Seeding FAQ docs to database (one-time migration)...');
    const entities = this.faqSeedData.map((faq) => ({
      docType: 'faq',
      title: faq.metadata.question as string,
      content: faq.content,
      metadata: faq.metadata,
      status: 'indexed',
      isActive: true,
    }));
    await this.ragKnowledgeRepo.save(entities);
    console.log(`✅ Seeded ${entities.length} FAQ docs to rag_knowledge_documents`);
  }

  /** One-time migration: copy legacy client_documents into rag_knowledge_documents */
  private async migrateClientDocuments() {
    const oldDocs = await this.clientDocRepo.find({ where: { isActive: true, status: 'indexed' } });
    if (oldDocs.length === 0) return;

    let migrated = 0;
    for (const cd of oldDocs) {
      const exists = await this.ragKnowledgeRepo.findOne({ where: { id: cd.id } });
      if (!exists) {
        await this.ragKnowledgeRepo.save({
          id: cd.id,
          docType: 'admin-upload',
          title: cd.fileName,
          content: cd.content,
          metadata: {
            type: 'admin-upload',
            fileName: cd.fileName,
            fileType: cd.fileType,
            conversationId: cd.conversationId || null,
            source: cd.metadata?.source || 'admin-upload',
            uploadedBy: cd.metadata?.uploadedBy || 'admin',
            category: cd.metadata?.category || 'General',
            uploadedAt: cd.createdAt?.toISOString(),
          },
          status: 'indexed',
          isActive: true,
        });
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`✅ Migrated ${migrated} docs from client_documents → rag_knowledge_documents`);
    }
  }

  /** Persist TF-IDF vectors for knowledge docs into DB for fast restart */
  private async persistEmbeddings(
    knowledgeDocs: RagKnowledgeDocument[],
    ragDocs: RagDocument[],
  ) {
    const updates = ragDocs
      .filter((rd) => rd.tfidfVector && rd.tfidfVector.size > 0)
      .map((rd) => {
        const kd = knowledgeDocs.find((k) => `rag-${k.id}` === rd.id);
        if (!kd) return Promise.resolve();
        const embeddings = JSON.stringify(Object.fromEntries(rd.tfidfVector!));
        return this.ragKnowledgeRepo.update(kd.id, { tfidfEmbeddings: embeddings });
      });
    await Promise.all(updates);
  }

  /** Return all admin-uploaded knowledge docs for the admin panel */
  async getAllDocuments(): Promise<{
    documents: Array<{
      id: string;
      fileName: string;
      fileType: string;
      docType: string;
      status: string;
      createdAt: Date;
    }>;
    stats: {
      totalDocuments: number;
      adminDocuments: number;
      faqDocuments: number;
      isIndexed: boolean;
    };
  }> {
    const all = await this.ragKnowledgeRepo.find({
      where: { isActive: true },
      order: { createdAt: 'DESC' },
    });
    const documents = all.map((kd) => ({
      id: kd.id,
      fileName: kd.title,
      fileType: kd.metadata?.fileType || (kd.docType === 'faq' ? 'faq' : 'txt'),
      docType: kd.docType,
      status: kd.status,
      createdAt: kd.createdAt,
    }));
    return {
      documents,
      stats: {
        totalDocuments: all.length,
        adminDocuments: all.filter((d) => d.docType === 'admin-upload').length,
        faqDocuments: all.filter((d) => d.docType === 'faq').length,
        isIndexed: this.isIndexed,
      },
    };
  }

  private tokenize(text: string, expand = false): string[] {
    const base = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .map((t) => TYPO_MAP[t] || t);

    if (!expand) return base;

    const expanded = [...base];
    base.forEach((token) => {
      const syns = SYNONYMS[token];
      if (syns) {
        syns.forEach((s) =>
          s.split(/\s+/).forEach((w) => { if (w.length > 2) expanded.push(w); }),
        );
      }
    });
    return expanded;
  }

  private buildTfIdf() {
    const N = this.documents.length;
    const dfMap = new Map<string, number>();

    this.documents.forEach((doc) => {
      const extraTags = doc.metadata.tags ? ' ' + (doc.metadata.tags as string[]).join(' ') : '';
      const tokens = this.tokenize(doc.content + extraTags, doc.metadata.type === 'faq');
      const tf = new Map<string, number>();
      tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
      doc.tfidfVector = tf;
      new Set(tokens).forEach((t) => dfMap.set(t, (dfMap.get(t) || 0) + 1));
    });

    dfMap.forEach((df, term) => {
      this.idfScores.set(term, Math.log((N + 1) / (df + 1)) + 1);
    });

    this.documents.forEach((doc) => {
      let norm = 0;
      doc.tfidfVector!.forEach((tf, term) => {
        const tfidf = (tf / (doc.tfidfVector!.size || 1)) * (this.idfScores.get(term) || 1);
        doc.tfidfVector!.set(term, tfidf);
        norm += tfidf * tfidf;
      });
      const magnitude = Math.sqrt(norm) || 1;
      doc.tfidfVector!.forEach((v, term) => doc.tfidfVector!.set(term, v / magnitude));
    });
  }

  private cosineSimilarity(queryVec: Map<string, number>, docVec: Map<string, number>): number {
    let dot = 0;
    queryVec.forEach((v, term) => { dot += v * (docVec.get(term) || 0); });
    return dot;
  }

  private dynamicThreshold(queryTokenCount: number): number {
    if (queryTokenCount <= 2) return 0.04;
    if (queryTokenCount <= 4) return 0.05;
    return 0.06;
  }

  async query(
    userInput: string,
    topK = 3,
    opts: { contextKeywords?: string[]; faqOnly?: boolean; partOnly?: boolean; prioritizeClientDocs?: boolean } = {},
  ): Promise<RagResult[]> {
    if (!this.isIndexed) await this.buildIndex();

    const queryTokens = this.tokenize(userInput, true);
    if (queryTokens.length === 0) return [];

    const queryTf = new Map<string, number>();
    queryTokens.forEach((t) => queryTf.set(t, (queryTf.get(t) || 0) + 1));
    const queryVec = new Map<string, number>();
    let norm = 0;
    queryTf.forEach((tf, term) => {
      const tfidf = (tf / queryTokens.length) * (this.idfScores.get(term) || 0.1);
      queryVec.set(term, tfidf);
      norm += tfidf * tfidf;
    });
    const magnitude = Math.sqrt(norm) || 1;
    queryVec.forEach((v, t) => queryVec.set(t, v / magnitude));

    const threshold = this.dynamicThreshold(queryTokens.length);

    let candidates = this.documents;
    if (opts.faqOnly) candidates = this.documents.filter((d) => d.metadata.type === 'faq');
    if (opts.partOnly) candidates = this.documents.filter((d) => d.metadata.type === 'part');

    let scored = candidates.map((doc) => ({
      document: doc,
      score: this.cosineSimilarity(queryVec, doc.tfidfVector!),
    }));

    // Context re-ranking boost
    if (opts.contextKeywords && opts.contextKeywords.length > 0) {
      scored = scored.map((r) => {
        const boost = opts.contextKeywords!.filter((kw) =>
          r.document.content.includes(kw.toLowerCase()),
        ).length;
        return { ...r, score: r.score + boost * 0.02 };
      });
    }

    // Prioritize client documents if requested (e.g., when in conversation with uploaded docs)
    if (opts.prioritizeClientDocs) {
      scored = scored.map((r) => {
        if (r.document.metadata.type === 'client-document') {
          // Boost client document scores by 15%
          return { ...r, score: r.score * 1.15 };
        }
        return r;
      });
    }

    return scored
      .filter((r) => r.score > threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((r) => ({
        ...r,
        answer: r.document.metadata.answer || this.buildPartAnswer(r.document, userInput),
      }));
  }

  /**
   * Blend top-2 FAQ answers when scores are close (multi-topic queries).
   *
   * SAFETY GUARD: Returns null immediately if the input looks like a part number
   * (e.g. "6E1 868 153 EL", "BMW-X5-BR-001"). Part-number queries must be
   * handled by the DB lookup layer — never by the FAQ RAG index — because
   * letter tokens in part numbers can spuriously match FAQ content (e.g.
   * "EL" matching OEM/aftermarket FAQ).
   */
  async blendedFaqAnswer(userInput: string): Promise<string | null> {
    // Part-number guard: if the input is a short alphanumeric code containing
    // digits, treat it as a part number and bail out immediately.
    // Pattern: 4–40 chars, alphanumeric + spaces/hyphens, MUST contain a digit,
    // token count ≤ 8, majority of tokens are digit-containing.
    const trimmed = userInput.trim();
    const partNumberGuard = /^[A-Z0-9][A-Z0-9\s\-]{3,39}$/i.test(trimmed) && /\d/.test(trimmed);
    if (partNumberGuard) {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const digitTokens = tokens.filter(t => /\d/.test(t)).length;
      // Short input with digits and mostly alphanumeric tokens → part number
      if (tokens.length <= 8 && digitTokens >= Math.ceil(tokens.length / 2)) {
        return null;
      }
    }

    // v7.3: Query ALL documents (FAQ + client docs) with client doc prioritization
    // This ensures admin-uploaded documents are searched when users ask questions
    const results = await this.query(userInput, 2, { prioritizeClientDocs: true });
    if (results.length === 0 || results[0].score < 0.05) return null;

    // Only blend a second answer when it is very close in score AND same doc type
    // (prevents unrelated FAQ appearing after an admin-upload answer)
    if (
      results.length > 1 &&
      results[1].score > results[0].score * 0.90 &&
      results[1].document.id !== results[0].document.id &&
      results[1].document.metadata.type === results[0].document.metadata.type
    ) {
      return `${results[0].answer}\n\n---\n\n${results[1].answer}`;
    }
    return results[0].answer;
  }

  /** Admin-side RAG — lets admin query the knowledge base */
  async adminQuery(adminInput: string): Promise<RagResult[]> {
    return this.query(adminInput, 3, { faqOnly: true });
  }

  private buildPartAnswer(doc: RagDocument, userInput = ''): string {
    if (doc.metadata.type === 'admin-upload' || doc.metadata.type === 'client-document') {
      // Use original (non-lowercased) content for display
      const raw: string = doc.metadata.originalContent || doc.content;
      const preview = this.extractRelevantSnippet(raw, userInput, 420);
      const truncated = raw.length > preview.length ? '...' : '';
      const ft = (doc.metadata.fileType || 'txt').toUpperCase();
      const name = doc.metadata.fileName || doc.metadata.title || 'Knowledge Base';
      return (
        `📄 From: ${name} (${ft})\n\n` +
        `${preview}${truncated}`
      );
    }
    
    if (doc.metadata.type !== 'part') return '';
    const p = doc.metadata.part;
    return (
      `**${p.name}** (${p.partNumber})\n` +
      `• Brand: ${p.brand} ${p.model} — ${p.variant}\n` +
      `• Category: ${p.category} › ${p.subCategory || ''}\n` +
      `• Price: **NOK ${p.price?.toLocaleString()}**\n` +
      `• Availability: **${p.availability}**\n` +
      `• Supplier: ${p.supplierBrand}`
    );
  }

  private extractRelevantSnippet(raw: string, userInput: string, maxLen: number): string {
    const text = (raw || '')
      .replace(/[=]{3,}/g, ' ')
      .replace(/VENG Auto Parts\s*[\-—]\s*Complete Knowledge Base/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    if (!userInput?.trim()) return text.substring(0, maxLen);

    const keywords = this.tokenize(userInput, true).filter((t) => t.length >= 3);
    if (keywords.length === 0) return text.substring(0, maxLen);

    const lower = text.toLowerCase();
    let bestIdx = -1;
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx !== -1) {
        bestIdx = idx;
        break;
      }
    }

    if (bestIdx === -1) return text.substring(0, maxLen);

    const start = Math.max(0, bestIdx - Math.floor(maxLen * 0.25));
    const end = Math.min(text.length, start + maxLen);
    return text.substring(start, end).trim();
  }

  async rebuildIndex() {
    this.isIndexed = false;
    await this.buildIndex();
    return { documents: this.documents.length };
  }

  getIndexStats() {
    const faqCount = this.documents.filter((d) => d.metadata.type === 'faq').length;
    const partCount = this.documents.filter((d) => d.metadata.type === 'part').length;
    const adminUploadCount = this.documents.filter((d) => d.metadata.type === 'admin-upload').length;
    return {
      isIndexed: this.isIndexed,
      totalDocuments: this.documents.length,
      faqDocuments: faqCount,
      partDocuments: partCount,
      adminDocuments: adminUploadCount,
      clientDocuments: adminUploadCount, // backward-compat alias
      faqTopics: this.documents
        .filter((d) => d.metadata.type === 'faq')
        .map((d) => ({ id: d.id, question: d.metadata.question })),
    };
  }

  /**
   * Add a document to the centralized RAG knowledge base.
   * Saves to rag_knowledge_documents (persistent), rebuilds TF-IDF,
   * and persists embeddings back to DB.
   */
  async addClientDocument(
    docId: string,
    fileName: string,
    fileType: string,
    content: string,
    conversationId?: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      // ── Save to centralised rag_knowledge_documents ──────────────────────
      await this.ragKnowledgeRepo.save({
        id: docId,
        docType: 'admin-upload',
        title: fileName,
        content,
        metadata: {
          type: 'admin-upload',
          fileName,
          fileType,
          conversationId: conversationId || null,
          source: metadata?.source || 'admin-upload',
          uploadedBy: metadata?.uploadedBy || 'admin',
          category: metadata?.category || 'General',
          uploadedAt: new Date().toISOString(),
          ...metadata,
        },
        status: 'indexed',
        isActive: true,
      });

      // ── Create in-memory RagDocument ─────────────────────────────────────
      const ragDoc: RagDocument = {
        id: `rag-${docId}`,
        content: content.toLowerCase(),
        metadata: {
          type: 'admin-upload',
          knowledgeDocId: docId,
          fileName,
          fileType,
          originalContent: content,
          source: metadata?.source || 'admin-upload',
          category: metadata?.category || 'General',
        },
        tfidfVector: new Map(),
      };

      this.documents.push(ragDoc);
      this.clientDocuments.set(docId, ragDoc);
      this.buildTfIdf();

      // ── Persist updated embedding ─────────────────────────────────────────
      const embeddings = JSON.stringify(Object.fromEntries(ragDoc.tfidfVector!));
      await this.ragKnowledgeRepo.update(docId, { tfidfEmbeddings: embeddings });

      console.log(`✅ Document added to RAG knowledge base: ${fileName} (${fileType})`);
    } catch (err) {
      console.error(`❌ Failed to add document: ${this.getErrorMessage(err)}`);
      throw err;
    }
  }

  /**
   * Remove a document from the RAG knowledge base (soft-delete).
   * Updates both rag_knowledge_documents and client_documents (legacy).
   */
  async removeClientDocument(docId: string): Promise<void> {
    try {
      // Soft-delete in centralised knowledge store
      await this.ragKnowledgeRepo.update(docId, { isActive: false });
      // Also soft-delete in legacy client_documents (ignore if not found)
      await this.clientDocRepo.update(docId, { isActive: false }).catch(() => {});

      // Remove from in-memory index
      this.documents = this.documents.filter(
        (d) => d.id !== `rag-${docId}` && d.id !== `client-doc-${docId}`,
      );
      this.clientDocuments.delete(docId);
      this.buildTfIdf();

      console.log(`✅ Document removed from RAG knowledge base: ${docId}`);
    } catch (err) {
      console.error(`❌ Failed to remove document: ${this.getErrorMessage(err)}`);
      throw err;
    }
  }

  /**
   * Query client documents specifically
   */
  async queryClientDocuments(
    userInput: string,
    topK = 3,
  ): Promise<RagResult[]> {
    if (!this.isIndexed) await this.buildIndex();

    return this.query(userInput, topK, { partOnly: false, faqOnly: false });
  }

  /**
   * Get all client documents for a conversation
   */
  async getConversationDocuments(conversationId: string) {
    return this.clientDocRepo.find({
      where: { conversationId, isActive: true },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Rebuild RAG index including all client documents
   */
  async rebuildIndexWithClientDocs() {
    this.isIndexed = false;
    await this.buildIndex();
    const clientDocs = await this.clientDocRepo.find({ where: { isActive: true } });
    return {
      totalDocuments: this.documents.length,
      clientDocuments: clientDocs.length,
      indexed: true,
    };
  }

  /**
   * Get a document by ID from database
   */
  async getDocumentById(docId: string, conversationId: string) {
    return this.clientDocRepo.findOne({
      where: { 
        id: docId, 
        conversationId, 
        isActive: true 
      },
    });
  }
}
