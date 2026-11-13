# Beginner's Step-by-Step Implementation & Deployment Guide: CloseDesk

> **Document:** Complete Hands-On Integration Guide for Engineers & Operators  
> **Product:** CloseDesk Engine (Aicyro) | **Version:** `v2.1.0`  
> **Architecture Highlights:** Multi-Tenant Architecture, Decoupled Embed Widget, WebRTC Voice, Vision Diagnostics, Server-Side RBAC & Step-Up Auth  
> **Goal:** Deploy the **CloseDesk Multimodal Chatbot Widget** and **Pulse Operations Dashboard** on any new website in less than 30 minutes, without writing backend code.

---

## 1. What You Are Building & How It Works

Before running any code, understand the 3 core pieces of the CloseDesk platform:

```text
+----------------------------------------------------------------------------------------------------+
|                                      THE 3 PIECES OF CLOSEDESK                                     |
|                                                                                                    |
|  1. YOUR CLIENT'S HOST WEBSITE             2. THE CLOSEDESK BACKEND & PULSE        3. CLOUD BACKEND|
|  (WordPress, Webflow, Shopify, or React)    (Hosted on Vercel / Netlify / Node)     (Firebase/OAI) |
|                                                                                                    |
|  +----------------------------------+       +-------------------------------+      +------------+  |
|  |  Client's Existing Website       |       |  api.youragency.com           |      |  OpenAI    |  |
|  |  (e.g. brightstarhvac.com)       |       |                               |----->|  Realtime  |  |
|  |                                  |       |  * /api/openai-token          |      |  GPT-4o    |  |
|  |  [ Floating CloseDesk Widget ]   |------>|  * /api/chat                  |      +------------+  |
|  |   - Voice AI (Talk with mic)     |       |  * /api/analyze-image         |             |        |
|  |   - Text Chat                    |       |  * /api/analytics             |      +------------+  |
|  |   - Equipment damage diagnostics |       |                               |      |  Firebase  |  |
|  |   - Automatic visitor tracking   |       |  * Pulse Dashboard (/lg)      |<---->|  RTDB &    |  |
|  +----------------------------------+       |    (Triage leads & calendar)  |      |  Storage   |  |
|                                             +-------------------------------+      +------------+  |
+----------------------------------------------------------------------------------------------------+
```

1. **The Client's Website (Front-End):** Any website (WordPress, Shopify, Webflow, custom Next.js). It simply loads the floating CloseDesk widget with one line of HTML code (`public/widget.js`).
2. **CloseDesk Backend & Dashboard (`closedesk-engine`):** A Next.js application (Pages Router) deployed to Vercel or Netlify. It manages AI completions, mints ephemeral WebRTC voice tokens, classifies damage images, records visitor analytics, and provides the **Pulse Dashboard** at `/lg` for the contractor.
3. **Cloud Providers:** Free Firebase Realtime Database & Storage (to store leads, transcripts, visitor telemetry, and client settings) and OpenAI (for GPT-4o-mini chat, vision, and Realtime WebRTC voice).

---

## 2. Phase 1: Prerequisites & Account Setup (10 Minutes)

You need two cloud accounts to run the platform:

### 2.1 Step 1: Get an OpenAI API Key
1. Go to [platform.openai.com](https://platform.openai.com) and log in or create an account.
2. Navigate to **API Keys** and click **+ Create new secret key**.
3. Name it `CloseDesk-Production` and copy the secret key (it begins with `sk-proj-...`).
4. Ensure your account has credit loaded for API calls (GPT-4o-mini and Realtime WebRTC).

### 2.2 Step 2: Set Up a Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add Project**.
2. Name your project (e.g. `closedesk-platform`) and continue.
3. Once created, click the **Web icon (`</>`)** on the dashboard to register a web app:
   * App nickname: `CloseDesk Web Engine`
   * Copy the `firebaseConfig` keys for Step 2.3.
4. In the left sidebar, click **Build > Realtime Database**:
   * Click **Create Database**, choose a region (e.g., `United States`), and start with standard rules.
   * Copy the database URL (e.g. `https://your-project-default-rtdb.firebaseio.com/`).
5. In the left sidebar, click **Build > Storage**:
   * Click **Get Started**, select **Start in production mode**, and click **Done**.

### 2.3 Step 3: Create Your `.env.local` File
In your repository root directory, create a file named `.env.local` and paste your credentials:

```ini
# =============================================================================
# CLOSEDESK PRODUCTION ENVIRONMENT VARIABLES
# =============================================================================

# 1. Base App URL (localhost for local testing, production URL on deploy)
NEXT_PUBLIC_APP_URL=http://localhost:3000

# 2. OpenAI Secret Key
OPENAI_API_KEY=sk-proj-YOUR_ACTUAL_OPENAI_KEY_HERE

# 3. Firebase Configuration (From Firebase Console > Project Settings)
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...YOUR_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:abcdef123456

# 4. Privileged Session Signing Secret (32+ random characters)
SESSION_SECRET=super_secret_session_signing_key_at_least_32_bytes_long

# 5. Security Passkey for Maintenance Crons
CRON_SECRET=super_secret_passkey_123456789

# 6. Optional: Google Maps (for Visitor Location Map in /lg)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSy...YOUR_MAPS_KEY
```

---

## 3. Phase 2: Deploying the Backend & Pulse Dashboard (5 Minutes)

Deploy the central engine so that client websites can connect to it.

### Step 1: Deploy to Vercel or Netlify
1. Push this repository to your GitHub account:
   ```bash
   git push origin main
   ```
2. Go to [vercel.com](https://vercel.com) or [netlify.com](https://netlify.com) and click **Add New > Project**.
3. Import your repository.
4. In **Environment Variables**, paste all keys from your `.env.local` file.
5. Click **Deploy**. Within 2 minutes, you will receive your live URL:
   ```text
   https://closedesk-engine.vercel.app
   ```

### Step 2: Verify Your Live Deployment
Open your browser and verify these active routes:
* `https://closedesk-engine.vercel.app/lg`  
  *(Opens the Pulse Dashboard login interface)*
* `https://closedesk-engine.vercel.app/embed/chatbot?tenant=default`  
  *(Opens the standalone embeddable CloseDesk AI chatbot interface)*
* `https://closedesk-engine.vercel.app/logs`  
  *(Opens the operational logging explorer)*
* `https://closedesk-engine.vercel.app/e2e-report`  
  *(Opens the automated E2E test report)*

---

## 4. Phase 3: Provisioning a New Client in Super Admin (2 Minutes)

Before embedding the chatbot on a client's website, register the client tenant in your Pulse control plane:

```text
+----------------------------------------------------------------------------------------------------+
|                               PROVISIONING A CLIENT IN /lg SUPERADMIN                              |
|                                                                                                    |
|   1. Open /lg                  2. Enter SuperAdmin Credentials 3. Step-Up Verification             |
|      Switch to SuperAdmin Form    (Protected by salted scrypt)    (Enter TOTP / Secondary PIN)     |
|                                                                                                    |
|   4. Client Management Tab     5. Fill Tenant Wizard:          6. Modal generates HTML script!     |
|      Click "+ Add New Client"     * Name: "Apex Plumbing"         <script src=".../widget.js"      |
|                                   * Slug: "apex_plumbing"                 data-tenant="..."></script>
|                                   * Admin User: "apex_admin"                                       |
|                                   * Admin Pass: "Apex2026!"                                        |
+----------------------------------------------------------------------------------------------------+
```

### Step-by-Step Client Setup:
1. Navigate to your live dashboard: `https://YOUR_DOMAIN.vercel.app/lg`.
2. Click **Super Admin Login** at the bottom of the card.
3. Authenticate with your SuperAdmin username and password.
4. **Step-Up Verification Modal:**  
   Enter your 6-digit RFC 6238 TOTP code (or your secondary PIN). The server validates the code at `/api/superadmin/verify-pin` and elevates your session with `stepUpVerified: true`.
5. In the **Client Management** view ([`src/Closedesk/Dashboard/superadmin/ClientManagement.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/ClientManagement.jsx)), click **+ Add New Client**.
6. Fill in the client parameters:
   * **Business Name:** `Apex Emergency Plumbing`
   * **Tenant Identifier (Slug):** `apex_plumbing` *(Lowercase alphanumeric, hyphens, and underscores)*
   * **Service Industry:** Select `Plumbing Services` (assigns the `plumbing_v2` rulebook).
   * **Dispatch Email & Emergency Phone:** Enter on-call dispatch contacts.
   * **Timezone:** Select client timezone (e.g. `Eastern (US)`).
   * **Initial Tenant Admin Credentials:**
     * **Admin Username:** `apex_admin`
     * **Admin Password:** `Apex2026!` *(Automatically hashed using salted scrypt on the server)*
7. Click **Create Client Tenant**. The server creates the tenant tree under `/tenants/apex_plumbing/` in Firebase RTDB.
8. **Instant Embed Snippet Modal:** A modal pops up confirming creation with a one-click **"Copy Code"** button.

---

## 5. Phase 4: Embedding the Widget on the Host Website

You can now add the CloseDesk AI Front-Desk to **any website**. Pick your platform below:

> [!TIP]
> **Automatic Visitor Telemetry Included:** The snippet below automatically captures website traffic (`page_view`), visitor hardware specs, and referring domains without requiring external tracking pixels.

### Option 4A: Plain HTML / Static Website
Add this snippet directly before the closing `</body>` tag of your HTML document:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Apex Emergency Plumbing</title>
</head>
<body>
  <h1>Welcome to Apex Plumbing</h1>
  <p>Call us 24/7 for plumbing emergencies.</p>

  <!-- ======================================================== -->
  <!-- CLOSEDESK UNIVERSAL EMBEDDABLE WIDGET                    -->
  <!-- ======================================================== -->
  <script 
    src="https://YOUR_DOMAIN.vercel.app/widget.js" 
    data-tenant="apex_plumbing" 
    defer>
  </script>
</body>
</html>
```

---

### Option 4B: WordPress Website
1. Log in to your WordPress Admin dashboard (`/wp-admin`).
2. Go to **Plugins > Add New** and install **WPCode** (or any header/footer code injector).
3. Activate the plugin and go to **Code Snippets > Header & Footer**.
4. In the **Footer** textarea, paste:
   ```html
   <script 
     src="https://YOUR_DOMAIN.vercel.app/widget.js" 
     data-tenant="apex_plumbing" 
     defer>
   </script>
   ```
5. Click **Save Changes**. Visit your WordPress website—the CloseDesk floating widget appears in the bottom-right corner.

---

### Option 4C: Webflow Website
1. Open your Webflow Designer.
2. Click the **W** icon in the top left and select **Site Settings**.
3. In the left navigation, click **Custom Code**.
4. Scroll to the **Footer Code** block and paste:
   ```html
   <script 
     src="https://YOUR_DOMAIN.vercel.app/widget.js" 
     data-tenant="apex_plumbing" 
     defer>
   </script>
   ```
5. Click **Save Changes** and **Publish to Selected Domains**.

---

### Option 4D: Shopify Store
1. Log in to your Shopify Admin.
2. Go to **Online Store > Themes**.
3. Click the **three dots (`...`)** next to your active theme and select **Edit code**.
4. In the left file explorer, click `layout/theme.liquid`.
5. Scroll to the bottom and find the closing `</body>` tag.
6. Paste the script tag immediately above `</body>`:
   ```liquid
   <!-- CloseDesk AI Multimodal Assistant -->
   <script 
     src="https://YOUR_DOMAIN.vercel.app/widget.js" 
     data-tenant="apex_plumbing" 
     defer>
   </script>
   </body>
   ```
7. Click **Save**.

---

### Option 4E: Modern Next.js or React Website
If you are building a custom Next.js or React application and want to render the front-desk natively as a React component:

1. Copy the component folder [`src/Closedesk/Chatbot/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Chatbot/) into your project.
2. In your `pages/_app.jsx` or layout file, import and mount the component:
   ```jsx
   // pages/_app.jsx or app/layout.jsx
   import "@/styles/globals.css";
   import AicyroChatbot from "@/Closedesk/Chatbot/AicyroChatbot";

   export default function MyApp({ Component, pageProps }) {
     return (
       <>
         <Component {...pageProps} />

         {/* CloseDesk Multimodal AI Front-Desk */}
         <AicyroChatbot tenantId="apex_plumbing" />
       </>
     );
   }
   ```
3. Set your backend URL in your `.env.local`:
   ```bash
   NEXT_PUBLIC_APP_URL=https://YOUR_DOMAIN.vercel.app
   NEXT_PUBLIC_TENANT_ID=apex_plumbing
   ```

---

## 6. Phase 5: Client Login & Using the Pulse Dashboard

Hand off the operational dashboard to the business owner or dispatcher:

```text
+----------------------------------------------------------------------------------------------------+
|                                    CLIENT DISPATCHER DAILY WORKFLOW                                |
|                                                                                                    |
|  1. Dispatcher navigates to: https://YOUR_DOMAIN.vercel.app/lg                                     |
|  2. Logs in on standard operator form:                                                             |
|     * Username: apex_admin                                                                         |
|     * Password: Apex2026!                                                                          |
|                                                                                                    |
|  3. What they see:                                                                                 |
|     ┌────────────────────────┐  ┌────────────────────────┐  ┌─────────────────────────────────┐   |
|     │ Home KPI Cockpit       │  │ Terminal Triage Screen │  │ Conversations Screen            │   |
|     │ Total website visitors │  │ Emergency priority card│  │ Full text & voice call replays  │   |
|     │ Live conversion metrics│  │ One-click phone callback│ │ Customer defect photos uploaded │   |
|     └────────────────────────┘  └────────────────────────┘  └─────────────────────────────────┘   |
+----------------------------------------------------------------------------------------------------+
```

### Seamless Multi-Tenant Login:
* The client goes to `https://YOUR_DOMAIN.vercel.app/lg`.
* They enter their credentials (`apex_admin` / `Apex2026!`).
* The server endpoint `/api/login` verifies the salted scrypt hash, binds their session to tenant `apex_plumbing`, issues an HttpOnly SameSite Strict cookie, and loads their personalized brand appearance and operational data.

### What the Client Can Do in `/lg`:
1. **Home KPI Cockpit ([`HomeScreen.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/HomeScreen.jsx)):**  
   Real-time analytics for their website: Total Website Visitors, Chatbot Opens, Conversations Started, and Closed Pipeline Value.
2. **Live Lead Triage ([`TerminalScreen.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/TerminalScreen.jsx)):**  
   Whenever a customer submits an inquiry or emergency request, it appears instantly with an audible chime and emergency status badge. The dispatcher clicks **Call Customer** to dial them immediately.
3. **Review Conversations & Defect Photos ([`Conversations.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Conversations.jsx)):**  
   Review verbatim text transcripts, conversation timestamps, and defect photos uploaded by homeowners.
4. **Appointments & Bookings ([`Booking.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Booking.jsx)):**  
   View appointments with status filters and manual status override dropdowns (`Confirmed`, `Completed`, `Reschedule`, `Cancel`).
5. **Visitor Hardware & Map ([`CookieDataDisplay.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/CookieDataDisplay.jsx)):**  
   View visitor device types (iOS, Android, Windows, Mac) and geographic cluster maps.
6. **Customize AI Front-Desk ([`Settings/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/)):**  
   * Operating hours and on-call emergency numbers ([`BusinessProfile.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/BusinessProfile.jsx)).
   * AI voice persona (Alloy, Echo, Shimmer, Ash, Coral) ([`Chatbotsetting.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/Chatbotsetting.jsx)).
   * Brand accent colors and dark/light mode ([`apearance.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/apearance.jsx)).
   * Password rotation with automatic scrypt upgrade ([`PasswordChange.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/PasswordChange.jsx)).

---

## 7. Phase 6: End-to-End Flight Check (Verification Test)

Follow these 5 steps to verify that your new deployment works end-to-end:

| Step | Action | Expected Result |
| :--- | :--- | :--- |
| **Test 1: Website Visit Tracking** | Open the client's host website in an incognito window. | The widget bubble appears in the bottom right corner. In `/lg`, **Total Website Visitors** increments by +1. |
| **Test 2: Chatbot Open Tracking** | Click the launcher icon to expand the chatbot. | In `/lg` Home Screen, **Chatbot Opens** increments by +1. |
| **Test 3: Realtime Voice Call** | Click the **Microphone** icon, accept permission, and say: *"I have an emergency water leak under my sink."* | In `/lg`, **Conversations Started** increments by +1. The assistant speaks back within 1 second: *"Please shut off the main water valve immediately. What is your phone number?"* |
| **Test 4: Lead Qualification** | Speak or type a test phone number: *"555-019-2834"*. | The bot confirms the callback request and closes the qualification loop. |
| **Test 5: Live Dispatch Alert** | In `/lg`, switch to the **Terminal Screen**. | An emergency audio chime sounds, and the lead appears with priority `EMERGENCY` and phone `555-019-2834`. |

---

## 8. Troubleshooting Common Beginner Pitfalls

### Issue 1: "Microphone Not Allowed" or Voice Won't Connect
* **Cause:** WebRTC audio requires a secure HTTPS context.
* **Fix:** Ensure both your host website and your central backend run on `https://`, not `http://`. Browsers block microphone access over unencrypted HTTP.

### Issue 2: Widget Disappears on Mobile
* **Cause:** The host website has a higher `z-index` banner or sticky footer.
* **Fix:** The CloseDesk widget container has `z-index: 2147483647` (maximum 32-bit integer). Verify that your host website does not have `overflow: hidden` on the `<body>` element.

### Issue 3: 403 Forbidden on SuperAdmin Actions
* **Cause:** Destructive operations (creating clients, changing email protocols) require secondary factor Step-Up verification.
* **Fix:** Complete Step-Up verification using your RFC 6238 TOTP authenticator app or emergency recovery code.

### Issue 4: "Voice Features Disabled by Administrator"
* **Cause:** The master killswitch is toggled off in settings.
* **Fix:** In `/lg` **Chatbot Settings**, toggle **Enable Voice Mode** to ON, or set `tenants/{tenant_id}/chatbot_config/voiceEnabled` to `true` in Firebase RTDB.
