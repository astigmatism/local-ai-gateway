import { useEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { AuthUser } from '../lib/types.js';

interface TopBarProps {
  activeUser: AuthUser;
  settingsButtonRef?: Ref<HTMLButtonElement>;
  onOpenSettings: () => void;
  onChangePassword: () => void;
  onOpenUserManagement: () => void;
  onLogout: () => Promise<void>;
}

const initialsForDisplayName = (displayName: string) =>
  displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'U';

export const TopBar = ({
  activeUser,
  settingsButtonRef,
  onOpenSettings,
  onChangePassword,
  onOpenUserManagement,
  onLogout
}: TopBarProps) => {
  const canManageUsers = activeUser.isAdmin && activeUser.displayName.trim().toLowerCase() === 'eric';
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
      setMenuOpen(false);
    }
  };

  return (
    <header className="app-topbar">
      <div className="app-brand" aria-label="Bear Castle AI">
        <span className="app-brand-mark">BC</span>
        <span className="app-brand-title">BEAR CASTLE AI</span>
      </div>

      <div className="topbar-actions">
        <button
          ref={settingsButtonRef}
          className="settings-button"
          type="button"
          aria-label="Open settings"
          onClick={() => {
            setMenuOpen(false);
            onOpenSettings();
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
            <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.32 7.32 0 0 0-1.7-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42L9.13 5.07c-.61.24-1.18.57-1.7.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.13.22.39.31.62.22l2.47-1c.52.4 1.09.73 1.7.98l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.61-.25 1.18-.58 1.7-.98l2.47 1c.23.09.49 0 .62-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
          </svg>
        </button>

        <div className="user-menu" ref={menuRef}>
          <button
            className="user-menu-trigger"
            type="button"
            aria-label="Open user menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <span aria-hidden="true">{initialsForDisplayName(activeUser.displayName)}</span>
          </button>

          {menuOpen && (
            <div className="user-menu-panel" role="menu">
              <div className="user-menu-section">
                <span className="eyebrow">Signed in</span>
                <strong>{activeUser.displayName}</strong>
                {canManageUsers && <p className="user-menu-note">Administrator</p>}
              </div>

              <div className="user-menu-section menu-actions">
                <button
                  className="secondary-button full-width"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onChangePassword();
                  }}
                >
                  Change password
                </button>

                {canManageUsers && (
                  <button
                    className="secondary-button full-width"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenUserManagement();
                    }}
                  >
                    User management
                  </button>
                )}

                <button
                  className="secondary-button full-width"
                  type="button"
                  role="menuitem"
                  onClick={() => void handleLogout()}
                  disabled={loggingOut}
                >
                  {loggingOut ? 'Logging out...' : 'Logout'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
