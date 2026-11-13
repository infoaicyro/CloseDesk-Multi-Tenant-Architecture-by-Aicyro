// src/pages/embed/chatbot.jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { ref, get } from "firebase/database";
import { db } from "@/lib/firebase";
import { isOriginAllowedForTenant } from "@/lib/onboardingContract";
import AicyroChatbot from "@/Closedesk/Chatbot/AicyroChatbot";

function EmbedErrorCard({ title, message, code }) {
  return (
    <div className="flex items-center justify-center min-h-screen w-full p-4 bg-transparent font-sans">
      <div className="bg-[#111827]/95 border border-rose-500/40 rounded-2xl p-6 max-w-sm w-full text-center shadow-2xl backdrop-blur-md">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-rose-500/15 text-rose-400 flex items-center justify-center text-xl font-bold border border-rose-500/30">
          ⚠️
        </div>
        <h3 className="text-sm font-bold text-white mb-1.5 uppercase tracking-wider">
          {title}
        </h3>
        <p className="text-xs text-neutral-300 leading-relaxed mb-4">
          {message}
        </p>
        {code && (
          <span className="inline-block px-2.5 py-1 rounded bg-neutral-900 border border-neutral-800 text-[10px] font-mono text-neutral-400">
            {code}
          </span>
        )}
      </div>
    </div>
  );
}

export default function EmbeddedChatbotPage() {
  const router = useRouter();
  const { tenant, tenant_id, anonId, host } = router.query;
  const [verificationState, setVerificationState] = useState({
    loading: true,
    allowed: false,
    errorTitle: "",
    errorMessage: "",
    errorCode: "",
  });

  const activeTenantId = tenant || tenant_id ? String(tenant || tenant_id).trim() : null;

  useEffect(() => {
    if (anonId && typeof window !== "undefined") {
      try {
        localStorage.setItem("aicyro_anonymous_id", String(anonId));
        localStorage.setItem("closedesk_anon_id", String(anonId));
      } catch (_) {}
    }
  }, [anonId]);

  useEffect(() => {
    if (!router.isReady) return;

    if (!activeTenantId) {
      setVerificationState({
        loading: false,
        allowed: false,
        errorTitle: "Tenant Missing",
        errorMessage: "Tenant identifier is required to initialize the CloseDesk assistant.",
        errorCode: "TENANT_REQUIRED",
      });
      return;
    }

    if (activeTenantId === "default") {
      setVerificationState({ loading: false, allowed: true });
      return;
    }

    let isMounted = true;

    async function verifyTenant() {
      try {
        const tenantRef = ref(db, `tenants/${activeTenantId}`);
        const snap = await get(tenantRef);

        if (!isMounted) return;

        if (!snap.exists()) {
          setVerificationState({
            loading: false,
            allowed: false,
            errorTitle: "Tenant Not Found",
            errorMessage: `Tenant '${activeTenantId}' does not exist or has been removed.`,
            errorCode: "TENANT_NOT_FOUND",
          });
          return;
        }

        const tenantData = snap.val() || {};

        if (tenantData.enabled === false) {
          setVerificationState({
            loading: false,
            allowed: false,
            errorTitle: "Tenant Inactive",
            errorMessage: `Tenant '${activeTenantId}' is not active or is pending operational onboarding.`,
            errorCode: "TENANT_INACTIVE",
          });
          return;
        }

        // Origin Whitelist Verification (CD11)
        const allowedOrigins =
          tenantData.config?.allowed_origins ||
          tenantData.business_profile?.allowed_origins ||
          [];

        const incomingHost = (() => {
          if (host && typeof host === "string" && host !== "null" && host !== "undefined") {
            try {
              return new URL(host).origin;
            } catch (_) {
              return host;
            }
          }
          if (typeof document !== "undefined" && document.referrer) {
            try {
              return new URL(document.referrer).origin;
            } catch (_) {}
          }
          return null;
        })();

        // If embedded on a third-party host, enforce allowed_origins
        if (incomingHost) {
          const isAllowed = isOriginAllowedForTenant(incomingHost, allowedOrigins);
          if (!isAllowed) {
            setVerificationState({
              loading: false,
              allowed: false,
              errorTitle: "Unauthorized Origin",
              errorMessage: `Embedding on origin '${incomingHost}' is not permitted for tenant '${activeTenantId}'.`,
              errorCode: "EMBED_ORIGIN_PROHIBITED",
            });
            return;
          }
        }

        setVerificationState({ loading: false, allowed: true });
      } catch (err) {
        if (!isMounted) return;
        setVerificationState({
          loading: false,
          allowed: false,
          errorTitle: "Verification Error",
          errorMessage: "Failed to verify tenant configuration. Please retry later.",
          errorCode: "TENANT_CHECK_ERROR",
        });
      }
    }

    verifyTenant();

    return () => {
      isMounted = false;
    };
  }, [router.isReady, activeTenantId, host]);

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
        {verificationState.loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !verificationState.allowed ? (
          <EmbedErrorCard
            title={verificationState.errorTitle}
            message={verificationState.errorMessage}
            code={verificationState.errorCode}
          />
        ) : (
          <AicyroChatbot tenantId={activeTenantId} />
        )}
      </div>
    </>
  );
}
