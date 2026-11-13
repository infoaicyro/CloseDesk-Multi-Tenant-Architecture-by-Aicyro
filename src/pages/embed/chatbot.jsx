// src/pages/embed/chatbot.jsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import AicyroChatbot from "@/Closedesk/Chatbot/AicyroChatbot";

export default function EmbeddedChatbotPage() {
  const router = useRouter();
  const { tenant, tenant_id, anonId } = router.query;
  const activeTenantId = tenant || tenant_id || "default";

  useEffect(() => {
    if (anonId && typeof window !== "undefined") {
      try {
        localStorage.setItem("aicyro_anonymous_id", String(anonId));
        localStorage.setItem("closedesk_anon_id", String(anonId));
      } catch (_) {}
    }
  }, [anonId]);

  return (
    <>
      <Head>
        <title>CloseDesk AI Assistant</title>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0"
        />
        <meta name="robots" content="noindex, nofollow" />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body, #__next {
                background: transparent !important;
                background-color: transparent !important;
                overflow: hidden !important;
                margin: 0 !important;
                padding: 0 !important;
                width: 100% !important;
                height: 100% !important;
              }
            `,
          }}
        />
      </Head>

      <div className="w-full h-full bg-transparent overflow-hidden">
        <AicyroChatbot tenantId={activeTenantId} />
      </div>
    </>
  );
}
