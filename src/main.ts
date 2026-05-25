import 'dotenv/config';
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  // const app = await NestFactory.create(AppModule);

  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: true,
      credentials: true,
    },
  });
  app.enableCors({
    origin: "*",
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
