import React, { useState, useEffect, useRef } from "react";
import { db } from "../../lib/firebase"; // Adjust path to your firebase config
import { ref, onValue, update, remove, get } from "firebase/database"; // Added 'get'

// Helper function to format timestamps into "5m ago", "1h ago", etc.
const formatTimeAgo = (timestamp) => {
  if (!timestamp) return "Just now";
  const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export default function LiveNotifications({ onNavigate }) {
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  // --- 30-DAY AUTO CLEANUP LOGIC ---
  // This runs silently in the background once when the component loads
  useEffect(() => {
    const cleanupArchivedNotifications = async () => {
      try {
        const archiveRef = ref(db, "archived_notifications");
        const snapshot = await get(archiveRef);
        
        if (snapshot.exists()) {
          const data = snapshot.val();
          const now = Date.now();
          const updates = {};
          let hasDeletions = false;

          // Find any archived notifications where 30 days have passed
          Object.keys(data).forEach((key) => {
            if (data[key].expiresAt && data[key].expiresAt < now) {
              updates[`archived_notifications/${key}`] = null;
              hasDeletions = true;
            }
          });

          // Delete them permanently
          if (hasDeletions) {
            await update(ref(db), updates);
            console.log("Cleaned up expired archived notifications.");
          }
        }
      } catch (error) {
        console.error("Error cleaning up archive:", error);
      }
    };

    cleanupArchivedNotifications();
  }, []);


  // --- FETCH LIVE NOTIFICATIONS FROM FIREBASE ---
  useEffect(() => {
    const notificationsRef = ref(db, "notifications");

    const unsubscribe = onValue(notificationsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        // Convert Firebase object to an array and sort by newest first
        const notifArray = Object.keys(data)
          .map((key) => ({
            id: key,
            ...data[key],
          }))
          .sort((a, b) => b.timestamp - a.timestamp);

        setNotifications(notifArray);
      } else {
        setNotifications([]);
      }
    });

    return () => unsubscribe();
  }, []);

  // --- CLOSE ON OUTSIDE CLICK ---
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // --- MARK AS READ LOGIC ---
  const handleMarkAsRead = async (id) => {
    try {
      const updates = {};
      updates[`notifications/${id}/unread`] = false;
      await update(ref(db), updates);
    } catch (error) {
      console.error("Error marking notification as read:", error);
    }
  };

  const handleMarkAllAsRead = async () => {
    try {
      const updates = {};
      notifications.forEach((notif) => {
        if (notif.unread) {
          updates[`notifications/${notif.id}/unread`] = false;
        }
      });
      if (Object.keys(updates).length > 0) {
        await update(ref(db), updates);
      }
    } catch (error) {
      console.error("Error marking all as read:", error);
    }
  };

  // --- REMOVE SINGLE NOTIFICATION LOGIC ---
  const handleRemoveNotification = async (e, id) => {
    e.stopPropagation(); 
    try {
      await remove(ref(db, `notifications/${id}`));
    } catch (error) {
      console.error("Error removing notification:", error);
    }
  };

  // --- ARCHIVE WITH 30-DAY EXPIRATION LOGIC ---
  const handleRemoveAllNotifications = async () => {
    if (notifications.length === 0) return;

    try {
      const updates = {};
      const THIRTY_DAYS_IN_MS = 30 * 24 * 60 * 60 * 1000;
      const archiveExpiry = Date.now() + THIRTY_DAYS_IN_MS;

      // Move all current notifications to archive and remove from active
      notifications.forEach((notif) => {
        const notifData = { 
          ...notif, 
          archivedAt: Date.now(),
          expiresAt: archiveExpiry // Stamp it with the exact time 30 days from now
        };
        
        delete notifData.id; // Clean up the injected ID before saving to DB

        updates[`archived_notifications/${notif.id}`] = notifData;
        updates[`notifications/${notif.id}`] = null;
      });

      // Perform the atomic update to move them securely
      await update(ref(db), updates);

    } catch (error) {
      console.error("Error archiving all notifications:", error);
    }
  };

  const unreadCount = notifications.filter((n) => n.unread).length;

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Icon Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-all shadow-sm"
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
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>

        {/* Live Unread Badge */}
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-red-500 rounded-full transform translate-x-1/4 -translate-y-1/4 ring-2 ring-[var(--background)]">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 mt-3 w-80 sm:w-96 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.3)] overflow-hidden z-50 animate-in fade-in slide-in-from-top-4 duration-200">
          {/* Header */}
          <div className="px-4 py-3 border-b border-[var(--border-color)] flex justify-between items-center bg-[var(--background)]">
            <h3 className="text-sm font-semibold text-[var(--foreground)] flex items-center gap-2">
              Notifications
              {notifications.length > 0 && (
                <span className="bg-[var(--primary)]/10 text-[var(--primary)] py-0.5 px-2 rounded-full text-[10px]">
                  {notifications.length}
                </span>
              )}
            </h3>
          </div>

          {/* Notification List */}
          <div className="max-h-[350px] overflow-y-auto custom-scrollbar flex flex-col">
            {notifications.length > 0 ? (
              notifications.map((notification) => (
                <div
                  key={notification.id}
                  onClick={() => handleMarkAsRead(notification.id)}
                  className={`group relative p-4 border-b border-[var(--border-color)] last:border-0 hover:bg-[var(--background)] transition-colors cursor-pointer flex gap-3 ${
                    notification.unread ? "bg-[var(--primary)]/5" : ""
                  }`}
                >
                  {/* Unread Indicator Dot */}
                  <div className="mt-1.5 shrink-0">
                    <div
                      className={`w-2 h-2 rounded-full ${notification.unread ? "bg-[var(--primary)]" : "bg-transparent"}`}
                    ></div>
                  </div>

                  <div className="flex-1 min-w-0 pr-6">
                    {" "}
                    {/* padding right to avoid text overlapping the delete button */}
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <h4
                        className={`text-sm font-semibold truncate ${
                          notification.unread
                            ? "text-[var(--foreground)]"
                            : "text-[var(--foreground-muted)]"
                        }`}
                      >
                        {notification.title}
                      </h4>
                      <span className="text-[10px] text-[var(--foreground-muted)] whitespace-nowrap mt-0.5">
                        {formatTimeAgo(notification.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--foreground-muted)] line-clamp-2 leading-relaxed">
                      {notification.message}
                    </p>
                  </div>

                  {/* Individual Delete Button (Appears on Hover) */}
                  <button
                    onClick={(e) =>
                      handleRemoveNotification(e, notification.id)
                    }
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-[var(--foreground-muted)] opacity-0 group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-500 transition-all"
                    title="Remove notification"
                  >
                    <svg
                      className="w-4 h-4"
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
              ))
            ) : (
              <div className="p-10 text-center flex flex-col items-center justify-center bg-[var(--card-bg)]">
                <div className="w-12 h-12 rounded-full bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center mb-3">
                  <svg
                    className="w-6 h-6 text-[var(--foreground-muted)] opacity-70"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="1.5"
                      d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2-2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                    />
                  </svg>
                </div>
                <span className="text-sm font-medium text-[var(--foreground)]">
                  All caught up!
                </span>
                <span className="text-xs text-[var(--foreground-muted)] mt-1">
                  No new notifications to display.
                </span>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          {notifications.length > 0 && (
            <div className="px-4 py-3 border-t border-[var(--border-color)] bg-[var(--background)] flex justify-between items-center gap-2">
              {unreadCount > 0 ? (
                <button
                  onClick={handleMarkAllAsRead}
                  className="text-xs font-semibold text-[var(--primary)] hover:text-[var(--secondary)] transition-colors px-2 py-1 rounded hover:bg-[var(--primary)]/10"
                >
                  Mark all read
                </button>
              ) : (
                <span className="text-xs text-[var(--foreground-muted)]">
                  All read
                </span>
              )}

              <button
                onClick={handleRemoveAllNotifications}
                className="text-xs font-semibold text-[var(--foreground-muted)] hover:text-red-500 transition-colors px-2 py-1 rounded hover:bg-red-500/10"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}