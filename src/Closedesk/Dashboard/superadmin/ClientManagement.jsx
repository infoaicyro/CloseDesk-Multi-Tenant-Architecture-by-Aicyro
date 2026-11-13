// src/Closedesk/Dashboard/superadmin/ClientManagement.jsx
"use client";

import React, { useState, useEffect } from "react";
import { ref, get, set, update } from "firebase/database";
import { db } from "../../../lib/firebase";

// 🔥 TICKET 14
import { createPulseLogger } from "../../../lib/loggerPresets";
import { recordAuditTrail } from "../../../lib/auditTracer";
import {
  validateTenantReadiness,
  TENANT_ACTIVATION_STATUS,
  ACTIVATION_CHECKLIST_ITEMS,
} from "../../../lib/onboardingContract";

const pulseLogger = createPulseLogger("ClientManagement");

const INDUSTRY_OPTIONS = [
  { label: "HVAC (Heating & Air)", value: "HVAC", pack: "hvac_v2" },
  { label: "Plumbing Services", value: "Plumbing", pack: "plumbing_v2" },
  { label: "Water & Fire Restoration", value: "Restoration", pack: "restoration_v2" },
  { label: "Roofing & Storm Repair", value: "Roofing", pack: "roofing_v2" },
  { label: "Electrical Contracting", value: "Electrical", pack: "electrical_v2" },
  { label: "Pest Control", value: "Pest Control", pack: "pest_v2" },
  { label: "General Home Services", value: "General", pack: "general_v2" },
];

const CHECKLIST_METADATA = [
  { key: ACTIVATION_CHECKLIST_ITEMS.ALLOWED_DOMAINS, label: "Domains", icon: "🌐" },
  { key: ACTIVATION_CHECKLIST_ITEMS.TENANT_MAPPING, label: "Slug", icon: "🏷️" },
  { key: ACTIVATION_CHECKLIST_ITEMS.SERVICES_AREAS, label: "Services & Areas", icon: "🛠️" },
  { key: ACTIVATION_CHECKLIST_ITEMS.TIMEZONE_HOURS, label: "Hours", icon: "🕒" },
  { key: ACTIVATION_CHECKLIST_ITEMS.APPROVED_POLICIES, label: "Policies", icon: "📜" },
  { key: ACTIVATION_CHECKLIST_ITEMS.SUPPORTED_MODES, label: "Modes", icon: "💬" },
  { key: ACTIVATION_CHECKLIST_ITEMS.RECIPIENTS_LIMITS, label: "Alerts", icon: "🔔" },
];

const INITIAL_NEW_CLIENT = {
  businessName: "",
  tenantId: "",
  industry: "HVAC",
  industryPack: "hvac_v2",
  email: "",
  phone: "",
  timezone: "America/New_York",
  website: "",
  adminUsername: "",
  adminPassword: "",
  allowedOrigin: "*",
  primaryColor: "#0284c7",
};

export default function ClientManagement() {
  const [clients, setClients] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // --- MODAL STATES ---
  const [viewingProfile, setViewingProfile] = useState(null);
  const [managingUsers, setManagingUsers] = useState(null);
  const [viewingChecklist, setViewingChecklist] = useState(null);

  // --- ADD CLIENT STATES ---
  const [isAddingClient, setIsAddingClient] = useState(false);
  const [newClientData, setNewClientData] = useState(INITIAL_NEW_CLIENT);
  const [addClientError, setAddClientError] = useState("");
  const [createdClientModal, setCreatedClientModal] = useState(null);
  const [copySuccess, setCopySuccess] = useState("");

  // --- PIN VERIFICATION STATES ---
  const [pinModal, setPinModal] = useState({
    isOpen: false,
    action: null,
    error: "",
  });
  const [pinInput, setPinInput] = useState("");

  // --- PROFILE EDIT STATES ---
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const [editedProfileData, setEditedProfileData] = useState({});

  // --- USER EDIT STATES ---
  const [editingUser, setEditingUser] = useState(null); // { clientIndex, userIndex, name, password }
  const [newPassword, setNewPassword] = useState("");
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", password: "" });
  const [revealedPasswords, setRevealedPasswords] = useState(new Set());

  // --- FETCH CLIENTS (PRIMARY + MULTI-TENANT) ---
  const fetchClientData = async () => {
    try {
      const settingsRef = ref(db, "settings/business_profile");
      const settingsSnap = await get(settingsRef);

      const loginRef = ref(db, "login");
      const loginSnap = await get(loginRef);

      let profileData = {};
      if (settingsSnap.exists()) {
        const rawProfile = settingsSnap.val();
        profileData = {
          ...rawProfile.basic_info,
          timezone: rawProfile.timezone,
          updated_at: rawProfile.updated_at,
        };
      }

      let usersData = [];
      if (loginSnap.exists()) {
        usersData = loginSnap.val().filter((u) => u !== null);
      }

      const loadedClients = [
        {
          id: "primary_client",
          enabled: true,
          readiness: validateTenantReadiness({
            id: "primary_client",
            business_profile: { basic_info: profileData, timezone: profileData.timezone || "America/New_York" },
            config: { allowed_origins: ["https://app.closedesk.ai"] },
            notification_settings: { adminEmail: profileData.email || "admin@closedesk.ai" },
          }),
          profile: profileData,
          users: usersData,
          isPrimary: true,
        },
      ];

      // Fetch dynamic multi-tenant partitions
      try {
        const tenantsRef = ref(db, "tenants");
        const tenantsSnap = await get(tenantsRef);
        if (tenantsSnap.exists()) {
          const tenantsVal = tenantsSnap.val();
          for (const [tId, tData] of Object.entries(tenantsVal)) {
            if (!tData || tId === "primary_client") continue;
            const tProfile = tData.business_profile?.basic_info || {};
            const tUsers = tData.users
              ? Object.values(tData.users).filter(Boolean)
              : [];
            const tDataWithId = { id: tId, ...tData };
            const readiness = validateTenantReadiness(tDataWithId);
            loadedClients.push({
              id: tId,
              profile: {
                businessName:
                  tProfile.businessName || tData.config?.business_name || tId,
                email: tProfile.email || "",
                phone: tProfile.phone || "",
                website: tProfile.website || "",
                industry:
                  tProfile.industry || tData.config?.industry_pack || "General",
                timezone:
                  tData.business_profile?.timezone ||
                  tData.config?.timezone ||
                  "America/New_York",
                updated_at:
                  tData.business_profile?.updated_at ||
                  tData.created_at ||
                  new Date().toISOString(),
              },
              users: tUsers,
              config: tData.config || {},
              isMultiTenant: true,
              enabled: Boolean(tData.enabled === true && readiness.ready),
              activation_status: tData.activation_status || readiness.status,
              readiness,
            });
          }
        }
      } catch (tenantErr) {
        console.warn("Could not fetch multi-tenant list:", tenantErr);
      }

      setClients(loadedClients);
    } catch (error) {
      console.error("Error fetching client data:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchClientData();
  }, []);

  // --- PIN AUTH ---
  const requestPinAuth = (actionPayload) => {
    setPinModal({ isOpen: true, action: actionPayload, error: "" });
    setPinInput("");
  };

  const verifyPin = async (pinToVerify) => {
    setActionLoading(true);
    try {
      const currentAdminName = localStorage.getItem("currentSuperAdmin") || "admin";
      const token = localStorage.getItem("cd_session_token");
      const response = await fetch("/api/superadmin/verify-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          username: currentAdminName,
          pin: pinToVerify,
        }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.token) {
          localStorage.setItem("cd_session_token", data.token);
        }
        executeSecuredAction(pinModal.action);
        setPinModal({ isOpen: false, action: null, error: "" });
        setPinInput("");
      } else {
        setPinModal((prev) => ({
          ...prev,
          error: data.error || "Invalid Secondary Verification PIN or Code. Access denied.",
        }));
        setPinInput("");
      }
    } catch (error) {
      console.error("PIN check error:", error);
      setPinModal((prev) => ({
        ...prev,
        error: "Network error checking verification PIN.",
      }));
      setPinInput("");
    } finally {
      setActionLoading(false);
    }
  };

  const handlePinChange = (e) => {
    const val = e.target.value.replace(/\D/g, "").slice(0, 4);
    setPinInput(val);
    if (val.length === 4) {
      verifyPin(val);
    }
  };

  const handlePinSubmit = (e) => {
    e.preventDefault();
    if (pinInput.length === 4) {
      verifyPin(pinInput);
    }
  };

  const executeSecuredAction = (action) => {
    switch (action.type) {
      case "REVEAL_PASSWORD":
        setRevealedPasswords((prev) => {
          const newSet = new Set(prev);
          newSet.add(action.userIndex);
          return newSet;
        });
        break;
      case "EDIT_PASSWORD":
        setEditingUser(action.payload);
        break;
      case "EDIT_PROFILE":
        setIsEditingProfile(true);
        setEditedProfileData({ ...viewingProfile.profile });
        break;
      default:
        break;
    }
  };

  // --- USER PERSISTENCE (SCOPED PER CLIENT) ---
  const saveUsersToFirebase = async (client, updatedUsersArray) => {
    try {
      setActionLoading(true);
      const token = localStorage.getItem("cd_session_token");
      const res = await fetch("/api/superadmin/tenants", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          tenantId: client ? client.id : "primary_client",
          userUpdates: updatedUsersArray,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update users");
      }
    } catch (error) {
      console.error("Error saving users:", error);
      alert("Failed to save changes to the database: " + error.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSavePassword = async () => {
    if (!newPassword.trim()) return;
    const updatedClients = [...clients];
    const targetClient = updatedClients[editingUser.clientIndex];
    const targetUsers = targetClient.users;
    targetUsers[editingUser.userIndex].password = newPassword;

    await saveUsersToFirebase(targetClient, targetUsers);

    recordAuditTrail(pulseLogger, "user_role_changed", {
      who: localStorage.getItem("currentSuperAdmin") || "superadmin",
      target: `client_${targetClient.id}_user_${editingUser.userIndex}`,
      status: "success",
      reason: "Password updated",
    });

    setClients(updatedClients);
    setEditingUser(null);
    setNewPassword("");
  };

  const handleAddUser = async (clientIndex) => {
    if (!newUser.name.trim() || !newUser.password.trim()) return;
    const updatedClients = [...clients];
    const targetClient = updatedClients[clientIndex];
    const targetUsers = targetClient.users;
    targetUsers.push({ ...newUser, role: "admin" });

    await saveUsersToFirebase(targetClient, targetUsers);

    recordAuditTrail(pulseLogger, "client_updated", {
      who: localStorage.getItem("currentSuperAdmin") || "superadmin",
      target: `client_${targetClient.id}`,
      newState: newUser,
      status: "success",
      reason: "New user allocated",
    });

    setClients(updatedClients);
    setNewUser({ name: "", password: "" });
    setIsAddingUser(false);
  };

  const handleDeleteUser = async (clientIndex, userIndex) => {
    if (!window.confirm("Are you sure you want to delete this user?")) return;
    const updatedClients = [...clients];
    const targetClient = updatedClients[clientIndex];
    const targetUsers = targetClient.users;
    const userBeingDeleted = targetUsers[userIndex];

    targetUsers.splice(userIndex, 1);
    await saveUsersToFirebase(targetClient, targetUsers);

    recordAuditTrail(pulseLogger, "user_deleted", {
      who: localStorage.getItem("currentSuperAdmin") || "superadmin",
      target: `client_${targetClient.id}`,
      user: userBeingDeleted?.name,
      status: "success",
    });

    setClients(updatedClients);
  };

  const handleSaveProfile = async () => {
    setActionLoading(true);
    try {
      const nowIso = new Date().toISOString();
      const targetClient = viewingProfile;

      if (!targetClient || targetClient.id === "primary_client") {
        const updates = {
          "settings/business_profile/basic_info/address":
            editedProfileData.address || "",
          "settings/business_profile/basic_info/avgJobValue":
            editedProfileData.avgJobValue || "",
          "settings/business_profile/basic_info/businessName":
            editedProfileData.businessName || "",
          "settings/business_profile/basic_info/email":
            editedProfileData.email || "",
          "settings/business_profile/basic_info/industry":
            editedProfileData.industry || "",
          "settings/business_profile/basic_info/phone":
            editedProfileData.phone || "",
          "settings/business_profile/basic_info/website":
            editedProfileData.website || "",
          "settings/business_profile/timezone":
            editedProfileData.timezone || "America/New_York",
          "settings/business_profile/updated_at": nowIso,
        };
        await update(ref(db), updates);
      } else {
        const tenantUpdates = {
          [`tenants/${targetClient.id}/business_profile/basic_info`]: {
            businessName: editedProfileData.businessName || "",
            email: editedProfileData.email || "",
            phone: editedProfileData.phone || "",
            website: editedProfileData.website || "",
            industry: editedProfileData.industry || "",
            address: editedProfileData.address || "",
          },
          [`tenants/${targetClient.id}/business_profile/timezone`]:
            editedProfileData.timezone || "America/New_York",
          [`tenants/${targetClient.id}/business_profile/updated_at`]: nowIso,
          [`tenants/${targetClient.id}/config/business_name`]:
            editedProfileData.businessName || "",
        };
        await update(ref(db), tenantUpdates);
      }

      recordAuditTrail(pulseLogger, "configuration_changed", {
        who: localStorage.getItem("currentSuperAdmin") || "superadmin",
        target: `tenants/${targetClient.id}/business_profile`,
        previousState: targetClient.profile,
        newState: editedProfileData,
      });

      const updatedClients = clients.map((c) =>
        c.id === targetClient.id
          ? {
              ...c,
              profile: {
                ...editedProfileData,
                updated_at: nowIso,
              },
            }
          : c
      );

      setClients(updatedClients);
      setViewingProfile({
        ...targetClient,
        profile: {
          ...editedProfileData,
          updated_at: nowIso,
        },
      });
      setIsEditingProfile(false);
    } catch (error) {
      console.error("Error saving profile:", error);
      alert("Failed to save profile changes.");
    } finally {
      setActionLoading(false);
    }
  };

  // --- AUTO-SLUGIFY TENANT ID ON NAME CHANGE ---
  const handleBusinessNameChange = (name) => {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    setNewClientData((prev) => ({
      ...prev,
      businessName: name,
      tenantId: prev.tenantId && prev.tenantId !== slug ? prev.tenantId : slug,
    }));
  };

  const handleIndustryChange = (industry) => {
    const match = INDUSTRY_OPTIONS.find((opt) => opt.value === industry);
    setNewClientData((prev) => ({
      ...prev,
      industry,
      industryPack: match ? match.pack : "general_v2",
    }));
  };

  // --- CREATE NEW CLIENT HANDLER ---
  const handleCreateNewClient = async (e) => {
    e.preventDefault();
    setAddClientError("");

    const {
      businessName,
      tenantId,
      industry,
      industryPack,
      email,
      phone,
      timezone,
      website,
      adminUsername,
      adminPassword,
      allowedOrigin,
      primaryColor,
    } = newClientData;

    // Validations
    if (!businessName.trim()) {
      setAddClientError("Business Name is required.");
      return;
    }
    if (!tenantId.trim()) {
      setAddClientError("Tenant ID / Identifier is required.");
      return;
    }
    const cleanTenantId = tenantId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (cleanTenantId !== tenantId) {
      setAddClientError("Tenant ID can only contain lowercase letters, numbers, hyphens, and underscores.");
      return;
    }
    if (clients.some((c) => c.id === cleanTenantId)) {
      setAddClientError(`Tenant ID '${cleanTenantId}' already exists. Please choose a unique identifier.`);
      return;
    }
    if (!adminUsername.trim() || !adminPassword.trim()) {
      setAddClientError("Initial Admin Username and Password are required.");
      return;
    }

    setActionLoading(true);
    try {
      const nowIso = new Date().toISOString();
      const originHost =
        typeof window !== "undefined" ? window.location.origin : "https://app.closedesk.ai";

      const tenantPayload = {
        id: cleanTenantId,
        enabled: true,
        created_at: nowIso,
        business_profile: {
          basic_info: {
            businessName: businessName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            website: website.trim(),
            industry: industry,
          },
          timezone: timezone || "America/New_York",
          updated_at: nowIso,
        },
        config: {
          business_name: businessName.trim(),
          industry_pack: industryPack,
          timezone: timezone || "America/New_York",
          allowed_origins: [allowedOrigin.trim() || "*"],
        },
        chatbot_config: {
          bot_name: `${businessName.trim()} Specialist`,
          voiceEnabled: true,
          voice: "alloy",
          serviceCategory: industry,
        },
        appearance: {
          primaryColor: primaryColor || "#0284c7",
          hue: "blue",
        },
        users: {
          "1": {
            name: adminUsername.trim(),
            username: adminUsername.trim(),
            password: adminPassword.trim(),
            role: "admin",
            created_at: nowIso,
          },
        },
      };

      // Write tenant record securely via server API (CD02)
      const token = localStorage.getItem("cd_session_token");
      const createRes = await fetch("/api/superadmin/tenants", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          tenantId: cleanTenantId,
          tenantPayload,
        }),
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create tenant");
      }

      // Record SOC2-style Audit Trail
      recordAuditTrail(pulseLogger, "client_created", {
        who: localStorage.getItem("currentSuperAdmin") || "superadmin",
        target: `tenants/${cleanTenantId}`,
        tenant_id: cleanTenantId,
        industry_pack: industryPack,
        status: "success",
      });

      // Update client state locally
      const createdClientObj = {
        id: cleanTenantId,
        profile: {
          businessName: businessName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          website: website.trim(),
          industry: industry,
          timezone: timezone,
          updated_at: nowIso,
        },
        users: [
          {
            name: adminUsername.trim(),
            password: adminPassword.trim(),
            role: "admin",
          },
        ],
        config: tenantPayload.config,
        isMultiTenant: true,
      };

      setClients((prev) => [...prev, createdClientObj]);

      // Open Success & Embed Snippet Modal
      setCreatedClientModal({
        tenantId: cleanTenantId,
        businessName: businessName.trim(),
        adminUsername: adminUsername.trim(),
        adminPassword: adminPassword.trim(),
        embedSnippet: `<script src="${originHost}/widget.js" data-tenant="${cleanTenantId}" defer></script>`,
      });

      // Reset Form
      setNewClientData(INITIAL_NEW_CLIENT);
      setIsAddingClient(false);
    } catch (error) {
      console.error("Failed to create client:", error);
      setAddClientError("Failed to save new client to Firebase database. Check network or console.");
    } finally {
      setActionLoading(false);
    }
  };

  const closeProfileModal = () => {
    setViewingProfile(null);
    setIsEditingProfile(false);
  };

  const closeUsersModal = () => {
    setManagingUsers(null);
    setEditingUser(null);
    setIsAddingUser(false);
    setRevealedPasswords(new Set());
  };

  const handleToggleActivation = async (client) => {
    if (!client.readiness?.ready) {
      setViewingChecklist(client);
      return;
    }

    const nextState = !client.enabled;
    setActionLoading(true);
    try {
      const token = localStorage.getItem("cd_session_token");
      const res = await fetch("/api/superadmin/tenants", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          tenantId: client.id,
          updates: {
            enabled: nextState,
            activation_status: nextState ? TENANT_ACTIVATION_STATUS.ACTIVE : TENANT_ACTIVATION_STATUS.PENDING_SETUP,
          },
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update tenant activation state");
      }

      setClients((prev) =>
        prev.map((c) => (c.id === client.id ? { ...c, enabled: nextState } : c))
      );

      recordAuditTrail(pulseLogger, "tenant_activation_toggled", {
        who: localStorage.getItem("currentSuperAdmin") || "superadmin",
        tenant_id: client.id,
        enabled: nextState,
        status: "success",
      });
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const copyToClipboard = (text, label) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopySuccess(label);
      setTimeout(() => setCopySuccess(""), 3000);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-96 flex flex-col items-center justify-center gap-4">
        <svg
          className="animate-spin h-8 w-8 text-[var(--primary)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <path
            d="M21 12a9 9 0 1 1-6.219-8.56"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <p className="text-[var(--foreground-muted)] font-bold">
          Syncing client directory with database...
        </p>
      </div>
    );
  }

  return (
    <div className="w-full relative">
      {/* HEADER SECTION */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-2xl font-black text-[var(--foreground)]">
            Client Directory
          </h2>
          <p className="text-[var(--foreground-muted)] font-medium text-sm mt-1">
            Manage multi-tenant client profiles, staff access, and embed snippets.
          </p>
        </div>
        <button
          onClick={() => {
            setAddClientError("");
            setIsAddingClient(true);
          }}
          className="px-5 py-2.5 bg-[var(--primary)] text-white text-sm font-bold rounded-xl shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Add New Client
        </button>
      </div>

      {/* CLIENT GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {clients.map((client, cIdx) => (
          <div
            key={client.id}
            className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm hover:shadow-[0_4px_20px_var(--lead-glow)] transition-all flex flex-col"
          >
            <div className="flex justify-between items-start mb-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-[var(--primary)]/10 text-[var(--primary)] flex items-center justify-center font-black text-xl border border-[var(--primary)]/20 uppercase">
                  {client.profile.businessName
                    ? client.profile.businessName.charAt(0)
                    : "C"}
                </div>
                <div>
                  <h3 className="text-lg font-bold text-[var(--foreground)]">
                    {client.profile.businessName || "Unnamed Business"}
                  </h3>
                  <div className="flex items-center gap-2 text-[var(--foreground-muted)] text-xs font-medium mt-1">
                    {client.enabled ? (
                      <span className="flex items-center gap-1.5 font-bold text-xs text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        Active
                      </span>
                    ) : client.readiness?.status === TENANT_ACTIVATION_STATUS.RESTRICTED ? (
                      <span className="flex items-center gap-1.5 font-bold text-xs text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                        Restricted ({client.readiness?.passedCount || 0}/7)
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 font-bold text-xs text-rose-500 bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20">
                        <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                        Pending Setup ({client.readiness?.passedCount || 0}/7)
                      </span>
                    )}
                    <span>•</span>
                    <span className="px-2 py-0.5 rounded-md bg-[var(--background)] border border-[var(--border-color)] font-mono text-[10px]">
                      {client.id}
                    </span>
                    <span>•</span>
                    <span>{client.profile.industry || "General"}</span>
                  </div>
                </div>
              </div>
              <span className="px-3 py-1 bg-[var(--background)] border border-[var(--border-color)] rounded-lg text-xs font-bold text-[var(--foreground)]">
                {client.users.length} {client.users.length === 1 ? "User" : "Users"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4 p-4 bg-[var(--background)] rounded-xl border border-[var(--border-color)]">
              <div>
                <p className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider">
                  Email
                </p>
                <p className="text-sm font-semibold text-[var(--foreground)] truncate">
                  {client.profile.email || "—"}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider">
                  Phone
                </p>
                <p className="text-sm font-semibold text-[var(--foreground)] truncate">
                  {client.profile.phone || "—"}
                </p>
              </div>
            </div>

            {/* 7-Item Operational Readiness Pills */}
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--foreground-muted)]">
                  Activation Readiness
                </span>
                <span className="text-[10px] font-mono font-bold text-[var(--foreground)]">
                  {client.readiness?.passedCount || 0}/7 items ({client.readiness?.score || 0}%)
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CHECKLIST_METADATA.map((meta) => {
                  const item = client.readiness?.checklist?.[meta.key];
                  const passed = Boolean(item?.passed);
                  return (
                    <span
                      key={meta.key}
                      title={`${meta.label}: ${passed ? "Ready" : "Incomplete"}`}
                      className={`text-[10px] font-medium px-2 py-0.5 rounded-md border flex items-center gap-1 transition-colors ${
                        passed
                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/25"
                          : "bg-neutral-800/60 text-neutral-400 border-neutral-700/60"
                      }`}
                    >
                      <span>{meta.icon}</span>
                      <span>{meta.label}</span>
                      <span className="font-bold">{passed ? "✓" : "✗"}</span>
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="mt-auto pt-3 border-t border-[var(--border-color)] flex flex-wrap gap-2">
              <button
                onClick={() => setViewingProfile(client)}
                className="flex-1 min-w-[70px] py-2 rounded-xl border border-[var(--border-color)] text-[var(--foreground)] text-xs font-bold hover:bg-[var(--background)] hover:border-[var(--primary)] transition-all"
              >
                Profile
              </button>
              <button
                onClick={() => setManagingUsers({ client, cIdx })}
                className="flex-1 min-w-[70px] py-2 rounded-xl bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 text-xs font-bold hover:bg-[var(--primary)] hover:text-white transition-all"
              >
                Users ({client.users.length})
              </button>
              <button
                onClick={() => setViewingChecklist(client)}
                className="py-2 px-3 rounded-xl border border-[var(--border-color)] bg-[var(--background)] text-[var(--foreground)] text-xs font-bold hover:border-amber-500/50 transition-all flex items-center gap-1.5"
              >
                <span>Checklist</span>
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                  client.readiness?.ready ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/20 text-amber-400"
                }`}>
                  {client.readiness?.passedCount || 0}/7
                </span>
              </button>
              {client.id !== "primary_client" && (
                <button
                  onClick={() => handleToggleActivation(client)}
                  disabled={actionLoading}
                  title={
                    !client.enabled && !client.readiness?.ready
                      ? "Cannot activate: Operational readiness checklist incomplete (all 7 required)"
                      : client.enabled
                      ? "Deactivate tenant"
                      : "Activate tenant"
                  }
                  className={`py-2 px-3 rounded-xl text-xs font-bold border transition-all ${
                    client.enabled
                      ? "border-rose-500/30 text-rose-400 bg-rose-500/10 hover:bg-rose-500 hover:text-white"
                      : client.readiness?.ready
                      ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500 hover:text-white"
                      : "border-neutral-700 text-neutral-500 bg-neutral-800/40 cursor-not-allowed opacity-60"
                  }`}
                >
                  {client.enabled ? "Deactivate" : "Activate"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ======================================================== */}
      {/* 🚀 MODAL 1: ADD NEW CLIENT (MULTI-TENANT WIZARD)         */}
      {/* ======================================================== */}
      {isAddingClient && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !actionLoading && setIsAddingClient(false)}
          ></div>
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-6 sm:p-8 max-w-2xl w-full relative z-50 shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar flex flex-col">
            <div className="flex justify-between items-center mb-6 shrink-0 border-b border-[var(--border-color)] pb-4">
              <div>
                <h3 className="text-xl font-black text-[var(--foreground)]">
                  Provision New Tenant
                </h3>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  Create an isolated client partition with customized rules & staff login.
                </p>
              </div>
              <button
                disabled={actionLoading}
                onClick={() => setIsAddingClient(false)}
                className="p-2 text-[var(--foreground-muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--background)] transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {addClientError && (
              <div className="p-3 mb-6 bg-red-500/10 border border-red-500/30 rounded-xl text-red-500 text-xs font-bold">
                ⚠️ {addClientError}
              </div>
            )}

            <form onSubmit={handleCreateNewClient} className="space-y-6">
              {/* SECTION: BASIC INFO */}
              <div>
                <h4 className="text-xs font-black uppercase text-[var(--primary)] tracking-wider mb-3">
                  1. Company & Tenant Identity
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Business Name *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Apex Emergency Plumbing"
                      value={newClientData.businessName}
                      onChange={(e) => handleBusinessNameChange(e.target.value)}
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Tenant Identifier (Slug) *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. apex_plumbing"
                      value={newClientData.tenantId}
                      onChange={(e) =>
                        setNewClientData({
                          ...newClientData,
                          tenantId: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                    <span className="text-[10px] text-[var(--foreground-muted)] mt-1 block">
                      Used in &lt;script data-tenant="{newClientData.tenantId || "slug"}"&gt;
                    </span>
                  </div>
                </div>
              </div>

              {/* SECTION: INDUSTRY & RULES */}
              <div>
                <h4 className="text-xs font-black uppercase text-[var(--primary)] tracking-wider mb-3">
                  2. Industry Intelligence Pack
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Service Industry *
                    </label>
                    <select
                      value={newClientData.industry}
                      onChange={(e) => handleIndustryChange(e.target.value)}
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    >
                      {INDUSTRY_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Assigned Pack Version
                    </label>
                    <input
                      type="text"
                      readOnly
                      value={newClientData.industryPack}
                      className="w-full bg-[var(--background)]/50 border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-mono text-[var(--foreground-muted)] cursor-not-allowed outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* SECTION: CONTACT & LOCATION */}
              <div>
                <h4 className="text-xs font-black uppercase text-[var(--primary)] tracking-wider mb-3">
                  3. Operational Contact & Timezone
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Dispatch Email
                    </label>
                    <input
                      type="email"
                      placeholder="dispatch@client.com"
                      value={newClientData.email}
                      onChange={(e) =>
                        setNewClientData({ ...newClientData, email: e.target.value })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Emergency Phone
                    </label>
                    <input
                      type="text"
                      placeholder="(555) 000-0000"
                      value={newClientData.phone}
                      onChange={(e) =>
                        setNewClientData({ ...newClientData, phone: e.target.value })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Timezone
                    </label>
                    <select
                      value={newClientData.timezone}
                      onChange={(e) =>
                        setNewClientData({ ...newClientData, timezone: e.target.value })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    >
                      <option value="America/New_York">Eastern (US)</option>
                      <option value="America/Chicago">Central (US)</option>
                      <option value="America/Denver">Mountain (US)</option>
                      <option value="America/Los_Angeles">Pacific (US)</option>
                      <option value="UTC">UTC Universal</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* SECTION: ADMIN CREDENTIALS */}
              <div>
                <h4 className="text-xs font-black uppercase text-[var(--primary)] tracking-wider mb-3">
                  4. Initial Tenant Admin Credentials
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Admin Username *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. apex_admin"
                      value={newClientData.adminUsername}
                      onChange={(e) =>
                        setNewClientData({ ...newClientData, adminUsername: e.target.value })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-bold text-[var(--foreground-muted)] mb-1 block">
                      Admin Password *
                    </label>
                    <input
                      type="password"
                      required
                      placeholder="••••••••••••"
                      value={newClientData.adminPassword}
                      onChange={(e) =>
                        setNewClientData({ ...newClientData, adminPassword: e.target.value })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* SUBMIT BUTTONS */}
              <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="flex-1 py-3 bg-[var(--primary)] text-white text-sm font-bold rounded-xl shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                >
                  {actionLoading ? (
                    <>
                      <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="10" strokeWidth="4" className="opacity-25" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M4 12a8 8 0 018-8" className="opacity-75" />
                      </svg>
                      Provisioning Tenant in Database...
                    </>
                  ) : (
                    "Create Client Tenant"
                  )}
                </button>
                <button
                  type="button"
                  disabled={actionLoading}
                  onClick={() => setIsAddingClient(false)}
                  className="px-6 py-3 border border-[var(--border-color)] text-[var(--foreground)] text-sm font-bold rounded-xl hover:bg-[var(--background)] transition-all"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 🎉 MODAL 2: CREATED TENANT SUCCESS & EMBED SNIPPET       */}
      {/* ======================================================== */}
      {createdClientModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/75 backdrop-blur-md"
            onClick={() => setCreatedClientModal(null)}
          ></div>
          <div className="bg-[var(--card-bg)] border border-emerald-500/40 rounded-3xl p-6 sm:p-8 max-w-xl w-full relative z-50 shadow-2xl flex flex-col">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center justify-center">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <h3 className="text-xl font-black text-[var(--foreground)]">
                  Tenant Successfully Created!
                </h3>
                <p className="text-xs text-[var(--foreground-muted)]">
                  {createdClientModal.businessName} is ready to deploy.
                </p>
              </div>
            </div>

            {/* EMBED CODE BOX */}
            <div className="mt-4 mb-4">
              <div className="flex justify-between items-center mb-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-[var(--primary)]">
                  Website Embed Snippet
                </label>
                <button
                  onClick={() =>
                    copyToClipboard(createdClientModal.embedSnippet, "embed")
                  }
                  className="text-xs font-bold text-[var(--primary)] hover:underline flex items-center gap-1"
                >
                  {copySuccess === "embed" ? "✓ Copied!" : "Copy Code"}
                </button>
              </div>
              <div className="p-3 bg-[var(--background)] rounded-xl border border-[var(--border-color)] font-mono text-xs text-[var(--foreground)] break-all select-all">
                {createdClientModal.embedSnippet}
              </div>
              <p className="text-[11px] text-[var(--foreground-muted)] mt-1.5">
                Paste this 1-line script tag before the closing &lt;/body&gt; tag on the client's website (WordPress, Webflow, Shopify, or HTML).
              </p>
            </div>

            {/* CREDENTIALS BOX */}
            <div className="p-4 bg-[var(--background)] rounded-xl border border-[var(--border-color)] mb-6">
              <p className="text-xs font-bold text-[var(--foreground)] mb-2 uppercase tracking-wider">
                Client Dashboard Login (/lg)
              </p>
              <div className="grid grid-cols-2 gap-4 text-xs font-mono">
                <div>
                  <span className="text-[var(--foreground-muted)] block text-[10px] uppercase font-bold">Username</span>
                  <span className="font-bold text-[var(--foreground)]">{createdClientModal.adminUsername}</span>
                </div>
                <div>
                  <span className="text-[var(--foreground-muted)] block text-[10px] uppercase font-bold">Password</span>
                  <span className="font-bold text-[var(--foreground)]">{createdClientModal.adminPassword}</span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setCreatedClientModal(null)}
              className="w-full py-3 bg-[var(--primary)] text-white text-sm font-bold rounded-xl shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 transition-all"
            >
              Done & Return to Directory
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 👁️ MODAL 3: VIEW / EDIT BUSINESS PROFILE                 */}
      {/* ======================================================== */}
      {viewingProfile && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeProfileModal}
          ></div>
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-8 max-w-2xl w-full relative z-50 shadow-2xl max-h-[85vh] overflow-y-auto custom-scrollbar flex flex-col">
            <div className="flex justify-between items-center mb-6 shrink-0 border-b border-[var(--border-color)] pb-4">
              <div>
                <h3 className="text-xl font-black text-[var(--foreground)]">
                  Business Profile
                </h3>
                <p className="text-xs text-[var(--foreground-muted)] mt-1 font-mono">
                  Tenant: {viewingProfile.id}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {!isEditingProfile && (
                  <button
                    onClick={() => requestPinAuth({ type: "EDIT_PROFILE" })}
                    className="flex items-center gap-2 px-3 py-1.5 bg-[var(--primary)]/10 text-[var(--primary)] text-xs font-bold rounded-lg border border-[var(--primary)]/20 hover:bg-[var(--primary)] hover:text-white transition-colors"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                      />
                    </svg>
                    Edit Profile
                  </button>
                )}
                <button
                  onClick={closeProfileModal}
                  className="text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors p-1"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>

            <div className="space-y-6">
              {/* Profile Details */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Business Name
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="text"
                      value={editedProfileData.businessName || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          businessName: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.businessName || "—"}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Industry
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="text"
                      value={editedProfileData.industry || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          industry: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.industry || "—"}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Email
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="email"
                      value={editedProfileData.email || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          email: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.email || "—"}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Phone
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="text"
                      value={editedProfileData.phone || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          phone: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.phone || "—"}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Website
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="text"
                      value={editedProfileData.website || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          website: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.website || "—"}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-[var(--foreground-muted)] tracking-wider mb-1 block">
                    Timezone
                  </label>
                  {isEditingProfile ? (
                    <input
                      type="text"
                      value={editedProfileData.timezone || ""}
                      onChange={(e) =>
                        setEditedProfileData({
                          ...editedProfileData,
                          timezone: e.target.value,
                        })
                      }
                      className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm font-semibold text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  ) : (
                    <p className="text-sm font-bold text-[var(--foreground)]">
                      {viewingProfile.profile.timezone || "—"}
                    </p>
                  )}
                </div>
              </div>

              {/* Embed snippet view inside profile */}
              <div className="p-4 bg-[var(--background)] rounded-xl border border-[var(--border-color)]">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] uppercase font-bold text-[var(--primary)] tracking-wider">
                    Client Embed Script
                  </span>
                  <button
                    onClick={() =>
                      copyToClipboard(
                        `<script src="${typeof window !== "undefined" ? window.location.origin : ""}/widget.js" data-tenant="${viewingProfile.id}" defer></script>`,
                        "profile_embed"
                      )
                    }
                    className="text-xs font-bold text-[var(--primary)] hover:underline"
                  >
                    {copySuccess === "profile_embed" ? "✓ Copied" : "Copy"}
                  </button>
                </div>
                <div className="font-mono text-xs text-[var(--foreground-muted)] break-all select-all">
                  &lt;script src="{typeof window !== "undefined" ? window.location.origin : ""}/widget.js" data-tenant="{viewingProfile.id}" defer&gt;&lt;/script&gt;
                </div>
              </div>

              {isEditingProfile && (
                <div className="flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
                  <button
                    onClick={() => setIsEditingProfile(false)}
                    className="px-4 py-2 rounded-xl border border-[var(--border-color)] text-[var(--foreground)] text-sm font-bold hover:bg-[var(--background)] transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={actionLoading}
                    onClick={handleSaveProfile}
                    className="px-5 py-2 rounded-xl bg-[var(--primary)] text-white text-sm font-bold shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 disabled:opacity-50 transition-all flex items-center gap-2"
                  >
                    {actionLoading ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 👥 MODAL 4: MANAGE TENANT USERS                           */}
      {/* ======================================================== */}
      {managingUsers && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closeUsersModal}
          ></div>
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-8 max-w-2xl w-full relative z-50 shadow-2xl max-h-[85vh] overflow-y-auto custom-scrollbar flex flex-col">
            <div className="flex justify-between items-center mb-6 shrink-0 border-b border-[var(--border-color)] pb-4">
              <div>
                <h3 className="text-xl font-black text-[var(--foreground)]">
                  Manage Users
                </h3>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  Tenant: {managingUsers.client.profile.businessName || managingUsers.client.id}
                </p>
              </div>
              <button
                onClick={closeUsersModal}
                className="text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors p-1"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              {managingUsers.client.users.map((user, uIdx) => (
                <div
                  key={uIdx}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-[var(--background)] rounded-xl border border-[var(--border-color)] gap-3"
                >
                  <div>
                    <h5 className="font-bold text-sm text-[var(--foreground)] flex items-center gap-2">
                      {user.name || user.username || "User"}
                      <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--primary)]/10 text-[var(--primary)] font-bold">
                        {user.role || "Admin"}
                      </span>
                    </h5>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs font-mono text-[var(--foreground-muted)]">
                        Password:
                      </span>
                      <span className="text-xs font-mono text-[var(--foreground)] font-bold">
                        {revealedPasswords.has(uIdx) ? user.password : "••••••••"}
                      </span>
                      <button
                        onClick={() =>
                          requestPinAuth({
                            type: "REVEAL_PASSWORD",
                            userIndex: uIdx,
                          })
                        }
                        className="text-[11px] font-bold text-[var(--primary)] hover:underline ml-1"
                      >
                        {revealedPasswords.has(uIdx) ? "" : "Reveal"}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-center">
                    <button
                      onClick={() =>
                        requestPinAuth({
                          type: "EDIT_PASSWORD",
                          payload: {
                            clientIndex: managingUsers.cIdx,
                            userIndex: uIdx,
                            name: user.name || user.username,
                            password: user.password,
                          },
                        })
                      }
                      className="px-3 py-1.5 bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 text-xs font-bold rounded-lg hover:bg-[var(--primary)] hover:text-white transition-all"
                    >
                      Reset Password
                    </button>
                    <button
                      onClick={() => handleDeleteUser(managingUsers.cIdx, uIdx)}
                      className="px-3 py-1.5 bg-red-500/10 text-red-500 border border-red-500/20 text-xs font-bold rounded-lg hover:bg-red-500 hover:text-white transition-all"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}

              {/* Password Edit Box */}
              {editingUser && (
                <div className="p-4 bg-[var(--card-bg)] border border-[var(--primary)] rounded-xl mt-4">
                  <h6 className="text-xs font-bold text-[var(--primary)] uppercase mb-2">
                    Reset Password for {editingUser.name}
                  </h6>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      placeholder="Enter new password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="flex-1 bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                    <button
                      disabled={actionLoading || !newPassword.trim()}
                      onClick={handleSavePassword}
                      className="px-4 py-2 bg-[var(--primary)] text-white text-xs font-bold rounded-xl hover:opacity-90 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditingUser(null);
                        setNewPassword("");
                      }}
                      className="px-3 py-2 border border-[var(--border-color)] text-[var(--foreground-muted)] text-xs font-bold rounded-xl"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Add User Box */}
              {isAddingUser ? (
                <div className="p-4 bg-[var(--background)] border border-[var(--primary)]/30 rounded-xl mt-4 space-y-3">
                  <h6 className="text-xs font-bold text-[var(--primary)] uppercase">
                    Allocate New Staff Account
                  </h6>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      placeholder="Username"
                      value={newUser.name}
                      onChange={(e) =>
                        setNewUser({ ...newUser, name: e.target.value })
                      }
                      className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                    <input
                      type="password"
                      placeholder="Password"
                      value={newUser.password}
                      onChange={(e) =>
                        setNewUser({ ...newUser, password: e.target.value })
                      }
                      className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)] outline-none"
                    />
                  </div>
                  <div className="flex gap-2 justify-end pt-2">
                    <button
                      onClick={() => setIsAddingUser(false)}
                      className="px-4 py-2 border border-[var(--border-color)] text-xs font-bold rounded-xl text-[var(--foreground-muted)]"
                    >
                      Cancel
                    </button>
                    <button
                      disabled={actionLoading || !newUser.name.trim() || !newUser.password.trim()}
                      onClick={() => handleAddUser(managingUsers.cIdx)}
                      className="px-5 py-2 bg-[var(--primary)] text-white text-xs font-bold rounded-xl hover:opacity-90 disabled:opacity-50"
                    >
                      Add User
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setIsAddingUser(true)}
                  className="w-full py-3.5 border-2 border-dashed border-[var(--border-color)] rounded-2xl text-[var(--foreground-muted)] font-bold text-sm hover:border-[var(--primary)] hover:text-[var(--primary)] hover:bg-[var(--primary)]/5 transition-all flex items-center justify-center gap-2 mt-4"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Allocate New Staff Account
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 🔒 MODAL 5: PIN SECURITY AUTHORIZATION                   */}
      {/* ======================================================== */}
      {pinModal.isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-md"
            onClick={() =>
              setPinModal({ isOpen: false, action: null, error: "" })
            }
          ></div>
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-8 max-w-sm w-full relative z-[70] shadow-[0_0_50px_rgba(0,0,0,0.5)]">
            <div className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-full bg-[var(--logo-politico-red)]/10 text-[var(--logo-politico-red)] flex items-center justify-center mb-4 border border-[var(--logo-politico-red)]/20">
                <svg
                  className="w-8 h-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                  />
                </svg>
              </div>
              <h3 className="text-xl font-black text-[var(--foreground)]">
                Secondary PIN Verification
              </h3>
              <p className="text-[var(--foreground-muted)] text-xs mt-2 mb-6">
                Please enter your Super Admin Secondary Verification PIN or TOTP code to authorize this sensitive action.
              </p>

              <form onSubmit={handlePinSubmit} className="w-full">
                <input
                  type="password"
                  autoFocus
                  maxLength={4}
                  value={pinInput}
                  onChange={handlePinChange}
                  placeholder="••••"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] text-center text-2xl tracking-[0.5em] font-mono px-4 py-3 rounded-xl focus:outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary)]/20 transition-all mb-2"
                />

                {pinModal.error && (
                  <p className="text-[var(--logo-politico-red)] text-xs font-bold mb-4">
                    {pinModal.error}
                  </p>
                )}

                {actionLoading && (
                  <p className="text-[var(--primary)] text-xs font-bold mb-4 animate-pulse">
                    Verifying PIN...
                  </p>
                )}

                <div className="flex mt-6">
                  <button
                    type="button"
                    onClick={() =>
                      setPinModal({ isOpen: false, action: null, error: "" })
                    }
                    className="w-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] font-bold py-3 rounded-xl hover:text-[var(--logo-politico-red)] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 🚀 MODAL: OPERATIONAL ACTIVATION CHECKLIST (CD11)        */}
      {/* ======================================================== */}
      {viewingChecklist && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setViewingChecklist(null)}
          />
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-6 sm:p-8 max-w-2xl w-full relative z-50 shadow-2xl max-h-[90vh] overflow-y-auto custom-scrollbar flex flex-col">
            <div className="flex justify-between items-start mb-6 border-b border-[var(--border-color)] pb-4">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="text-xl font-black text-[var(--foreground)]">
                    Operational Readiness Checklist
                  </h3>
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                    viewingChecklist.readiness?.ready
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                      : viewingChecklist.readiness?.status === TENANT_ACTIVATION_STATUS.RESTRICTED
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                  }`}>
                    {viewingChecklist.readiness?.status?.toUpperCase()}
                  </span>
                </div>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  Tenant: <span className="font-mono text-[var(--foreground)] font-bold">{viewingChecklist.id}</span> ({viewingChecklist.profile?.businessName || "Unnamed"})
                </p>
              </div>
              <button
                onClick={() => setViewingChecklist(null)}
                className="p-2 text-[var(--foreground-muted)] hover:text-[var(--foreground)] rounded-lg hover:bg-[var(--background)] transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Progress Bar & Summary */}
            <div className="mb-6 p-4 bg-[var(--background)] border border-[var(--border-color)] rounded-2xl">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-[var(--foreground-muted)]">
                  Activation Readiness Score
                </span>
                <span className="text-sm font-black font-mono text-[var(--foreground)]">
                  {viewingChecklist.readiness?.passedCount || 0} / 7 items ({viewingChecklist.readiness?.score || 0}%)
                </span>
              </div>
              <div className="w-full h-3 bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-500 ${
                    viewingChecklist.readiness?.ready
                      ? "bg-emerald-500"
                      : viewingChecklist.readiness?.passedCount >= 4
                      ? "bg-amber-500"
                      : "bg-rose-500"
                  }`}
                  style={{ width: `${viewingChecklist.readiness?.score || 0}%` }}
                />
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-2">
                {viewingChecklist.readiness?.ready
                  ? "✅ All 7 operational criteria satisfied. This tenant is fully eligible for production activation."
                  : "⚠️ Tenant activation is strictly gated. All 7 items must pass before this partition can serve live traffic."}
              </p>
            </div>

            {/* 7 Items List */}
            <div className="space-y-3 mb-6">
              {CHECKLIST_METADATA.map((meta, index) => {
                const itemKey = meta.key;
                const itemResult = viewingChecklist.readiness?.checklist?.[itemKey] || {};
                const isPassed = Boolean(itemResult.passed);

                return (
                  <div
                    key={itemKey}
                    className={`p-4 rounded-xl border transition-all ${
                      isPassed
                        ? "bg-emerald-500/5 border-emerald-500/20"
                        : "bg-rose-500/5 border-rose-500/20"
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{meta.icon}</span>
                        <span className="text-sm font-bold text-[var(--foreground)]">
                          {index + 1}. {meta.label}
                        </span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                        isPassed
                          ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-rose-500/20 text-rose-400"
                      }`}>
                        {isPassed ? "Passed" : "Incomplete"}
                      </span>
                    </div>

                    {/* Item Details */}
                    <div className="mt-2 text-xs text-[var(--foreground-muted)]">
                      {itemResult.details && typeof itemResult.details === "object" ? (
                        <pre className="font-mono text-[11px] bg-[var(--background)] p-2 rounded-lg overflow-x-auto text-[var(--foreground)]">
                          {JSON.stringify(itemResult.details, null, 2)}
                        </pre>
                      ) : (
                        <p className="font-mono text-[11px] bg-[var(--background)] p-2 rounded-lg text-[var(--foreground)]">
                          {String(itemResult.details || "None configured")}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Missing Items Summary if Any */}
            {viewingChecklist.readiness?.missing?.length > 0 && (
              <div className="p-4 mb-6 bg-amber-500/10 border border-amber-500/30 rounded-2xl">
                <h4 className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-2">
                  Action Items Required for Activation ({viewingChecklist.readiness.missing.length})
                </h4>
                <ul className="space-y-1.5 text-xs text-[var(--foreground)]">
                  {viewingChecklist.readiness.missing.map((req, rIdx) => (
                    <li key={rIdx} className="flex items-start gap-2">
                      <span className="text-amber-400">•</span>
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Modal Actions */}
            <div className="mt-auto flex justify-end gap-3 pt-4 border-t border-[var(--border-color)]">
              <button
                onClick={() => setViewingChecklist(null)}
                className="px-5 py-2.5 rounded-xl border border-[var(--border-color)] text-[var(--foreground)] text-xs font-bold hover:bg-[var(--background)] transition-all"
              >
                Close
              </button>
              {viewingChecklist.id !== "primary_client" && (
                <button
                  onClick={() => {
                    const target = viewingChecklist;
                    setViewingChecklist(null);
                    handleToggleActivation(target);
                  }}
                  disabled={!viewingChecklist.readiness?.ready || actionLoading}
                  className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all ${
                    viewingChecklist.enabled
                      ? "bg-rose-500 text-white hover:bg-rose-600"
                      : viewingChecklist.readiness?.ready
                      ? "bg-emerald-500 text-white hover:bg-emerald-600"
                      : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
                  }`}
                >
                  {viewingChecklist.enabled ? "Deactivate Tenant" : "Activate Tenant"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--foreground-muted); }
      `,
        }}
      />
    </div>
  );
}
