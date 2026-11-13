// src/pages/api/insights.js
import OpenAI from "openai";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { ref, get, set } from "firebase/database";
import { resolveTenantId, resolveAuthenticatedTenantId } from "../../lib/tenantResolver";
import { safeDbGet, safeDbSet } from "../../lib/safeDb";

async function handler(req, res, apiLogger) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
  const authResult = await resolveAuthenticatedTenantId(req);
  if (!authResult.allowed) {
    apiLogger.warn("security", "unauthorized_insights_access_blocked", {
      context: { error: authResult.error, status: authResult.status }
    });
    return res.status(authResult.status || 401).json({ error: authResult.error });
  }

  // 1. Resolve Tenant Context strictly from verified session
  const tenantId = authResult.tenantId;
  const isTenant = tenantId && tenantId !== "default";

  // 🚨 SECURITY GATE: Verify tenant existence to prevent cross-tenant traversal or unauthorized access
  if (isTenant) {
    try {
      const tenantSnap = await safeDbGet(ref(db, `tenants/${tenantId}`), 600);
      if (tenantSnap && !tenantSnap.exists()) {
        apiLogger.warn("security", "unauthorized_fake_tenant_access", {
          context: {
            tenantId,
            ip: req.headers["x-forwarded-for"] || req.socket?.remoteAddress,
          },
        });
        return res
          .status(404)
          .json({ error: `Tenant '${tenantId}' not found or unauthorized.` });
      }
    } catch (dbErr) {
      // offline fallback
    }
  }

  const insightsPath = isTenant ? `tenants/${tenantId}/insights` : "insights";

  // ──────────────────────────────────────────────────────────────────────────
  // GET REQUEST: Fetch existing insights or placeholder
  // ──────────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      let snap = null;
      try {
        snap = await safeDbGet(ref(db, insightsPath), 600);
      } catch (e) {
        // offline fallback
      }
      if (snap && snap.exists()) {
        return res.status(200).json(snap.val());
      }
      return res.status(200).json({
        status: "ok",
        tenantId,
        detailed_bullets: [
          "No insights generated yet for this tenant. Click 'Get Insights' to generate.",
        ],
        kpis: {
          total_conversations: "0 Total Chats",
          conversion_rate: "0% Booked",
          top_service: "N/A",
          after_hours_stat: "0 leads",
          top_dropoff: "None",
          pricing_inquiries_stat: "0 asked",
          urgent_requests_stat: "0 High Urgency",
          top_objection: "None",
        },
        charts: {
          service_demand: [],
          visitor_intent: [],
          time_distribution: [],
        },
      });
    } catch (err) {
      apiLogger.error("Error fetching insights:", err);
      return res.status(500).json({ error: "Failed to fetch insights." });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST REQUEST: Generate AI insights strictly scoped to tenant leads
  // ──────────────────────────────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "OpenAI API key is missing from .env" });
  }

  try {
    const leadsPath = isTenant ? `tenants/${tenantId}/leads` : "leads";
    const snapshot = await get(ref(db, leadsPath));

    let conversationData = "";

    if (snapshot.exists()) {
      const leads = snapshot.val();
      // Extract the last 50 leads to prevent token overflow
      const entries = Object.values(leads).slice(-50);

      conversationData = entries
        .map(
          (lead) => `
        ---
        Date: ${lead.timestamp || "Unknown"}
        Service Requested: ${lead.service_requested || "Unknown"}
        Urgency: ${lead.urgency_level || "Unknown"}
        Intent: ${lead.visitor_intent || "Unknown"}
        After Hours: ${lead.after_hours_flag ? "Yes" : "No"}
        Booking Status: ${lead.booking_status || "Unknown"}
        Transcript: ${lead.full_conversation_transcript || "None"}
      `,
        )
        .join("\n");
    } else {
      return res
        .status(200)
        .json({ detailed_bullets: ["No conversation data found yet for this tenant."] });
    }

    const openai = new OpenAI({ apiKey });

    const systemPrompt = `
      You are a Business Intelligence analyst. Review the provided chatbot conversation transcripts and extract key KPIs and chart data.
      Return the data STRICTLY as a JSON object matching this exact structure:

      {
        "kpis": {
          "total_conversations": "string (e.g., '50 Total Chats')",
          "conversion_rate": "string (e.g., '24% Booked')",
          "top_service": "string (e.g., 'AC Repair')",
          "after_hours_stat": "string (e.g., '9 leads')",
          "top_dropoff": "string (e.g., 'Phone Number req')",
          "pricing_inquiries_stat": "string (e.g., '18 asked')",
          "urgent_requests_stat": "string (e.g., '12 High Urgency')",
          "top_objection": "string (e.g., 'Too expensive')"
        },
        "charts": {
          "service_demand": [
            {"name": "string (Service Name)", "value": "number (Count)"}
          ],
          "visitor_intent": [
            {"name": "string (e.g., Booking, Support, Pricing)", "value": "number"}
          ],
          "time_distribution": [
            {"time": "string (e.g., Morning, Afternoon, Evening, Night)", "leads": "number"}
          ]
        },
        "detailed_bullets": [
          "An array of 4 to 6 string sentences detailing deeper insights like location patterns, availability questions, and general trends."
        ]
      }

      Analyze the provided data deeply to generate these exact counts and trends. If data is sparse, make logical estimates based on the available text.
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Here is the conversation data:\n${conversationData}`,
        },
      ],
      temperature: 0.2,
    });

    const aiInsights = JSON.parse(completion.choices[0].message.content);

    // Save insights under tenant-scoped path for caching
    try {
      await set(ref(db, insightsPath), aiInsights);
    } catch (saveErr) {
      apiLogger.warn("Failed to cache insights to database:", saveErr);
    }

    return res.status(200).json(aiInsights);
  } catch (error) {
    apiLogger.error("Error generating insights:", error);
    return res.status(500).json({ error: "Failed to process insights." });
  }
}

export default withApiLogger(handler, "Insights-API");
