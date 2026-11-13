// src/lib/notificationHelper.js
import { db } from "./firebase";
import { ref, push, set } from "firebase/database";
import { enqueueNotificationJob } from "./handoffManager";
import { sanitizeTenantId, resolveTenantId } from "./tenantResolver";

// Also log silently to internal UI history
export const logToFirebase = async (title, message, leadData = {}, explicitTenantId = null) => {
  try {
    const tenantId = sanitizeTenantId(explicitTenantId || leadData?.tenant_id || leadData?.tenantId || "default");
    const notificationsPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/notifications` : "notifications";
    const notificationsRef = ref(db, notificationsPath);

    await set(push(notificationsRef), {
      title,
      message,
      timestamp: Date.now(),
      unread: true,
      tenant_id: tenantId,
      lead_data: leadData,
    });
  } catch (error) {
    console.error("Firebase logging error:", error);
  }
};

export const queueEmailAlert = async (
  title,
  message,
  rawLeadData = {},
  eventType = "end",
  visitorEmailConfig = null,
  explicitTenantId = null,
) => {
  try {
    const tenantId = sanitizeTenantId(explicitTenantId || rawLeadData?.tenant_id || rawLeadData?.tenantId || "default");
    const rawLeadId = rawLeadData?.lead_id || rawLeadData?.firebaseId || rawLeadData?.id || `lead_${Date.now()}`;

    // 1. Log to tenant UI history
    await logToFirebase(title, message, rawLeadData, tenantId);

    // 2. Format lead data
    const formattedLeadData = { ...rawLeadData, tenant_id: tenantId };
    Object.keys(formattedLeadData).forEach((key) => {
      if (
        formattedLeadData[key] === "" ||
        formattedLeadData[key] === undefined
      ) {
        formattedLeadData[key] = null;
      }
    });

    // 3. 🚨 CD07: Create durable tenant-isolated notification handoff job
    const handoffResult = await enqueueNotificationJob({
      tenantId,
      leadId: rawLeadId,
      title,
      message,
      leadData: formattedLeadData,
      eventType,
      visitorEmailConfig,
      dbInstance: db,
    });

    // 4. Forward to Cloud Function email_alerts queue with durable link
    const emailQueueRef = ref(db, "email_alerts");
    await set(push(emailQueueRef), {
      job_id: handoffResult.jobId,
      tenant_id: tenantId,
      lead_id: String(rawLeadId),
      title,
      message,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      lead_data: formattedLeadData,
      visitor_email_config: visitorEmailConfig,
      status: handoffResult.job.delivery_status === "failed" ? "failed_config" : "pending",
      failure_reason: handoffResult.job.failure_reason || null,
      assigned_recipient: handoffResult.job.assigned_recipient || null,
    });

    return handoffResult;
  } catch (error) {
    console.error("Error queueing email alert:", error);
    return { error: error.message };
  }
};
