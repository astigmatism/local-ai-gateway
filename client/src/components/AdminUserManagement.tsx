import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import type { AdminUser, AuthUser } from '../lib/types.js';

interface AdminUserManagementProps {
  currentUser: AuthUser;
  onClose: () => void;
}

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

const formatDate = (value: string | null) => {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
};

export const AdminUserManagement = ({ currentUser, onClose }: AdminUserManagementProps) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [newUserTemporaryPassword, setNewUserTemporaryPassword] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listAdminUsers();
      setUsers(response.users);
      setNewUserTemporaryPassword(response.newUserTemporaryPassword || null);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  const createUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) return;

    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.createAdminUser(name);
      setUsers((current) => [response.user, ...current]);
      setDisplayName('');
      setNotice('User created. They must log in with the configured temporary password and change it immediately.');
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setCreating(false);
    }
  };

  const deleteUser = async (user: AdminUser) => {
    if (
      !window.confirm(
        'Delete this user permanently?\n\nThis will remove the user account and all conversation history for this user. This cannot be undone.'
      )
    ) {
      return;
    }

    setBusyUserId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.purgeAdminUser(user.id);
      setUsers((current) => current.filter((item) => item.id !== response.deletedUserId));
      setNotice(`${user.displayName} was permanently deleted.`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusyUserId(null);
    }
  };

  const resetPassword = async (user: AdminUser) => {
    if (!window.confirm(`Reset ${user.displayName}'s password to the configured temporary password?`)) return;

    setBusyUserId(user.id);
    setError(null);
    setNotice(null);
    try {
      const response = await api.resetAdminUserPassword(user.id);
      setUsers((current) => current.map((item) => (item.id === response.user.id ? response.user : item)));
      setNotice(`${user.displayName}'s password was reset. They must change it on next login.`);
    } catch (resetError) {
      setError(errorMessage(resetError));
    } finally {
      setBusyUserId(null);
    }
  };

  const activeAdminCount = users.filter((user) => user.isAdmin && user.isActive && !user.deletedAt).length;
  const temporaryPasswordHint = newUserTemporaryPassword
    ? `Temporary password: ${newUserTemporaryPassword}`
    : 'Temporary password is not configured.';

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="admin-panel" role="dialog" aria-modal="true" aria-label="User management">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Eric administrator</p>
            <h2>User management</h2>
          </div>
          <button className="secondary-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <form className="admin-create-form" onSubmit={createUser}>
          <label className="field-label" htmlFor="new-user-display-name">
            Create user
          </label>
          <div className="inline-form">
            <input
              id="new-user-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Display name"
              maxLength={80}
              aria-describedby="new-user-temporary-password-hint"
            />
            <button type="submit" disabled={creating || !displayName.trim()}>
              {creating ? 'Adding...' : 'Add'}
            </button>
          </div>
          <p id="new-user-temporary-password-hint" className="auth-help">
            {temporaryPasswordHint}
          </p>
        </form>

        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="auth-success" role="status">
            {notice}
          </div>
        )}

        <div className="admin-user-list">
          {loading && <div className="muted padded">Loading users...</div>}
          {!loading &&
            users.map((user) => {
              const isSelf = user.id === currentUser.id;
              const isBootstrapAdmin = user.isAdmin && user.displayName.trim().toLowerCase() === 'eric';
              const isProtectedAdmin = user.isAdmin || user.displayName.trim().toLowerCase() === 'eric';
              const isLastAdmin = user.isAdmin && user.isActive && !user.deletedAt && activeAdminCount <= 1;
              const busy = busyUserId === user.id;
              const deleteDisabledReason = busy
                ? 'Deleting user...'
                : isSelf
                  ? 'You cannot delete your own account.'
                  : isBootstrapAdmin
                    ? 'The default administrator cannot be deleted.'
                    : isLastAdmin
                      ? 'You cannot delete the last administrator.'
                      : undefined;

              return (
                <article key={user.id} className={`admin-user-row ${user.isActive ? '' : 'inactive'}`}>
                  <div className="admin-user-main">
                    <div className="login-avatar" aria-hidden="true">
                      {user.displayName
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) => part[0]?.toUpperCase())
                        .join('') || 'U'}
                    </div>
                    <div>
                      <h3>{user.displayName}</h3>
                      <p>
                        {user.isAdmin ? 'Admin' : 'User'} · {user.isActive ? 'Active' : 'Inactive'} · Last login:{' '}
                        {formatDate(user.lastLoginAt)}
                      </p>
                      {user.mustChangePassword && <span className="admin-chip">Must change password</span>}
                    </div>
                  </div>

                  <div className="admin-user-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void resetPassword(user)}
                      disabled={busy || isSelf || isProtectedAdmin || !user.isActive}
                    >
                      Reset password
                    </button>
                    <button
                      className="secondary-button danger-button"
                      type="button"
                      onClick={() => void deleteUser(user)}
                      disabled={Boolean(deleteDisabledReason)}
                      title={deleteDisabledReason}
                    >
                      {busy ? 'Deleting...' : 'Delete user'}
                    </button>
                  </div>
                </article>
              );
            })}
        </div>
      </section>
    </div>
  );
};
