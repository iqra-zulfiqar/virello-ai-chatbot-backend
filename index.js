import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import chatbotAI from "./chatbotAI.js";

const app = express();
const PORT = process.env.PORT || 5000;

// Fix __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, ".env") });

// ── Middleware ──────────────────────────────────

// CORS FIX
app.use(
  cors({
    origin: "https://virello-ai-chatbot-frontend.vercel.app",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Body parser
app.use(express.json({ limit: "2mb" }));

// ── Routes ──────────────────────────────────────

// Test route
app.get("/", (req, res) => {
  res.send("API is running...");
});

// API routes
app.use("/api", chatbotAI);

// ── MongoDB Connection ──────────────────────────

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("MongoDB connected");
  })
  .catch((err) => {
    console.error("MongoDB error:", err);
  });

// ── Start Server ────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});