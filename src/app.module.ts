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

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "postgres",
      // host: process.env.DB_HOST || 'localhost',
      // port: parseInt(process.env.DB_PORT) || 5432,
      // username: process.env.DB_USER || 'postgres',
      // password: process.env.DB_PASS || 'root',
      // database: process.env.DB_NAME || 'veng_chat',
      url: "postgresql://neondb_owner:npg_iZJ4afh7Bsle@ep-odd-paper-aqjgt1wm.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require",
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
  ],
})
export class AppModule {}

// Dev DB

// @Module({
//   imports: [
//     TypeOrmModule.forRoot({
//       type: 'postgres',
//       url: 'postgresql://neondb_owner:npg_iZJ4afh7Bsle@ep-odd-paper-aqjgt1wm.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require',
//       ssl: { rejectUnauthorized: false },
//       entities: [Conversation, Message, Part],
//       synchronize: true,
//       autoLoadEntities: true,
//     }),
//     TypeOrmModule.forFeature([Conversation, Message, Part]),
//   ],
//   controllers: [ApiController],
//   providers: [ChatGateway, RagService, GuardrailService, QueryMonitorService],
// })
// export class AppModule {}
