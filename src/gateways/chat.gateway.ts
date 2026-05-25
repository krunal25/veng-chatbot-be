// import {
//   WebSocketGateway,
//   WebSocketServer,
//   SubscribeMessage,
//   OnGatewayConnection,
//   OnGatewayDisconnect,
//   ConnectedSocket,
//   MessageBody,
// } from '@nestjs/websockets';
// import { Server, Socket } from 'socket.io';
// import { InjectRepository } from '@nestjs/typeorm';
// import { Repository } from 'typeorm';
// import { Conversation } from '../entities/conversation.entity';
// import { Message } from '../entities/message.entity';
// import { Part } from '../entities/part.entity';
// import { v4 as uuidv4 } from 'uuid';
// import { RagService } from '../services/rag.service';
// import { GuardrailService } from '../services/guardrail.service';
// import { QueryMonitorService } from '../services/monitor.service';

// type NlpReply = {
//   content: string;
//   widgetType?: string;
//   widgetPayload?: any;
//   options?: string[];
// };

// @WebSocketGateway({
//   cors: { origin: '*' },
//   namespace: '/',
// })
// export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
//   @WebSocketServer()
//   server: Server;

//   private static readonly ADMIN_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
//   private adminSockets: Set<string> = new Set();
//   private sessionToSocket: Map<string, string> = new Map();
//   private socketToSession: Map<string, string> = new Map();

//   constructor(
//     @InjectRepository(Conversation)
//     private convRepo: Repository<Conversation>,
//     @InjectRepository(Message)
//     private msgRepo: Repository<Message>,
//     @InjectRepository(Part)
//     private partRepo: Repository<Part>,
//     private ragService: RagService,
//     private guardrailService: GuardrailService,
//     private monitorService: QueryMonitorService,
//   ) {}

//   handleConnection(client: Socket) {
//     console.log('Client connected:', client.id);
//   }

//   handleDisconnect(client: Socket) {
//     console.log('Client disconnected:', client.id);
//     this.adminSockets.delete(client.id);
//     const sessionId = this.socketToSession.get(client.id);
//     if (sessionId) {
//       this.sessionToSocket.delete(sessionId);
//       this.socketToSession.delete(client.id);
//     }
//   }

//   @SubscribeMessage('admin_connect')
//   handleAdminConnect(@ConnectedSocket() client: Socket) {
//     this.adminSockets.add(client.id);
//     client.join('admin_room');
//     console.log('Admin connected:', client.id);
//     client.emit('admin_connected', { success: true });
//   }

//   @SubscribeMessage('user_connect')
//   async handleUserConnect(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { sessionId?: string },
//   ) {
//     let sessionId = data?.sessionId || uuidv4();
//     let conversation = await this.convRepo.findOne({ where: { sessionId } });
//     const isNewConversation = !conversation;

//     if (isNewConversation) {
//       conversation = this.convRepo.create({
//         sessionId,
//         guestName: 'Guest',
//         isAdminChatMode: false,
//         isAdminJoined: false,
//       });
//       await this.convRepo.save(conversation);
//     }

//     this.sessionToSocket.set(sessionId, client.id);
//     this.socketToSession.set(client.id, sessionId);
//     client.join(`conv_${conversation.id}`);

//     client.emit('session_ready', {
//       sessionId,
//       conversationId: conversation.id,
//       isAdminChatMode: conversation.isAdminChatMode ?? false,
//       isAdminJoined: conversation.isAdminJoined ?? false,
//     });

//     const adminModeExpired = await this.expireAdminModeIfStale(conversation.id);
//     if (adminModeExpired) {
//       conversation = await this.convRepo.findOne({ where: { id: conversation.id } });
//       client.emit('admin_chat_mode', { active: false });
//     }

//     if (isNewConversation) {
//       const welcome = await this.saveMessage(
//         conversation.id,
//         'bot',
//         'Welcome to **Veng.no**! I am your parts assistant. How can I help you today?',
//         'options',
//         { options: ['Find a Part', 'Search by Part Number', 'Order Help', 'Contact Us'] },
//       );
//       client.emit('message', welcome);
//     } else {
//       const history = await this.msgRepo.find({
//         where: { conversationId: conversation.id },
//         order: { createdAt: 'ASC' },
//         take: 50,
//       });
//       client.emit('history', history);
//       client.emit('conversation_history', { messages: history, conversation });
//     }
//   }

//   @SubscribeMessage('user_message')
//   async handleUserMessageCompat(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string; content: string },
//   ) {
//     await this.handleMessage(client, data);
//   }

//   @SubscribeMessage('message')
//   async handleMessage(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string; content: string },
//   ) {
//     const start = Date.now();
//     const { conversationId, content } = data;
//     const sessionId = this.socketToSession.get(client.id) || 'unknown';

//     // ── Safety filter: reject Ask Admin as user message ─────────────────
//     // Ask Admin should only be sent via 'ask_admin' event, never as 'message'
//     if (content.trim() === 'Ask Admin') {
//       console.warn(`[QA-FILTER] Ask Admin received as message (not ask_admin event). Rejecting. sessionId=${sessionId}`);
//       client.emit('error', { reason: 'Ask Admin must be sent via proper action, not as message.' });
//       return;
//     }

//     // ── GUARDRAIL: check input ─────────────────────────────────────────
//     const guardrail = this.guardrailService.checkInput(sessionId, content);

//     if (guardrail.action === 'block') {
//       const msg = await this.saveMessage(conversationId, 'bot', guardrail.reason || 'Message blocked.', 'options', {
//         options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
//       });
//       client.emit('message', msg);
//       // v7: if guardrail says escalate (repeated violations), notify admin room
//       if (guardrail.shouldEscalate) {
//         this.server.to('admin_room').emit('admin_requested', { conversationId, reason: 'repeated_violations' });
//       }
//       this.monitorService.log({
//         sessionId,
//         conversationId,
//         userInput: content,
//         responseMs: Date.now() - start,
//         timestamp: new Date(),
//         category: 'blocked',
//         guardrailAction: 'block',
//         guardrailRule: guardrail.triggeredRule,
//         ragUsed: false,
//         isEscalated: guardrail.shouldEscalate || false,
//       });
//       return;
//     }

//     // Save user message
//     const userMsg = await this.saveMessage(conversationId, 'user', content);
//     // Echo the persisted user message back to the conversation so user UI updates immediately.
//     this.server.to(`conv_${conversationId}`).emit('message', userMsg);
//     this.server.to('admin_room').emit('new_message', { conversationId, message: userMsg });

//     const conversation = await this.convRepo.findOne({ where: { id: conversationId } });
//     if (!conversation) return;

//     // ── ADMIN CHAT MODE ────────────────────────────────────────────────
//     if (conversation.isAdminChatMode) {
//       this.server.to('admin_room').emit('user_message_in_admin_mode', { conversationId, message: userMsg });
//       this.monitorService.log({
//         sessionId, conversationId, userInput: content, responseMs: Date.now() - start,
//         timestamp: new Date(), category: 'admin', guardrailAction: guardrail.action,
//         guardrailRule: guardrail.triggeredRule, ragUsed: false, isEscalated: true,
//       });
//       return;
//     }

//     // ── GUARDRAIL: handle 'warn' — send a helpful redirect but still process ──
//     if (guardrail.action === 'warn' && guardrail.triggeredRule !== 'profanity') {
//       const warnMsg = await this.saveMessage(conversationId, 'bot', guardrail.reason || 'Please keep messages on-topic.', 'options', {
//         options: ['Find a Part', 'Search by Part Number', 'Order Help'],
//       });
//       client.emit('message', warnMsg);
//       this.monitorService.log({
//         sessionId, conversationId, userInput: content, responseMs: Date.now() - start,
//         timestamp: new Date(), category: 'warned', guardrailAction: 'warn',
//         guardrailRule: guardrail.triggeredRule, ragUsed: false, isEscalated: false,
//       });
//       return;
//     }

//     // ── Handle option buttons ──────────────────────────────────────────
//     const userInput = content.trim();
//     let category = 'navigation';
//     let ragUsed = false;
//     let ragScore: number | undefined;

//     if (userInput === 'Find a Part') {
//       const brands = await this.getDistinctBrands();
//       const msg = await this.saveMessage(conversationId, 'bot', 'Select a brand:', 'brands', { brands });
//       this.server.to(`conv_${conversationId}`).emit('message', msg);
//       this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//       category = 'navigation';
//     } else if (userInput === 'Search by Part Number') {
//       const msg = await this.saveMessage(conversationId, 'bot', 'Enter the part number (e.g. BMW-X5-BR-001):', 'text', {});
//       this.server.to(`conv_${conversationId}`).emit('message', msg);
//       category = 'navigation';
//     } else if (userInput === 'Order Help' || userInput === 'Contact Us') {
//       // ── RAG: answer from knowledge base ───────────────────────────
//       const ragResults = await this.ragService.query(userInput, 1);
//       if (ragResults.length > 0 && ragResults[0].score > 0.1) {
//         ragUsed = true;
//         ragScore = ragResults[0].score;
//         const outputGuard = this.guardrailService.checkOutput(ragResults[0].answer);
//         const answer = outputGuard.action === 'redact' ? outputGuard.safeContent! : ragResults[0].answer;
//         const msg = await this.saveMessage(conversationId, 'bot', answer, 'options', {
//           options: ['Find a Part', 'Search by Part Number'],
//         });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       } else {
//         const msg = await this.saveMessage(
//           conversationId, 'bot',
//           userInput === 'Contact Us'
//             ? '📞 **Contact Veng:**\n• Email: support@veng.no\n• Use the **Contact Admin** button in the header to chat live'
//             : '📦 How can I help with your order? Please describe your issue.',
//           'options',
//           { options: ['Delivery Info', 'Return a Part', 'Damaged Part'] },
//         );
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       category = 'faq';
//     } else if (['Delivery Info', 'Return a Part', 'Damaged Part'].includes(userInput)) {
//       const ragResults = await this.ragService.query(userInput, 1);
//       ragUsed = ragResults.length > 0 && ragResults[0].score > 0.05;
//       if (ragUsed) {
//         ragScore = ragResults[0].score;
//         const answer = ragResults[0].answer;
//         const msg = await this.saveMessage(conversationId, 'bot', answer, 'options', {
//           options: ['Find a Part'],
//         });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       category = 'faq';
//     } else if (userInput === 'Order Help' || userInput === 'Contact Us') {
//       // Support info options
//       const supportMsg = userInput === 'Order Help'
//         ? 'For order assistance, please share your order number. Our team will help you track, modify, or resolve any issues.'
//         : '📞 **Contact Veng:**\n• Email: support@veng.no (24h response)\n• Phone: +47 XX XX XX XX (Mon–Fri 08:00–16:00 CET)\n• Live Chat: Use the **Contact Admin** button in the header';
//       const msg = await this.saveMessage(conversationId, 'bot', supportMsg, 'options', {
//         options: ['Find a Part', 'Search by Part Number'],
//       });
//       this.server.to(`conv_${conversationId}`).emit('message', msg);
//       category = 'info';
//     } else {
//       // ── PRIORITY 1: Widget flow (brand/model/variant/category selection) ──
//       // Must always run first so guided flows are never broken by RAG
//       const widgetFlowHandled = await this.handleWidgetFlow(conversationId, userInput);
//       if (widgetFlowHandled) {
//         this.monitorService.log({
//           sessionId,
//           conversationId,
//           userInput: content,
//           responseMs: Date.now() - start,
//           timestamp: new Date(),
//           category: 'widget',
//           guardrailAction: guardrail.action,
//           guardrailRule: guardrail.triggeredRule,
//           ragUsed: false,
//           isEscalated: false,
//           widgetType: 'flow',
//         });
//         return;
//       }

//       // ── PRIORITY 2: Part number extraction + DB lookup ─────────────────
//       // MUST run before RAG — part numbers containing letters (e.g. "6E1 868 153 EL")
//       // would otherwise be falsely matched by the FAQ TF-IDF index.
//       const extractedPartCode = this.extractPartCodeFromText(userInput);
//       if (extractedPartCode) {
//         const exactParts = await this.findPartsByPartCode(extractedPartCode);
//         if (exactParts.length > 0) {
//           const msg = await this.saveMessage(conversationId, 'bot',
//             `Found ${exactParts.length} result(s) for **${extractedPartCode}**:`, 'parts', { parts: exactParts });
//           this.server.to(`conv_${conversationId}`).emit('message', msg);
//           this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//           category = 'part-search';
//         } else {
//           const suggestions = await this.suggestPartsFromPartCode(extractedPartCode);
//           if (suggestions.length > 0) {
//             const msg = await this.saveMessage(conversationId, 'bot',
//               `No exact part found for **${extractedPartCode}**. Here are close matches:`, 'parts', { parts: suggestions });
//             this.server.to(`conv_${conversationId}`).emit('message', msg);
//             this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//           } else {
//             const msg = await this.saveMessage(conversationId, 'bot',
//               `No part found for **${extractedPartCode}** in our catalog.\n\nWe can source-check it for you — click **Ask Admin** and share the part number and vehicle details.`,
//               'options', { options: ['Find a Part', 'Ask Admin'] });
//             this.server.to(`conv_${conversationId}`).emit('message', msg);
//           }
//           category = 'part-search';
//         }
//       } else {
//       // ── PRIORITY 3: NLP intent matching ────────────────────────────────
//       // Handles structured intents: price queries, availability, fitment, damages etc.
//       const nlpAnswer = await this.handleNLPQuestion(conversationId, userInput);
//       if (nlpAnswer) {
//         const outputGuard = this.guardrailService.checkOutput(nlpAnswer.content);
//         const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : nlpAnswer.content;
//         const widgetType = nlpAnswer.widgetType || 'options';
//         const widgetPayload = nlpAnswer.widgetPayload || (widgetType === 'options'
//           ? { options: nlpAnswer.options || ['Find a Part', 'Search by Part Number'] }
//           : {});
//         const msg = await this.saveMessage(conversationId, 'bot', safeAnswer, widgetType, widgetPayload);
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//         category = 'nlp';
//       } else {
//         // ── PRIORITY 4: FAQ RAG (knowledge base) ───────────────────────────
//         // Only runs when there is NO part number signal and NLP has no match.
//         // This prevents OEM/aftermarket FAQ from firing on part number queries.
//         const blendedRagAnswer = await this.ragService.blendedFaqAnswer(userInput);
//         if (blendedRagAnswer) {
//           ragUsed = true;
//           const outputGuard = this.guardrailService.checkOutput(blendedRagAnswer);
//           const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : blendedRagAnswer;
//           const msg = await this.saveMessage(conversationId, 'bot', safeAnswer, 'options', {
//             options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
//           }, { ragUsed: true, ragSource: 'FAQ/Knowledge Base' });
//           this.server.to(`conv_${conversationId}`).emit('message', msg);
//           category = 'rag';
//         } else {
//           // ── PRIORITY 5: Brand match ──────────────────────────────────────
//           const brands = await this.getDistinctBrands();
//           const matchedBrand = brands.find((b) => b.toLowerCase() === userInput.toLowerCase());
//           if (matchedBrand) {
//             const models = await this.getModelsForBrand(matchedBrand);
//             const msg = await this.saveMessage(
//               conversationId, 'bot',
//               `Select model for ${matchedBrand}:`, 'models',
//               { brand: matchedBrand, models },
//             );
//             this.server.to(`conv_${conversationId}`).emit('message', msg);
//             this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//             category = 'widget';
//             this.monitorService.log({
//               sessionId, conversationId, userInput: content,
//               responseMs: Date.now() - start, timestamp: new Date(),
//               category, guardrailAction: guardrail.action,
//               guardrailRule: guardrail.triggeredRule, ragUsed, ragScore,
//               isEscalated: false, widgetType: 'models',
//             });
//             return;
//           }

//           // ── PRIORITY 6: Fallback ─────────────────────────────────────────
//           const msg = await this.saveMessage(conversationId, 'bot',
//             "I'm here to help! Choose an option or type a part number:", 'options',
//             { options: ['Find a Part', 'Search by Part Number', 'Order Help'] });
//           this.server.to(`conv_${conversationId}`).emit('message', msg);
//           category = 'fallback';
//         }
//       }
//       } // end extractedPartCode else
//     }

//     // ── Monitor log ────────────────────────────────────────────────────
//     this.monitorService.log({
//       sessionId, conversationId, userInput: content,
//       responseMs: Date.now() - start,
//       timestamp: new Date(),
//       category,
//       guardrailAction: guardrail.action,
//       guardrailRule: guardrail.triggeredRule,
//       ragUsed,
//       ragScore,
//       isEscalated: false,
//       widgetType: undefined,
//     });
//   }

//   @SubscribeMessage('admin_message')
//   async handleAdminMessage(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string; content: string },
//   ) {
//     const { conversationId, content } = data;
//     const msg = await this.saveMessage(conversationId, 'admin', content);
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//     this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//   }

//   /**
//    * v7: Admin RAG query — admin can ask the knowledge base a question
//    * without routing it to a user conversation.
//    * Event: 'admin_rag_query'  Data: { query: string }
//    * Reply: 'admin_rag_result' Data: { query, results: [{question, answer, score}] }
//    */
//   @SubscribeMessage('admin_rag_query')
//   async handleAdminRagQuery(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { query: string },
//   ) {
//     const results = await this.ragService.adminQuery(data.query || '');
//     client.emit('admin_rag_result', {
//       query: data.query,
//       results: results.map((r) => ({
//         question: r.document.metadata.question || r.document.id,
//         answer: r.answer,
//         score: Math.round(r.score * 1000) / 1000,
//       })),
//     });
//   }

//   @SubscribeMessage('ask_admin')
//   async handleAskAdminCompat(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     const { conversationId } = data;
//     await this.convRepo.update({ id: conversationId }, {
//       isAdminChatMode: true,
//       isAdminJoined: false,
//       lastAdminRequestedAt: new Date(),
//     });
//     this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: true });
//     const msg = await this.saveMessage(
//       conversationId,
//       'bot',
//       '⏳ Connecting you to an admin... Please hold on. An agent will join shortly.',
//       null,
//       null,
//     );
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//     this.server.to('admin_room').emit('admin_requested', { conversationId });
//     this.server.to('admin_room').emit('admin_chat_requested', { conversationId });
//   }

//   @SubscribeMessage('ask_veng')
//   async handleAskVengCompat(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     const { conversationId } = data;
//     await this.convRepo.update({ id: conversationId }, {
//       isAdminChatMode: false,
//       isAdminJoined: false,
//       lastAdminRequestedAt: null,
//     });
//     this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
//     const msg = await this.saveMessage(
//       conversationId,
//       'bot',
//       'I am back as your Veng assistant. What would you like to do next?',
//       'options',
//       { options: ['Find a Part', 'Search by Part Number', 'Order Help', 'Contact Us'] },
//     );
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//   }

//   @SubscribeMessage('admin_join')
//   async handleAdminJoin(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     const { conversationId } = data;
//     await this.convRepo.update({ id: conversationId }, { isAdminJoined: true });
//     this.server.to(`conv_${conversationId}`).emit('admin_joined');
//     const msg = await this.saveMessage(conversationId, 'bot', '✅ An admin has joined the chat. Go ahead!');
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//     this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//   }

//   @SubscribeMessage('admin_join_conversation')
//   async handleAdminJoinCompat(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     const { conversationId } = data;
//     const conversation = await this.convRepo.findOne({ where: { id: conversationId } });
//     if (!conversation) return;
//     const history = await this.msgRepo.find({
//       where: { conversationId },
//       order: { createdAt: 'ASC' },
//       take: 100,
//     });
//     client.emit('conversation_history', { messages: history, conversation });
//   }

//   @SubscribeMessage('admin_leave')
//   async handleAdminLeave(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     const { conversationId } = data;
//     await this.convRepo.update({ id: conversationId }, { isAdminChatMode: false, isAdminJoined: false, lastAdminRequestedAt: null });
//     this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
//     const msg = await this.saveMessage(conversationId, 'bot',
//       'Admin has left. I\'m back as your Veng assistant!', 'options',
//       { options: ['Find a Part', 'Search by Part Number'] });
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//     this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//   }

//   @SubscribeMessage('resolve_conversation')
//   async handleResolve(
//     @ConnectedSocket() client: Socket,
//     @MessageBody() data: { conversationId: string },
//   ) {
//     await this.convRepo.update({ id: data.conversationId }, { isResolved: true });
//     this.server.to('admin_room').emit('conversation_resolved', { conversationId: data.conversationId });
//   }

//   // ── Widget flow handler ────────────────────────────────────────────────
//   private async handleWidgetFlow(conversationId: string, userInput: string): Promise<boolean> {
//     const lastBotMsg = await this.msgRepo.findOne({
//       where: { conversationId, senderType: 'bot' },
//       order: { createdAt: 'DESC' },
//     });
//     if (!lastBotMsg?.widgetType) return false;

//     if (lastBotMsg.widgetType === 'brands') {
//       const brands = await this.getDistinctBrands();
//       const matched = brands.find(b => b.toLowerCase() === userInput.toLowerCase());
//       if (matched) {
//         const models = await this.getModelsForBrand(matched);
//         const msg = await this.saveMessage(conversationId, 'bot', `Select model for ${matched}:`, 'models', { brand: matched, models });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//         this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//       } else {
//         const brands2 = await this.getDistinctBrands();
//         const msg = await this.saveMessage(conversationId, 'bot', 'Please select a brand:', 'brands', { brands: brands2 });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       return true;
//     }

//     if (lastBotMsg.widgetType === 'models') {
//       const { brand } = lastBotMsg.widgetPayload;
//       const models = await this.getModelsForBrand(brand);
//       const matched = models.find(m => m.toLowerCase() === userInput.toLowerCase());
//       if (matched) {
//         const variants = await this.getVariantsForBrandModel(brand, matched);
//         const msg = await this.saveMessage(conversationId, 'bot', `Select variant for ${brand} ${matched}:`, 'variants', { brand, model: matched, variants });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//         this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//       } else {
//         const msg = await this.saveMessage(conversationId, 'bot', 'Please select a model:', 'models', { brand, models });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       return true;
//     }

//     if (lastBotMsg.widgetType === 'variants') {
//       const { brand, model } = lastBotMsg.widgetPayload;
//       const variants = await this.getVariantsForBrandModel(brand, model);
//       const matched = variants.find(v => v.toLowerCase() === userInput.toLowerCase());
//       if (matched) {
//         const categories = await this.getCategoriesForVariant(brand, model, matched);
//         const msg = await this.saveMessage(conversationId, 'bot', `Pick category for ${brand} ${model}:`, 'categories', { brand, model, variant: matched, categories });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//         this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//       } else {
//         const msg = await this.saveMessage(conversationId, 'bot', 'Please select a variant:', 'variants', { brand, model, variants });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       return true;
//     }

//     if (lastBotMsg.widgetType === 'categories') {
//       const { brand, model, variant } = lastBotMsg.widgetPayload;
//       const categories = await this.getCategoriesForVariant(brand, model, variant);
//       const matched = categories.find(c => c.toLowerCase() === userInput.toLowerCase());
//       if (matched) {
//         const parts = await this.getPartsForCategory(brand, model, variant, matched);
//         if (parts.length === 0) {
//           const msg = await this.saveMessage(conversationId, 'bot', `No parts for ${matched} — ${brand} ${model}. Try another.`, 'categories', { brand, model, variant, categories });
//           this.server.to(`conv_${conversationId}`).emit('message', msg);
//         } else {
//           const msg = await this.saveMessage(conversationId, 'bot', `${matched} — ${brand} ${model} ${variant}`, 'parts', { parts });
//           this.server.to(`conv_${conversationId}`).emit('message', msg);
//           this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//         }
//       } else {
//         const msg = await this.saveMessage(conversationId, 'bot', 'Please select a category:', 'categories', { brand, model, variant, categories });
//         this.server.to(`conv_${conversationId}`).emit('message', msg);
//       }
//       return true;
//     }

//     return false;
//   }

//   private async expireAdminModeIfStale(conversationId: string): Promise<boolean> {
//     const conv = await this.convRepo.findOne({ where: { id: conversationId } });
//     if (!conv?.isAdminChatMode || conv.isAdminJoined || !conv.lastAdminRequestedAt) return false;
//     const elapsed = Date.now() - new Date(conv.lastAdminRequestedAt).getTime();
//     if (elapsed < ChatGateway.ADMIN_WAIT_TIMEOUT_MS) return false;
//     await this.convRepo.update({ id: conversationId }, { isAdminChatMode: false, isAdminJoined: false, lastAdminRequestedAt: null });
//     this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
//     const msg = await this.saveMessage(conversationId, 'bot',
//       'Admin did not reply in time. I\'ve switched back to the Veng assistant.',
//       'options', { options: ['Find a Part', 'Search by Part Number'] });
//     this.server.to(`conv_${conversationId}`).emit('message', msg);
//     this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
//     return true;
//   }

//   private async handleNLPQuestion(conversationId: string, input: string): Promise<NlpReply | null> {
//     const q = input.toLowerCase();

//     if (q.includes('does not fit') || q.includes("doesn't fit") || q.includes('wrong part')) {
//       return {
//         content: "Sorry about that. Please share your order number and vehicle details. We will verify fitment and arrange return/exchange if needed.\n\nUse the **Contact Admin** button in the header to speak with our team directly.",
//         widgetType: 'options',
//         options: ['Order Help'],
//       };
//     }
//     if (q.includes('damaged') || q.includes('replacement')) {
//       return {
//         content: "Sorry this arrived damaged. Please send clear photos with your order number. We will prioritize a replacement immediately. Use the **Contact Admin** button in the header to connect with us immediately.",
//         widgetType: 'options',
//         options: ['Damaged Part'],
//       };
//     }
//     if (q.includes('not received') || q.includes("haven't received") || q.includes('check the status')) {
//       return {
//         content: "Sorry to hear that. Please share your order number so we can trace shipment status, or use the **Contact Admin** button in the header for immediate assistance.",
//         widgetType: 'options',
//         options: ['Order Help'],
//       };
//     }
//     if ((q.includes('when will') && q.includes('order')) || q.includes('delivery') || q.includes('delivered')) {
//       return {
//         content: '🚚 **Delivery Times:**\n• **In Stock** parts → 1–3 business days\n• **2–3 Days** → 2–3 business days\n• **On Order** → 5–10 business days\nFor your specific order status, share your order number or use the **Contact Admin** button in the header.',
//         widgetType: 'options',
//         options: ['Order Help'],
//       };
//     }
//     if ((q.includes('not seeing') && q.includes('price')) || (q.includes('price') && q.includes('veng.no'))) {
//       return {
//         content: 'Prices can be hidden when you are not on a part result page or when the vehicle/part match is incomplete. All prices are shown in **NOK** including VAT once a valid part match is found. Use **Find a Part** or **Search by Part Number** and we can also verify via the header Contact Admin button.',
//         widgetType: 'options',
//         options: ['Find a Part', 'Search by Part Number'],
//       };
//     }

//     // NOTE: Part number extraction is handled at Priority 2 in the gateway
//     // before handleNLPQuestion is called. No part-code logic here.

//     const intentMatches = await this.findPartsFromIntent(input);
//     const asksPrice = /\b(price|cost|how much)\b/i.test(input);
//     const asksAvailability = /\b(do you have|can you supply|do you supply|available|supply|need|looking for|searching for|want|find me|get me)\b/i.test(input);
//     const hasVehicleOrModelHint = this.hasVehicleOrModelHint(input);
//     const hasPartTopicHint = this.hasPartTopicHint(input);

//     if (intentMatches.length > 0 && (asksPrice || asksAvailability || hasVehicleOrModelHint || hasPartTopicHint)) {
//       if (asksPrice) {
//         const preview = intentMatches
//           .slice(0, 3)
//           .map((p) => `• ${p.name} (${p.partNumber}) — **NOK ${Number(p.price || 0).toLocaleString()}**`)
//           .join('\n');
//         return {
//           content: `I found pricing for matching parts:\n${preview}`,
//           widgetType: 'parts',
//           widgetPayload: { parts: intentMatches },
//         };
//       }

//       return {
//         content: `I found ${intentMatches.length} matching part(s):`,
//         widgetType: 'parts',
//         widgetPayload: { parts: intentMatches },
//       };
//     }

//     if (q.includes('price') || q.includes('nok')) {
//       return {
//         content: 'All prices are shown in **NOK** (including VAT). Share a part number, vehicle ID, or use **Find a Part** for exact pricing.',
//         widgetType: 'options',
//         options: ['Find a Part', 'Search by Part Number'],
//       };
//     }

//     if (asksAvailability) {
//       const supplyContext = this.extractSupplyContext(input);
//       if (supplyContext.brand) {
//         const where: any = { brand: supplyContext.brand };
//         if (supplyContext.model) where.model = supplyContext.model;
//         const count = await this.partRepo.count({ where });
//         if (count > 0) {
//           const scopeText = supplyContext.model
//             ? `${supplyContext.brand} ${supplyContext.model}`
//             : supplyContext.brand;
//           return {
//             content: `Yes, we currently list **${count} part(s)** for ${scopeText}.`,
//             widgetType: 'options',
//             options: ['Find a Part', 'Search by Part Number'],
//           };
//         }

//         const scopeText = supplyContext.model
//           ? `${supplyContext.brand} ${supplyContext.model}`
//           : supplyContext.brand;
//         return {
//           content: `I could not find a direct match for ${scopeText} in the live catalog right now. Use the **Contact Admin** button to speak with us and we can source-check it for you.`,
//           widgetType: 'options',
//           options: ['Find a Part'],
//         };
//       }
//     }

//     if (q.includes('wheel bearing') || q.includes('shock absorber') || q.includes('categories')) {
//       return {
//         content: 'Yes, we supply categories such as brakes, steering, suspension, cooling, engine, electrical, and exhaust. Share your vehicle ID/registration or use **Find a Part** for exact matches.',
//         widgetType: 'options',
//         options: ['Find a Part'],
//       };
//     }

//     return null;
//   }

//   /**
//    * Extract a part number from free-text user input.
//    *
//    * Handles OEM-style codes like:
//    *   "6E1 868 153 EL"          — space-separated with letter suffix
//    *   "BMW-X5-BR-001"           — hyphen-separated internal code
//    *   "part number 6E1 868 153 EL" — explicit prefix
//    *   "do you have 6E1 868 153 EL?" — embedded in sentence
//    *   "Is 7L6 601 025 H in stock?"  — code before common words
//    *
//    * Design rules:
//    *   - SEED token must contain a digit (rules out plain English words)
//    *   - CONTINUATION tokens must also contain a digit OR be a short (≤3 char)
//    *     uppercase suffix like "A", "EL", "AA" — stops on common English words
//    *   - Minimum one pure-digit group in the extracted sequence
//    *   - Common English stop-words terminate the scan even if alphanumeric
//    */
//   private readonly PART_STOP_WORDS = new Set([
//     'in','is','it','of','for','my','the','to','at','as','by','on',
//     'do','go','up','we','me','he','she','they','you','can','has',
//     'had','but','not','are','was','with','that','this','from','have',
//     'all','any','and','or','an','be','no','so','if','ok','hi',
//     'stock','part','parts','need','want','find','get','have','has',
//     'looking','please','help','does','did','will','would','could',
//     'should','about','some','more','also','just','here','there',
//     'what','when','where','how','who','which','why','new','old',
//   ]);

//   private extractPartCodeFromText(input: string): string | null {
//     const trimmed = input.trim();

//     // ── Case 1: Direct input — entire message is a part code ──────────
//     // Only matches if it looks like code (no common English words when split)
//     const directPattern = /^[A-Za-z0-9][A-Za-z0-9\s\-]{4,39}$/;
//     if (directPattern.test(trimmed) && /\d/.test(trimmed)) {
//       const tokens = trimmed.split(/\s+/).filter(Boolean);
//       const pureDigitCount = tokens.filter((t) => /^\d+$/.test(t)).length;
//       const digitAnyCount = tokens.filter((t) => /\d/.test(t)).length;
//       const hasStopWord = tokens.some((t) => this.PART_STOP_WORDS.has(t.toLowerCase()));
//       if (
//         !hasStopWord &&
//         tokens.length <= 8 &&
//         (pureDigitCount >= 1 || digitAnyCount >= Math.ceil(tokens.length / 2))
//       ) {
//         return trimmed.toUpperCase();
//       }
//     }

//     // ── Case 2: Explicit "part number" / "part#" prefix ───────────────
//     const partPrefixMatch = input.match(/part(?:\s+number)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\s\-]{4,40})/i);
//     if (partPrefixMatch && /\d/.test(partPrefixMatch[1])) {
//       const tokens = partPrefixMatch[1].trim().split(/\s+/);
//       const codeTokens: string[] = [];
//       for (const token of tokens) {
//         if (this.PART_STOP_WORDS.has(token.toLowerCase())) break;
//         if (/^[A-Z0-9-]+$/i.test(token)) { codeTokens.push(token.toUpperCase()); continue; }
//         break;
//       }
//       const candidate = codeTokens.join(' ').trim();
//       if (candidate.length >= 5 && /\d/.test(candidate)) return candidate;
//     }

//     // ── Case 3: Embedded code scan ────────────────────────────────────
//     // Scans word-by-word. Seed token MUST contain a digit (not a plain word).
//     // Continuation: accept if it has a digit, OR if it is a short pure-letter
//     //   suffix (1–3 chars, e.g. "A", "EL", "AA") AND the previous token had digits.
//     // Stop immediately on stop-words, punctuation-only, or long pure-letter words.
//     const words = input.split(/\s+/);
//     for (let start = 0; start < words.length; start++) {
//       const seedClean = words[start].replace(/[?.,!]+$/, '');
//       // Seed must have a digit and be alphanumeric
//       if (!/\d/.test(seedClean)) continue;
//       if (!/^[A-Z0-9-]+$/i.test(seedClean) || seedClean.length === 0) continue;
//       if (this.PART_STOP_WORDS.has(seedClean.toLowerCase())) continue;

//       const codeTokens = [seedClean.toUpperCase()];
//       let pureDigitCount = /^\d+$/.test(seedClean) ? 1 : 0;
//       let lastHadDigit = /\d/.test(seedClean);

//       for (let j = start + 1; j < Math.min(start + 8, words.length); j++) {
//         const raw = words[j].replace(/[?.,!]+$/, '');
//         if (raw.length === 0) break;
//         if (this.PART_STOP_WORDS.has(raw.toLowerCase())) break;
//         if (!/^[A-Z0-9-]+$/i.test(raw)) break;

//         const hasDigit = /\d/.test(raw);
//         const isPureLetterSuffix = /^[A-Z]{1,3}$/i.test(raw) && !hasDigit;

//         // Accept digit-containing tokens freely; accept short pure-letter suffix
//         // only when previous token had digits (classic OEM suffix like "EL", "AA")
//         if (hasDigit) {
//           codeTokens.push(raw.toUpperCase());
//           if (/^\d+$/.test(raw)) pureDigitCount++;
//           lastHadDigit = true;
//         } else if (isPureLetterSuffix && lastHadDigit) {
//           codeTokens.push(raw.toUpperCase());
//           lastHadDigit = false; // suffix consumed — don't chain another suffix
//         } else {
//           break; // long pure-letter word = English word, stop
//         }
//       }

//       // Valid: ≥2 tokens AND at least one pure-digit group
//       if (codeTokens.length >= 2 && pureDigitCount >= 1) {
//         return codeTokens.join(' ');
//       }
//     }

//     return null;
//   }

//   private async findPartsByPartCode(code: string): Promise<Part[]> {
//     const trimmed = code.trim();

//     // 1. Exact match (case-insensitive) — most precise
//     const exact = await this.partRepo
//       .createQueryBuilder('part')
//       .where('LOWER(part.partNumber) = LOWER(:code)', { code: trimmed })
//       .orWhere('LOWER(part.internalCode) = LOWER(:code)', { code: trimmed })
//       .take(8)
//       .getMany();
//     if (exact.length > 0) return exact;

//     // 2. Normalized match — strips spaces/hyphens for cross-format matching
//     // e.g. "6E1 868 153 EL" vs "6E1868153EL" vs "6E1-868-153-EL"
//     const normalized = this.normalizeCode(trimmed);
//     if (!normalized || normalized.length < 4) return [];

//     const candidates = await this.partRepo
//       .createQueryBuilder('part')
//       .where('part.partNumber IS NOT NULL')
//       .orWhere('part.internalCode IS NOT NULL')
//       .take(500)
//       .getMany();

//     const normalizedMatches = candidates.filter((p) => {
//       const pn = this.normalizeCode(p.partNumber || '');
//       const ic = this.normalizeCode(p.internalCode || '');
//       return pn === normalized || ic === normalized;
//     }).slice(0, 8);

//     if (normalizedMatches.length > 0) return normalizedMatches;

//     // 3. Prefix/suffix containment — catches partial codes
//     return candidates.filter((p) => {
//       const pn = this.normalizeCode(p.partNumber || '');
//       const ic = this.normalizeCode(p.internalCode || '');
//       return (
//         (pn.length >= 5 && (pn.startsWith(normalized) || normalized.startsWith(pn))) ||
//         (ic.length >= 5 && (ic.startsWith(normalized) || normalized.startsWith(ic)))
//       );
//     }).slice(0, 8);
//   }

//   private hasVehicleOrModelHint(input: string): boolean {
//     const q = input.toLowerCase();
//     // Generic alphanumeric model pattern (e.g. E300, XC90, Q7)
//     if (/\b[a-z]{1,4}\d{1,4}\b/i.test(input)) return true;
//     const modelKeywords = [
//       'e-tron', 'land cruiser', 'glk', 'q7', 'q5', 'q3', 'a4', 'a6', 'a3',
//       'x5', 'x3', 'x1', '3 series', '5 series', '7 series',
//       'c-class', 'e-class', 's-class', 'glc', 'gle', 'glb',
//       'xc90', 'xc60', 'xc40', 'v60', 's90', 's60',
//       'civic', 'accord', 'cr-v', 'hr-v',
//       'camry', 'corolla', 'rav4', 'prius', 'hilux',
//       'model 3', 'model s', 'model x', 'model y',
//       'golf', 'passat', 'tiguan', 'polo',
//       'focus', 'fiesta', 'kuga', 'transit',
//       '208', '308', '3008', 'clio', 'megane',
//     ];
//     return modelKeywords.some((m) => q.includes(m));
//   }

//   private hasPartTopicHint(input: string): boolean {
//     const q = input.toLowerCase();
//     return [
//       'brake disc', 'brake pad', 'brake pads', 'brakes',
//       'control arm', 'steering rack', 'radiator',
//       'wheel bearing', 'shock absorber', 'absorber',
//       'exhaust', 'suspension', 'steering',
//       'oil filter', 'air filter', 'fuel filter', 'cabin filter',
//       'timing belt', 'timing chain', 'drive belt', 'serpentine',
//       'spark plug', 'ignition coil', 'alternator', 'starter motor',
//       'water pump', 'thermostat', 'coolant',
//       'clutch', 'gearbox', 'transmission',
//       'cv joint', 'axle', 'driveshaft',
//       'tie rod', 'ball joint', 'strut',
//       'caliper', 'rotor', 'drum',
//       'headlight', 'tail light', 'bulb',
//       'battery', 'sensor', 'lambda', 'o2 sensor',
//       'windshield', 'wiper', 'mirror',
//       'bumper', 'bonnet', 'hood', 'door handle', 'fender',
//     ].some((k) => q.includes(k));
//   }

//   private extractSupplyContext(input: string): { brand?: string; model?: string } {
//     const q = input.toLowerCase();
//     const brandMap: Array<{ pattern: RegExp; brand: string }> = [
//       { pattern: /mercedes(?:-benz)?/i, brand: 'Mercedes-Benz' },
//       { pattern: /honda/i, brand: 'Honda' },
//       { pattern: /bmw/i, brand: 'BMW' },
//       { pattern: /volvo/i, brand: 'Volvo' },
//       { pattern: /audi/i, brand: 'Audi' },
//       { pattern: /toyota/i, brand: 'Toyota' },
//       { pattern: /tesla/i, brand: 'Tesla' },
//       { pattern: /volkswagen|vw\b/i, brand: 'Volkswagen' },
//       { pattern: /ford/i, brand: 'Ford' },
//       { pattern: /peugeot/i, brand: 'Peugeot' },
//       { pattern: /renault/i, brand: 'Renault' },
//       { pattern: /nissan/i, brand: 'Nissan' },
//       { pattern: /hyundai/i, brand: 'Hyundai' },
//       { pattern: /kia/i, brand: 'Kia' },
//       { pattern: /skoda/i, brand: 'Skoda' },
//       { pattern: /seat/i, brand: 'SEAT' },
//       { pattern: /opel|vauxhall/i, brand: 'Opel' },
//       { pattern: /porsche/i, brand: 'Porsche' },
//       { pattern: /lexus/i, brand: 'Lexus' },
//       { pattern: /subaru/i, brand: 'Subaru' },
//       { pattern: /mazda/i, brand: 'Mazda' },
//       { pattern: /mitsubishi/i, brand: 'Mitsubishi' },
//     ];

//     let brand: string | undefined;
//     for (const item of brandMap) {
//       if (item.pattern.test(input)) {
//         brand = item.brand;
//         break;
//       }
//     }

//     // Model hints — map common model keywords to brand+model
//     const modelHints: Array<{ keyword: string; model: string; defaultBrand?: string }> = [
//       { keyword: 'e-tron', model: 'e-tron', defaultBrand: 'Audi' },
//       { keyword: 'q7', model: 'Q7', defaultBrand: 'Audi' },
//       { keyword: 'q5', model: 'Q5', defaultBrand: 'Audi' },
//       { keyword: 'q3', model: 'Q3', defaultBrand: 'Audi' },
//       { keyword: 'a4', model: 'A4', defaultBrand: 'Audi' },
//       { keyword: 'a6', model: 'A6', defaultBrand: 'Audi' },
//       { keyword: 'land cruiser', model: 'Land Cruiser', defaultBrand: 'Toyota' },
//       { keyword: 'rav4', model: 'RAV4', defaultBrand: 'Toyota' },
//       { keyword: 'camry', model: 'Camry', defaultBrand: 'Toyota' },
//       { keyword: 'corolla', model: 'Corolla', defaultBrand: 'Toyota' },
//       { keyword: 'glk', model: 'GLK', defaultBrand: 'Mercedes-Benz' },
//       { keyword: 'glc', model: 'GLC', defaultBrand: 'Mercedes-Benz' },
//       { keyword: 'c-class', model: 'C-Class', defaultBrand: 'Mercedes-Benz' },
//       { keyword: 'e-class', model: 'E-Class', defaultBrand: 'Mercedes-Benz' },
//       { keyword: 'x5', model: 'X5', defaultBrand: 'BMW' },
//       { keyword: 'x3', model: 'X3', defaultBrand: 'BMW' },
//       { keyword: 'x1', model: 'X1', defaultBrand: 'BMW' },
//       { keyword: '3 series', model: '3 Series', defaultBrand: 'BMW' },
//       { keyword: '5 series', model: '5 Series', defaultBrand: 'BMW' },
//       { keyword: 'xc90', model: 'XC90', defaultBrand: 'Volvo' },
//       { keyword: 'xc60', model: 'XC60', defaultBrand: 'Volvo' },
//       { keyword: 'civic', model: 'Civic', defaultBrand: 'Honda' },
//       { keyword: 'cr-v', model: 'CR-V', defaultBrand: 'Honda' },
//       { keyword: 'model 3', model: 'Model 3', defaultBrand: 'Tesla' },
//       { keyword: 'model s', model: 'Model S', defaultBrand: 'Tesla' },
//       { keyword: 'golf', model: 'Golf', defaultBrand: 'Volkswagen' },
//       { keyword: 'passat', model: 'Passat', defaultBrand: 'Volkswagen' },
//       { keyword: 'tiguan', model: 'Tiguan', defaultBrand: 'Volkswagen' },
//     ];

//     let model: string | undefined;
//     for (const hint of modelHints) {
//       if (q.includes(hint.keyword)) {
//         model = hint.model;
//         if (!brand && hint.defaultBrand) brand = hint.defaultBrand;
//         break;
//       }
//     }

//     return { brand, model };
//   }

//   private async findPartsFromIntent(input: string): Promise<Part[]> {
//     const q = input.toLowerCase();
//     const vehicleIdMatch = input.match(/\b([A-Z]{2,6}\d{3,10})\b/i);
//     const vehicleId = vehicleIdMatch?.[1];
//     const supplyContext = this.extractSupplyContext(input);
//     const keywords: string[] = [];

//     const phraseKeywords: Array<{ pattern: RegExp; keys: string[] }> = [
//       { pattern: /brake\s*disc/i, keys: ['brake disc', 'brake discs', 'disc'] },
//       { pattern: /brake\s*pad/i, keys: ['brake pad', 'brake pads'] },
//       { pattern: /control\s*arm/i, keys: ['control arm'] },
//       { pattern: /steering\s*rack/i, keys: ['steering rack'] },
//       { pattern: /radiator/i, keys: ['radiator'] },
//       { pattern: /wheel\s*bearing/i, keys: ['wheel bearing', 'bearings'] },
//       { pattern: /shock\s*absorber/i, keys: ['shock absorber', 'absorber'] },
//       { pattern: /exhaust/i, keys: ['exhaust'] },
//       { pattern: /suspension/i, keys: ['suspension'] },
//       { pattern: /steering/i, keys: ['steering'] },
//       { pattern: /rear/i, keys: ['rear'] },
//       { pattern: /front/i, keys: ['front'] },
//       { pattern: /lower/i, keys: ['lower'] },
//     ];

//     for (const item of phraseKeywords) {
//       if (item.pattern.test(q)) keywords.push(...item.keys);
//     }

//     const candidates = await this.partRepo
//       .createQueryBuilder('part')
//       .where('1=1')
//       .andWhere(vehicleId ? 'LOWER(part.vehicleId) = LOWER(:vehicleId)' : '1=1', { vehicleId })
//       .andWhere(supplyContext.brand ? 'LOWER(part.brand) = LOWER(:brand)' : '1=1', { brand: supplyContext.brand })
//       .andWhere(supplyContext.model ? 'LOWER(part.model) LIKE LOWER(:model)' : '1=1', { model: `%${supplyContext.model || ''}%` })
//       .take(200)
//       .getMany();

//     if (candidates.length === 0) return [];
//     if (keywords.length === 0) return candidates.slice(0, 8);

//     const scored = candidates
//       .map((part) => {
//         const haystack = [
//           part.name,
//           part.category,
//           part.subCategory,
//           part.position,
//           part.fitment,
//           part.partNumber,
//           part.model,
//         ].filter(Boolean).join(' ').toLowerCase();

//         const score = keywords.reduce((sum, k) => sum + (haystack.includes(k) ? 10 : 0), 0);
//         return { part, score };
//       })
//       .filter((x) => x.score > 0)
//       .sort((a, b) => b.score - a.score)
//       .slice(0, 8)
//       .map((x) => x.part);

//     return scored.length > 0 ? scored : candidates.slice(0, 8);
//   }

//   private async saveMessage(conversationId: string, senderType: string, content: string, widgetType?: string, widgetPayload?: any, metadata?: any): Promise<Message> {
//     const msg = this.msgRepo.create({ conversationId, senderType, content, widgetType, widgetPayload, metadata });
//     return this.msgRepo.save(msg);
//   }

//   private async getDistinctBrands(): Promise<string[]> {
//     const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.brand', 'brand').where('part.brand IS NOT NULL').getRawMany();
//     if (result.length === 0) return ['BMW', 'Audi', 'Tesla', 'Toyota', 'Mercedes-Benz', 'Honda', 'Volvo'];
//     return result.map(r => r.brand).filter(Boolean);
//   }

//   private async getModelsForBrand(brand: string): Promise<string[]> {
//     const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.model', 'model').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('part.model IS NOT NULL').getRawMany();
//     const defaults = { BMW: ['X1','X3','X5','X6','5 Series','3 Series'], Audi: ['A4','A6','Q5','Q7','e-tron'], Tesla: ['Model 3','Model S','Model X','Model Y'], Toyota: ['Camry','Corolla','RAV4','Prius'], 'Mercedes-Benz': ['C-Class','E-Class','GLC','S-Class'], Honda: ['Civic','CR-V','Accord'], Volvo: ['XC60','XC90','V60','S90'] };
//     if (result.length > 0) return result.map(r => r.model).filter(Boolean);
//     return defaults[brand] || ['Model 1','Model 2'];
//   }

//   private async getVariantsForBrandModel(brand: string, model: string): Promise<string[]> {
//     const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.variant', 'variant').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('part.variant IS NOT NULL').getRawMany();
//     if (result.length > 0) return result.map(r => r.variant).filter(Boolean);
//     return [`${model} 2.0 TDI (2019-2023)`, `${model} 3.0 TDI (2020-2024)`];
//   }

//   private async getCategoriesForVariant(brand: string, model: string, variant: string): Promise<string[]> {
//     const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.category', 'category').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('part.category IS NOT NULL').getRawMany();
//     if (result.length > 0) return result.map(r => r.category).filter(Boolean);
//     return ['Body Parts','Brakes','Cooling','Electrical','Engine','Exhaust','Steering','Suspension'];
//   }

//   private async getPartsForCategory(brand: string, model: string, variant: string, category: string): Promise<Part[]> {
//     return this.partRepo.createQueryBuilder('part').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('LOWER(part.category) = LOWER(:category)', { category }).take(10).getMany();
//   }

//   private normalizeCode(input: string): string {
//     return input.replace(/[^a-z0-9]/gi, '').toLowerCase();
//   }

//   private async suggestPartsFromPartCode(input: string): Promise<Part[]> {
//     const clean = this.normalizeCode(input);
//     if (!clean || clean.length < 4) return [];

//     const candidates = await this.partRepo
//       .createQueryBuilder('part')
//       .where('part.partNumber IS NOT NULL')
//       .orWhere('part.internalCode IS NOT NULL')
//       .take(120)
//       .getMany();

//     const scored = candidates
//       .map((part) => {
//         const pn = this.normalizeCode(part.partNumber || '');
//         const ic = this.normalizeCode(part.internalCode || '');
//         const score = this.matchScore(clean, pn, ic);
//         return { part, score };
//       })
//       .filter((x) => x.score > 0)
//       .sort((a, b) => b.score - a.score)
//       .slice(0, 6)
//       .map((x) => x.part);

//     return scored;
//   }

//   private matchScore(target: string, pn: string, ic: string): number {
//     if (!pn && !ic) return 0;
//     if (target === pn || target === ic) return 100;

//     let score = 0;
//     if (pn.includes(target) || ic.includes(target)) score += 50;
//     if (target.includes(pn) || target.includes(ic)) score += 35;

//     const targetTokens = target.match(/[a-z]+|\d+/gi) || [];
//     for (const token of targetTokens) {
//       if (token.length < 2) continue;
//       if (pn.includes(token) || ic.includes(token)) score += token.length > 3 ? 12 : 7;
//     }

//     return score;
//   }
// }


import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { Part } from '../entities/part.entity';
import { v4 as uuidv4 } from 'uuid';
import { RagService } from '../services/rag.service';
import { GuardrailService } from '../services/guardrail.service';
import { QueryMonitorService } from '../services/monitor.service';
import { GeminiService } from '../services/gemini.service';

type NlpReply = {
  content: string;
  widgetType?: string;
  widgetPayload?: any;
  options?: string[];
};

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private static readonly ADMIN_WAIT_TIMEOUT_MS = 3 * 60 * 1000;
  private adminSockets: Set<string> = new Set();
  private sessionToSocket: Map<string, string> = new Map();
  private socketToSession: Map<string, string> = new Map();

  constructor(
    @InjectRepository(Conversation)
    private convRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private msgRepo: Repository<Message>,
    @InjectRepository(Part)
    private partRepo: Repository<Part>,
    private ragService: RagService,
    private guardrailService: GuardrailService,
    private monitorService: QueryMonitorService,
    private geminiService: GeminiService,
  ) {}

  handleConnection(client: Socket) {
    console.log('Client connected:', client.id);
  }

  handleDisconnect(client: Socket) {
    console.log('Client disconnected:', client.id);
    this.adminSockets.delete(client.id);
    const sessionId = this.socketToSession.get(client.id);
    if (sessionId) {
      this.sessionToSocket.delete(sessionId);
      this.socketToSession.delete(client.id);
    }
  }

  @SubscribeMessage('admin_connect')
  handleAdminConnect(@ConnectedSocket() client: Socket) {
    this.adminSockets.add(client.id);
    client.join('admin_room');
    console.log('Admin connected:', client.id);
    client.emit('admin_connected', { success: true });
  }

  @SubscribeMessage('user_connect')
  async handleUserConnect(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId?: string },
  ) {
    let sessionId = data?.sessionId || uuidv4();
    let conversation = await this.convRepo.findOne({ where: { sessionId } });
    const isNewConversation = !conversation;

    if (isNewConversation) {
      conversation = this.convRepo.create({
        sessionId,
        guestName: 'Guest',
        isAdminChatMode: false,
        isAdminJoined: false,
      });
      await this.convRepo.save(conversation);
    }

    this.sessionToSocket.set(sessionId, client.id);
    this.socketToSession.set(client.id, sessionId);
    client.join(`conv_${conversation.id}`);

    client.emit('session_ready', {
      sessionId,
      conversationId: conversation.id,
      isAdminChatMode: conversation.isAdminChatMode ?? false,
      isAdminJoined: conversation.isAdminJoined ?? false,
    });

    const adminModeExpired = await this.expireAdminModeIfStale(conversation.id);
    if (adminModeExpired) {
      conversation = await this.convRepo.findOne({ where: { id: conversation.id } });
      client.emit('admin_chat_mode', { active: false });
    }

    if (isNewConversation) {
      const welcome = await this.saveMessage(
        conversation.id,
        'bot',
        'Welcome to **Veng.no**! I am your parts assistant. How can I help you today?',
        'options',
        { options: ['Find a Part', 'Search by Part Number', 'Order Help', 'Contact Us'] },
      );
      client.emit('message', welcome);
    } else {
      const history = await this.msgRepo.find({
        where: { conversationId: conversation.id },
        order: { createdAt: 'ASC' },
        take: 50,
      });
      client.emit('history', history);
      client.emit('conversation_history', { messages: history, conversation });
    }
  }

  @SubscribeMessage('user_message')
  async handleUserMessageCompat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    await this.handleMessage(client, data);
  }

  @SubscribeMessage('message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    const start = Date.now();
    const { conversationId, content } = data;
    const sessionId = this.socketToSession.get(client.id) || 'unknown';
    try {

    // ── Safety filter: reject Ask Admin as user message ─────────────────
    // Ask Admin should only be sent via 'ask_admin' event, never as 'message'
    if (content.trim() === 'Ask Admin') {
      console.warn(`[QA-FILTER] Ask Admin received as message (not ask_admin event). Rejecting. sessionId=${sessionId}`);
      client.emit('error', { reason: 'Ask Admin must be sent via proper action, not as message.' });
      return;
    }

    // ── GUARDRAIL: check input ─────────────────────────────────────────
    const guardrail = this.guardrailService.checkInput(sessionId, content);

    if (guardrail.action === 'block') {
      const msg = await this.saveMessage(conversationId, 'bot', guardrail.reason || 'Message blocked.', 'options', {
        options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
      });
      client.emit('message', msg);
      // v7: if guardrail says escalate (repeated violations), notify admin room
      if (guardrail.shouldEscalate) {
        this.server.to('admin_room').emit('admin_requested', { conversationId, reason: 'repeated_violations' });
      }
      this.monitorService.log({
        sessionId,
        conversationId,
        userInput: content,
        responseMs: Date.now() - start,
        timestamp: new Date(),
        category: 'blocked',
        guardrailAction: 'block',
        guardrailRule: guardrail.triggeredRule,
        ragUsed: false,
        isEscalated: guardrail.shouldEscalate || false,
      });
      return;
    }

    // Save user message
    const userMsg = await this.saveMessage(conversationId, 'user', content);
    // Echo the persisted user message back to the conversation so user UI updates immediately.
    this.server.to(`conv_${conversationId}`).emit('message', userMsg);
    this.server.to('admin_room').emit('new_message', { conversationId, message: userMsg });

    const conversation = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conversation) return;

    // ── ADMIN CHAT MODE ────────────────────────────────────────────────
    if (conversation.isAdminChatMode) {
      this.server.to('admin_room').emit('user_message_in_admin_mode', { conversationId, message: userMsg });
      this.monitorService.log({
        sessionId, conversationId, userInput: content, responseMs: Date.now() - start,
        timestamp: new Date(), category: 'admin', guardrailAction: guardrail.action,
        guardrailRule: guardrail.triggeredRule, ragUsed: false, isEscalated: true,
      });
      return;
    }

    // ── GUARDRAIL: handle 'warn' — send a helpful redirect but still process ──
    if (guardrail.action === 'warn' && guardrail.triggeredRule !== 'profanity') {
      const warnMsg = await this.saveMessage(conversationId, 'bot', guardrail.reason || 'Please keep messages on-topic.', 'options', {
        options: ['Find a Part', 'Search by Part Number', 'Order Help'],
      });
      client.emit('message', warnMsg);
      this.monitorService.log({
        sessionId, conversationId, userInput: content, responseMs: Date.now() - start,
        timestamp: new Date(), category: 'warned', guardrailAction: 'warn',
        guardrailRule: guardrail.triggeredRule, ragUsed: false, isEscalated: false,
      });
      return;
    }

    // ── Handle option buttons ──────────────────────────────────────────
    const userInput = content.trim();
    let category = 'navigation';
    let ragUsed = false;
    let ragScore: number | undefined;

    const outOfScopeOwnershipQuery = /\b(owner|owns|ownership|founder|founded|ceo|chairman|company history|history of company|stock|share price|market cap|net worth)\b/i.test(userInput);
    const outOfScopeMathQuery = /^\s*\d+(?:\.\d+)?\s*[+\-*/]\s*\d+(?:\.\d+)?\s*\??\s*$/i.test(userInput);
    if (outOfScopeOwnershipQuery || outOfScopeMathQuery) {
      const msg = await this.saveMessage(
        conversationId,
        'bot',
        'That question is outside VENG support scope. I can help with VENG auto parts, fitment, pricing, availability, orders, and warranty. For non-parts questions, please use Google.',
        'options',
        { options: ['Find a Part', 'Search by Part Number', 'Ask Admin'] },
      );
      this.server.to(`conv_${conversationId}`).emit('message', msg);
      category = 'out-of-scope';
      this.monitorService.log({
        sessionId,
        conversationId,
        userInput: content,
        responseMs: Date.now() - start,
        timestamp: new Date(),
        category,
        guardrailAction: guardrail.action,
        guardrailRule: guardrail.triggeredRule,
        ragUsed: false,
        isEscalated: false,
      });
      return;
    }

    if (userInput === 'Find a Part') {
      const brands = await this.getDistinctBrands();
      const msg = await this.saveMessage(conversationId, 'bot', 'Select a brand:', 'brands', { brands });
      this.server.to(`conv_${conversationId}`).emit('message', msg);
      this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
      category = 'navigation';
    } else if (userInput === 'Search by Part Number') {
      const msg = await this.saveMessage(conversationId, 'bot', 'Enter the part number (e.g. BMW-X5-BR-001):', 'text', {});
      this.server.to(`conv_${conversationId}`).emit('message', msg);
      category = 'navigation';
    } else if (userInput === 'Order Help' || userInput === 'Contact Us') {
      // ── RAG: answer from knowledge base ───────────────────────────
      const ragResults = await this.ragService.query(userInput, 1);
      if (ragResults.length > 0 && ragResults[0].score > 0.1) {
        ragUsed = true;
        ragScore = ragResults[0].score;
        const outputGuard = this.guardrailService.checkOutput(ragResults[0].answer);
        const answer = outputGuard.action === 'redact' ? outputGuard.safeContent! : ragResults[0].answer;
        const msg = await this.saveMessage(conversationId, 'bot', answer, 'options', {
          options: ['Find a Part', 'Search by Part Number'],
        });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      } else {
        const msg = await this.saveMessage(
          conversationId, 'bot',
          userInput === 'Contact Us'
            ? '📞 **Contact Veng:**\n• Email: support@veng.no\n• Use the **Contact Admin** button in the header to chat live'
            : '📦 How can I help with your order? Please describe your issue.',
          'options',
          { options: ['Delivery Info', 'Return a Part', 'Damaged Part'] },
        );
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      }
      category = 'faq';
    } else if (['Delivery Info', 'Return a Part', 'Damaged Part'].includes(userInput)) {
      const ragResults = await this.ragService.query(userInput, 1);
      ragUsed = ragResults.length > 0 && ragResults[0].score > 0.05;
      if (ragUsed) {
        ragScore = ragResults[0].score;
        const answer = ragResults[0].answer;
        const msg = await this.saveMessage(conversationId, 'bot', answer, 'options', {
          options: ['Find a Part'],
        });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      } else {
        const fallback = await this.saveMessage(
          conversationId,
          'bot',
          'I can help with that. Please share your order number and a short description, or click Ask Admin for live assistance.',
          'options',
          { options: ['Order Help', 'Ask Admin', 'Find a Part'] },
        );
        this.server.to(`conv_${conversationId}`).emit('message', fallback);
      }
      category = 'faq';
    } else if (userInput === 'Order Help' || userInput === 'Contact Us') {
      // Support info options
      const supportMsg = userInput === 'Order Help'
        ? 'For order assistance, please share your order number. Our team will help you track, modify, or resolve any issues.'
        : '📞 **Contact Veng:**\n• Email: support@veng.no (24h response)\n• Phone: +47 XX XX XX XX (Mon–Fri 08:00–16:00 CET)\n• Live Chat: Use the **Contact Admin** button in the header';
      const msg = await this.saveMessage(conversationId, 'bot', supportMsg, 'options', {
        options: ['Find a Part', 'Search by Part Number'],
      });
      this.server.to(`conv_${conversationId}`).emit('message', msg);
      category = 'info';
    } else {
      // ── PRIORITY 1: Widget flow (brand/model/variant/category selection) ──
      // Must always run first so guided flows are never broken by RAG
      const widgetFlowHandled = await this.handleWidgetFlow(conversationId, userInput);
      if (widgetFlowHandled) {
        this.monitorService.log({
          sessionId,
          conversationId,
          userInput: content,
          responseMs: Date.now() - start,
          timestamp: new Date(),
          category: 'widget',
          guardrailAction: guardrail.action,
          guardrailRule: guardrail.triggeredRule,
          ragUsed: false,
          isEscalated: false,
          widgetType: 'flow',
        });
        return;
      }

      // ── PRIORITY 2: Part number extraction + DB lookup ─────────────────
      // MUST run before RAG — part numbers containing letters (e.g. "6E1 868 153 EL")
      // would otherwise be falsely matched by the FAQ TF-IDF index.
      const supportIssueIntent = /(does not fit|doesn't fit|wrong part|damaged|replacement|not received|haven't received|check the status)/i.test(userInput);
      if (supportIssueIntent) {
        const issueNlpAnswer = await this.handleNLPQuestion(conversationId, userInput);
        if (issueNlpAnswer) {
          const outputGuard = this.guardrailService.checkOutput(issueNlpAnswer.content);
          const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : issueNlpAnswer.content;
          const widgetType = issueNlpAnswer.widgetType || 'options';
          const widgetPayload = issueNlpAnswer.widgetPayload || (widgetType === 'options'
            ? { options: issueNlpAnswer.options || ['Find a Part', 'Search by Part Number'] }
            : {});
          const msg = await this.saveMessage(conversationId, 'bot', safeAnswer, widgetType, widgetPayload);
          this.server.to(`conv_${conversationId}`).emit('message', msg);
          category = 'nlp';
          this.monitorService.log({
            sessionId, conversationId, userInput: content,
            responseMs: Date.now() - start,
            timestamp: new Date(),
            category,
            guardrailAction: guardrail.action,
            guardrailRule: guardrail.triggeredRule,
            ragUsed,
            ragScore,
            isEscalated: false,
            widgetType,
          });
          return;
        }
      }

      const extractedPartCode = this.extractPartCodeFromText(userInput);
      if (extractedPartCode) {
        const exactParts = await this.findPartsByPartCode(extractedPartCode);
        if (exactParts.length > 0) {
          const msg = await this.saveMessage(conversationId, 'bot',
            `Found ${exactParts.length} result(s) for **${extractedPartCode}**:`, 'parts', { parts: exactParts });
          this.server.to(`conv_${conversationId}`).emit('message', msg);
          this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
          category = 'part-search';
        } else {
          const suggestions = await this.suggestPartsFromPartCode(extractedPartCode);
          if (suggestions.length > 0) {
            const msg = await this.saveMessage(conversationId, 'bot',
              `No exact part found for **${extractedPartCode}**. Here are close matches:`, 'parts', { parts: suggestions });
            this.server.to(`conv_${conversationId}`).emit('message', msg);
            this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
          } else {
            const msg = await this.saveMessage(conversationId, 'bot',
              `No part found for **${extractedPartCode}** in our catalog.\n\nWe can source-check it for you — click **Ask Admin** and share the part number and vehicle details.`,
              'options', { options: ['Find a Part', 'Ask Admin'] });
            this.server.to(`conv_${conversationId}`).emit('message', msg);
          }
          category = 'part-search';
        }
      } else {
      // ── PRIORITY 3: Grounded Gemini (DB + RAG context) ─────────────────
      // Main free-text path: send query to Gemini with catalog + knowledge context.
      const groundedGemini = await this.getGroundedGeminiResponse(userInput);
      if (groundedGemini) {
        const outputGuard = this.guardrailService.checkOutput(groundedGemini.answer);
        const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : groundedGemini.answer;

        if (groundedGemini.parts.length > 0) {
          const msg = await this.saveMessage(
            conversationId,
            'bot',
            safeAnswer,
            'parts',
            { parts: groundedGemini.parts },
            { ragUsed: groundedGemini.usedKnowledge, ragSource: groundedGemini.usedKnowledge ? 'FAQ/Knowledge Base' : undefined },
          );
          this.server.to(`conv_${conversationId}`).emit('message', msg);
          this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
        } else {
          const msg = await this.saveMessage(
            conversationId,
            'bot',
            safeAnswer,
            'options',
            { options: ['Find a Part', 'Search by Part Number', 'Ask Admin'] },
            { ragUsed: groundedGemini.usedKnowledge, ragSource: groundedGemini.usedKnowledge ? 'FAQ/Knowledge Base' : undefined },
          );
          this.server.to(`conv_${conversationId}`).emit('message', msg);
        }

        category = 'gemini-grounded';
        ragUsed = groundedGemini.usedKnowledge;
      } else {
      // ── PRIORITY 3: NLP intent matching ────────────────────────────────
      // Handles structured intents: price queries, availability, fitment, damages etc.
      const nlpAnswer = await this.handleNLPQuestion(conversationId, userInput);
      if (nlpAnswer) {
        const outputGuard = this.guardrailService.checkOutput(nlpAnswer.content);
        const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : nlpAnswer.content;
        const widgetType = nlpAnswer.widgetType || 'options';
        const widgetPayload = nlpAnswer.widgetPayload || (widgetType === 'options'
          ? { options: nlpAnswer.options || ['Find a Part', 'Search by Part Number'] }
          : {});
        const msg = await this.saveMessage(conversationId, 'bot', safeAnswer, widgetType, widgetPayload);
        this.server.to(`conv_${conversationId}`).emit('message', msg);
        category = 'nlp';
      } else {
        // ── PRIORITY 4: FAQ RAG (knowledge base) ───────────────────────────
        // Only runs when there is NO part number signal and NLP has no match.
        // This prevents OEM/aftermarket FAQ from firing on part number queries.
        const blendedRagAnswer = await this.ragService.blendedFaqAnswer(userInput);
        if (blendedRagAnswer) {
          ragUsed = true;
          const outputGuard = this.guardrailService.checkOutput(blendedRagAnswer);
          const safeAnswer = outputGuard.action === 'redact' ? outputGuard.safeContent! : blendedRagAnswer;
          const msg = await this.saveMessage(conversationId, 'bot', safeAnswer, 'options', {
            options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
          }, { ragUsed: true, ragSource: 'FAQ/Knowledge Base' });
          this.server.to(`conv_${conversationId}`).emit('message', msg);
          category = 'rag';
        } else {
          // ── PRIORITY 5: Brand match ──────────────────────────────────────
          const brands = await this.getDistinctBrands();
          const matchedBrand = brands.find((b) => b.toLowerCase() === userInput.toLowerCase());
          if (matchedBrand) {
            const models = await this.getModelsForBrand(matchedBrand);
            const msg = await this.saveMessage(
              conversationId, 'bot',
              `Select model for ${matchedBrand}:`, 'models',
              { brand: matchedBrand, models },
            );
            this.server.to(`conv_${conversationId}`).emit('message', msg);
            this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
            category = 'widget';
            this.monitorService.log({
              sessionId, conversationId, userInput: content,
              responseMs: Date.now() - start, timestamp: new Date(),
              category, guardrailAction: guardrail.action,
              guardrailRule: guardrail.triggeredRule, ragUsed, ragScore,
              isEscalated: false, widgetType: 'models',
            });
            return;
          }

          // ── PRIORITY 6: Gemini assisted fallback (optional, env-driven) ──
          // Only used when enabled and all deterministic routes above had no match.
          const geminiAnswer = await this.geminiService.generateVengReply(userInput);
          if (geminiAnswer) {
            const msg = await this.saveMessage(conversationId, 'bot', geminiAnswer, 'options', {
              options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
            });
            this.server.to(`conv_${conversationId}`).emit('message', msg);
            category = 'gemini';
          } else {
            // ── PRIORITY 7: Fallback ───────────────────────────────────────
            const msg = await this.saveMessage(conversationId, 'bot',
              "I'm here to help! Choose an option or type a part number:", 'options',
              { options: ['Find a Part', 'Search by Part Number', 'Order Help'] });
            this.server.to(`conv_${conversationId}`).emit('message', msg);
            category = 'fallback';
          }
        }
      }
      }
      } // end extractedPartCode else
    }

    // ── Monitor log ────────────────────────────────────────────────────
    this.monitorService.log({
      sessionId, conversationId, userInput: content,
      responseMs: Date.now() - start,
      timestamp: new Date(),
      category,
      guardrailAction: guardrail.action,
      guardrailRule: guardrail.triggeredRule,
      ragUsed,
      ragScore,
      isEscalated: false,
      widgetType: undefined,
    });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[ChatGateway] handleMessage failed: ${reason}`);

      const fallbackText = 'Sorry, I hit a temporary issue. Please try again, or click Ask Admin for live help.';
      const fallbackMessage = {
        senderType: 'bot',
        content: fallbackText,
        createdAt: new Date().toISOString(),
        widgetType: 'options',
        widgetPayload: { options: ['Find a Part', 'Search by Part Number', 'Ask Admin'] },
      };

      try {
        if (conversationId) {
          const saved = await this.saveMessage(
            conversationId,
            'bot',
            fallbackText,
            'options',
            { options: ['Find a Part', 'Search by Part Number', 'Ask Admin'] },
          );
          this.server.to(`conv_${conversationId}`).emit('message', saved);
        } else {
          client.emit('message', fallbackMessage);
        }
      } catch {
        client.emit('message', fallbackMessage);
      }
    }
  }

  @SubscribeMessage('admin_message')
  async handleAdminMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; content: string },
  ) {
    const { conversationId, content } = data;
    const msg = await this.saveMessage(conversationId, 'admin', content);
    this.server.to(`conv_${conversationId}`).emit('message', msg);
    this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
  }

  /**
   * v7: Admin RAG query — admin can ask the knowledge base a question
   * without routing it to a user conversation.
   * Event: 'admin_rag_query'  Data: { query: string }
   * Reply: 'admin_rag_result' Data: { query, results: [{question, answer, score}] }
   */
  @SubscribeMessage('admin_rag_query')
  async handleAdminRagQuery(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { query: string },
  ) {
    const results = await this.ragService.adminQuery(data.query || '');
    client.emit('admin_rag_result', {
      query: data.query,
      results: results.map((r) => ({
        question: r.document.metadata.question || r.document.id,
        answer: r.answer,
        score: Math.round(r.score * 1000) / 1000,
      })),
    });
  }

  @SubscribeMessage('ask_admin')
  async handleAskAdminCompat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { conversationId } = data;
    await this.convRepo.update({ id: conversationId }, {
      isAdminChatMode: true,
      isAdminJoined: false,
      lastAdminRequestedAt: new Date(),
    });
    this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: true });
    const msg = await this.saveMessage(
      conversationId,
      'bot',
      '⏳ Connecting you to an admin... Please hold on. An agent will join shortly.',
      null,
      null,
    );
    this.server.to(`conv_${conversationId}`).emit('message', msg);
    this.server.to('admin_room').emit('admin_requested', { conversationId });
    this.server.to('admin_room').emit('admin_chat_requested', { conversationId });
  }

  @SubscribeMessage('ask_veng')
  async handleAskVengCompat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { conversationId } = data;
    await this.convRepo.update({ id: conversationId }, {
      isAdminChatMode: false,
      isAdminJoined: false,
      lastAdminRequestedAt: null,
    });
    this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
    const msg = await this.saveMessage(
      conversationId,
      'bot',
      'I am back as your Veng assistant. What would you like to do next?',
      'options',
      { options: ['Find a Part', 'Search by Part Number', 'Order Help', 'Contact Us'] },
    );
    this.server.to(`conv_${conversationId}`).emit('message', msg);
  }

  @SubscribeMessage('admin_join')
  async handleAdminJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { conversationId } = data;
    await this.convRepo.update({ id: conversationId }, { isAdminJoined: true });
    this.server.to(`conv_${conversationId}`).emit('admin_joined');
    const msg = await this.saveMessage(conversationId, 'bot', '✅ An admin has joined the chat. Go ahead!');
    this.server.to(`conv_${conversationId}`).emit('message', msg);
    this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
  }

  @SubscribeMessage('admin_join_conversation')
  async handleAdminJoinCompat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { conversationId } = data;
    const conversation = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conversation) return;
    const history = await this.msgRepo.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
      take: 100,
    });
    client.emit('conversation_history', { messages: history, conversation });
  }

  @SubscribeMessage('admin_leave')
  async handleAdminLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    const { conversationId } = data;
    await this.convRepo.update({ id: conversationId }, { isAdminChatMode: false, isAdminJoined: false, lastAdminRequestedAt: null });
    this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
    const msg = await this.saveMessage(conversationId, 'bot',
      'Admin has left. I\'m back as your Veng assistant!', 'options',
      { options: ['Find a Part', 'Search by Part Number'] });
    this.server.to(`conv_${conversationId}`).emit('message', msg);
    this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
  }

  @SubscribeMessage('resolve_conversation')
  async handleResolve(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string },
  ) {
    await this.convRepo.update({ id: data.conversationId }, { isResolved: true });
    this.server.to('admin_room').emit('conversation_resolved', { conversationId: data.conversationId });
  }

  // ── Widget flow handler ────────────────────────────────────────────────
  private async handleWidgetFlow(conversationId: string, userInput: string): Promise<boolean> {
    const lastBotMsg = await this.msgRepo.findOne({
      where: { conversationId, senderType: 'bot' },
      order: { createdAt: 'DESC' },
    });
    if (!lastBotMsg?.widgetType) return false;

    if (lastBotMsg.widgetType === 'brands') {
      const brands = await this.getDistinctBrands();
      const matched = brands.find(b => b.toLowerCase() === userInput.toLowerCase());
      if (matched) {
        const models = await this.getModelsForBrand(matched);
        const msg = await this.saveMessage(conversationId, 'bot', `Select model for ${matched}:`, 'models', { brand: matched, models });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
        this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
      } else {
        const brands2 = await this.getDistinctBrands();
        const msg = await this.saveMessage(conversationId, 'bot', 'Please select a brand:', 'brands', { brands: brands2 });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      }
      return true;
    }

    if (lastBotMsg.widgetType === 'models') {
      const { brand } = lastBotMsg.widgetPayload;
      const models = await this.getModelsForBrand(brand);
      const matched = models.find(m => m.toLowerCase() === userInput.toLowerCase());
      if (matched) {
        const variants = await this.getVariantsForBrandModel(brand, matched);
        const msg = await this.saveMessage(conversationId, 'bot', `Select variant for ${brand} ${matched}:`, 'variants', { brand, model: matched, variants });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
        this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
      } else {
        const msg = await this.saveMessage(conversationId, 'bot', 'Please select a model:', 'models', { brand, models });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      }
      return true;
    }

    if (lastBotMsg.widgetType === 'variants') {
      const { brand, model } = lastBotMsg.widgetPayload;
      const variants = await this.getVariantsForBrandModel(brand, model);
      const matched = variants.find(v => v.toLowerCase() === userInput.toLowerCase());
      if (matched) {
        const categories = await this.getCategoriesForVariant(brand, model, matched);
        const msg = await this.saveMessage(conversationId, 'bot', `Pick category for ${brand} ${model}:`, 'categories', { brand, model, variant: matched, categories });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
        this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
      } else {
        const msg = await this.saveMessage(conversationId, 'bot', 'Please select a variant:', 'variants', { brand, model, variants });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      }
      return true;
    }

    if (lastBotMsg.widgetType === 'categories') {
      const { brand, model, variant } = lastBotMsg.widgetPayload;
      const categories = await this.getCategoriesForVariant(brand, model, variant);
      const matched = categories.find(c => c.toLowerCase() === userInput.toLowerCase());
      if (matched) {
        const parts = await this.getPartsForCategory(brand, model, variant, matched);
        if (parts.length === 0) {
          const msg = await this.saveMessage(conversationId, 'bot', `No parts for ${matched} — ${brand} ${model}. Try another.`, 'categories', { brand, model, variant, categories });
          this.server.to(`conv_${conversationId}`).emit('message', msg);
        } else {
          const msg = await this.saveMessage(conversationId, 'bot', `${matched} — ${brand} ${model} ${variant}`, 'parts', { parts });
          this.server.to(`conv_${conversationId}`).emit('message', msg);
          this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
        }
      } else {
        const msg = await this.saveMessage(conversationId, 'bot', 'Please select a category:', 'categories', { brand, model, variant, categories });
        this.server.to(`conv_${conversationId}`).emit('message', msg);
      }
      return true;
    }

    return false;
  }

  private async expireAdminModeIfStale(conversationId: string): Promise<boolean> {
    const conv = await this.convRepo.findOne({ where: { id: conversationId } });
    if (!conv?.isAdminChatMode || conv.isAdminJoined || !conv.lastAdminRequestedAt) return false;
    const elapsed = Date.now() - new Date(conv.lastAdminRequestedAt).getTime();
    if (elapsed < ChatGateway.ADMIN_WAIT_TIMEOUT_MS) return false;
    await this.convRepo.update({ id: conversationId }, { isAdminChatMode: false, isAdminJoined: false, lastAdminRequestedAt: null });
    this.server.to(`conv_${conversationId}`).emit('admin_chat_mode', { active: false });
    const msg = await this.saveMessage(conversationId, 'bot',
      'Admin did not reply in time. I\'ve switched back to the Veng assistant.',
      'options', { options: ['Find a Part', 'Search by Part Number'] });
    this.server.to(`conv_${conversationId}`).emit('message', msg);
    this.server.to('admin_room').emit('new_message', { conversationId, message: msg });
    return true;
  }

  private async handleNLPQuestion(conversationId: string, input: string): Promise<NlpReply | null> {
    const q = input.toLowerCase();

    const outOfScopePattern = /\b(owner|owns|ownership|founder|founded|ceo|chairman|stock|share price|market cap|net worth|who is|who's)\b/i;
    const nonVengCompanyPattern = /\b(tata|toyota|bmw|ford|volkswagen|mercedes|hyundai|honda|tesla|audi|nissan|kia|mazda|porsche)\b/i;
    if (outOfScopePattern.test(input) && nonVengCompanyPattern.test(input)) {
      return {
        content: 'That question is outside VENG support scope. I can help with VENG auto parts, fitment, pricing, delivery, returns, and warranty. For company ownership or industry information, please use Google.',
        widgetType: 'options',
        options: ['Find a Part', 'Search by Part Number', 'Ask Admin'],
      };
    }

    if (q.includes('abs') && (q.includes('warning') || q.includes('light') || q.includes('sensor'))) {
      return {
        content: 'For ABS warning issues, please share your vehicle make/model/year and whether the fault is front or rear, left or right. ABS sensors are axle/side-specific. If you have an OBD fault code, share it and we will identify the correct part.',
        widgetType: 'options',
        options: ['Find a Part', 'Ask Admin'],
      };
    }

    if ((q.includes('vin') || q.includes('registration') || q.includes('chassis number') || q.includes('license plate')) &&
        (q.includes('search') || q.includes('find') || q.includes('part') || q.includes('can i'))) {
      return {
        content: 'Yes. You can search using VIN or registration number. Share it and we will verify exact fitment for your vehicle before suggesting parts.',
        widgetType: 'options',
        options: ['Find a Part', 'Ask Admin'],
      };
    }

    if ((q.includes('oem') || q.includes('aftermarket') || q.includes('genuine')) &&
        (q.includes('option') || q.includes('have') || q.includes('sell') || q.includes('part'))) {
      return {
        content: 'Yes. We offer both OEM and aftermarket parts depending on availability. OEM is exact-match and usually higher priced; quality aftermarket is typically more affordable.',
        widgetType: 'options',
        options: ['Find a Part', 'Search by Part Number'],
      };
    }

    if ((q.includes('ship') || q.includes('shipping') || q.includes('delivery')) &&
        (q.includes('germany') || q.includes('eu') || q.includes('international') || q.includes('outside norway'))) {
      return {
        content: 'Yes, we ship to Germany and select EU countries. Typical international delivery is 5–14 business days depending on destination.',
        widgetType: 'options',
        options: ['Order Help', 'Ask Admin'],
      };
    }

    if (q.includes('does not fit') || q.includes("doesn't fit") || q.includes('wrong part')) {
      return {
        content: "Sorry about that. Please share your order number and vehicle details. We will verify fitment and arrange return/exchange if needed.\n\nUse the **Contact Admin** button in the header to speak with our team directly.",
        widgetType: 'options',
        options: ['Order Help'],
      };
    }
    if (q.includes('damaged') || q.includes('replacement')) {
      return {
        content: "Sorry this arrived damaged. Please send clear photos with your order number. We will prioritize a replacement immediately. Use the **Contact Admin** button in the header to connect with us immediately.",
        widgetType: 'options',
        options: ['Damaged Part'],
      };
    }
    if (q.includes('not received') || q.includes("haven't received") || q.includes('check the status')) {
      return {
        content: "Sorry to hear that. Please share your order number so we can trace shipment status, or use the **Contact Admin** button in the header for immediate assistance.",
        widgetType: 'options',
        options: ['Order Help'],
      };
    }
    if ((q.includes('when will') && q.includes('order')) || q.includes('delivery') || q.includes('delivered')) {
      return {
        content: '🚚 **Delivery Times:**\n• **In Stock** parts → 1–3 business days\n• **2–3 Days** → 2–3 business days\n• **On Order** → 5–10 business days\nFor your specific order status, share your order number or use the **Contact Admin** button in the header.',
        widgetType: 'options',
        options: ['Order Help'],
      };
    }
    if ((q.includes('not seeing') && q.includes('price')) || (q.includes('price') && q.includes('veng.no'))) {
      return {
        content: 'Prices can be hidden when you are not on a part result page or when the vehicle/part match is incomplete. All prices are shown in **NOK** including VAT once a valid part match is found. Use **Find a Part** or **Search by Part Number** and we can also verify via the header Contact Admin button.',
        widgetType: 'options',
        options: ['Find a Part', 'Search by Part Number'],
      };
    }

    // NOTE: Part number extraction is handled at Priority 2 in the gateway
    // before handleNLPQuestion is called. No part-code logic here.

    const intentMatches = await this.findPartsFromIntent(input);
    const supplyContext = this.extractSupplyContext(input);
    const asksPrice = /\b(price|cost|how much|pricing)\b/i.test(input);
    const asksAvailability = /\b(do you have|have you got|you got|got any|any\b|can you supply|do you supply|available|in stock|stock|supply|need|looking for|searching for|want|find me|get me|sell|carry|source|order)\b/i.test(input);
    const hasVehicleOrModelHint = this.hasVehicleOrModelHint(input);
    const hasPartTopicHint = this.hasPartTopicHint(input);

    if (intentMatches.length > 0 && (asksPrice || asksAvailability || hasVehicleOrModelHint || hasPartTopicHint)) {
      if (asksPrice) {
        const preview = intentMatches
          .slice(0, 3)
          .map((p) => `• ${p.name} (${p.partNumber}) — **NOK ${Number(p.price || 0).toLocaleString()}**`)
          .join('\n');
        return {
          content: `I found pricing for matching parts:\n${preview}`,
          widgetType: 'parts',
          widgetPayload: { parts: intentMatches },
        };
      }

      return {
        content: `I found ${intentMatches.length} matching part(s):`,
        widgetType: 'parts',
        widgetPayload: { parts: intentMatches },
      };
    }

    if (q.includes('price') || q.includes('nok')) {
      return {
        content: 'All prices are shown in **NOK** (including VAT). Share a part number, vehicle ID, or use **Find a Part** for exact pricing.',
        widgetType: 'options',
        options: ['Find a Part', 'Search by Part Number'],
      };
    }

    if (asksAvailability) {
      const supplyContext = this.extractSupplyContext(input);
      if (supplyContext.brand) {
        const where: any = { brand: supplyContext.brand };
        if (supplyContext.model) where.model = supplyContext.model;
        const count = await this.partRepo.count({ where });
        if (count > 0) {
          const scopeText = supplyContext.model
            ? `${supplyContext.brand} ${supplyContext.model}`
            : supplyContext.brand;
          return {
            content: `Yes, we currently list **${count} part(s)** for ${scopeText}.`,
            widgetType: 'options',
            options: ['Find a Part', 'Search by Part Number'],
          };
        }

        const scopeText = supplyContext.model
          ? `${supplyContext.brand} ${supplyContext.model}`
          : supplyContext.brand;
        return {
          content: `I could not find a direct match for ${scopeText} in the live catalog right now. Use the **Contact Admin** button to speak with us and we can source-check it for you.`,
          widgetType: 'options',
          options: ['Find a Part'],
        };
      }
    }

    if (q.includes('wheel bearing') || q.includes('shock absorber') || q.includes('categories')) {
      return {
        content: 'Yes, we supply categories such as brakes, steering, suspension, cooling, engine, electrical, and exhaust. Share your vehicle ID/registration or use **Find a Part** for exact matches.',
        widgetType: 'options',
        options: ['Find a Part'],
      };
    }

    // If the query clearly mentions a part type but we found no matches,
    // give a helpful response rather than silently falling through to RAG/fallback
    if (hasPartTopicHint && (hasVehicleOrModelHint || asksAvailability)) {
      const partHint = q.match(/\b(brake[s]?|caliper|disc|pad|rotor|shock|absorber|control arm|tie rod|steering rack|bearing|suspension|exhaust|clutch|filter|belt|pump|alternator|starter|radiator)\b/i)?.[0] || 'part';
      const vehicleHint = supplyContext.model
        ? `${supplyContext.brand ? supplyContext.brand + ' ' : ''}${supplyContext.model}`
        : supplyContext.brand || 'that vehicle';
      return {
        content: `I couldn't find an exact **${partHint}** match for **${vehicleHint}** in our live catalog right now. This may mean the exact variant isn't in the database yet, or the vehicle/part combination needs clarifying.\n\nPlease use **Find a Part** to browse by brand → model → category, or **Ask Admin** to have our team source-check it for you.`,
        widgetType: 'options',
        options: ['Find a Part', 'Ask Admin'],
      };
    }

    return null;
  }

  /**
   * Extract a part number from free-text user input.
   *
   * Handles OEM-style codes like:
   *   "6E1 868 153 EL"          — space-separated with letter suffix
   *   "BMW-X5-BR-001"           — hyphen-separated internal code
   *   "part number 6E1 868 153 EL" — explicit prefix
   *   "do you have 6E1 868 153 EL?" — embedded in sentence
   *   "Is 7L6 601 025 H in stock?"  — code before common words
   *
   * Design rules:
   *   - SEED token must contain a digit (rules out plain English words)
   *   - CONTINUATION tokens must also contain a digit OR be a short (≤3 char)
   *     uppercase suffix like "A", "EL", "AA" — stops on common English words
   *   - Minimum one pure-digit group in the extracted sequence
   *   - Common English stop-words terminate the scan even if alphanumeric
   */
  private readonly PART_STOP_WORDS = new Set([
    'in','is','it','of','for','my','the','to','at','as','by','on',
    'do','go','up','we','me','he','she','they','you','can','has',
    'had','but','not','are','was','with','that','this','from','have',
    'all','any','and','or','an','be','no','so','if','ok','hi',
    'stock','part','parts','need','want','find','get','have','has',
    'looking','please','help','does','did','will','would','could',
    'should','about','some','more','also','just','here','there',
    'what','when','where','how','who','which','why','new','old',
  ]);

  private extractPartCodeFromText(input: string): string | null {
    const trimmed = input.trim();

    // ── Case 1: Direct input — entire message is a part code ──────────
    // Only matches if it looks like code (no common English words when split)
    const directPattern = /^[A-Za-z0-9][A-Za-z0-9\s\-]{4,39}$/;
    if (directPattern.test(trimmed) && /\d/.test(trimmed)) {
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const pureDigitCount = tokens.filter((t) => /^\d+$/.test(t)).length;
      const digitAnyCount = tokens.filter((t) => /\d/.test(t)).length;
      const hasStopWord = tokens.some((t) => this.PART_STOP_WORDS.has(t.toLowerCase()));
      if (
        !hasStopWord &&
        tokens.length <= 8 &&
        (pureDigitCount >= 1 || digitAnyCount >= Math.ceil(tokens.length / 2))
      ) {
        return trimmed.toUpperCase();
      }
    }

    // ── Case 2: Explicit "part number" / "part#" prefix ───────────────
    const partPrefixMatch = input.match(/part(?:\s+number)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\s\-]{4,40})/i);
    if (partPrefixMatch && /\d/.test(partPrefixMatch[1])) {
      const tokens = partPrefixMatch[1].trim().split(/\s+/);
      const codeTokens: string[] = [];
      for (const token of tokens) {
        if (this.PART_STOP_WORDS.has(token.toLowerCase())) break;
        if (/^[A-Z0-9-]+$/i.test(token)) { codeTokens.push(token.toUpperCase()); continue; }
        break;
      }
      const candidate = codeTokens.join(' ').trim();
      if (candidate.length >= 5 && /\d/.test(candidate)) return candidate;
    }

    // ── Case 3: Embedded code scan ────────────────────────────────────
    // Scans word-by-word. Seed token MUST contain a digit (not a plain word).
    // Continuation: accept if it has a digit, OR if it is a short pure-letter
    //   suffix (1–3 chars, e.g. "A", "EL", "AA") AND the previous token had digits.
    // Stop immediately on stop-words, punctuation-only, or long pure-letter words.
    const words = input.split(/\s+/);
    for (let start = 0; start < words.length; start++) {
      const seedClean = words[start].replace(/[?.,!]+$/, '');
      // Seed must have a digit and be alphanumeric
      if (!/\d/.test(seedClean)) continue;
      if (!/^[A-Z0-9-]+$/i.test(seedClean) || seedClean.length === 0) continue;
      if (this.PART_STOP_WORDS.has(seedClean.toLowerCase())) continue;

      const codeTokens = [seedClean.toUpperCase()];
      let pureDigitCount = /^\d+$/.test(seedClean) ? 1 : 0;
      let lastHadDigit = /\d/.test(seedClean);

      for (let j = start + 1; j < Math.min(start + 8, words.length); j++) {
        const raw = words[j].replace(/[?.,!]+$/, '');
        if (raw.length === 0) break;
        if (this.PART_STOP_WORDS.has(raw.toLowerCase())) break;
        if (!/^[A-Z0-9-]+$/i.test(raw)) break;

        const hasDigit = /\d/.test(raw);
        const isPureLetterSuffix = /^[A-Z]{1,3}$/i.test(raw) && !hasDigit;

        // Accept digit-containing tokens freely; accept short pure-letter suffix
        // only when previous token had digits (classic OEM suffix like "EL", "AA")
        if (hasDigit) {
          codeTokens.push(raw.toUpperCase());
          if (/^\d+$/.test(raw)) pureDigitCount++;
          lastHadDigit = true;
        } else if (isPureLetterSuffix && lastHadDigit) {
          codeTokens.push(raw.toUpperCase());
          lastHadDigit = false; // suffix consumed — don't chain another suffix
        } else {
          break; // long pure-letter word = English word, stop
        }
      }

      // Valid: ≥2 tokens AND at least one pure-digit group
      if (codeTokens.length >= 2 && pureDigitCount >= 1) {
        return codeTokens.join(' ');
      }
    }

    return null;
  }

  private async findPartsByPartCode(code: string): Promise<Part[]> {
    const trimmed = code.trim();

    // 1. Exact match (case-insensitive) — most precise
    const exact = await this.partRepo
      .createQueryBuilder('part')
      .where('LOWER(part.partNumber) = LOWER(:code)', { code: trimmed })
      .orWhere('LOWER(part.internalCode) = LOWER(:code)', { code: trimmed })
      .take(8)
      .getMany();
    if (exact.length > 0) return exact;

    // 2. Normalized match — strips spaces/hyphens for cross-format matching
    // e.g. "6E1 868 153 EL" vs "6E1868153EL" vs "6E1-868-153-EL"
    const normalized = this.normalizeCode(trimmed);
    if (!normalized || normalized.length < 4) return [];

    const candidates = await this.partRepo
      .createQueryBuilder('part')
      .where('part.partNumber IS NOT NULL')
      .orWhere('part.internalCode IS NOT NULL')
      .take(500)
      .getMany();

    const normalizedMatches = candidates.filter((p) => {
      const pn = this.normalizeCode(p.partNumber || '');
      const ic = this.normalizeCode(p.internalCode || '');
      return pn === normalized || ic === normalized;
    }).slice(0, 8);

    if (normalizedMatches.length > 0) return normalizedMatches;

    // 3. Prefix/suffix containment — catches partial codes
    return candidates.filter((p) => {
      const pn = this.normalizeCode(p.partNumber || '');
      const ic = this.normalizeCode(p.internalCode || '');
      return (
        (pn.length >= 5 && (pn.startsWith(normalized) || normalized.startsWith(pn))) ||
        (ic.length >= 5 && (ic.startsWith(normalized) || normalized.startsWith(ic)))
      );
    }).slice(0, 8);
  }

  private hasVehicleOrModelHint(input: string): boolean {
    const q = input.toLowerCase();
    // Generic alphanumeric model pattern (e.g. E300, XC90, Q7)
    if (/\b[a-z]{1,4}\d{1,4}\b/i.test(input)) return true;
    const modelKeywords = [
      'e-tron', 'land cruiser', 'glk', 'q7', 'q5', 'q3', 'q2', 'a4', 'a6', 'a3', 'a5', 'a7', 'a8',
      'x6', 'x5', 'x4', 'x3', 'x2', 'x1', 'm3', 'm4', 'm5', 'm6', 'm8',
      '1 series', '2 series', '3 series', '4 series', '5 series', '6 series', '7 series', '8 series',
      'c-class', 'e-class', 's-class', 'a-class', 'b-class', 'glc', 'gle', 'glb', 'gla', 'gls', 'cla',
      'xc90', 'xc60', 'xc40', 'v60', 'v90', 's90', 's60',
      'civic', 'accord', 'cr-v', 'hr-v', 'jazz', 'pilot',
      'camry', 'corolla', 'rav4', 'prius', 'hilux', 'land cruiser', 'yaris', 'auris',
      'model 3', 'model s', 'model x', 'model y',
      'golf', 'passat', 'tiguan', 'polo', 'touareg', 'arteon', 'jetta',
      'focus', 'fiesta', 'kuga', 'transit', 'mondeo', 'ranger', 'explorer',
      '208', '308', '3008', '5008', 'clio', 'megane', 'kadjar', 'captur',
      'tucson', 'santa fe', 'i30', 'ioniq', 'kona',
      'sportage', 'sorento', 'stinger', 'cerato',
      'octavia', 'superb', 'kodiaq', 'karoq', 'fabia',
      'ibiza', 'leon', 'ateca', 'tarraco',
      'outback', 'forester', 'impreza', 'legacy', 'wrx',
      'cx-5', 'cx-3', 'mazda3', 'mazda6', 'mx-5',
      'outlander', 'eclipse', 'pajero', 'l200',
      'cayenne', 'macan', 'panamera', '911', 'boxster',
    ];
    return modelKeywords.some((m) => q.includes(m));
  }

  private hasPartTopicHint(input: string): boolean {
    const q = input.toLowerCase();
    return [
      // Brakes — all forms
      'brake disc', 'brake pad', 'brake pads', 'brake caliper', 'brake calipers',
      'brake rotor', 'brake drum', 'brake line', 'brake hose', 'brake fluid',
      'brakes', 'brake',
      // Suspension & steering
      'control arm', 'steering rack', 'tie rod', 'ball joint', 'strut', 'sway bar',
      'shock absorber', 'shock absorbers', 'absorber', 'spring', 'coilover',
      'wheel bearing', 'hub bearing', 'suspension', 'steering',
      // Engine
      'oil filter', 'air filter', 'fuel filter', 'cabin filter', 'pollen filter',
      'timing belt', 'timing chain', 'drive belt', 'serpentine belt',
      'spark plug', 'ignition coil', 'alternator', 'starter motor', 'starter',
      'water pump', 'thermostat', 'coolant', 'radiator',
      'clutch', 'gearbox', 'transmission',
      'cv joint', 'axle', 'driveshaft', 'prop shaft',
      // Exhaust
      'exhaust', 'catalytic converter', 'muffler', 'silencer', 'dpf',
      // Electrical & body
      'headlight', 'headlamp', 'tail light', 'bulb', 'fog light',
      'battery', 'sensor', 'lambda', 'o2 sensor', 'abs sensor', 'cam sensor', 'map sensor',
      'windshield', 'wiper', 'mirror', 'door handle', 'fender',
      'bumper', 'bonnet', 'hood', 'grille', 'wing',
      // Generic
      'caliper', 'rotor', 'drum', 'pad', 'disc',
    ].some((k) => q.includes(k));
  }

  private extractSupplyContext(input: string): { brand?: string; model?: string } {
    const q = input.toLowerCase();
    const brandMap: Array<{ pattern: RegExp; brand: string }> = [
      { pattern: /mercedes(?:-benz)?/i, brand: 'Mercedes-Benz' },
      { pattern: /honda/i, brand: 'Honda' },
      { pattern: /bmw/i, brand: 'BMW' },
      { pattern: /volvo/i, brand: 'Volvo' },
      { pattern: /audi/i, brand: 'Audi' },
      { pattern: /toyota/i, brand: 'Toyota' },
      { pattern: /tesla/i, brand: 'Tesla' },
      { pattern: /volkswagen|vw\b/i, brand: 'Volkswagen' },
      { pattern: /ford/i, brand: 'Ford' },
      { pattern: /peugeot/i, brand: 'Peugeot' },
      { pattern: /renault/i, brand: 'Renault' },
      { pattern: /nissan/i, brand: 'Nissan' },
      { pattern: /hyundai/i, brand: 'Hyundai' },
      { pattern: /kia/i, brand: 'Kia' },
      { pattern: /skoda/i, brand: 'Skoda' },
      { pattern: /seat/i, brand: 'SEAT' },
      { pattern: /opel|vauxhall/i, brand: 'Opel' },
      { pattern: /porsche/i, brand: 'Porsche' },
      { pattern: /lexus/i, brand: 'Lexus' },
      { pattern: /subaru/i, brand: 'Subaru' },
      { pattern: /mazda/i, brand: 'Mazda' },
      { pattern: /mitsubishi/i, brand: 'Mitsubishi' },
    ];

    let brand: string | undefined;
    for (const item of brandMap) {
      if (item.pattern.test(input)) {
        brand = item.brand;
        break;
      }
    }

    // Model hints — map common model keywords to brand+model
    const modelHints: Array<{ keyword: string; model: string; defaultBrand?: string }> = [
      { keyword: 'e-tron', model: 'e-tron', defaultBrand: 'Audi' },
      { keyword: 'q8', model: 'Q8', defaultBrand: 'Audi' },
      { keyword: 'q7', model: 'Q7', defaultBrand: 'Audi' },
      { keyword: 'q5', model: 'Q5', defaultBrand: 'Audi' },
      { keyword: 'q3', model: 'Q3', defaultBrand: 'Audi' },
      { keyword: 'q2', model: 'Q2', defaultBrand: 'Audi' },
      { keyword: 'a8', model: 'A8', defaultBrand: 'Audi' },
      { keyword: 'a7', model: 'A7', defaultBrand: 'Audi' },
      { keyword: 'a6', model: 'A6', defaultBrand: 'Audi' },
      { keyword: 'a5', model: 'A5', defaultBrand: 'Audi' },
      { keyword: 'a4', model: 'A4', defaultBrand: 'Audi' },
      { keyword: 'a3', model: 'A3', defaultBrand: 'Audi' },
      { keyword: 'land cruiser', model: 'Land Cruiser', defaultBrand: 'Toyota' },
      { keyword: 'rav4', model: 'RAV4', defaultBrand: 'Toyota' },
      { keyword: 'camry', model: 'Camry', defaultBrand: 'Toyota' },
      { keyword: 'corolla', model: 'Corolla', defaultBrand: 'Toyota' },
      { keyword: 'hilux', model: 'Hilux', defaultBrand: 'Toyota' },
      { keyword: 'yaris', model: 'Yaris', defaultBrand: 'Toyota' },
      { keyword: 'glk', model: 'GLK', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'glc', model: 'GLC', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'gle', model: 'GLE', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'gls', model: 'GLS', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'gla', model: 'GLA', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'glb', model: 'GLB', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'cla', model: 'CLA', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'c-class', model: 'C-Class', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'e-class', model: 'E-Class', defaultBrand: 'Mercedes-Benz' },
      { keyword: 's-class', model: 'S-Class', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'a-class', model: 'A-Class', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'b-class', model: 'B-Class', defaultBrand: 'Mercedes-Benz' },
      { keyword: 'x6', model: 'X6', defaultBrand: 'BMW' },
      { keyword: 'x5', model: 'X5', defaultBrand: 'BMW' },
      { keyword: 'x4', model: 'X4', defaultBrand: 'BMW' },
      { keyword: 'x3', model: 'X3', defaultBrand: 'BMW' },
      { keyword: 'x2', model: 'X2', defaultBrand: 'BMW' },
      { keyword: 'x1', model: 'X1', defaultBrand: 'BMW' },
      { keyword: 'm3', model: 'M3', defaultBrand: 'BMW' },
      { keyword: 'm4', model: 'M4', defaultBrand: 'BMW' },
      { keyword: 'm5', model: 'M5', defaultBrand: 'BMW' },
      { keyword: '8 series', model: '8 Series', defaultBrand: 'BMW' },
      { keyword: '7 series', model: '7 Series', defaultBrand: 'BMW' },
      { keyword: '6 series', model: '6 Series', defaultBrand: 'BMW' },
      { keyword: '5 series', model: '5 Series', defaultBrand: 'BMW' },
      { keyword: '4 series', model: '4 Series', defaultBrand: 'BMW' },
      { keyword: '3 series', model: '3 Series', defaultBrand: 'BMW' },
      { keyword: '2 series', model: '2 Series', defaultBrand: 'BMW' },
      { keyword: '1 series', model: '1 Series', defaultBrand: 'BMW' },
      { keyword: 'xc90', model: 'XC90', defaultBrand: 'Volvo' },
      { keyword: 'xc60', model: 'XC60', defaultBrand: 'Volvo' },
      { keyword: 'xc40', model: 'XC40', defaultBrand: 'Volvo' },
      { keyword: 'v90', model: 'V90', defaultBrand: 'Volvo' },
      { keyword: 'v60', model: 'V60', defaultBrand: 'Volvo' },
      { keyword: 's90', model: 'S90', defaultBrand: 'Volvo' },
      { keyword: 's60', model: 'S60', defaultBrand: 'Volvo' },
      { keyword: 'civic', model: 'Civic', defaultBrand: 'Honda' },
      { keyword: 'cr-v', model: 'CR-V', defaultBrand: 'Honda' },
      { keyword: 'accord', model: 'Accord', defaultBrand: 'Honda' },
      { keyword: 'jazz', model: 'Jazz', defaultBrand: 'Honda' },
      { keyword: 'model y', model: 'Model Y', defaultBrand: 'Tesla' },
      { keyword: 'model x', model: 'Model X', defaultBrand: 'Tesla' },
      { keyword: 'model 3', model: 'Model 3', defaultBrand: 'Tesla' },
      { keyword: 'model s', model: 'Model S', defaultBrand: 'Tesla' },
      { keyword: 'touareg', model: 'Touareg', defaultBrand: 'Volkswagen' },
      { keyword: 'tiguan', model: 'Tiguan', defaultBrand: 'Volkswagen' },
      { keyword: 'passat', model: 'Passat', defaultBrand: 'Volkswagen' },
      { keyword: 'golf', model: 'Golf', defaultBrand: 'Volkswagen' },
      { keyword: 'polo', model: 'Polo', defaultBrand: 'Volkswagen' },
      { keyword: 'jetta', model: 'Jetta', defaultBrand: 'Volkswagen' },
      { keyword: 'kuga', model: 'Kuga', defaultBrand: 'Ford' },
      { keyword: 'focus', model: 'Focus', defaultBrand: 'Ford' },
      { keyword: 'fiesta', model: 'Fiesta', defaultBrand: 'Ford' },
      { keyword: 'transit', model: 'Transit', defaultBrand: 'Ford' },
      { keyword: 'ranger', model: 'Ranger', defaultBrand: 'Ford' },
      { keyword: 'tucson', model: 'Tucson', defaultBrand: 'Hyundai' },
      { keyword: 'santa fe', model: 'Santa Fe', defaultBrand: 'Hyundai' },
      { keyword: 'i30', model: 'i30', defaultBrand: 'Hyundai' },
      { keyword: 'sportage', model: 'Sportage', defaultBrand: 'Kia' },
      { keyword: 'sorento', model: 'Sorento', defaultBrand: 'Kia' },
      { keyword: 'octavia', model: 'Octavia', defaultBrand: 'Skoda' },
      { keyword: 'superb', model: 'Superb', defaultBrand: 'Skoda' },
      { keyword: 'kodiaq', model: 'Kodiaq', defaultBrand: 'Skoda' },
      { keyword: 'forester', model: 'Forester', defaultBrand: 'Subaru' },
      { keyword: 'outback', model: 'Outback', defaultBrand: 'Subaru' },
      { keyword: 'cx-5', model: 'CX-5', defaultBrand: 'Mazda' },
      { keyword: 'cx-3', model: 'CX-3', defaultBrand: 'Mazda' },
      { keyword: 'outlander', model: 'Outlander', defaultBrand: 'Mitsubishi' },
      { keyword: 'cayenne', model: 'Cayenne', defaultBrand: 'Porsche' },
      { keyword: 'macan', model: 'Macan', defaultBrand: 'Porsche' },
    ];

    let model: string | undefined;
    for (const hint of modelHints) {
      if (q.includes(hint.keyword)) {
        model = hint.model;
        if (!brand && hint.defaultBrand) brand = hint.defaultBrand;
        break;
      }
    }

    return { brand, model };
  }

  private async findPartsFromIntent(input: string): Promise<Part[]> {
    const q = input.toLowerCase();
    const vehicleIdMatch = input.match(/\b([A-Z]{2,6}\d{3,10})\b/i);
    let vehicleId = vehicleIdMatch?.[1];
    const supplyContext = this.extractSupplyContext(input);
    const aiIntent = await this.geminiService.extractPartsIntent(input);
    const mergedContext = {
      brand: aiIntent?.brand || supplyContext.brand,
      model: aiIntent?.model || supplyContext.model,
    };
    if (!vehicleId && aiIntent?.vehicleId) vehicleId = aiIntent.vehicleId;
    const keywords: string[] = [];

    const phraseKeywords: Array<{ pattern: RegExp; keys: string[] }> = [
      // Brakes — all forms map to 'brakes' category keyword + specific names
      { pattern: /brake\s*disc|brake\s*rotor/i, keys: ['brake disc', 'brake discs', 'disc', 'rotor', 'brakes'] },
      { pattern: /brake\s*pad/i, keys: ['brake pad', 'brake pads', 'pad', 'brakes'] },
      { pattern: /brake\s*caliper|caliper/i, keys: ['brake caliper', 'caliper', 'brakes'] },
      { pattern: /brake\s*drum|drum/i, keys: ['brake drum', 'drum', 'brakes'] },
      { pattern: /brake\s*line|brake\s*hose/i, keys: ['brake line', 'brake hose', 'brakes'] },
      { pattern: /\bbrakes?\b/i, keys: ['brakes', 'brake disc', 'brake pad', 'brake caliper', 'brake'] },
      // Suspension
      { pattern: /control\s*arm/i, keys: ['control arm', 'suspension'] },
      { pattern: /shock\s*absorber|shock\s*absorbers/i, keys: ['shock absorber', 'absorber', 'suspension'] },
      { pattern: /wheel\s*bearing|hub\s*bearing/i, keys: ['wheel bearing', 'hub bearing', 'bearing', 'suspension'] },
      { pattern: /strut/i, keys: ['strut', 'suspension'] },
      { pattern: /ball\s*joint/i, keys: ['ball joint', 'suspension'] },
      { pattern: /sway\s*bar|anti.roll\s*bar/i, keys: ['sway bar', 'anti-roll bar', 'suspension'] },
      { pattern: /spring/i, keys: ['spring', 'suspension'] },
      { pattern: /\bsuspension\b/i, keys: ['suspension'] },
      // Steering
      { pattern: /steering\s*rack/i, keys: ['steering rack', 'steering'] },
      { pattern: /tie\s*rod/i, keys: ['tie rod', 'steering'] },
      { pattern: /\bsteering\b/i, keys: ['steering'] },
      // Engine / filters
      { pattern: /oil\s*filter/i, keys: ['oil filter'] },
      { pattern: /air\s*filter/i, keys: ['air filter'] },
      { pattern: /fuel\s*filter/i, keys: ['fuel filter'] },
      { pattern: /cabin\s*filter|pollen\s*filter/i, keys: ['cabin filter', 'pollen filter'] },
      { pattern: /timing\s*belt/i, keys: ['timing belt'] },
      { pattern: /timing\s*chain/i, keys: ['timing chain'] },
      { pattern: /drive\s*belt|serpentine/i, keys: ['drive belt', 'serpentine'] },
      { pattern: /spark\s*plug/i, keys: ['spark plug'] },
      { pattern: /ignition\s*coil/i, keys: ['ignition coil'] },
      { pattern: /alternator/i, keys: ['alternator'] },
      { pattern: /starter\s*motor|starter/i, keys: ['starter motor', 'starter'] },
      { pattern: /water\s*pump/i, keys: ['water pump'] },
      { pattern: /thermostat/i, keys: ['thermostat'] },
      { pattern: /coolant|radiator/i, keys: ['radiator', 'coolant', 'cooling'] },
      { pattern: /\bclutch\b/i, keys: ['clutch'] },
      { pattern: /gearbox|transmission/i, keys: ['gearbox', 'transmission'] },
      { pattern: /cv\s*joint/i, keys: ['cv joint'] },
      { pattern: /axle|driveshaft|prop\s*shaft/i, keys: ['axle', 'driveshaft'] },
      // Exhaust
      { pattern: /exhaust|muffler|silencer|dpf|catalytic/i, keys: ['exhaust'] },
      // Body / electrical
      { pattern: /headlight|headlamp/i, keys: ['headlight'] },
      { pattern: /tail\s*light/i, keys: ['tail light'] },
      { pattern: /\bbulb\b/i, keys: ['bulb'] },
      { pattern: /battery/i, keys: ['battery'] },
      { pattern: /abs\s*sensor|cam\s*sensor|o2\s*sensor|lambda|map\s*sensor/i, keys: ['abs sensor', 'sensor'] },
      { pattern: /wiper/i, keys: ['wiper'] },
      { pattern: /bumper/i, keys: ['bumper', 'body parts'] },
      { pattern: /fender|wing/i, keys: ['fender', 'body parts'] },
      // Position modifiers
      { pattern: /\brear\b/i, keys: ['rear'] },
      { pattern: /\bfront\b/i, keys: ['front'] },
      { pattern: /\blower\b/i, keys: ['lower'] },
      { pattern: /\bupper\b/i, keys: ['upper'] },
    ];

    for (const item of phraseKeywords) {
      if (item.pattern.test(q)) keywords.push(...item.keys);
    }

    if (aiIntent?.partTerms?.length) {
      keywords.push(...aiIntent.partTerms);
    }

    const dedupedKeywords = Array.from(new Set(keywords.map((k) => k.toLowerCase()).filter(Boolean)));

    const candidates = await this.partRepo
      .createQueryBuilder('part')
      .where('1=1')
      .andWhere(vehicleId ? 'LOWER(part.vehicleId) = LOWER(:vehicleId)' : '1=1', { vehicleId })
      .andWhere(mergedContext.brand ? 'LOWER(part.brand) = LOWER(:brand)' : '1=1', { brand: mergedContext.brand })
      .andWhere(mergedContext.model ? 'LOWER(part.model) LIKE LOWER(:model)' : '1=1', { model: `%${mergedContext.model || ''}%` })
      .take(200)
      .getMany();

    if (candidates.length === 0) return [];

    // If we have no part-specific keywords but have a brand/model context,
    // return all parts for that vehicle (used for broad "do you have parts for X6?" queries).
    // But only if the query actually has a vehicle hint — never dump random parts.
    if (dedupedKeywords.length === 0) {
      if (mergedContext.brand || mergedContext.model || vehicleId || aiIntent?.isPartsQuery) {
        return candidates.slice(0, 8);
      }
      return [];
    }

    const scored = candidates
      .map((part) => {
        const haystack = [
          part.name,
          part.category,
          part.subCategory,
          part.position,
          part.fitment,
          part.partNumber,
          part.model,
        ].filter(Boolean).join(' ').toLowerCase();

        const score = dedupedKeywords.reduce((sum, k) => sum + (haystack.includes(k) ? 10 : 0), 0);
        return { part, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.part);

    // CRITICAL: if we had specific part keywords but nothing scored,
    // return [] rather than leaking unrelated parts (e.g. steering/suspension when brakes asked)
    return scored;
  }

  private async getGroundedGeminiResponse(
    input: string,
  ): Promise<{ answer: string; parts: Part[]; usedKnowledge: boolean } | null> {
    if (!this.geminiService.isEnabled()) return null;

    const [parts, ragResults] = await Promise.all([
      this.findPartsFromIntent(input),
      this.ragService.query(input, 2, { prioritizeClientDocs: true }),
    ]);

    const partContext = parts.slice(0, 6).map((p) => ({
      name: p.name,
      partNumber: p.partNumber,
      brand: p.brand,
      model: p.model,
      availability: p.availability,
      price: Number(p.price || 0),
      fitment: p.fitment,
    }));

    const knowledgeSnippets = ragResults.slice(0, 2).map((r) => r.answer || r.document?.content || '').filter(Boolean);
    const answer = await this.geminiService.generateGroundedReply(input, {
      parts: partContext,
      knowledgeSnippets,
    });

    if (!answer) return null;
    return {
      answer,
      parts: parts.slice(0, 6),
      usedKnowledge: knowledgeSnippets.length > 0,
    };
  }

  private async saveMessage(conversationId: string, senderType: string, content: string, widgetType?: string, widgetPayload?: any, metadata?: any): Promise<Message> {
    const msg = this.msgRepo.create({ conversationId, senderType, content, widgetType, widgetPayload, metadata });
    return this.msgRepo.save(msg);
  }

  private async getDistinctBrands(): Promise<string[]> {
    const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.brand', 'brand').where('part.brand IS NOT NULL').getRawMany();
    if (result.length === 0) return ['BMW', 'Audi', 'Tesla', 'Toyota', 'Mercedes-Benz', 'Honda', 'Volvo'];
    return result.map(r => r.brand).filter(Boolean);
  }

  private async getModelsForBrand(brand: string): Promise<string[]> {
    const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.model', 'model').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('part.model IS NOT NULL').getRawMany();
    const defaults = { BMW: ['X1','X3','X5','X6','5 Series','3 Series'], Audi: ['A4','A6','Q5','Q7','e-tron'], Tesla: ['Model 3','Model S','Model X','Model Y'], Toyota: ['Camry','Corolla','RAV4','Prius'], 'Mercedes-Benz': ['C-Class','E-Class','GLC','S-Class'], Honda: ['Civic','CR-V','Accord'], Volvo: ['XC60','XC90','V60','S90'] };
    if (result.length > 0) return result.map(r => r.model).filter(Boolean);
    return defaults[brand] || ['Model 1','Model 2'];
  }

  private async getVariantsForBrandModel(brand: string, model: string): Promise<string[]> {
    const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.variant', 'variant').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('part.variant IS NOT NULL').getRawMany();
    if (result.length > 0) return result.map(r => r.variant).filter(Boolean);
    return [`${model} 2.0 TDI (2019-2023)`, `${model} 3.0 TDI (2020-2024)`];
  }

  private async getCategoriesForVariant(brand: string, model: string, variant: string): Promise<string[]> {
    const result = await this.partRepo.createQueryBuilder('part').select('DISTINCT part.category', 'category').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('part.category IS NOT NULL').getRawMany();
    if (result.length > 0) return result.map(r => r.category).filter(Boolean);
    return ['Body Parts','Brakes','Cooling','Electrical','Engine','Exhaust','Steering','Suspension'];
  }

  private async getPartsForCategory(brand: string, model: string, variant: string, category: string): Promise<Part[]> {
    return this.partRepo.createQueryBuilder('part').where('LOWER(part.brand) = LOWER(:brand)', { brand }).andWhere('LOWER(part.model) = LOWER(:model)', { model }).andWhere('LOWER(part.category) = LOWER(:category)', { category }).take(10).getMany();
  }

  private normalizeCode(input: string): string {
    return input.replace(/[^a-z0-9]/gi, '').toLowerCase();
  }

  private async suggestPartsFromPartCode(input: string): Promise<Part[]> {
    const clean = this.normalizeCode(input);
    if (!clean || clean.length < 4) return [];

    const candidates = await this.partRepo
      .createQueryBuilder('part')
      .where('part.partNumber IS NOT NULL')
      .orWhere('part.internalCode IS NOT NULL')
      .take(120)
      .getMany();

    const scored = candidates
      .map((part) => {
        const pn = this.normalizeCode(part.partNumber || '');
        const ic = this.normalizeCode(part.internalCode || '');
        const score = this.matchScore(clean, pn, ic);
        return { part, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => x.part);

    return scored;
  }

  private matchScore(target: string, pn: string, ic: string): number {
    if (!pn && !ic) return 0;
    if (target === pn || target === ic) return 100;

    let score = 0;
    if (pn.includes(target) || ic.includes(target)) score += 50;
    if (target.includes(pn) || target.includes(ic)) score += 35;

    const targetTokens = target.match(/[a-z]+|\d+/gi) || [];
    for (const token of targetTokens) {
      if (token.length < 2) continue;
      if (pn.includes(token) || ic.includes(token)) score += token.length > 3 ? 12 : 7;
    }

    return score;
  }
}