import Head from "next/head";
import Link from "next/link";
import React, { useState } from "react";

export default function Home() {
  const [copied, setCopied] = useState(false);
  const embedSnippet = `<script src="https://YOUR_DOMAIN/widget.js" data-tenant="YOUR_TENANT" defer></script>`;

  const copyToClipboard = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(embedSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <>
      <Head>
        <title>Closedesk bys aicyro</title>
        <meta
          name="description"
          content="Closedesk bys aicyro — Multi-Tenant Multimodal AI Voice & Visual Dispatch Engine"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/icon.png" />
      </Head>

      <main className="min-h-screen w-full bg-[#0a0118] text-[#ffffff] flex flex-col items-center justify-center p-6 relative overflow-hidden font-sans">
        {/* Ambient Glows */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-[radial-gradient(ellipse_at_center,rgba(138,43,226,0.22),transparent_70%)] pointer-events-none blur-3xl" />
        <div className="absolute bottom-10 right-1/4 w-[400px] h-[250px] bg-[radial-gradient(ellipse_at_center,rgba(91,134,211,0.15),transparent_70%)] pointer-events-none blur-3xl" />

        {/* Subtle Background Grid Pattern */}
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.12]"
          style={{
            backgroundImage: `linear-gradient(#ffffff 1px, transparent 1px), linear-gradient(90deg, #ffffff 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
            maskImage: "radial-gradient(circle at center, #000 40%, transparent 85%)",
            WebkitMaskImage: "radial-gradient(circle at center, #000 40%, transparent 85%)",
          }}
        />

        {/* Central Banner Container */}
        <div className="relative z-10 w-full max-w-3xl flex flex-col items-center text-center">
          {/* Status Badge */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-md mb-8">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
              CloseDesk Engine Active
            </span>
            <span className="text-xs text-white/40">|</span>
            <span className="text-xs text-white/60">v2.1 Production</span>
          </div>

          {/* Primary Requested Banner */}
          <div className="w-full bg-gradient-to-b from-white/[0.08] to-white/[0.02] border border-white/15 rounded-3xl p-8 sm:p-12 backdrop-blur-xl shadow-2xl relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-purple-500 to-transparent" />

            {/* Core Text Header */}
            <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-purple-200 to-purple-400 mb-4 select-none">
              Closedesk bys aicyro
            </h1>

            <p className="text-base sm:text-lg text-white/70 max-w-xl mx-auto font-medium mb-8">
              Core Backend Engine & Multimodal AI Dispatch System. Powering Realtime Voice AI,
              Visual Analysis, Lead Qualification & Telemetry.
            </p>

            {/* Quick Action Navigation Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg mx-auto mb-8">
              <Link
                href="/lg"
                className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-sm transition-all shadow-[0_0_20px_rgba(138,43,226,0.4)] hover:shadow-[0_0_25px_rgba(138,43,226,0.6)] hover:-translate-y-0.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Pulse Dashboard (/lg)
              </Link>

              <Link
                href="/embed/chatbot?tenant=default"
                className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/15 text-white font-semibold text-sm transition-all hover:-translate-y-0.5"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                Chatbot Test Embed
              </Link>

              <Link
                href="/widget.js"
                className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 hover:text-white font-medium text-sm transition-all"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                </svg>
                Widget Script SDK (/widget.js)
              </Link>

              <Link
                href="/logs"
                className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 hover:text-white font-medium text-sm transition-all"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                System Telemetry (/logs)
              </Link>
            </div>

            {/* Client Embed Snippet Card */}
            <div className="w-full bg-black/40 border border-white/10 rounded-2xl p-4 text-left">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase tracking-wider font-semibold text-white/60">
                  Universal Client Embed Snippet
                </span>
                <button
                  onClick={copyToClipboard}
                  className="text-xs px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white font-medium transition-colors"
                >
                  {copied ? "Copied!" : "Copy Code"}
                </button>
              </div>
              <code className="text-xs sm:text-sm font-mono text-purple-300 break-all select-all block">
                {embedSnippet}
              </code>
            </div>
          </div>

          {/* Engine Footer Note */}
          <p className="mt-8 text-xs text-white/40 font-mono">
            CloseDesk Multimodal Engine • Standalone Backend Service
          </p>
        </div>
      </main>
    </>
  );
}
