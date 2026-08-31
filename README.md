# 🤖 Arham's WhatsApp AI Agent — 24/7 Smart Business Assistant

An intelligent, autonomous WhatsApp AI assistant designed for **Arham's Freelance & Agency Business**. Built with Node.js, Baileys Multi-Device API, Groq Ultra-Fast LLM, Google Gemini Vision, and Edge-TTS Voice Generation.

---

## 📋 Table of Contents
1. [Overview & Features](#-overview--features)
2. [Business Information & Pricing](#-business-information--pricing)
3. [Architecture & Technology Stack](#-architecture--technology-stack)
4. [Project Structure](#-project-structure)
5. [Environment Variables (`.env`)](#-environment-variables-env)
6. [Getting Started & Installation](#-getting-started--installation)
7. [Comprehensive Errors & Solutions Guide](#-comprehensive-errors--solutions-guide)
8. [Available Scripts & Testing Tools](#-available-scripts--testing-tools)
9. [Deployment Guide](#-deployment-guide)

---

## 🚀 Overview & Features

- **⚡ Sub-Second AI Response (Groq + Gemini):** Powered by Groq's high-speed inference engine (`qwen/qwen3.6-27b`, `groq/compound-mini`) for sub-second text replies, backed by Google Gemini for vision and offline smart local engine fallbacks.
- **🎤 Full Voice Message Understanding & Generation:** Automatically transcribes incoming voice notes (Urdu, Roman Urdu, English, Punjabi) with Whisper, understands intent, and replies with natural voice audio (Edge-TTS Opus/PTT).
- **🖼️ Image & Document Analysis:** Analyzes photos, mockups, screenshots, and invoices sent by customers and gives contextual business feedback.
- **🧠 500+ Messages Customer Memory:** Remembers customer names, previous inquiries, budgets, project specifications, and conversation context permanently.
- **📊 Real-Time Web Dashboard:** Built-in web dashboard (`http://localhost:3000`) with Server-Sent Events (SSE) for live log streaming, connection QR/Pairing code display, and status monitoring.
- **🔐 Modern Multi-Device Authentication:** Connect via phone number **Pairing Code** (e.g. `YFC1WM44`) or QR Code without needing a browser window.

---

## 💼 Business Information & Pricing

The bot is strictly trained with Arham's authentic service catalog:

| Service | Price (PKR) | Description |
| :--- | :--- | :--- |
| 🌐 **Website Development** | **15,000 PKR** | Modern, responsive portfolio, business, and e-commerce websites. |
| 📱 **Mobile App Development** | **20,000 PKR** | Cross-platform iOS & Android mobile applications (Flutter / React Native). |
| 🤖 **AI Chatbot Development** | **5,000 PKR** | Custom WhatsApp, Telegram, and Website AI agents & automation bots. |

- **Owner:** Arham
- **Languages Supported:** Roman Urdu, Urdu (اردو), English, Punjabi, and mixed dialects.

---

## 🛠️ Architecture & Technology Stack

```
[ Customer WhatsApp ]
        │
        ▼ (WebSocket / Baileys 7.0 Multi-Device)
[ src/whatsappService.js ] ── (Real-time SSE) ──> [ Web Dashboard (localhost:3000) ]
        │
        ├── Text Message ──────> [ src/aiService.js (Groq / Gemini) ]
        ├── Voice Note (PTT) ──> [ Whisper Transcription -> AI -> Edge-TTS ]
        └── Image / Video ─────> [ Gemini 3.6/3.7 Flash Vision ]
        │
        ▼
[ Customer WhatsApp Reply Delivered in 1.5s ]
```

- **Backend:** Node.js (ES Modules), Express.js
- **WhatsApp Multi-Device Client:** `@whiskeysockets/baileys` (v7.0.0-rc14)
- **AI Intelligence:** Groq SDK (`qwen/qwen3.6-27b`, `groq/compound-mini`), Google Generative AI (`gemini-flash-latest`, `gemini-3.6-flash`, `gemini-3.7-flash`)
- **Voice / Audio:** `msedge-tts` (Urdu Neural Asad Voice), `google-tts-api`, Groq Whisper (`whisper-large-v3`, `whisper-large-v3-turbo`)
- **Memory Storage:** JSON-backed persistent store (`data/user_profiles.json`, `data/chat_history.json`)

---

## 📂 Project Structure

```
├── auth_info_baileys/         # WhatsApp credentials and session keys (creds.json)
├── data/                      # Persistent storage for user profiles and chat history
│   ├── chat_history.json
│   └── user_profiles.json
├── public/                    # Web dashboard frontend
│   ├── index.html
│   ├── style.css
│   └── app.js
├── src/                       # Core backend source code
│   ├── aiService.js           # Multi-engine AI router (Groq, Gemini, Local Engine, Voice)
│   ├── config.js              # Business info, system prompts, pricing rules, env loader
│   ├── memoryStore.js         # Conversation continuity & user profile memory manager
│   ├── server.js              # Express web server & SSE event dispatcher
│   ├── testAi.js              # AI prompt & model verification test
│   └── whatsappService.js     # Baileys WhatsApp socket, message handling & delivery
├── .env                       # API keys and environment configuration
├── package.json               # Dependencies and scripts
└── README.md                  # Complete documentation and error resolution guide
```

---

## ⚙️ Environment Variables (`.env`)

Create a `.env` file in the root directory:

```env
# AI Model API Keys
GEMINI_API_KEY=your_gemini_api_key_here
GROQ_API_KEY=your_groq_api_key_here

# WhatsApp Configuration
PHONE_NUMBER=923298024266
AUTH_MODE=pairing          # Options: "pairing" or "qr"

# Server Configuration
PORT=3000
```

---

## 🚀 Getting Started & Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Server
```bash
npm start
```
Or for auto-reload during development:
```bash
npm run dev
```

### 3. Link WhatsApp Account
1. Open your browser at `http://localhost:3000`.
2. The terminal and dashboard will display your **8-digit Pairing Code** (e.g. `YFC1WM44`).
3. On your phone (+923298024266), go to:
   **WhatsApp > Settings / Linked Devices > Link a Device > Link with phone number instead**.
4. Enter the code. The bot will connect and remain online permanently.

---

## 🛠️ Comprehensive Errors & Solutions Guide

This section documents every error encountered during development, root causes, and exact technical solutions:

---

### ❌ Error 1: Model Deprecations (404 Not Found & API Hangs)
- **Symptom:** AI calls failed with `404 Not Found` or hung indefinitely without replying.
- **Root Cause:** Google deprecated `gemini-2.0-flash` and `gemini-2.5-flash` for new API requests. Groq deprecated `llama-3.3-70b-versatile` and `llama-3.2-11b-vision-preview`.
- **Solution:** 
  1. Updated model lists in [src/aiService.js](file:///e:/whatsappp%20Ai%20agent/src/aiService.js) to active models:
     - **Groq:** `qwen/qwen3.6-27b`, `groq/compound-mini`, `groq/compound`, `openai/gpt-oss-120b`.
     - **Gemini:** `gemini-flash-latest`, `gemini-3.6-flash`, `gemini-3.7-flash`.
  2. Wrapped every API call in a `withTimeout(promise, 4000)` wrapper to prevent infinite request hangs.
  3. Added `cleanAiResponse()` to strip `<think>...</think>` internal reasoning tags from deep-thinking models.

---

### ❌ Error 2: Reason Code 515 (`restartRequired`) & Code 428 (`connectionClosed`) Session Desync
- **Symptom:** Entering pairing code resulted in `515`, and upon temporary socket drop (`428`), the computer would wipe `auth_info_baileys` and log out while the mobile phone still showed the device as linked ("Phone shows logged in, bot shows logged out").
- **Root Cause:** In [src/whatsappService.js](file:///e:/whatsappp%20Ai%20agent/src/whatsappService.js), disconnect handlers were deleting credentials whenever status code was not 428/515, causing accidental deletion during pairing finalization.
- **Solution:**
  1. Code `515` (`restartRequired`) is now handled as **Pairing Success** — it restarts the socket session within 1.5s using newly saved `creds.json`.
  2. Code `428` (`connectionClosed`) and `408` (`timedOut`) reconnect seamlessly without wiping credentials.
  3. Only genuine `DisconnectReason.loggedOut` (`401`) resets local auth files.

---

### ❌ Error 3: JavaScript Temporal Dead Zone (`Cannot access 'ownerText' before initialization`)
- **Symptom:** `Error processing incoming message: Cannot access 'ownerText' before initialization` in server logs when owner messaged.
- **Root Cause:** In [src/whatsappService.js](file:///e:/whatsappp%20Ai%20agent/src/whatsappService.js), `isBotSentText(ownerText)` was called on line 573 before `const ownerText = ...` was declared on line 578.
- **Solution:** Moved `const ownerText` declaration above all validation checks.

---

### ❌ Error 4: WhatsApp Error 463 (`NackCallerReachoutTimelocked` / Missing `tctoken`)
- **Symptom:** Messages showed as delivered in dashboard logs, but never appeared on the customer's mobile WhatsApp chat screen (`error="463"` in socket ACK).
- **Root Cause:** WhatsApp's server-side anti-spam policy restricts multi-device linked bots from sending automated messages to "cold" or unverified contacts without a **Trusted Contact Token (`tctoken`)**.
- **Solution:**
  1. Upgraded `@whiskeysockets/baileys` to `v7.0.0-rc14` which includes the automatic `tctoken` and `cstoken` recovery and persistence module.
  2. Saved customer phone number in the host phone's contacts / initiated at least 1 mutual message exchange to issue the trusted contact token.

---

### ❌ Error 5: Signal Protocol Session Corruption (`Closing session: SessionEntry`)
- **Symptom:** Sending replies to both `@lid` (Linked Identity) and `@s.whatsapp.net` (Phone JID) caused double ticks to fail and messages were dropped by the recipient device.
- **Root Cause:** Sending stanzas to both `@lid` and `@s.whatsapp.net` simultaneously triggered a cryptographic identity collision in Signal Protocol, causing the session to close and corrupt end-to-end encryption keys.
- **Solution:**
  1. Set single JID routing: Deliver strictly to `targetPhoneJid || rawJid`.
  2. Added validation in `sendToAll` so that quoted messages (`{ quoted: msg }`) are only attached if `quotedMsg.key.remoteJid === destinationJid`.
  3. Added `getMessage` callback and in-memory `messageCache` in `makeWASocket` for retry decryption handling.

---

### ❌ Error 6: Human Takeover False Positives
- **Symptom:** Bot became silent and ignored customer messages with the log: `Message from +9234... ignored because Human Takeover is active.`
- **Root Cause:** When the owner sent a message from their phone (or tested between two personal numbers), `humanTakeover` locked the chat for 30s and dropped all incoming customer messages.
- **Solution:** Removed the hard drop check so the bot always delivers automated AI replies to customers.

---

## 🧪 Available Scripts & Testing Tools

| Command | Description |
| :--- | :--- |
| `npm start` | Launches the production WhatsApp bot server and web dashboard. |
| `npm run dev` | Launches the server with auto-restart on file edits. |
| `npm run test:ai` | Runs AI response tests for text, Urdu context, pricing, and system prompts. |
| `node test_send_now.mjs` | Sends a direct test message to verify socket delivery. |
| `node test_direct_delivery.mjs` | Verifies phone JID delivery and checks socket ACKs. |

---

## 🌐 Deployment Guide (Railway / VPS / Docker)

### Deploying to Railway or Cloud VPS:
1. **Set Environment Variables:** Add `GEMINI_API_KEY`, `GROQ_API_KEY`, `PHONE_NUMBER`, and `PORT=3000` in your cloud settings.
2. **Persistent Storage:** Attach a persistent volume to `/auth_info_baileys` and `/data` so login credentials and customer chat histories survive container restarts.
3. **Start Command:**
   ```bash
   node src/server.js
   ```
4. Open your Railway public domain to view the dashboard and link your WhatsApp device via Pairing Code.

---

## 👨‍💻 Author
- **Owner & Developer:** Arham
- **Project:** WhatsApp AI Agent (Full-Stack Automated Business Assistant)
- **License:** ISC
