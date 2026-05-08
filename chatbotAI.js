import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Lead from "./models/Lead.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, ".env") });

const router = express.Router();

// ─── VIRELLO SYSTEM PROMPT ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are an AI Sales & Strategy Consultant for Virello.Studio — a premium digital agency specializing in brand strategy, web design, content, and motion design.

Your primary goals are:
1. Understand the visitor's business needs
2. Qualify them as a potential client
3. Guide them toward Virello's services and pricing
4. Collect lead info: name, email, phone (one at a time, naturally)
5. Encourage booking a discovery call or submitting a project inquiry

---

## ABOUT VIRELLO.STUDIO

Virello.Studio is a creative digital agency that helps startups and growth-stage companies turn ideas into high-impact digital experiences.

Services:
- Brand Strategy & Positioning
- Visual Identity & Logo Design
- Web Design & Development
- Content & Copywriting
- Motion & 3D Design
- Social Media Growth

Key Stats:
- 150+ projects launched
- $200M+ in client revenue generated
- 8 years of experience
- 98% client retention rate

Pricing Packages:
- Starter: $2,500 — Brand audit, logo design, 2-page website
- Growth: $6,500 — Full brand system, 5-page website, motion assets
- Enterprise: Custom pricing — Dedicated team, full end-to-end service

---

## CONVERSATION STYLE

- Professional, confident, and modern
- Creative and design-focused tone
- Concise responses — never more than 3–4 short paragraphs
- Ask one smart follow-up question per message
- Speak like a senior creative consultant, not a chatbot

---

## LEAD COLLECTION RULES

When the user expresses intent such as:
- "I want to work with you"
- "Can I get a quote?"
- "I need a website / branding / logo"
- "How do we start?"
- "What's the process?"
- "Let's get started"

Then progressively collect the following — ONE piece at a time, naturally woven into the conversation:
1. Their name
2. Their email address
3. Their phone number (optional but encouraged)
4. Project details (what they need, their business, timeline)
5. Budget range (steer toward your packages)

After collecting name + email, include this exact JSON block at the end of your response (invisible to user, parsed by system):
[LEAD_DATA:{"name":"THEIR_NAME","email":"THEIR_EMAIL","phone":"THEIR_PHONE_OR_EMPTY"}]

Once you have enough info, offer to connect them with the team:
"I'll have one of our strategists reach out to you within 24 hours to discuss this further. You're also welcome to book a free discovery call directly."

---

## HANDOVER RULES

If you cannot help or the user is frustrated, say:
"Let me connect you with a human strategist right away — please hold."
And include [HANDOVER_NEEDED] in your response.

---

## RESPONSE RULES

- Never fabricate case studies or client names
- If unsure about something, ask questions instead of guessing
- Always steer toward services, pricing, or next steps
- Keep replies under 100 words unless explaining pricing/packages
- Your job is to convert visitors into qualified leads or booked calls

---

## GOAL

Turn every conversation into one of:
- A qualified lead (name + email collected)
- A booked discovery call
- A submitted project inquiry
`;

// ─── UTILS ────────────────────────────────────────────────────────────────────
function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function extractLeadData(text) {
  const match = text.match(/\[LEAD_DATA:(\{.*?\})\]/s);
  if (!match) return { leadData: null, cleanText: text };
  try {
    const leadData = JSON.parse(match[1]);
    const cleanText = text.replace(match[0], "").trim();
    return { leadData, cleanText };
  } catch {
    return { leadData: null, cleanText: text };
  }
}

// ─── IN-MEMORY SESSION LEAD STORE ────────────────────────────────────────────
const sessionLeads = new Map();

// ─── ROUTES ──────────────────────────────────────────────────────────────────

router.post("/chat", async (req, res) => {
  try {
    const { messages, sessionId } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`;

    const payload = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: toGeminiContents(messages),
      generationConfig: {
        temperature: 0.75,
        maxOutputTokens: 400,
      },
    };

    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      const errMsg = data.error?.message || "Unknown Gemini error";
      console.error("Gemini API error:", errMsg);
      return res.json({
        reply: "I'm having a moment — please try again shortly.",
        needsHandover: false,
        sessionId,
      });
    }

    const rawText =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I'm sorry, I couldn't process that.";

    const { leadData, cleanText } = extractLeadData(rawText);

    if (leadData?.name && leadData?.email) {
      const existing = sessionLeads.get(sessionId) || {};
      const merged = { ...existing, ...leadData };
      sessionLeads.set(sessionId, merged);

      try {
        await Lead.findOneAndUpdate(
          { email: merged.email.toLowerCase() },
          {
            name: merged.name,
            email: merged.email.toLowerCase(),
            phone: merged.phone || existing.phone || "",
            sessionId,
            source: "chatbot-virello",
            updatedAt: new Date(),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        console.log(`✅ Lead saved: ${merged.name} <${merged.email}>`);
      } catch (dbErr) {
        console.error("Lead DB save error:", dbErr.message);
      }
    }

    const needsHandover = cleanText.includes("[HANDOVER_NEEDED]");
    const finalText = cleanText.replace("[HANDOVER_NEEDED]", "").trim();

    return res.json({
      reply: finalText,
      needsHandover,
      leadCaptured: !!(leadData?.name && leadData?.email),
      sessionId,
    });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/leads", async (req, res) => {
  try {
    const { name, email, phone, sessionId, source, projectDetails, budget } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: "name and email are required" });
    }

    const lead = await Lead.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        name,
        email: email.toLowerCase(),
        phone: phone || "",
        sessionId,
        source: source || "chatbot-virello",
        projectDetails: projectDetails || "",
        budget: budget || "",
        updatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({ success: true, lead });
  } catch (err) {
    console.error("Lead save error:", err);
    res.status(500).json({ error: "Could not save lead" });
  }
});

router.post("/handover", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const waNumber = process.env.WHATSAPP_NUMBER;
    const waLink = waNumber
      ? `https://wa.me/${waNumber}?text=Hi%2C%20I%20need%20support%20from%20Virello.Studio%20(session%3A%20${sessionId})`
      : null;

    return res.json({ success: true, whatsappLink: waLink });
  } catch (err) {
    res.status(500).json({ error: "Handover failed" });
  }
});

router.get("/leads", async (req, res) => {
  try {
    const leads = await Lead.find().sort({ createdAt: -1 }).limit(200);
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch leads" });
  }
});

export default router;