// src/pages/api/cron/retention-cleanup.js
import { db } from "../../../lib/firebase";
import { ref, get, update } from "firebase/database";
import { createPulseLogger } from "../../../lib/loggerPresets";

const cronLogger = createPulseLogger("RetentionCleanupJob");

function determineLogCategory(log) {
  const svc = (log.service || "").toUpperCase();
  const lvl = (log.level || "").toUpperCase();
  const evt = (log.event_type || "").toLowerCase();

  if (evt.includes("audit") || evt.includes("security") || log.action_by) return "SECURITY_AUDIT";
  if (lvl === "ERROR" || lvl === "CRITICAL") return "ERROR";
  if (svc === "AI" || svc === "VOICE" || evt.includes("ai_") || evt.includes("tool_")) return "AI";
  if (lvl === "DEBUG") return "DEBUG";
  return "APPLICATION";
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    cronLogger.warn("security_audit", "unauthorized_cron_attempt", {
      context: { message: "Failed authorization on retention cleanup." }
    });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const txId = `cron_${Date.now()}`;
  cronLogger.info("system_event", "retention_cleanup_started", { correlation: { correlation_id: txId } });

  try {
    const configSnap = await get(ref(db, "settings/log_retention"));
    
    if (!configSnap.exists() || !configSnap.val().is_approved) {
      cronLogger.warn("system_event", "retention_aborted_unapproved", {
        correlation: { correlation_id: txId },
        context: { message: "Retention policy is missing or not explicitly approved by PO. Aborting." }
      });
      return res.status(200).json({ status: "aborted", reason: "Policy not approved." });
    }

    const policy = configSnap.val();
    const logsRef = ref(db, "system_logs");
    const logsSnap = await get(logsRef);
    
    if (!logsSnap.exists()) return res.status(200).json({ status: "success", deleted_count: 0, message: "No logs to process." });

    const logsData = logsSnap.val();
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    
    let deleteCount = 0;
    let updates = {};
    let deletionStats = { DEBUG: 0, APPLICATION: 0, ERROR: 0, AI: 0, SECURITY_AUDIT: 0 };

    for (const [logId, logEntry] of Object.entries(logsData)) {
      if (!logEntry.timestamp) continue;
      const logAgeDays = (now - new Date(logEntry.timestamp).getTime()) / ONE_DAY_MS;
      const category = determineLogCategory(logEntry);
      const maxAge = policy[category];
      
      if (maxAge !== undefined && logAgeDays > maxAge) {
        updates[logId] = null; 
        deleteCount++;
        deletionStats[category]++;
      }
    }

    if (deleteCount > 0) await update(logsRef, updates);

    cronLogger.info("system_event", "retention_cleanup_completed", {
      correlation: { correlation_id: txId },
      metadata: { deleted_count: deleteCount, stats: deletionStats }
    });

    return res.status(200).json({ status: "success", deleted_count: deleteCount, stats: deletionStats });

  } catch (error) {
    cronLogger.error("system_event", "retention_cleanup_failed", { correlation: { correlation_id: txId }, error });
    return res.status(500).json({ error: "Internal processing error." });
  }
}