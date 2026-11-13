// functions/index.js
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Initialize Firebase Admin if not already done
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.database();

/**
 * 🔥 DYNAMIC TRANSPORTER GENERATOR
 * Fetches SMTP credentials from the Realtime Database configured in the Dashboard UI.
 * Supports Microsoft OAuth2, Google OAuth2, Custom SMTP, and App Passwords.
 */
async function getDynamicTransporter(tenantId = "default") {
  const cleanTenantId = tenantId ? String(tenantId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "") : "default";

  let config = null;
  let usedFallback = false;

  // 1. Strict Multi-Tenant SMTP Routing & Global Fallback Authorization
  if (cleanTenantId && cleanTenantId !== "default") {
    const tenantSnap = await db.ref(`tenants/${cleanTenantId}`).once("value");
    if (tenantSnap.exists()) {
      const tenantVal = tenantSnap.val() || {};
      const tenantEmailConfig = tenantVal.email_config || tenantVal.config?.email_config;

      // Custom Tenant SMTP configuration
      if (tenantEmailConfig && (tenantEmailConfig.smtpHost || tenantEmailConfig.refreshToken || tenantEmailConfig.smtpPassword)) {
        config = tenantEmailConfig;
      } else {
        // Fallback check: Tenant must explicitly have allowGlobalSenderFallback: true
        const allowFallback = tenantVal.allowGlobalSenderFallback === true || tenantVal.config?.allowGlobalSenderFallback === true;
        if (!allowFallback) {
          const err = new Error(`UnauthorizedGlobalSenderFallback: Tenant '${cleanTenantId}' lacks custom SMTP and is not authorized to use platform global SMTP fallback (allowGlobalSenderFallback: false).`);
          err.code = "GLOBAL_FALLBACK_UNAUTHORIZED";
          throw err;
        }
        usedFallback = true;
      }
    } else {
      const err = new Error(`UnauthorizedGlobalSenderFallback: Tenant '${cleanTenantId}' not found and cannot use platform sender.`);
      err.code = "TENANT_NOT_FOUND";
      throw err;
    }
  }

  // 2. Load platform global email config when authorized or default
  if (!config) {
    const snap = await db.ref("settings/email_config").once("value");
    config = snap.val() || {};
  }
  
  // 3. Check for revoked or disconnected OAuth status
  if (config.status === "revoked" || config.status === "disconnected") {
    const err = new Error(`OAuthCredentialsRevoked: The connected ${config.provider || "OAuth"} credentials have been revoked or disconnected. Reconnection required.`);
    err.code = "OAUTH_CREDENTIALS_REVOKED";
    throw err;
  }

  const userEmail = config.smtpEmail || process.env.GMAIL_EMAIL;
  const userPass = config.smtpPassword || process.env.GMAIL_PASSWORD;
  const senderName = config.senderName || "CloseDesk";
  const provider = config.provider || "gmail";

  let transportConfig;

  if (provider === "microsoft" && config.refreshToken) {
    transportConfig = {
      host: "smtp-mail.outlook.com",
      port: 587,
      secure: false,
      auth: {
        type: "OAuth2",
        user: userEmail,
        clientId: config.clientId || process.env.MICROSOFT_CLIENT_ID,
        clientSecret: config.clientSecret || process.env.MICROSOFT_CLIENT_SECRET,
        refreshToken: config.refreshToken,
        accessUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token", 
      },
    };
  } else if (provider === "google_oauth" || (provider !== "microsoft" && config.refreshToken)) {
    transportConfig = {
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: userEmail,
        clientId: config.clientId || process.env.GOOGLE_CLIENT_ID,
        clientSecret: config.clientSecret || process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: config.refreshToken,
      },
    };
  } else if (provider === "custom" && config.smtpHost) {
    const port = parseInt(config.smtpPort) || 465;
    transportConfig = {
      host: config.smtpHost,
      port: port,
      secure: port === 465,
      auth: {
        user: userEmail,
        pass: userPass,
      },
    };
  } else {
    transportConfig = {
      service: "gmail",
      auth: {
        user: userEmail,
        pass: userPass,
      },
    };
  }

  const transporter = nodemailer.createTransport(transportConfig);

  return { transporter, userEmail, senderName, usedFallback };
}

exports.getDynamicTransporter = getDynamicTransporter;

const COMPANY_LOGO_SVG = `<?xml version="1.0" encoding="utf-8"?>
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
     viewBox="0 0 1920 537.19" style="height: 48px; width: auto; display: block; margin: 0 auto; enable-background:new 0 0 1920 537.19;" xml:space="preserve">
<g>
    <path fill="#0B1E48" d="M333.16,38.06c-29.28,51.04-58.51,102.11-87.85,153.11c-22.81,39.67-45.75,79.26-69.56,120.48
        c-3.43-6.81-6.27-12.54-9.19-18.23C127.07,216.23,87.7,138.99,47.88,61.97c-4.15-8.03-2.61-15.9-3.26-23.91
        C140.81,38.06,236.98,38.06,333.16,38.06z"/>
    <path fill="#7463D9" d="M435.42,509.5c10.11-23.4,22.67-45.58,34.21-68.26c33.31-65.5,66.89-130.88,100.38-196.29
        c0.93-1.82,2.06-3.53,3.63-6.18c15,25.95,29.58,51.14,44.13,76.36c36.59,63.42,73.16,126.85,109.73,190.29
        c0.75,1.3,1.29,2.72,1.93,4.08C631.43,509.5,533.43,509.5,435.42,509.5z"/>
    <path fill="#0B1E48" d="M174.28,509.5c7.98-18.32,19.08-34.91,28.99-52.15c55.57-96.74,111.34-193.37,167.08-290.02
        c24.08-41.76,48.25-83.46,72.36-125.2c0.74-1.28,1.23-2.71,1.84-4.07c2.43,0,4.87,0,7.3,0c6.79,16.8,17.58,31.4,25.92,47.35
        c2.51,4.79,5.01,9.58,7.52,14.37c-1.02,1.05-2.33,1.95-3.03,3.18c-14.22,24.78-28.37,49.6-42.54,74.41
        c-47.93,83.96-95.9,167.89-143.75,251.89c-15.18,26.64-30.01,53.49-44.99,80.24C225.42,509.5,199.85,509.5,174.28,509.5z"/>
    <path fill="#7463D9" d="M250.98,509.5c14.99-26.75,29.82-53.59,44.99-80.24c47.85-84,95.82-167.93,143.75-251.89
        c14.16-24.81,28.32-49.63,42.54-74.41c0.71-1.23,2.01-2.12,3.03-3.18c11.74,16.25,20.27,34.43,30.85,51.38
        c2.58,4.14-1,6.96-2.6,9.81c-31.19,55.57-62.59,111.03-93.88,166.55c-32.78,58.17-65.51,116.37-98.24,174.56
        c-1.31,2.32-3.45,4.35-2.88,7.42C296.03,509.5,273.51,509.5,250.98,509.5z"/>
    <path fill="#7463D9" d="M1770.34,399.99c-71.45,0.8-126.5-57.63-126.06-125.94c0.43-66.54,52.47-125.43,125.99-125.58
        c72.89-0.15,126.13,58.09,125.91,126.45C1895.94,345.38,1841.21,400.01,1770.34,399.99z M1695,274.17
        c-0.69,39.43,23.11,69.38,53.97,77.84c32.96,9.03,65.4-2.19,83.47-30.86c15.32-24.31,17.02-50.26,7.67-77.61
        c-18.61-54.45-78.49-58.75-110.55-37.83C1704.99,221.75,1695.83,245.98,1695,274.17z"/>
    <path fill="#7463D9" d="M1467.02,274.35c0-37.14,0.19-74.29-0.16-111.43c-0.07-7.55,2-9.95,9.72-9.64c30.07,1.2,60.25-1.84,90.24,1.91
        c21.93,2.75,41.4,11.1,54.09,30.04c21.27,31.76,16.95,92.97-35.01,108.57c-10.84,3.25-10.8,3.52-4.63,12.58
        c18.65,27.37,37.33,54.72,55.98,82.08c1.29,1.9,4.08,3.49,2.3,6.24c-1.36,2.12-3.92,1.04-5.94,1.05c-14,0.07-27.99-0.13-41.99,0.13
        c-4.5,0.08-7.57-1.46-9.93-5.07c-18.29-27.96-38.6-54.6-54.83-83.9c-1.71-3.1-3.68-6.14-7.62-5.05c-3.8,1.05-3.04,4.8-3.04,7.75
        c-0.03,25.57-0.2,51.15,0.11,76.72c0.08,6.97-1.84,9.97-9.28,9.59c-10.62-0.53-21.31-0.57-31.93,0.01c-6.7,0.36-8.23-2.18-8.2-8.34
        C1467.13,349.86,1467.02,312.11,1467.02,274.35z M1516.22,227.33c0,7.9,0.16,15.8-0.05,23.69c-0.16,6.06,2.26,8.32,8.31,7.13
        c2.94-0.58,6.04-0.41,9.07-0.39c11.56,0.07,23.09,0.21,33.91-4.92c10.31-4.89,16.6-15.04,16.19-26.35
        c-0.41-11.57-7.15-20.38-17.95-24.99c-14.61-6.24-29.87-3.78-44.92-4.22c-4.23-0.12-4.58,3.12-4.58,6.36
        C1516.21,211.53,1516.2,219.43,1516.22,227.33z"/>
    <path fill="#0B1E48" d="M921.89,395.5c-19.61,5.18-30.29-2.91-33.48-22.39c-0.28-1.72-1.65-3.24-2.2-4.95
        c-6.94-21.61-1.82-18.24-25.07-18.39c-24.33-0.16-48.66,0.1-72.99-0.16c-5.77-0.06-9.35,0.79-11.21,7.27
        c-3.09,10.74-7.66,21.04-11.12,31.68c-1.54,4.74-3.77,7.14-8.98,7.04c-13.07-0.23-26.16-0.25-39.23-0.05c-5.68,0.09-7-1.57-4.75-7
        c14.5-34.95,28.85-69.96,43.12-105c11.41-28.01,22.61-56.11,33.97-84.15c5.34-13.2,10.86-26.33,16.22-39.52
        c1.96-4.82,5.03-6.74,10.51-6.39c8.78,0.56,17.66,0.62,26.44-0.01c6.46-0.46,9.05,2.41,11.24,7.9
        c15.86,39.66,31.91,79.23,48.03,118.79c14.5,35.6,29.08,71.16,43.8,106.68c2.76,6.66,1.8,9.49-6.07,8.76
        C934.09,395.05,927.97,395.5,921.89,395.5z M830.92,219.15c-3.46,2.32-3.88,5.79-4.99,8.82c-3.13,8.51-5.76,17.17-9.33,25.57
        c-6.75,15.87-12.39,32.21-18.78,48.24c-2.13,5.34-0.13,6.34,4.69,6.31c18.23-0.11,36.47-0.14,54.7,0.04
        c5.38,0.05,6.46-2.16,4.66-6.72C851.17,274.23,839.22,247.53,830.92,219.15z"/>
    <path fill="#7463D9" d="M1160.68,400.02c-48.39-0.91-86.52-21.09-110.63-63.43c-38.45-67.53-6.87-159.23,70.12-181.7
        c40.33-11.77,79.34-9.65,114.1,17.39c16.72,13.01,16.6,14.59,0.09,27.61c-6.18,4.87-11.39,12.5-18.3,14.48
        c-7.3,2.09-11.89-7.72-18.55-11.1c-43.61-22.12-99.87-3.01-110.71,52.44c-5.95,30.45,0.54,56.78,22.05,78.85
        c26.51,27.19,78.15,26.32,102.08,1.55c4.15-4.3,7.14-4.13,11.41-0.29c8.13,7.31,16.55,14.32,25.1,21.14
        c4.3,3.43,3.66,6.06,0.16,9.56c-12.91,12.94-28.03,22.39-45.46,27.56C1188.73,398.06,1175.01,401.16,1160.68,400.02z"/>
    <path fill="#7463D9" d="M1326.33,345.31c0-6.7-0.76-13.5,0.15-20.07c2.79-20.22-4.78-37.11-14.7-53.98
        c-21.4-36.38-41.94-73.27-62.91-109.91c-3.04-5.31-3.32-8.24,4.32-8.02c12.46,0.36,24.95,0.33,37.41,0.01
        c5.6-0.15,9.21,1.87,11.71,6.75c14.98,29.18,32.28,57.11,46.25,86.83c0.96,2.05,1.01,5.39,4.23,5.2c3.26-0.2,2.48-3.63,3.51-5.64
        c12.57-24.61,26.4-48.66,37.38-73.96c6.98-16.06,16.63-21.76,33.21-19.24c7.14,1.08,14.58,0.34,21.87,0.12
        c6.12-0.18,8.74,0.71,4.86,7.53c-24.18,42.5-48.03,85.19-72.08,127.76c-3.5,6.2-5.66,12.47-5.58,19.8
        c0.28,25.87-0.13,51.75,0.26,77.61c0.12,7.65-2.38,10.25-9.96,9.84c-10.01-0.54-20.11-0.68-30.1,0.04
        c-8.45,0.62-10.33-2.74-10-10.49C1326.74,372.11,1326.32,358.7,1326.33,345.31z"/>
    <path fill="#0B1E48" d="M1009.21,274.68c0,37.15-0.17,74.29,0.15,111.44c0.06,7.09-1.72,9.88-9.16,9.5
        c-10.93-0.55-21.91-0.35-32.85-0.04c-5.57,0.16-7.36-1.85-7.35-7.42c0.13-75.81,0.11-151.63-0.01-227.44
        c-0.01-5,1.41-7.24,6.69-7.14c11.56,0.22,23.13,0.34,34.68-0.06c6.76-0.23,8,2.74,7.97,8.81
        C1009.09,199.78,1009.21,237.23,1009.21,274.68z"/>
</g>
</svg>`;


// ============================================================================
// 1. MAIN ALERT & QUEUE FUNCTION (Runs when a lead is captured)
// ============================================================================
exports.sendEmailAlert = functions.database
  .ref("/email_alerts/{alertId}")
  .onCreate(async (snapshot, context) => {
    const data = snapshot.val();

    if (data.status !== "pending") return null;

    let receiverEmail = process.env.GMAIL_EMAIL;
    let settings = { urgentAlerts: true, afterHoursAlerts: true };

    try {
      const settingsSnap = await db.ref("users/root/notifications").once("value");
      if (settingsSnap.exists()) {
        const dbSettings = settingsSnap.val();
        receiverEmail = dbSettings.adminEmail || dbSettings.leadReceivers || receiverEmail;
        if (dbSettings.urgentAlerts !== undefined)
          settings.urgentAlerts = dbSettings.urgentAlerts;
        if (dbSettings.afterHoursAlerts !== undefined)
          settings.afterHoursAlerts = dbSettings.afterHoursAlerts;
      }
    } catch (err) {
      console.error("Failed to fetch notification settings:", err);
    }

    const lead = data.lead_data || {};
    const eventType = data.event_type || "end";
    const title = data.title || "New Lead Alert";
    const isUrgent =
      lead.urgency_level === "High" ||
      title.includes("URGENT") ||
      title.includes("Callback");
    const isAfterHours = lead.after_hours_flag === true;

    if (isUrgent && settings.urgentAlerts === false) {
      return snapshot.ref.update({
        status: "blocked_by_settings",
        reason: "urgentAlerts=false",
      });
    }
    if (isAfterHours && settings.afterHoursAlerts === false) {
      return snapshot.ref.update({
        status: "blocked_by_settings",
        reason: "afterHoursAlerts=false",
      });
    }

    let htmlContent = "";

    // INTERNAL ADMIN ALERT HTML BUILDER
    if (eventType === "start") {
      htmlContent = `
        <div style="background-color: #f4f4f5; padding: 40px 20px; font-family: 'Helvetica Neue', Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e2e5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(11,2,25,0.05);">
            <div style="text-align: center; padding: 20px; border-bottom: 3px solid #8a2be2;">
              ${COMPANY_LOGO_SVG}
            </div>
            <div style="padding: 30px; text-align: center;">
              <h2 style="color: #0b0219; margin: 0 0 10px; font-size: 22px;">New Chat Started</h2>
              <p style="font-size: 15px; color: #4a4a6a; margin: 0;">A visitor has just initiated a conversation on your website.</p>
            </div>
            <div style="background-color: #eaebf0; padding: 20px; text-align: center; border-top: 1px solid #e2e2e5;">
              <p style="font-size: 14px; color: #4a4a6a; margin: 0;"><strong>Details:</strong> ${data.message}</p>
            </div>
          </div>
        </div>
      `;
    } else {
      const urgencyHtml =
        lead.urgency_level === "High"
          ? `<div style="background-color: #fee2e2; padding: 12px; text-align: center; border-bottom: 1px solid #f87171;"><strong style="color: #dc2626; font-size: 14px; letter-spacing: 0.5px; text-transform: uppercase;">🚨 High Urgency Lead 🚨</strong></div>`
          : "";

      htmlContent = `
        <div style="background-color: #f4f4f5; padding: 40px 20px; font-family: 'Helvetica Neue', Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e2e5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(11,2,25,0.05);">
            <div style="text-align: center; padding: 20px; border-bottom: 3px solid #8a2be2;">
              ${COMPANY_LOGO_SVG}
            </div>
            ${urgencyHtml}
            <div style="padding: 30px;">
              <h2 style="color: #0b0219; margin: 0 0 15px; font-size: 22px; text-align: center;">CloseDesk Lead Alert</h2>
              <p style="font-size: 15px; color: #4a4a6a; text-align: center; margin-bottom: 25px;"><strong>Action Required:</strong> ${data.message}</p>
              
              <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 15px; color: #4a4a6a;">
                <tr><td style="padding: 12px; border-bottom: 1px solid #eaebf0; width: 35%; color: #0b0219;"><strong>Name:</strong></td><td style="padding: 12px; border-bottom: 1px solid #eaebf0;">${lead.name || "N/A"}</td></tr>
                <tr><td style="padding: 12px; border-bottom: 1px solid #eaebf0; color: #0b0219;"><strong>Phone:</strong></td><td style="padding: 12px; border-bottom: 1px solid #eaebf0;">${lead.phone || "N/A"}</td></tr>
                <tr><td style="padding: 12px; border-bottom: 1px solid #eaebf0; color: #0b0219;"><strong>Email:</strong></td><td style="padding: 12px; border-bottom: 1px solid #eaebf0;">${lead.email || "N/A"}</td></tr>
                <tr><td style="padding: 12px; border-bottom: 1px solid #eaebf0; color: #0b0219;"><strong>Preferred Time:</strong></td><td style="padding: 12px; border-bottom: 1px solid #eaebf0;">${lead.preferred_time || ""} ${lead.preferred_date || ""}</td></tr>
              </table>
              
              <div style="background-color: #eaebf0; padding: 20px; border-radius: 8px; margin-top: 25px;">
                <h4 style="margin-top: 0; color: #0b0219; font-size: 15px;">AI Conversation Summary:</h4>
                <p style="margin-bottom: 0; color: #4a4a6a; font-style: italic; line-height: 1.6;">"${lead.conversation_summary || "No summary available."}"</p>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    try {
      const targetTenant = data.tenant_id || (data.lead_data && (data.lead_data.tenant_id || data.lead_data.tenantId)) || "default";
      const { transporter, userEmail, senderName } = await getDynamicTransporter(targetTenant);

      await transporter.sendMail({
        from: `"${senderName}" <${userEmail}>`,
        to: receiverEmail,
        subject: String(title || "New Lead Notification").replace(/[\r\n]+/g, " ").trim(),
        html: htmlContent,
      });

      if (data.visitor_email_config && data.visitor_email_config.visitorEmail) {
        const vConf = data.visitor_email_config;
        const finalSubject = String(vConf.subject || "Your Demo is Confirmed!").replace(/[\r\n]+/g, " ").trim();
        const finalBody =
          vConf.body ||
          `Hi ${vConf.name || "there"},\n\nYour meeting is confirmed. We look forward to speaking with you!\n\nBest,\nThe Team`;
        const formattedBody = finalBody.replace(/\n/g, "<br>");

        const visitorHtml = `
          <div style="background-color: #f4f4f5; padding: 40px 20px; font-family: 'Helvetica Neue', Arial, sans-serif;">
            <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e2e5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(11,2,25,0.05);">
              <div style="text-align: center; padding: 30px 20px 20px; border-bottom: 3px solid #8a2be2;">
                ${COMPANY_LOGO_SVG}
              </div>
              <div style="padding: 30px 30px 10px; text-align: center;">
                <h2 style="color: #0b0219; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">${finalSubject}</h2>
              </div>
              <div style="padding: 10px 30px 40px; line-height: 1.7; font-size: 15px; color: #4a4a6a;">
                ${formattedBody}
              </div>
              <div style="background-color: #eaebf0; padding: 20px; text-align: center; border-top: 1px solid #e2e2e5;">
                <p style="margin: 0; font-size: 13px; color: #4a4a6a;">You can reply directly to this email to reach us.</p>
              </div>
            </div>
          </div>
        `;

        await transporter.sendMail({
          from: `"${senderName}" <${userEmail}>`,
          to: vConf.visitorEmail,
          replyTo: userEmail,
          bcc: receiverEmail,
          subject: finalSubject,
          html: visitorHtml,
        });

        if (lead.preferred_date && lead.preferred_time) {
          const bookingTimestamp = Date.now();
          const meetingDate = new Date(
            `${lead.preferred_date} ${lead.preferred_time}`,
          ).getTime();

          if (!isNaN(meetingDate)) {
            const ONE_DAY_MS = 24 * 60 * 60 * 1000;
            const timeAfter1Day = bookingTimestamp + ONE_DAY_MS;
            const timeBefore1Day = meetingDate - ONE_DAY_MS;

            const remindersRef = db.ref("scheduled_reminders");

            if (meetingDate - bookingTimestamp > ONE_DAY_MS * 1.5) {
              await remindersRef.push({
                type: "24h_after_booking",
                scheduledFor: timeAfter1Day,
                email: vConf.visitorEmail,
                name: lead.name || "there",
                meetingDisplay: `${lead.preferred_date} at ${lead.preferred_time}`,
                status: "pending",
              });
            }

            if (timeBefore1Day > bookingTimestamp) {
              await remindersRef.push({
                type: "24h_before_meeting",
                scheduledFor: timeBefore1Day,
                email: vConf.visitorEmail,
                name: lead.name || "there",
                meetingDisplay: `${lead.preferred_date} at ${lead.preferred_time}`,
                status: "pending",
              });
            }
          }
        }
      }

      return snapshot.ref.update({
        status: "sent",
        sent_at: admin.database.ServerValue.TIMESTAMP,
      });
    } catch (error) {
      console.error("Email send failed:", error);
      await db.ref("logs/email_errors").push({
        error_message: error.message,
        alert_id: context.params.alertId,
        timestamp: admin.database.ServerValue.TIMESTAMP,
      });
      const isFallbackDenied = error.code === "GLOBAL_FALLBACK_UNAUTHORIZED";
      return snapshot.ref.update({ status: isFallbackDenied ? "rejected_fallback_unauthorized" : "error", error: error.message });
    }
  });

// ============================================================================
// 2. CRON JOB: PROCESS AUTOMATED REMINDERS (Runs every 1 hour)
// ============================================================================
exports.processScheduledReminders = functions.pubsub
  .schedule("every 1 hours")
  .onRun(async (context) => {
    const now = Date.now();
    const remindersRef = db.ref("scheduled_reminders");

    const snapshot = await remindersRef
      .orderByChild("scheduledFor")
      .endAt(now)
      .once("value");

    if (!snapshot.exists()) {
      console.log("No pending reminders to send at this time.");
      return null;
    }

    const reminders = snapshot.val();
    const promises = [];

    let transporterConfig;
    try {
      transporterConfig = await getDynamicTransporter();
    } catch (err) {
      console.error("CRON Failed to initialize dynamic transporter:", err);
      return null;
    }
    const { transporter, userEmail, senderName } = transporterConfig;

    for (const [key, reminder] of Object.entries(reminders)) {
      if (reminder.status !== "pending") continue;

      let subject = "";
      let htmlBody = "";

      if (reminder.type === "24h_after_booking") {
        subject = "Checking in before our meeting!";
        htmlBody = `Hi ${reminder.name},<br><br>You booked a meeting with us yesterday for <strong>${reminder.meetingDisplay}</strong>. We're getting everything ready for our chat.<br><br>If you have any specific questions you want to make sure we cover, feel free to reply to this email directly.<br><br>Talk soon,<br>The Team`;
      } else if (reminder.type === "24h_before_meeting") {
        subject = "Reminder: Our meeting is tomorrow!";
        htmlBody = `Hi ${reminder.name},<br><br>This is just a quick reminder that our meeting is scheduled for tomorrow, <strong>${reminder.meetingDisplay}</strong>.<br><br>We are looking forward to showing you how we can help your business grow. See you then!<br><br>Best,<br>The Team`;
      }

      const emailHtml = `
        <div style="background-color: #f4f4f5; padding: 40px 20px; font-family: 'Helvetica Neue', Arial, sans-serif;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e2e5; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(11,2,25,0.05);">
            <div style="text-align: center; padding: 30px 20px 20px; border-bottom: 3px solid #8a2be2;">
              ${COMPANY_LOGO_SVG}
            </div>
            <div style="padding: 30px 30px 40px; line-height: 1.7; font-size: 15px; color: #4a4a6a;">
              ${htmlBody}
            </div>
            <div style="background-color: #eaebf0; padding: 20px; text-align: center; border-top: 1px solid #e2e2e5;">
              <p style="margin: 0; font-size: 13px; color: #4a4a6a;">Need to reschedule? Just reply to this email.</p>
            </div>
          </div>
        </div>
      `;

      const mailOptions = {
        from: `"${senderName}" <${userEmail}>`,
        to: reminder.email,
        replyTo: userEmail,
        subject: subject,
        html: emailHtml,
      };

      const sendPromise = transporter
        .sendMail(mailOptions)
        .then(() =>
          remindersRef
            .child(key)
            .update({
              status: "sent",
              sentAt: admin.database.ServerValue.TIMESTAMP,
            }),
        )
        .catch((error) => {
          console.error(`Failed to send reminder ${key}:`, error);
          return remindersRef
            .child(key)
            .update({ status: "error", error: error.message });
        });

      promises.push(sendPromise);
    }

    await Promise.all(promises);
    console.log(`Processed ${promises.length} reminders.`);
    return null;
  });