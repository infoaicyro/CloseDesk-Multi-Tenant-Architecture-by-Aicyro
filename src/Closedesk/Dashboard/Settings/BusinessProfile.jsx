"use client";

import { useState, useEffect, useRef } from "react";
import { db } from "../../../lib/firebase";
import { ref, set, get } from "firebase/database";

const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const DEFAULT_SCHEDULE = DAYS_OF_WEEK.reduce((acc, day) => {
  acc[day] = {
    active: day !== "Saturday" && day !== "Sunday",
    open: "09:00",
    close: "17:00",
  };
  return acc;
}, {});

// Helper function to generate time zones with GMT offsets
const generateTimezonesWithGMT = () => {
  const tzs =
    typeof Intl !== "undefined" && Intl.supportedValuesOf
      ? Intl.supportedValuesOf("timeZone")
      : [
          "UTC",
          "America/New_York",
          "America/Chicago",
          "America/Denver",
          "America/Los_Angeles",
          "Europe/London",
          "Europe/Paris",
          "Asia/Tokyo",
          "Australia/Sydney",
        ];

  return tzs
    .map((tz) => {
      try {
        const formatter = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          timeZoneName: "shortOffset",
        });
        const parts = formatter.formatToParts(new Date());
        let offset =
          parts.find((p) => p.type === "timeZoneName")?.value || "GMT";

        if (offset === "GMT") offset = "GMT+0";

        const formattedName = tz.replace(/_/g, " ");

        return {
          value: tz,
          label: `(${offset}) ${formattedName}`,
        };
      } catch (e) {
        return { value: tz, label: tz };
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label));
};

const TIMEZONE_OPTIONS = generateTimezonesWithGMT();

export default function BusinessProfile({ onNavigate }) {
  const [tenantId, setTenantId] = useState("default");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [logoPreview, setLogoPreview] = useState("/icon.png");
  const fileInputRef = useRef(null);

  const [toast, setToast] = useState({
    show: false,
    message: "",
    type: "success",
  });

  const [formData, setFormData] = useState({
    businessName: "",
    industry: "",
    website: "",
    phone: "",
    email: "",
    avgJobValue: "",
    address: "",
  });
  const [supportedServicesText, setSupportedServicesText] = useState("");
  const [unsupportedServicesText, setUnsupportedServicesText] = useState("");
  const [serviceAreaText, setServiceAreaText] = useState("");

  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE);
  const [timezone, setTimezone] = useState("");

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(
      () => setToast({ show: false, message: "", type: "success" }),
      3500,
    );
  };

  useEffect(() => {
    const activeTenant = typeof window !== "undefined"
      ? (localStorage.getItem("currentTenant") || "default")
      : "default";
    setTenantId(activeTenant);

    const profilePath = activeTenant && activeTenant !== "default"
      ? `tenants/${activeTenant}/business_profile`
      : "settings/business_profile";

    const fetchProfile = async () => {
      try {
        const snapshot = await get(ref(db, profilePath));
        if (snapshot.exists()) {
          const data = snapshot.val();
          if (data.basic_info) setFormData((prev) => ({ ...prev, ...data.basic_info }));
          if (data.operating_hours) setSchedule(data.operating_hours);

          if (data.timezone) {
            setTimezone(data.timezone);
          } else {
            setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
          }

          if (Array.isArray(data.supported_services)) {
            setSupportedServicesText(data.supported_services.join(", "));
          }
          if (Array.isArray(data.unsupported_services)) {
            setUnsupportedServicesText(data.unsupported_services.join(", "));
          }
          if (Array.isArray(data.service_area)) {
            setServiceAreaText(data.service_area.join(", "));
          }
        } else {
          setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
        }

        setLogoPreview(`/icon.png?t=${new Date().getTime()}`);
      } catch (error) {
        showToast("Failed to load profile.", "error");
      } finally {
        setIsLoading(false);
      }
    };
    fetchProfile();
  }, []);

  const handleInputChange = (e) =>
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  const handleScheduleToggle = (day) =>
    setSchedule((prev) => ({
      ...prev,
      [day]: { ...prev[day], active: !prev[day].active },
    }));
  const handleTimeChange = (day, field, value) =>
    setSchedule((prev) => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));

  const handleLogoChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      showToast("File size must be under 2MB", "error");
      return;
    }

    setIsUploadingLogo(true);

    const reader = new FileReader();
    reader.onload = async (event) => {
      const base64Image = event.target.result;
      setLogoPreview(base64Image);

      try {
        const brandingPath = tenantId && tenantId !== "default"
          ? `tenants/${tenantId}/branding/logo`
          : "settings/branding/logo";
        await set(ref(db, brandingPath), base64Image);
        showToast("Logo updated successfully!", "success");
      } finally {
        setIsUploadingLogo(false);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveProfile = async () => {
    setIsSaving(true);
    const profilePath = tenantId && tenantId !== "default"
      ? `tenants/${tenantId}/business_profile`
      : "settings/business_profile";

    const parsedSupported = supportedServicesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const parsedUnsupported = unsupportedServicesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const parsedArea = serviceAreaText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await set(ref(db, profilePath), {
        basic_info: formData,
        operating_hours: schedule,
        timezone: timezone,
        supported_services: parsedSupported,
        unsupported_services: parsedUnsupported,
        service_area: parsedArea,
        updated_at: new Date().toISOString(),
      });
      showToast(`Tenant '${tenantId}' business profile saved!`, "success");
    } catch (error) {
      showToast("Failed to save changes.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-[var(--foreground-muted)] text-sm font-bold uppercase tracking-widest animate-pulse">
          Loading Profile...
        </p>
      </div>
    );

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-6 sm:px-12 py-8 fade-in">
      <div className="flex justify-between items-end mb-8">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">
              Business Profile & Service Truths
            </h1>
            <span className="text-xs font-mono font-semibold px-2.5 py-1 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-full text-[var(--primary)] uppercase">
              Tenant: {tenantId}
            </span>
          </div>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">
            Configure authoritative business facts, coverage areas, service boundaries, and operating hours.
          </p>
        </div>
        <button
          onClick={handleSaveProfile}
          disabled={isSaving}
          className="px-6 py-3 bg-[var(--primary)] text-white text-xs font-bold uppercase tracking-wider rounded-xl shadow-[0_0_15px_var(--lead-glow)] transition-all disabled:opacity-50"
        >
          {isSaving ? "Saving..." : "Save Changes"}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* ================= LEFT COLUMN ================= */}
        <div className="xl:col-span-7 flex flex-col gap-6">
          {/* Core Identity */}
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Core Identity
            </h2>

            {/* LOGO UPLOAD SECTION */}
            <div className="flex items-center gap-6 mb-8 p-4 rounded-xl bg-[var(--background)] border border-[var(--border-color)]">
              <div className="relative w-16 h-16 rounded-xl border border-[var(--border-color)] bg-[var(--card-bg)] flex items-center justify-center overflow-hidden shrink-0">
                <img
                  src={logoPreview}
                  alt="Business Logo"
                  className="w-full h-full object-contain p-2"
                />
                {isUploadingLogo && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                    <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin"></div>
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-bold text-[var(--foreground)]">
                  System Logo
                </h3>
                <p className="text-[10px] text-[var(--foreground-muted)] uppercase tracking-widest max-w-[250px]">
                  Updates the icon shown in the sidebar and browser tab.
                  Recommended: PNG, Square.
                </p>
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/png, image/jpeg, image/svg+xml"
                  onChange={handleLogoChange}
                  className="hidden"
                />
                <button
                  onClick={() => fileInputRef.current.click()}
                  disabled={isUploadingLogo}
                  className="self-start text-[11px] font-bold text-[var(--primary)] hover:text-[var(--secondary)] transition-colors uppercase tracking-wider"
                >
                  Upload New Image
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2 md:col-span-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Business Name
                </label>
                <input
                  type="text"
                  name="businessName"
                  value={formData.businessName}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Industry / Category
                </label>
                <input
                  type="text"
                  name="industry"
                  value={formData.industry}
                  onChange={handleInputChange}
                  placeholder="e.g. HVAC, Plumbing, Restoration"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Website
                </label>
                <input
                  type="url"
                  name="website"
                  value={formData.website}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Phone
                </label>
                <input
                  type="tel"
                  name="phone"
                  value={formData.phone}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Email
                </label>
                <input
                  type="email"
                  name="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Address
                </label>
                <textarea
                  name="address"
                  value={formData.address}
                  onChange={handleInputChange}
                  rows="2"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all resize-none outline-none"
                />
              </div>
            </div>
          </div>

          {/* Service Catalog & Boundaries */}
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Service Truths & Coverage Area
            </h2>

            <div className="space-y-5">
              <div>
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block mb-1">
                  Supported Services (Comma Separated)
                </label>
                <input
                  type="text"
                  value={supportedServicesText}
                  onChange={(e) => setSupportedServicesText(e.target.value)}
                  placeholder="e.g. AC Repair, Furnace Tune-Up, Heat Pump Installation"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
                <p className="text-[11px] text-[var(--foreground-muted)] mt-1">
                  The assistant will strictly offer only services in this catalog.
                </p>
              </div>

              <div>
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block mb-1">
                  Explicitly Unsupported Services (Comma Separated)
                </label>
                <input
                  type="text"
                  value={unsupportedServicesText}
                  onChange={(e) => setUnsupportedServicesText(e.target.value)}
                  placeholder="e.g. Commercial Chillers, Duct Cleaning, Window Units"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
                <p className="text-[11px] text-[var(--foreground-muted)] mt-1">
                  The assistant will explicitly inform callers that these jobs are not performed and will not book them.
                </p>
              </div>

              <div>
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block mb-1">
                  Confirmed Service Area / ZIP Codes (Comma Separated)
                </label>
                <input
                  type="text"
                  value={serviceAreaText}
                  onChange={(e) => setServiceAreaText(e.target.value)}
                  placeholder="e.g. 78701, 78702, Austin, Round Rock"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
                />
                <p className="text-[11px] text-[var(--foreground-muted)] mt-1">
                  Inquiries outside these boundaries will be truthfully noted as requiring coverage confirmation.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ================= RIGHT COLUMN ================= */}
        <div className="xl:col-span-5 flex flex-col gap-6">
          {/* Operating Schedule */}
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-8 shadow-sm flex flex-col max-h-[800px]">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Operating Schedule & Timezone
            </h2>

            {/* TIME ZONE DROPDOWN (IANA) */}
            <div className="mb-6 space-y-2">
              <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                Tenant Time Zone (IANA)
              </label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] transition-all outline-none"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-[var(--foreground-muted)]">
                Operating status and after-hours rules are calculated in this timezone.
              </p>
            </div>

            <div className="space-y-3 overflow-y-auto pr-2 custom-scrollbar">
              {DAYS_OF_WEEK.map((day) => {
                const isActive = schedule[day]?.active;
                return (
                  <div
                    key={day}
                    className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 rounded-xl border ${isActive ? "bg-[var(--background)] border-[var(--border-color)]" : "bg-transparent border-transparent opacity-60 grayscale"}`}
                  >
                    <div className="flex items-center gap-3 w-32 shrink-0 mb-3 sm:mb-0">
                      <button
                        onClick={() => handleScheduleToggle(day)}
                        className={`w-10 h-5 rounded-full relative transition-colors ${isActive ? "bg-[var(--primary)]" : "bg-[var(--border-color)]"}`}
                      >
                        <div
                          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${isActive ? "translate-x-5" : "translate-x-0"}`}
                        ></div>
                      </button>
                      <span className="text-sm font-bold">
                        {day.substring(0, 3)}
                      </span>
                    </div>
                    {isActive ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          value={schedule[day]?.open || "09:00"}
                          onChange={(e) =>
                            handleTimeChange(day, "open", e.target.value)
                          }
                          className="bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] text-xs font-mono font-bold px-2 py-1.5 rounded focus:border-[var(--primary)] outline-none"
                        />
                        <span className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase">
                          to
                        </span>
                        <input
                          type="time"
                          value={schedule[day]?.close || "17:00"}
                          onChange={(e) =>
                            handleTimeChange(day, "close", e.target.value)
                          }
                          className="bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] text-xs font-mono font-bold px-2 py-1.5 rounded focus:border-[var(--primary)] outline-none"
                        />
                      </div>
                    ) : (
                      <span className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase px-3 py-1 bg-[var(--card-bg)] rounded border border-[var(--border-color)]">
                        Closed
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Account Security Section */}
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-8 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight">
                  Account Security
                </h2>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  Manage your credentials and login methods.
                </p>
              </div>
              <button
                onClick={() => onNavigate && onNavigate("password_change")}
                className="shrink-0 px-5 py-2.5 bg-[var(--background)] border border-[var(--border-color)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--foreground)] text-xs font-bold uppercase tracking-wider rounded-xl transition-all"
              >
                Change Password
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <div
        className={`fixed bottom-6 right-6 z-[100] transition-all duration-500 ease-out ${toast.show ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0 pointer-events-none"}`}
      >
        <div className="app-toast border shadow-[0_10px_40px_rgba(0,0,0,0.3)] rounded-2xl p-4 pr-10 flex items-center gap-3 backdrop-blur-xl relative overflow-hidden">
          <div
            className={`w-1.5 h-full absolute left-0 top-0 ${toast.type === "error" ? "bg-red-500" : "bg-green-500"}`}
          ></div>
          <div>
            <p className="text-[10px] font-bold app-toast-label uppercase tracking-widest mb-0.5">
              System Update
            </p>
            <p className="text-sm font-semibold">{toast.message}</p>
          </div>
        </div>
      </div>
    </main>
  );
}
