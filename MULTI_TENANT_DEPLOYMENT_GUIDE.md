# CloseDesk Multi-Tenant Deployment & Integration Blueprint

**Document:** Ready-to-Deploy Multi-Tenant Architecture & Integration Guide  
**Product:** CloseDesk by Aicyro  
**Version:** 2.0 (Production Multi-Tenant Release)  
**Target:** Deploying Pulse Dashboard & Multimodal Chatbot Widget on **ANY** New Website  

---

## 1. System Overview & Decoupling Strategy

CloseDesk has been architected to completely separate the **Front-End Public Marketing Layer** from the **Conversational Intelligence & Operational Control Plane**. 

This means you can **freely replace or discard** the current public marketing pages (`src/pages/index.jsx`, `free-website-audit.jsx`, etc.) and seamlessly deploy:
1. **The CloseDesk Multimodal Chatbot Widget** onto **any external website** (WordPress, Webflow, Shopify, Squarespace, Wix, or custom React/Next.js/Vue).
2. **The Pulse Dashboard (Tenant & Super Admin)** onto **any new web domain** (either as a centralized SaaS portal or co-hosted on the new website under `/lg`).

```text

========================================================================================================
                                     MULTI-TENANT DEPLOYMENT TOPOLOGY
========================================================================================================

 [HOST OPTION A: External CMS / Any Website]         [HOST OPTION B: New Custom Next.js Site]
  * WordPress / Webflow / Shopify / Wix               * Client's Custom Marketing Frontend
  * Simply paste 1-line script tag:                   * Imports <AicyroChatbot tenantId="..." />
    <script src="https://api.yourdomain.com/widget.js" 
            data-tenant="brightstar_hvac"></script>
                        │                                                   │
                        └─────────────────────────┬─────────────────────────┘
                                                  │
                                                  ▼
                         ┌─────────────────────────────────────────────────┐
                         │   CLOSEDESK HEADLESS API ENGINE & BACKEND       │
                         │   (Hosted on Vercel / Netlify / Node Server)    │
                         ├─────────────────────────────────────────────────┤
                         │  * /api/session/bootstrap                       │
                         │  * /api/openai-token (WebRTC Ephemeral Voice)   │
                         │  * /api/chat (Structured JSON Engine)           │
                         │  * /api/analyze-image (GPT-4o-mini Vision)      │
                         │  * /api/leads (Multi-tenant lead ingestion)     │
                         │  * /embed/chatbot (Headless iframe mount)       │
                         └────────────────────────┬────────────────────────┘
                                                  │
                                                  ▼
                         ┌─────────────────────────────────────────────────┐
                         │   PULSE OPERATIONS COCKPIT (/lg)                │
                         │   (Accessible at app.yourdomain.com/lg)         │
                         ├─────────────────────────────────────────────────┤
                         │  * SuperAdmin: Tenant provisioning & protocols  │
                         │  * Tenant Admin: Real-time triage, calendar,    │
                         │    voice replay transcripts & AI configuration  │
                         └────────────────────────┬────────────────────────┘
                                                  │
                                                  ▼
                         ┌─────────────────────────────────────────────────┐
                         │   MULTI-TENANT FIREBASE REALTIME DATABASE       │
                         │   Partition: /tenants/{tenant_id}/...           │
                         └─────────────────────────────────────────────────┘
```

---

## 2. Deploying the Chatbot Widget on ANY New Website

You can embed the full multimodal front-desk (Voice WebRTC, Chat, and Vision upload) onto any website using either **Method A (Script Tag)** or **Method B (Native React Component)**.

### Method A: Universal 1-Line Script Tag (Zero Build Step)
Works with **WordPress, Webflow, Shopify, Squarespace, Wix, or static HTML**.

1. In your host website's admin panel, navigate to Custom Code / Header & Footer settings.
2. Paste the script tag immediately before the closing `</body>` tag:
   ```html
   <!-- CloseDesk Multimodal AI Front-Desk -->
   <script 
     src="https://YOUR_CLOSEDESK_DOMAIN/widget.js" 
     data-tenant="brightstar_hvac" 
     defer>
   </script>
   ```
3. **What happens automatically:**
   * `public/widget.js` detects `data-tenant="brightstar_hvac"`.
   * It injects a responsive, floating iframe pointing to `https://YOUR_CLOSEDESK_DOMAIN/embed/chatbot?tenant=brightstar_hvac`.
   * **Zero CSS conflicts:** The widget is isolated from the host site's styles.
   * **Full multimodal support:** Microphone permissions for WebRTC voice and camera/file uploads for photo inspection work seamlessly.
   * **Responsive Auto-Resize:** The widget occupies an 80x80px bubble when minimized and smoothly expands to full modal on desktop and full screen on mobile.

---

### Method B: Native React Component (New Next.js / React App)
If you are building a new React or Next.js website and want to embed CloseDesk directly into the component tree:

1. Copy [src/Closedesk/Chatbot/AicyroChatbot.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/Closedesk/Chatbot/AicyroChatbot.jsx) into your new project.
2. Mount the component anywhere in your layout:
   ```jsx
   import AicyroChatbot from "@/Closedesk/Chatbot/AicyroChatbot";

   export default function AppLayout({ children }) {
     return (
       <div className="relative min-h-screen">
         <main>{children}</main>

         {/* Mount CloseDesk Widget for specific tenant */}
         <AicyroChatbot tenantId="brightstar_hvac" />
       </div>
     );
   }
   ```
3. Set your environment variables in `.env.local`:
   ```bash
   NEXT_PUBLIC_TENANT_ID=brightstar_hvac
   ```

---

## 3. Deploying the Pulse Dashboard (Tenant & Super Admin)

The Pulse Dashboard ([src/pages/lg.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/pages/lg.jsx)) is a unified Single Page Application (SPA) designed to manage all operational triage, appointments, and client accounts.

### Deployment Options:
* **Option 1: Centralized SaaS Operations Center (Recommended)**  
  Host CloseDesk on a central administrative domain (e.g., `https://app.closedesk.ai` or `https://dispatch.youragency.com`).  
  All clients log into `/lg`. Their credentials automatically bind them to their specific `tenant_id` partition in Firebase RTDB.
* **Option 2: Co-hosted on the New Website**  
  Deploy the Next.js repository on the client's domain (e.g. `https://brightstarhvac.com/lg`). The public routes serve their marketing pages, and `/lg` serves their operational terminal.

### User Roles & Navigation in `/lg`:

```text
                                       /lg (PORTAL)
                                            │
               ┌────────────────────────────┴────────────────────────────┐
               │                                                         │
               ▼                                                         ▼
     [Tenant Admin Login]                                      [Super Admin Login]
       User: brightstar_admin                                    Master Passkey Gateway
       Pass: ••••••••••••                                        Pass: ••••••••••••
               │                                                         │
               ▼                                                         ▼
     [Tenant Operational Cockpit]                              [Super Admin Control Plane]
     * Inbound Lead Triage Terminal                            * Client Lifecycle & CRUD Provisioning
     * Dispatch Calendar & Bookings                            * Industry Pack Manager (HVAC, Plumbing)
     * Real-Time Voice Transcripts                             * Global SMTP Relay Configurations
     * AI Persona, Hours & Voice Config                        * Cross-Tenant Observability & Audits
```

#### 1. Tenant Authentication Flow:
* Client dispatchers log in with their assigned username and password via `LoginScreen.jsx`.
* [/api/login](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/pages/api/login.js) validates credentials against `tenants/{tenant_id}/users` (or root `login`).
* Upon success, the session stores the tenant identifier. All dashboard modules ([TerminalScreen.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/Closedesk/Dashboard/TerminalScreen.jsx), [Booking.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/Closedesk/Dashboard/Booking.jsx), [Conversations.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/Closedesk/Dashboard/Conversations.jsx)) subscribe exclusively to `/tenants/{tenant_id}/...`.

#### 2. Master Super Admin Flow:
* The platform administrator clicks **Super Admin Portal** on `/lg`.
* Authenticates via `superadminlogin.jsx`.
* Opens [ClientManagement.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/Closedesk/Dashboard/superadmin/ClientManagement.jsx) to:
  * Create new client tenants (e.g. `apex_plumbing`).
  * Assign the Industry Pack (`plumbing_v2`).
  * Issue initial admin credentials.
  * Whitelist their website origin.

---

## 4. Replacing the Public Marketing Architecture

If you want to replace the current public marketing pages with a completely new website design:

### Step 1: Replace or Delete Marketing Components
* The marketing components live cleanly under `src/Closedesk/Home/` and `src/Closedesk/Essential/`.
* You can safely replace [src/pages/index.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/pages/index.jsx) with your new landing page layout.
* If your new marketing site is hosted elsewhere (e.g., WordPress, Webflow, Webflow Cloud), you can configure [next.config.js](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/next.config.js) to redirect root `/` to the external marketing site while keeping `/lg`, `/embed/*`, and `/api/*` active:
  ```javascript
  // next.config.js (Optional Headless Mode)
  module.exports = {
    reactStrictMode: true,
    async rewrites() {
      return [
        {
          source: "/",
          destination: "https://your-marketing-site.webflow.io",
        },
      ];
    },
  };
  ```

### Step 2: Ensure Layout Isolation
[src/pages/layout.jsx](file:///d:/Software%20House%2001/CloseDesk-Aicyro-GIT/src/pages/layout.jsx) is already configured to automatically omit the chatbot on `/lg`, `/logs`, and `/embed/*` routes:
```jsx
// src/pages/layout.jsx
const isDashboard = router.pathname === "/lg";
const isLogsPage = router.pathname === "/logs";
const isEmbedPage = router.pathname.startsWith("/embed");

const showChatbot = !isDashboard && !isLogsPage && !isEmbedPage;
```
Your new marketing pages can render without fear of duplicate chatbot mounts.

---

## 5. Multi-Tenant Database Partitioning (Firebase RTDB)

In multi-tenant mode, data is partitioned under `/tenants/{tenant_id}/`. Below is the complete partition structure:

```text
Firebase Realtime Database (Root)
│
├── tenants/
│   ├── brightstar_hvac/
│   │   ├── config/                     # Business hours, service ZIP codes, enabled actions
│   │   ├── chatbot_config/             # Bot persona, voice ID ("alloy"), qualification questions
│   │   ├── users/                      # Hashed tenant admin credentials
│   │   ├── leads/                      # Inbound qualified customer leads
│   │   ├── bookings/                   # Confirmed dispatch calendar appointments
│   │   ├── transcripts/                # Full-duplex WebRTC and chat dialogues
│   │   └── analytics/                  # Scoped visitor telemetry and hardware profiles
│   │
│   └── apex_plumbing/
│       ├── config/
│       ├── chatbot_config/
│       ├── users/
│       └── leads/
│
├── industry_packs/                     # Shared trade intelligence (HVAC, Plumbing, Restoration)
│   ├── hvac_v2/
│   └── plumbing_v2/
│
└── settings/                           # Default single-tenant fallback configuration
```

### Firebase Security Rules Template (`database.rules.json`):
```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null",
    "tenants": {
      "$tenant_id": {
        ".read": "auth != null && (auth.token.tenant_id === $tenant_id || auth.token.is_superadmin === true)",
        ".write": "auth != null && (auth.token.tenant_id === $tenant_id || auth.token.is_superadmin === true)"
      }
    },
    "public_configs": {
      "$tenant_id": {
        ".read": "true",
        ".write": "auth != null && auth.token.is_superadmin === true"
      }
    }
  }
}
```

---

## 6. Required Environment Variables

When deploying the backend to Vercel, Netlify, or any Node.js hosting platform, provide the following environment variables:

```ini
# =============================================================================
# CLOSEDESK PRODUCTION ENVIRONMENT CONFIGURATION
# =============================================================================

# Next.js Runtime
NODE_ENV=production
NEXT_PUBLIC_APP_URL=https://api.yourdomain.com

# Firebase Client & Admin SDK
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:...

# OpenAI Realtime & Vision API
OPENAI_API_KEY=sk-proj-...

# Cron Secret for Daily Compliance Log Pruning
CRON_SECRET=super_secret_cron_token_xyz987

# Default Multi-Tenant Identifier (Optional Fallback)
NEXT_PUBLIC_TENANT_ID=default
```

---

## 7. 10-Minute Deployment Verification Checklist

To verify that your multi-tenant deployment is operational on a new website:

- [ ] **Step 1: Test Headless Embed Route**  
  Visit `https://YOUR_DOMAIN/embed/chatbot?tenant=brightstar_hvac`. Verify the AI Front-Desk loads cleanly without headers or footers.
- [ ] **Step 2: Test External Script Tag**  
  Open your external website (e.g. WordPress). Verify the launcher icon appears in the bottom right corner.
- [ ] **Step 3: Test WebRTC Realtime Voice**  
  Click the microphone icon and test: *"I need an emergency furnace repair in 30301."*  
  Confirm voice response is sub-100ms and speech stops when you interrupt (barge-in).
- [ ] **Step 4: Verify Multi-Tenant Scoping in `/lg`**  
  Log into `https://YOUR_DOMAIN/lg`. Open the **Triage Terminal** and confirm the newly captured emergency lead appears instantly with priority `emergency`.
- [ ] **Step 5: Verify Super Admin Client Management**  
  Open the SuperAdmin tab, create a second tenant (e.g., `test_plumbing`), and verify that its leads do not leak into `brightstar_hvac`.
