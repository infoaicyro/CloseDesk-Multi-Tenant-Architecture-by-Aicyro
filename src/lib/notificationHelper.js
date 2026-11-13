// src/lib/notificationHelper.js
import { db } from "./firebase";
import { ref, push, set } from "firebase/database";

// Also log silently to internal UI history
export const logToFirebase = async (title, message, leadData = {}) => {
  try {
    const notificationsRef = ref(db, "notifications");
    await set(push(notificationsRef), {
      title,
      message,
      timestamp: Date.now(),
      unread: true,
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
) => {
  try {
    logToFirebase(title, message, rawLeadData);

    const formattedLeadData = { ...rawLeadData };
    Object.keys(formattedLeadData).forEach((key) => {
      if (
        formattedLeadData[key] === "" ||
        formattedLeadData[key] === undefined
      ) {
        formattedLeadData[key] = null;
      }
    });

    const emailQueueRef = ref(db, "email_alerts");
    await set(push(emailQueueRef), {
      title,
      message,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      lead_data: formattedLeadData,
      visitor_email_config: visitorEmailConfig, // Passes visitor info to backend
      status: "pending",
    });
  } catch (error) {
    console.error("Error queueing email alert:", error);
  }
};
