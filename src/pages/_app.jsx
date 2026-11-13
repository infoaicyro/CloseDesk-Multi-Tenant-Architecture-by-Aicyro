// src/pages/_app.jsx
import React, { useEffect } from "react";
import { useRouter } from "next/router";
import "@/styles/globals.css";
import RootLayout from "./layout";
import ThemeProvider from "../Closedesk/ThemeProvider";
import GlobalActivityTracker from "../Closedesk/GlobalActivityTracker";
import { trackVisit } from "../lib/activityTracker";

// Import tracing utility
import { generateCorrelationId } from "../lib/tracer";
import { createWebsiteLogger } from "../lib/loggerPresets";

const routerLogger = createWebsiteLogger("AppRouter");

export default function App({ Component, pageProps }) {
  const router = useRouter();

  const isInternalRoute =
    router.pathname.startsWith("/lg") ||
    router.pathname.startsWith("/logs") ||
    router.pathname.startsWith("/embed");

  useEffect(() => {
    if (isInternalRoute) return;

    if (router.isReady) {
      const initialPageTxId = generateCorrelationId();
      routerLogger.info("navigation", "page_loaded", {
        correlation: { correlation_id: initialPageTxId },
        context: { endpoint: router.pathname },
      });
      trackVisit(router.pathname, initialPageTxId);
    }

    const handleRouteChange = (url) => {
      if (
        url.startsWith("/lg") ||
        url.startsWith("/logs") ||
        url.startsWith("/embed")
      ) {
        return;
      }
      const routeTxId = generateCorrelationId();
      routerLogger.info("navigation", "page_loaded", {
        correlation: { correlation_id: routeTxId },
        context: { endpoint: url },
      });
      trackVisit(url, routeTxId);
    };

    router.events.on("routeChangeComplete", handleRouteChange);
    return () => router.events.off("routeChangeComplete", handleRouteChange);
  }, [router.isReady, router.pathname, isInternalRoute]);

  return (
    <ThemeProvider>
      <RootLayout>
        {!isInternalRoute && <GlobalActivityTracker />}
        <Component {...pageProps} />
      </RootLayout>
    </ThemeProvider>
  );
}
