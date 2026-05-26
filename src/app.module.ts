import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Conversation } from "./entities/conversation.entity";
import { Message } from "./entities/message.entity";
import { Part } from "./entities/part.entity";
import { ClientDocument } from "./entities/client-document.entity";
import { RagKnowledgeDocument } from "./entities/rag-knowledge-document.entity";
import { ChatGateway } from "./gateways/chat.gateway";
import { ApiController } from "./modules/api.controller";
import { RagService } from "./services/rag.service";
import { GuardrailService } from "./services/guardrail.service";
import { QueryMonitorService } from "./services/monitor.service";
import { GeminiService } from "./services/gemini.service";
import { QueryUnderstandingService } from "./services/query-understanding.service";
import "dotenv/config";

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      // host: process.env.DB_HOST || 'localhost',
      // port: parseInt(process.env.DB_PORT) || 5432,
      // username: process.env.DB_USER || 'postgres',
      // password: process.env.DB_PASS || 'root',
      // database: process.env.DB_NAME || 'veng_chat',
      url: process.env.DB_URL,
      ssl: { rejectUnauthorized: false },
      entities: [
        Conversation,
        Message,
        Part,
        ClientDocument,
        RagKnowledgeDocument,
      ],
      synchronize: true,
      autoLoadEntities: true,
    }),
    TypeOrmModule.forFeature([
      Conversation,
      Message,
      Part,
      ClientDocument,
      RagKnowledgeDocument,
    ]),
  ],
  controllers: [ApiController],
  providers: [
    ChatGateway,
    RagService,
    GuardrailService,
    QueryMonitorService,
    GeminiService,
    QueryUnderstandingService,
  ],
})
export class AppModule {}
