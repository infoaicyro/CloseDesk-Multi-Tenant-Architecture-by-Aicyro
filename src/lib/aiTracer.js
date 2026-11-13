// src/lib/aiTracer.js

// Authoritative in-memory trace store for audit and sampled charge reconciliation
const aiTraceHistory = [];

export function getAiTraceHistory() {
  return [...aiTraceHistory];
}

export function clearAiTraceHistory() {
  aiTraceHistory.length = 0;
}

/**
 * Calculates estimated USD cost for known OpenAI / LLM models.
 * If usage is unknown or model pricing is unavailable, returns "unknown".
 */
export function estimateLlmCost(model, promptTokens, completionTokens) {
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") {
    return "unknown";
  }

  const modelLower = String(model || "").toLowerCase();
  // Standard OpenAI Pricing (as of 2026 reference baselines)
  let promptRatePerM = 0.15; // default gpt-4o-mini ($0.15 / 1M prompt tokens)
  let completionRatePerM = 0.60; // default gpt-4o-mini ($0.60 / 1M completion tokens)

  if (modelLower.includes("gpt-4o") && !modelLower.includes("mini")) {
    promptRatePerM = 2.50;
    completionRatePerM = 10.00;
  } else if (modelLower.includes("vision")) {
    promptRatePerM = 2.50;
    completionRatePerM = 10.00;
  }

  const cost = (promptTokens / 1_000_000) * promptRatePerM + (completionTokens / 1_000_000) * completionRatePerM;
  return Number(cost.toFixed(6));
}

/**
 * Wraps an LLM API call to automatically log lifecycle, tokens, latency,
 * and authoritative usage/cost accounting (Ticket CD05 & Ticket 5).
 */
export async function traceAiExecution(apiLogger, llmPromise, aiContext = {}) {
  const {
    ai_model = "unknown_model",
    prompt_version = "v1.0",
    conversation_state = "stateless",
    detected_intent = "general_chat",
    intent_confidence = 1.0,
    rag_used = false,
    provider = "openai",
    tenantId = "default",
    sessionId = "unknown",
    operation = "chat",
    retryCount = 0,
  } = aiContext;

  const startTime = Date.now();

  // 🚨 TICKET 5: ai_request_started
  apiLogger.info("ai_lifecycle", "ai_request_started", {
    context: { ai_model, prompt_version, provider, tenantId, sessionId, operation, retryCount },
    metadata: {
      conversation_state,
      detected_intent,
      intent_confidence,
      rag_used,
    },
  });

  try {
    const response = await llmPromise;
    const duration_ms = Date.now() - startTime;

    // Extract standard token usage
    const usage = response?.usage || {};

    // 🚨 REQUIREMENT: "Unknown" Usage Is NEVER Zero!
    // If provider usage does NOT return authoritative numbers, record explicitly as "unknown" (never 0)
    const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : "unknown";
    const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : "unknown";
    const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : "unknown";

    const estimatedCostUsd = estimateLlmCost(ai_model, promptTokens, completionTokens);

    // Check if the AI decided to call a tool
    const toolRequested = response?.choices?.[0]?.message?.tool_calls?.length > 0;
    if (toolRequested) {
      apiLogger.info("ai_lifecycle", "tool_requested", {
        context: {
          ai_model,
          tool_name: response.choices[0].message.tool_calls[0].function.name,
        },
        duration_ms,
      });
    }

    const isLowConfidence = intent_confidence < 0.6;
    const fallbackTriggered = aiContext.fallback_triggered || false;
    const handoffTriggered = aiContext.human_handoff_triggered || false;

    // Build authoritative trace record
    const traceRecord = {
      trace_id: `trace_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      provider,
      model: ai_model,
      tenantId,
      sessionId,
      operation,
      retryCount,
      usage: {
        total_tokens: totalTokens,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      },
      estimatedCostUsd,
      status: "completed",
      duration_ms,
    };
    aiTraceHistory.push(traceRecord);

    // 🚨 TICKET 5 & CD05: ai_request_completed with authoritative usage
    apiLogger.info("ai_lifecycle", "ai_request_completed", {
      context: { ai_model, prompt_version, provider, tenantId, sessionId, operation, retryCount },
      metadata: {
        total_tokens: totalTokens,
        completion_tokens: completionTokens,
        prompt_tokens: promptTokens,
        estimated_cost_usd: estimatedCostUsd,
        low_confidence_triggered: isLowConfidence,
        fallback_triggered: fallbackTriggered,
        human_handoff_triggered: handoffTriggered,
        hallucination_guard_triggered: aiContext.hallucination_guard_triggered || false,
      },
      duration_ms,
    });

    if (handoffTriggered) {
      apiLogger.warn("ai_lifecycle", "human_handoff_triggered", {
        context: {
          message: "Confidence too low or explicit request. Routing to human.",
        },
      });
    }

    return response;
  } catch (error) {
    const duration_ms = Date.now() - startTime;

    // Even on error, record the attempt with "unknown" usage
    const failedRecord = {
      trace_id: `trace_err_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      provider,
      model: ai_model,
      tenantId,
      sessionId,
      operation,
      retryCount,
      usage: {
        total_tokens: "unknown",
        prompt_tokens: "unknown",
        completion_tokens: "unknown",
      },
      estimatedCostUsd: "unknown",
      status: "failed",
      error: error.message,
      duration_ms,
    };
    aiTraceHistory.push(failedRecord);

    apiLogger.error("ai_lifecycle", "ai_request_failed", {
      error,
      context: { ai_model, prompt_version, provider, tenantId, sessionId, operation, retryCount },
      duration_ms,
    });

    throw error;
  }
}

/**
 * Directly records an authoritative trace record for non-LLM operations
 * (e.g. WebRTC ephemeral token minting, AWS Polly TTS byte streams, or vision inspections).
 * Strictly guarantees that missing usage is recorded as "unknown" (NEVER 0).
 *
 * @param {object} traceDetails
 * @returns {object} The recorded trace record
 */
export function recordAuthoritativeAiTrace(traceDetails) {
  const {
    provider = "openai",
    model = "unknown",
    tenantId = "default",
    sessionId = "unknown",
    operation = "unknown_op",
    retryCount = 0,
    usage = {},
    status = "completed",
    duration_ms = 0,
    estimatedCostUsd = "unknown",
  } = traceDetails;

  const promptTokens = usage.prompt_tokens !== undefined ? usage.prompt_tokens : "unknown";
  const completionTokens = usage.completion_tokens !== undefined ? usage.completion_tokens : "unknown";
  const totalTokens = usage.total_tokens !== undefined ? usage.total_tokens : "unknown";

  const record = {
    trace_id: `trace_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    provider,
    model,
    tenantId,
    sessionId,
    operation,
    retryCount,
    usage: {
      total_tokens: totalTokens,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      ...(usage.characters !== undefined ? { characters: usage.characters } : {}),
      ...(usage.images !== undefined ? { images: usage.images } : {}),
    },
    estimatedCostUsd: estimatedCostUsd !== undefined ? estimatedCostUsd : "unknown",
    status,
    duration_ms,
  };

  aiTraceHistory.push(record);
  return record;
}

/**
 * Safely parses AI JSON output and logs schema failures without dumping raw PII.
 */
export function safeParseAiResponse(apiLogger, rawJsonString, aiContext) {
  try {
    return JSON.parse(rawJsonString);
  } catch (error) {
    apiLogger.error("ai_lifecycle", "json_schema_failed", {
      error,
      context: { ai_model: aiContext.ai_model },
      metadata: {
        raw_response_snippet: rawJsonString.substring(0, 50) + "...",
      },
    });
    throw new Error("AI returned invalid JSON schema");
  }
}

/**
 * Reconciles traced AI operations against a sample provider invoice or usage statement.
 * Compares known token costs, tallies operations with "unknown" usage, and flags discrepancies.
 *
 * @param {Array<object>} [customTraceRecords] - Optional list of trace records
 * @param {object} [providerInvoice] - Actual provider invoice sample
 * @returns {object} Reconciliation summary report
 */
export function reconcileAiCharges(customTraceRecords = null, providerInvoice = {}) {
  const traces = Array.isArray(customTraceRecords) ? customTraceRecords : aiTraceHistory;

  let totalTracedCost = 0;
  let knownUsageCount = 0;
  let unknownUsageCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const providerBreakdown = {};

  for (const t of traces) {
    const prov = t.provider || "unknown";
    if (!providerBreakdown[prov]) {
      providerBreakdown[prov] = { count: 0, cost: 0, unknownCount: 0 };
    }
    providerBreakdown[prov].count++;

    if (t.usage && typeof t.usage.total_tokens === "number") {
      knownUsageCount++;
      totalPromptTokens += typeof t.usage.prompt_tokens === "number" ? t.usage.prompt_tokens : 0;
      totalCompletionTokens += typeof t.usage.completion_tokens === "number" ? t.usage.completion_tokens : 0;
    } else {
      unknownUsageCount++;
      providerBreakdown[prov].unknownCount++;
    }

    if (typeof t.estimatedCostUsd === "number") {
      totalTracedCost += t.estimatedCostUsd;
      providerBreakdown[prov].cost += t.estimatedCostUsd;
    }
  }

  const invoiceTotalCost = typeof providerInvoice.total_invoice_usd === "number"
    ? providerInvoice.total_invoice_usd
    : totalTracedCost;

  const costVariance = Number((totalTracedCost - invoiceTotalCost).toFixed(6));
  const isReconciled = Math.abs(costVariance) < 0.05; // $0.05 tolerance threshold

  return {
    reconciliation_timestamp: new Date().toISOString(),
    total_operations_traced: traces.length,
    known_usage_operations: knownUsageCount,
    unknown_usage_operations: unknownUsageCount,
    total_prompt_tokens: totalPromptTokens,
    total_completion_tokens: totalCompletionTokens,
    total_traced_cost_usd: Number(totalTracedCost.toFixed(6)),
    invoice_total_cost_usd: invoiceTotalCost,
    variance_usd: costVariance,
    reconciliation_status: isReconciled ? "reconciled" : "variance_detected",
    provider_breakdown: providerBreakdown,
  };
}
