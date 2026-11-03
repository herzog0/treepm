import cors from "@fastify/cors";
import Fastify from "fastify";
import { createRepository } from "./repository.js";
import { registerRoutes } from "./routes.js";

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cors, {
    origin: ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"],
  });
  await registerRoutes(app, createRepository());
  return app;
}
