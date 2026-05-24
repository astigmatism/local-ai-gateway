import { useEffect, useRef, useState } from 'react';
import type { AuthUser } from '../lib/types.js';

interface TopBarProps {
  activeUser: AuthUser;
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

export const TopBar = ({ activeUser, onChangePassword, onOpenUserManagement, onLogout }: TopBarProps) => {
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
    </header>
  );
};
