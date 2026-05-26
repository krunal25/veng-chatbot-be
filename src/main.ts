import 'dotenv/config';
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { isOriginAllowed, parseAllowedOrigins } from './utils/request-safety.util';

async function bootstrap() {
  const allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin, allowedOrigins)) {
          return callback(null, true);
        }
        return callback(new Error('CORS origin not allowed'), false);
      },
      credentials: true,
    },
  });
  app.enableCors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, allowedOrigins)) {
        return callback(null, true);
      }
      return callback(new Error('CORS origin not allowed'), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  });

  const port = process.env.PORT || 3001;
  await app.listen(port, "0.0.0.0");
  console.log(`🚀 Veng Chatbot Backend running on http://localhost:${port}`);
  console.log(`📡 WebSocket available on ws://localhost:${port}`);
  console.log(`� Also accessible over LAN - get your local IP and use http://<YOUR_LOCAL_IP>:${port}`);
  console.log(`�🌱 Seed data: http://localhost:${port}/api/seed`);
}
bootstrap();
