"use client";

import { useState, useEffect } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
  Legend,
} from "recharts";

// Colors for the Pie Chart
const COLORS = [
  "#10b981",
  "#3b82f6",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
];

export default function Insight() {
  const [insights, setInsights] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchExistingInsights = async () => {
      try {
        const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
        const res = await fetch(`/api/insights?tenant=${encodeURIComponent(tenantId)}`, {
          headers: { "x-tenant-id": tenantId },
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.kpis) {
            setInsights(data);
          }
        }
      } catch (_) {}
    };
    fetchExistingInsights();
  }, []);

  const handleGetInsights = async () => {
    setIsGenerating(true);
    setError("");
    try {
      const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
      const response = await fetch(`/api/insights?tenant=${encodeURIComponent(tenantId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to generate insights");
      }

      const data = await response.json();
      setInsights(data);
    } catch (err) {
      console.error(err);
      setError(
        "An error occurred while generating insights. Please try again.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto font-sans text-[var(--foreground)] pb-24">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Business Intelligence
          </h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">
            Analyze your AI Front Desk conversations to uncover actionable
            trends.
          </p>
        </div>

        <button
          onClick={handleGetInsights}
          disabled={isGenerating}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-white transition-all shadow-[0_0_15px_var(--lead-glow)] hover:shadow-[0_0_25px_var(--lead-glow)] ${
            isGenerating
              ? "bg-[var(--primary)]/70 cursor-not-allowed"
              : "bg-[var(--primary)] hover:-translate-y-0.5"
          }`}
        >
          {isGenerating ? (
            <>
              <svg
                className="animate-spin h-5 w-5 text-white"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Analyzing Data...
            </>
          ) : (
            <>
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              Get Insights
            </>
          )}
        </button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/50 text-red-500 rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      {!insights && !isGenerating && !error && (
        <div className="flex flex-col items-center justify-center py-24 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl border-dashed">
          <svg
            className="w-16 h-16 text-[var(--foreground-muted)] mb-4 opacity-50"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1"
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <p className="text-[var(--foreground-muted)] text-center max-w-md">
            Click the button above to run the AI model over your recent
            conversation logs. It will extract key business metrics, drop-off
            points, and generate visualizations.
          </p>
        </div>
      )}

      {insights && (
        <div className="space-y-6 animate-acy-fade">
          {/* KPI Cards Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              title="Total Chats"
              value={insights.kpis.total_conversations}
              icon="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              highlight
            />
            <KpiCard
              title="Booking Conv."
              value={insights.kpis.conversion_rate}
              icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              highlight
            />
            <KpiCard
              title="Top Service"
              value={insights.kpis.top_service}
              icon="M13 10V3L4 14h7v7l9-11h-7z"
            />
            <KpiCard
              title="After-Hours Leads"
              value={insights.kpis.after_hours_stat}
              icon="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
            />
            <KpiCard
              title="Top Drop-off"
              value={insights.kpis.top_dropoff}
              icon="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
            />
            <KpiCard
              title="Pricing Inquiries"
              value={insights.kpis.pricing_inquiries_stat}
              icon="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
            <KpiCard
              title="Urgent Requests"
              value={insights.kpis.urgent_requests_stat}
              icon="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
            <KpiCard
              title="Top Objection"
              value={insights.kpis.top_objection}
              icon="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Bar Chart - Service Demand */}
            <div className="bg-[var(--card-bg)] border border-[var(--border-color)] p-6 rounded-2xl shadow-sm">
              <h3 className="text-sm font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-6">
                Service Demand
              </h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={insights.charts.service_demand}
                    layout="vertical"
                    margin={{ top: 0, right: 0, left: 20, bottom: 0 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="name"
                      type="category"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "var(--foreground-muted)", fontSize: 12 }}
                      width={100}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--primary)", opacity: 0.1 }}
                      contentStyle={{
                        backgroundColor: "var(--card-bg)",
                        borderColor: "var(--border-color)",
                        borderRadius: "8px",
                      }}
                    />
                    <Bar
                      dataKey="value"
                      fill="#10b981"
                      radius={[0, 4, 4, 0]}
                      barSize={20}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Pie Chart - Visitor Intent */}
            <div className="bg-[var(--card-bg)] border border-[var(--border-color)] p-6 rounded-2xl shadow-sm">
              <h3 className="text-sm font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-2">
                Visitor Intent
              </h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={insights.charts.visitor_intent}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={5}
                      dataKey="value"
                    >
                      {insights.charts.visitor_intent.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={COLORS[index % COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--card-bg)",
                        borderColor: "var(--border-color)",
                        borderRadius: "8px",
                      }}
                    />
                    <Legend
                      verticalAlign="bottom"
                      height={36}
                      iconType="circle"
                      wrapperStyle={{
                        fontSize: "12px",
                        color: "var(--foreground)",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Charts Row 2 & Insights text */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Line Chart - Time of Day Distribution */}
            <div className="lg:col-span-2 bg-[var(--card-bg)] border border-[var(--border-color)] p-6 rounded-2xl shadow-sm">
              <h3 className="text-sm font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-6">
                Traffic Time Distribution
              </h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={insights.charts.time_distribution}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="var(--border-color)"
                    />
                    <XAxis
                      dataKey="time"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "var(--foreground-muted)", fontSize: 12 }}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: "var(--foreground-muted)", fontSize: 12 }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--card-bg)",
                        borderColor: "var(--border-color)",
                        borderRadius: "8px",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="leads"
                      stroke="#3b82f6"
                      strokeWidth={3}
                      dot={{
                        r: 4,
                        fill: "#3b82f6",
                        strokeWidth: 2,
                        stroke: "var(--card-bg)",
                      }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* AI Summary Bullets */}
            <div className="lg:col-span-1 bg-[var(--card-bg)] border border-[var(--border-color)] p-6 rounded-2xl shadow-sm overflow-y-auto max-h-[300px] acy-scroll">
              <h3 className="text-sm font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-4">
                AI Analysis Notes
              </h3>
              <ul className="space-y-4">
                {insights.detailed_bullets.map((bullet, idx) => (
                  <li
                    key={idx}
                    className="flex items-start gap-3 text-sm leading-relaxed text-[var(--foreground)]"
                  >
                    <div className="w-2 h-2 rounded-full bg-[var(--primary)] mt-1.5 shrink-0 shadow-[0_0_8px_var(--lead-glow)]"></div>
                    {bullet}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Helper Component for the KPI Cards
function KpiCard({ title, value, icon, highlight }) {
  return (
    <div
      className={`p-4 md:p-5 rounded-2xl border flex flex-col justify-between h-28 md:h-32 transition-all hover:-translate-y-1 ${highlight ? "bg-[var(--primary)]/10 border-[var(--primary)]/30" : "bg-[var(--card-bg)] border-[var(--border-color)] hover:border-[var(--grid-line)]"}`}
    >
      <div className="flex justify-between items-start mb-2">
        <span
          className={`text-[10px] md:text-xs font-bold uppercase tracking-wider ${highlight ? "text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}
        >
          {title}
        </span>
        <svg
          className={`w-4 h-4 md:w-5 md:h-5 ${highlight ? "text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
      </div>
      <p
        className={`text-base md:text-lg font-bold leading-tight truncate ${highlight ? "text-[var(--foreground)]" : "text-[var(--foreground)]"}`}
      >
        {value}
      </p>
    </div>
  );
}
