import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Part } from '../entities/part.entity';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { RagService } from '../services/rag.service';
import { GuardrailService } from '../services/guardrail.service';
import { QueryMonitorService } from '../services/monitor.service';
import {
  isUuidLike,
  normalizeTextInput,
  parseClampedInt,
  sanitizeFileName,
} from '../utils/request-safety.util';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

@Controller('api')
export class ApiController {
  constructor(
    @InjectRepository(Part) private partRepo: Repository<Part>,
    @InjectRepository(Conversation) private convRepo: Repository<Conversation>,
    @InjectRepository(Message) private msgRepo: Repository<Message>,
    private ragService: RagService,
    private guardrailService: GuardrailService,
    private monitorService: QueryMonitorService,
  ) {}

  @Get('parts/search')
  async searchParts(@Query('q') q: string) {
    const safeQuery = normalizeTextInput(q, { maxLength: 120 });
    if (!safeQuery) return [];
    return this.partRepo.createQueryBuilder('part')
      .where('LOWER(part.partNumber) LIKE LOWER(:q)', { q: `%${safeQuery}%` })
      .orWhere('LOWER(part.name) LIKE LOWER(:q)', { q: `%${safeQuery}%` })
      .orWhere('LOWER(part.internalCode) LIKE LOWER(:q)', { q: `%${safeQuery}%` })
      .take(20).getMany();
  }

  // ── Parts Catalog List (for admin Parts Catalog tab) ────────────────────
  @Get('parts')
  async getParts(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search: string,
    @Query('category') category: string,
    @Query('brand') brand: string,
    @Query('availability') availability: string,
    @Query('sortBy') sortBy: string,
  ) {
    const pageNum = parseClampedInt(page, 1, 1, 1000000);
    const limitNum = parseClampedInt(limit, 20, 1, 100);
    const skip = (pageNum - 1) * limitNum;
    const safeSearch = normalizeTextInput(search, { maxLength: 120 });
    const safeCategory = normalizeTextInput(category, { maxLength: 60 });
    const safeBrand = normalizeTextInput(brand, { maxLength: 60 });
    const safeAvailability = normalizeTextInput(availability, { maxLength: 30 });
    const safeSortBy = normalizeTextInput(sortBy, { maxLength: 30 });

    let qb = this.partRepo.createQueryBuilder('part');

    if (safeSearch) {
      const q = `%${safeSearch.toLowerCase()}%`;
      qb = qb.where(
        'LOWER(part.name) LIKE :q OR LOWER(part.partNumber) LIKE :q OR LOWER(part.brand) LIKE :q OR LOWER(part.internalCode) LIKE :q',
        { q },
      );
    }
    if (safeCategory && safeCategory !== 'All') qb = qb.andWhere('part.category = :category', { category: safeCategory });
    if (safeBrand && safeBrand !== 'All') qb = qb.andWhere('part.brand = :brand', { brand: safeBrand });
    if (safeAvailability && safeAvailability !== 'All') qb = qb.andWhere('part.availability = :availability', { availability: safeAvailability });

    if (safeSortBy === 'price_asc') qb = qb.orderBy('part.price', 'ASC');
    else if (safeSortBy === 'price_desc') qb = qb.orderBy('part.price', 'DESC');
    else if (safeSortBy === 'brand') qb = qb.orderBy('part.brand', 'ASC');
    else qb = qb.orderBy('part.name', 'ASC');

    const [parts, total] = await qb.skip(skip).take(limitNum).getManyAndCount();
    return { parts, total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) };
  }

  // ── Analytics: parts breakdown (supports brand filter for category drill-down)
  @Get('analytics/parts')
  async getPartsAnalytics(@Query('brand') brand: string) {
    let qb = this.partRepo.createQueryBuilder('part');
    if (brand && brand !== 'All') qb = qb.where('part.brand = :brand', { brand });

    const allParts = await qb.getMany();
    const total = allParts.length;

    const inStock = allParts.filter(p => p.availability === 'In Stock').length;
    const twoDays = allParts.filter(p => p.availability === '2-3 Days').length;
    const onOrder = allParts.filter(p => p.availability === 'On Order').length;
    const avgPrice = total > 0 ? Math.round(allParts.reduce((s, p) => s + Number(p.price || 0), 0) / total) : 0;

    // Brand distribution (only when no brand filter so we don't lose brand chart)
    const brandMap: Record<string, number> = {};
    const allPartsForBrand = await this.partRepo.createQueryBuilder('part').getMany();
    for (const p of allPartsForBrand) {
      if (p.brand) brandMap[p.brand] = (brandMap[p.brand] || 0) + 1;
    }
    const brandDist = Object.entries(brandMap).map(([brand, count]) => ({ brand, count }));

    // Category distribution (filtered by brand if brand param provided)
    const catMap: Record<string, number> = {};
    for (const p of allParts) {
      if (p.category) catMap[p.category] = (catMap[p.category] || 0) + 1;
    }
    const catColors: Record<string, string> = {
      Brakes: '#E84545', Suspension: '#6366f1', Engine: '#f59e0b', Cooling: '#06b6d4',
      Electrical: '#10b981', Exhaust: '#8b5cf6', Steering: '#ec4899', 'Body Parts': '#64748b',
    };
    const categoryDist = Object.entries(catMap).map(([cat, count]) => ({
      cat, count, color: catColors[cat] || '#94a3b8',
    }));

    // Supplier distribution (filtered)
    const supplierMap: Record<string, number> = {};
    for (const p of allParts) {
      if (p.supplierBrand) supplierMap[p.supplierBrand] = (supplierMap[p.supplierBrand] || 0) + 1;
    }
    const supplierDist = Object.entries(supplierMap).map(([supplier, count]) => ({ supplier, count }));

    // Price ranges (filtered)
    const priceRanges = [
      { range: '0–999', min: 0, max: 999 },
      { range: '1000–1299', min: 1000, max: 1299 },
      { range: '1300–1599', min: 1300, max: 1599 },
      { range: '1600–1899', min: 1600, max: 1899 },
      { range: '1900–2199', min: 1900, max: 2199 },
      { range: '2200+', min: 2200, max: 999999 },
    ].map(r => ({ range: r.range, count: allParts.filter(p => Number(p.price) >= r.min && Number(p.price) <= r.max).length }));

    return { total, inStock, twoDays, onOrder, avgPrice, brandDist, categoryDist, supplierDist, priceRanges, filteredBrand: brand || null };
  }

  // ── Dashboard Stats ─────────────────────────────────────────────────────
  @Get('dashboard/stats')
  async getDashboardStats() {
    const [totalConvs, activeConvs, resolvedConvs, totalMsgs, adminJoined] = await Promise.all([
      this.convRepo.count(),
      this.convRepo.count({ where: { isResolved: false } }),
      this.convRepo.count({ where: { isResolved: true } }),
      this.msgRepo.count(),
      this.convRepo.count({ where: { isAdminJoined: true } }),
    ]);
    const recentConvs = await this.convRepo.find({ order: { createdAt: 'DESC' }, take: 5 });
    return { totalConversations: totalConvs, activeConversations: activeConvs, resolvedConversations: resolvedConvs, totalMessages: totalMsgs, adminJoinedCount: adminJoined, recentConversations: recentConvs };
  }

  @Get('conversations')
  async getConversations() {
    const convs = await this.convRepo.find({ order: { createdAt: 'DESC' } });
    return Promise.all(convs.map(async (c) => {
      const [msgCount, lastMsg] = await Promise.all([
        this.msgRepo.count({ where: { conversationId: c.id } }),
        this.msgRepo.findOne({ where: { conversationId: c.id }, order: { createdAt: 'DESC' } }),
      ]);
      return { ...c, msgCount, lastMessage: lastMsg };
    }));
  }

  @Get('conversations/messages')
  async getMessages(@Query('conversationId') conversationId: string) {
    const safeConversationId = normalizeTextInput(conversationId, { maxLength: 64, collapseWhitespace: false });
    if (!isUuidLike(safeConversationId)) return [];
    return this.msgRepo.find({ where: { conversationId: safeConversationId }, order: { createdAt: 'ASC' } });
  }

  // ── RAG Endpoints ───────────────────────────────────────────────────────
  @Get('rag/query')
  async ragQuery(@Query('q') q: string) {
    const safeQuery = normalizeTextInput(q, { maxLength: 500 });
    if (!safeQuery) return { results: [] };
    const results = await this.ragService.query(safeQuery, 3, { prioritizeClientDocs: true });
    return { query: safeQuery, results };
  }

  @Get('rag/stats')
  getRagStats() {
    return this.ragService.getIndexStats();
  }

  /** Alias used by the admin panel RagPanel component */
  @Get('rag/index-stats')
  getRagIndexStats() {
    return this.ragService.getIndexStats();
  }

  /**
   * Return all knowledge documents for the Admin RAG Upload panel.
   * Includes both FAQ docs (seeded) and admin-uploaded documents.
   */
  @Get('rag/documents')
  async getAllRagDocuments() {
    try {
      return await this.ragService.getAllDocuments();
    } catch (err) {
      return { error: getErrorMessage(err), documents: [], stats: {} };
    }
  }

  @Post('rag/rebuild')
  async rebuildRag() {
    const result = await this.ragService.rebuildIndex();
    return { success: true, ...result };
  }

  // ── Guardrail Endpoints ─────────────────────────────────────────────────
  @Get('guardrail/test')
  testGuardrail(@Query('input') input: string) {
    const safeInput = normalizeTextInput(input, { maxLength: 500 });
    if (!safeInput) return { error: 'Provide ?input=' };
    const result = this.guardrailService.checkInput('test-session', safeInput);
    return { input: safeInput, ...result };
  }

  @Get('guardrail/stats')
  getGuardrailStats() {
    return this.guardrailService.getStats();
  }

  // ── Monitor Endpoints ───────────────────────────────────────────────────
  @Get('monitor/stats')
  getMonitorStats(@Query('hours') hours: string) {
    const h = parseClampedInt(hours, 24, 1, 24 * 30);
    return this.monitorService.getStats(h);
  }

  @Get('monitor/realtime')
  getRealtimeMetrics() {
    return this.monitorService.getRealtimeMetrics();
  }

  // ── Seed ────────────────────────────────────────────────────────────────
  @Get('seed')
  async seedData() {
    const count = await this.partRepo.count();
    if (count > 0) return { message: 'Already seeded', count };
    const sampleParts = [
      { partNumber:'4M0 615 301 AD', internalCode:'BRAKE-AUDI-Q7-01', name:'Front Brake Disc', category:'Brakes', subCategory:'Brake Discs', price:2850, availability:'In Stock', supplierBrand:'Bosch', position:'Front', fitment:'Audi Q7 3.0 TDI (2015-2020)', vehicleId:'EV80744', brand:'Audi', model:'Q7', variant:'Q7 3.0 TDI (2015-2020)' },
      { partNumber:'BMW-X6-BR-001', internalCode:'BRAKE-BMW-X6-01', name:'Front Brake Pad Set', category:'Brakes', subCategory:'Brake Pads', price:1890, availability:'In Stock', supplierBrand:'Brembo', position:'Front', fitment:'BMW X6 xLine (2019-2023)', vehicleId:'BMW-X6-2019', brand:'BMW', model:'X6', variant:'xLine (2019-2023)' },
      { partNumber:'BMW-X6-SUS-001', internalCode:'SUSP-BMW-X6-01', name:'Front Shock Absorber', category:'Suspension', subCategory:'Shock Absorbers', price:3200, availability:'2-3 Days', supplierBrand:'Bilstein', position:'Front Left', fitment:'BMW X6 xLine (2019-2023)', vehicleId:'BMW-X6-2019', brand:'BMW', model:'X6', variant:'xLine (2019-2023)' },
      { partNumber:'1H5 314 155 HO', internalCode:'COOL-TESL-MODE-01', name:'Radiator', category:'Cooling', subCategory:'Radiators', price:2403, availability:'2-3 Days', supplierBrand:'Sidem', position:'Front', fitment:'Tesla Model Y Long Range AWD (2021-2025)', vehicleId:'TESL-XL-2021', brand:'Tesla', model:'Model Y', variant:'Model Y Long Range AWD (2021-2025)' },
      { partNumber:'AUDI-ETRON-BR-001', internalCode:'BRAKE-AUDI-ETRON-01', name:'Front Brake Pads', category:'Brakes', subCategory:'Brake Pads', price:2100, availability:'In Stock', supplierBrand:'TRW', position:'Front', fitment:'Audi e-tron 55 quattro (2019-2023)', vehicleId:'AUDI-ETRON-2019', brand:'Audi', model:'e-tron', variant:'e-tron 55 quattro (2019-2023)' },
      { partNumber:'VOLV-XC60-01', internalCode:'BRAKE-VOLV-XC60-01', name:'Rear Brake Caliper', category:'Brakes', subCategory:'Brake Calipers', price:2310, availability:'2-3 Days', supplierBrand:'Triscan', position:'Rear', fitment:'Volvo XC60 2.0d (2018-2022)', vehicleId:'VOLV-XC60-2018', brand:'Volvo', model:'XC60', variant:'XC60 2.0d (2018-2022)' },
      { partNumber:'MERC-ECLASS-01', internalCode:'ENGI-MERC-E-01', name:'Timing Belt Kit', category:'Engine', subCategory:'Timing Belt', price:2834, availability:'In Stock', supplierBrand:'Dayco', position:'Engine', fitment:'Mercedes E-Class 2.0d (2016-2021)', vehicleId:'MERC-ECLASS-2016', brand:'Mercedes-Benz', model:'E-Class', variant:'E-Class 2.0d (2016-2021)' },
      { partNumber:'TOYO-CAM-01', internalCode:'STEE-TOYO-CAM-01', name:'Tie Rod End', category:'Steering', subCategory:'Tie Rod', price:699, availability:'On Order', supplierBrand:'Bosal', position:'Front', fitment:'Toyota Camry 2.5 (2018-2023)', vehicleId:'TOYO-CAM-2018', brand:'Toyota', model:'Camry', variant:'Camry 2.5 (2018-2023)' },
      { partNumber:'HOND-CRV-01', internalCode:'ELEC-HOND-CRV-01', name:'Alternator', category:'Electrical', subCategory:'Alternator', price:1551, availability:'2-3 Days', supplierBrand:'Sachs', position:'Engine', fitment:'Honda CR-V 2.0 (2015-2020)', vehicleId:'HOND-CRV-2015', brand:'Honda', model:'CR-V', variant:'CR-V 2.0 (2015-2020)' },
      { partNumber:'AUDI-A4-RAD-01', internalCode:'COOL-AUDI-A4-01', name:'Radiator', category:'Cooling', subCategory:'Radiator', price:983, availability:'On Order', supplierBrand:'Klokkerholm', position:'Front', fitment:'Audi A4 2.0 TDI (2015-2020)', vehicleId:'AUDI-A4-2015', brand:'Audi', model:'A4', variant:'A4 2.0 TDI (2015-2020)' },
    ];
    await this.partRepo.save(sampleParts);
    // Rebuild RAG index after seeding
    setTimeout(() => this.ragService.rebuildIndex(), 1000);
    return { message: 'Seeded successfully', count: sampleParts.length };
  }

  // ── Client Document Upload Endpoints ────────────────────────────────────────

  /**
   * Upload a client document that will be indexed by RAG
   * Supports: PDF, TXT, MD, JSON, CSV
   * Max file size: 5MB
   */
  /**
   * Upload a document into the centralised RAG knowledge base.
   * Admin uploads — conversationId is optional.
   * Supports: PDF, TXT, MD, JSON, CSV  |  Max 5 MB
   */
  @Post('rag/upload-document')
  async uploadClientDocument(
    @Body()
    body: {
      conversationId?: string; // optional for admin uploads
      fileName: string;
      fileType: string;
      content: string;
      size?: number;
      metadata?: Record<string, any>;
    },
  ) {
    try {
      if (!body || !body.fileName || !body.content) {
        return { error: 'Missing required fields: fileName, content' };
      }

      const safeFileName = sanitizeFileName(body.fileName);
      if (!safeFileName) {
        return { error: 'Invalid fileName' };
      }

      const safeConversationId = body.conversationId
        ? normalizeTextInput(body.conversationId, { maxLength: 64, collapseWhitespace: false })
        : undefined;
      if (safeConversationId && !isUuidLike(safeConversationId)) {
        return { error: 'conversationId must be a UUID' };
      }

      const validTypes = ['pdf', 'txt', 'md', 'json', 'csv'];
      const fileType = (body.fileType || 'txt').toLowerCase();
      if (!validTypes.includes(fileType)) {
        return { error: `Invalid fileType. Must be one of: ${validTypes.join(', ')}` };
      }

      const fileSizeBytes = Buffer.byteLength(body.content, 'utf8');
      if (fileSizeBytes > 5 * 1024 * 1024) {
        return { error: `File too large. Max 5 MB (got ${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB)` };
      }

      if (!body.content.trim()) {
        return { error: 'File content is empty' };
      }

      const docId = randomUUID();

      await this.ragService.addClientDocument(
        docId,
        safeFileName,
        fileType,
        body.content,
        safeConversationId,
        body.metadata || {},
      );

      return {
        success: true,
        documentId: docId,
        fileName: safeFileName,
        fileType,
        fileSizeKB: (fileSizeBytes / 1024).toFixed(2),
        message: `✅ "${safeFileName}" uploaded and added to RAG knowledge base!`,
        indexStats: this.ragService.getIndexStats(),
      };
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      console.error('Document upload failed:', errorMessage);
      return { error: `Upload failed: ${errorMessage}` };
    }
  }

  /**
   * Get all documents for a conversation
   */
  @Get('rag/conversation-documents')
  async getConversationDocuments(@Query('conversationId') conversationId: string) {
    const safeConversationId = normalizeTextInput(conversationId, { maxLength: 64, collapseWhitespace: false });
    if (!isUuidLike(safeConversationId)) {
      return { error: 'conversationId query parameter required' };
    }
    try {
      const documents = await this.ragService.getConversationDocuments(safeConversationId);
      return { conversationId: safeConversationId, documents, count: documents.length };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }

  /**
   * Query specifically against client documents
   */
  @Get('rag/query-client-docs')
  async queryClientDocuments(
    @Query('q') query: string,
    @Query('topK') topK: string,
  ) {
    const safeQuery = normalizeTextInput(query, { maxLength: 500 });
    if (!safeQuery) {
      return { error: 'query parameter (q) is required' };
    }
    try {
      const k = parseClampedInt(topK, 3, 1, 10);
      const results = await this.ragService.queryClientDocuments(safeQuery, k);
      return { query: safeQuery, results, count: results.length };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }

  /**
   * Rebuild RAG index including all client documents
   */
  @Post('rag/rebuild-with-clients')
  async rebuildRagWithClientDocs() {
    try {
      const result = await this.ragService.rebuildIndexWithClientDocs();
      return { success: true, ...result };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }

  /**
   * Remove a document from RAG index
   * Also marks it as inactive in database
   */
  @Post('rag/remove-document')
  async removeDocument(
    @Body() body: { documentId: string; conversationId?: string }
  ) {
    try {
      const safeDocumentId = normalizeTextInput(body?.documentId, { maxLength: 64, collapseWhitespace: false });
      if (!isUuidLike(safeDocumentId)) {
        return { error: 'Missing required field: documentId' };
      }

      await this.ragService.removeClientDocument(safeDocumentId);

      return {
        success: true,
        documentId: safeDocumentId,
        message: 'Document removed from RAG knowledge base',
        indexStats: this.ragService.getIndexStats(),
      };
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      console.error('Document removal failed:', errorMessage);
      return { error: `Removal failed: ${errorMessage}` };
    }
  }

  /**
   * Get document content by ID
   */
  @Get('rag/document-content')
  async getDocumentContent(
    @Query('documentId') documentId: string,
    @Query('conversationId') conversationId: string,
  ) {
    try {
      const safeDocumentId = normalizeTextInput(documentId, { maxLength: 64, collapseWhitespace: false });
      const safeConversationId = normalizeTextInput(conversationId, { maxLength: 64, collapseWhitespace: false });
      if (!isUuidLike(safeDocumentId) || !isUuidLike(safeConversationId)) {
        return { error: 'Missing required query parameters: documentId, conversationId' };
      }

      const document = await this.ragService.getDocumentById(safeDocumentId, safeConversationId);
      if (!document) {
        return { error: 'Document not found' };
      }

      return {
        success: true,
        document: {
          id: document.id,
          fileName: document.fileName,
          fileType: document.fileType,
          content: document.content,
          metadata: document.metadata,
          size: document.size,
          status: document.status,
          createdAt: document.createdAt,
          indexedAt: document.indexedAt,
        },
      };
    } catch (err) {
      return { error: getErrorMessage(err) };
    }
  }
}
