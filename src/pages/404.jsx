import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/router";

export default function Custom404() {
  const router = useRouter();
  const [mousePos, setMousePos] = useState({ x: 50, y: 50 });
  const [pupilPos, setPupilPos] = useState({ x: 0, y: 0 });
  const [isHovering, setIsHovering] = useState(false);
  const eyeRef = useRef(null);

  // Track mouse movement for ambient glow and eye tracking
  useEffect(() => {
    const handleMouseMove = (e) => {
      // 1. Ambient Background Position
      const x = (e.clientX / window.innerWidth) * 100;
      const y = (e.clientY / window.innerHeight) * 100;
      setMousePos({ x, y });

      // 2. AI Eye Tracking Logic
      if (eyeRef.current) {
        const rect = eyeRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        // Calculate angle and distance from center of the eye
        const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
        // Cap the movement distance so the pupil stays inside the eye
        const distance = Math.min(12, Math.hypot(e.clientX - centerX, e.clientY - centerY) / 20);
        
        setPupilPos({
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
        });
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-[var(--background)] text-[var(--foreground)] overflow-hidden font-sans">
      
      {/* Interactive Ambient Mouse Glow */}
      <div
        className="absolute inset-0 pointer-events-none transition-transform duration-75 ease-out opacity-30 mix-blend-screen"
        style={{
          background: `radial-gradient(circle 800px at ${mousePos.x}% ${mousePos.y}%, var(--primary), transparent 60%)`,
          filter: "blur(80px)",
        }}
      />

      {/* Background Grid Pattern with Radial Fade Mask */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          backgroundImage: `url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+CjxwYXRoIGQ9Ik0wIDBoNDB2NDBIMHoiIGZpbGw9Im5vbmUiLz4KPHBhdGggZD0iTTAgMTBoNDBNMTAgMHY0ME0wIDIwaDQwTTIwIDB2NDBNMCAzMGg0ME0zMCAwdjQwIiBzdHJva2U9InJnYmEoMTUwLCAxNTAsIDE1MCwgMC4wNSkiIHN0cm9rZS13aWR0aD0iMSIvPgo8L3N2Zz4=")`,
          WebkitMaskImage: "radial-gradient(circle at center, black 30%, transparent 90%)",
          maskImage: "radial-gradient(circle at center, black 30%, transparent 90%)"
        }}
      />

      {/* Main 404 Container (Floating) */}
      <div className="relative z-10 flex flex-col items-center w-full max-w-2xl px-6 fade-in-up animate-float">
        
        {/* Interactive AI Radar "Eye" */}
        <div
          ref={eyeRef}
          className="relative w-36 h-36 mb-6 group cursor-pointer"
          onMouseEnter={() => setIsHovering(true)}
          onMouseLeave={() => setIsHovering(false)}
        >
          {/* Outer Pulsing Rings */}
          <div className="absolute inset-0 rounded-full border-2 border-[var(--primary)] opacity-20 animate-[ping_3s_cubic-bezier(0,0,0.2,1)_infinite]" />
          <div className="absolute inset-2 rounded-full border border-[var(--primary)] opacity-40 animate-[spin_4s_linear_infinite] border-t-transparent shadow-[0_0_15px_var(--primary)_inset]" />
          <div className="absolute inset-5 rounded-full border border-[var(--accent-blue)] opacity-50 animate-[spin_3s_linear_infinite_reverse] border-b-transparent" />

          {/* Center Core (Tracks Mouse) */}
          <div
            className={`absolute inset-8 rounded-full bg-gradient-to-br from-[var(--primary)] to-[var(--accent-blue)] transition-all flex items-center justify-center
              ${isHovering ? "scale-110 shadow-[0_0_60px_var(--primary)]" : "scale-100 shadow-[0_0_30px_var(--primary)]"}`}
            style={{ 
              transform: `translate(${pupilPos.x}px, ${pupilPos.y}px) ${isHovering ? 'scale(1.1)' : 'scale(1)'}`,
              transition: isHovering ? 'transform 0.2s ease-out' : 'transform 0.1s ease-out'
            }}
          >
            {/* Inner Pupil Glow */}
            <div className="w-5 h-5 bg-white rounded-full animate-pulse shadow-[0_0_15px_white,0_0_30px_var(--primary)]"></div>
          </div>
        </div>

        {/* 404 Text */}
        <h1 className="text-[7rem] sm:text-[9rem] font-black leading-none text-transparent bg-clip-text bg-gradient-to-b from-[var(--foreground)] via-[var(--foreground)/80] to-transparent drop-shadow-[0_10px_20px_rgba(0,0,0,0.15)] select-none tracking-tighter">
        404
        </h1>

        {/* Glassmorphism Card */}
        <div className="bg-[var(--card-bg)]/40 backdrop-blur-2xl border border-[var(--border-color)] ring-1 ring-white/5 rounded-3xl p-8 sm:p-12 text-center shadow-[0_20px_50px_rgba(0,0,0,0.1)] mt-4 sm:mt-8 w-full relative z-20 overflow-hidden group">
          {/* Subtle Card Highlight on hover */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

          <h2 className="text-2xl sm:text-3xl font-bold text-[var(--foreground)] tracking-tight mb-3">
            Signal Lost in the Mainframe
          </h2>
          <p className="text-[var(--foreground)]/70 text-sm sm:text-base font-medium mb-8 max-w-md mx-auto leading-relaxed">
            The AI searched the entire database, but the page you are looking
            for doesn't exist, has been moved, or is temporarily offline.
          </p>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={() => router.back()}
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl border border-[var(--border-color)] text-[var(--foreground)] text-sm font-bold bg-transparent hover:bg-[var(--foreground)]/5 hover:border-[var(--primary)] transition-all flex items-center justify-center gap-2 group/btn"
            >
              <svg
                className="w-4 h-4 group-hover/btn:-translate-x-1 transition-transform"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Go Back
            </button>

            <Link
              href="/"
              className="w-full sm:w-auto px-7 py-3.5 rounded-xl bg-gradient-to-r from-[var(--primary)] to-[var(--accent-blue)] text-white text-sm font-bold shadow-[0_4px_20px_var(--lead-glow)] hover:shadow-[0_4px_25px_var(--primary)] hover:opacity-90 hover:-translate-y-1 transition-all duration-300 flex items-center justify-center gap-2"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              Navigate Home
            </Link>
          </div>
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .fade-in-up { animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeInUp { 
          from { opacity: 0; transform: translateY(30px) scale(0.95); } 
          to { opacity: 1; transform: translateY(0) scale(1); } 
        }
        .animate-float { animation: float 6s ease-in-out infinite; }
        @keyframes float {
          0% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
          100% { transform: translateY(0px); }
        }
      `,
        }}
      />
    </div>
  );
}