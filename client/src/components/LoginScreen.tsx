import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import type { AuthUser, LoginUser, PasswordPolicy } from '../lib/types.js';

interface LoginScreenProps {
  onAuthenticated: (user: AuthUser, mustChangePassword: boolean, csrfToken: string, passwordPolicy: PasswordPolicy) => void;
}

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

export const LoginScreen = ({ onAuthenticated }: LoginScreenProps) => {
  const [users, setUsers] = useState<LoginUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, users]
  );

  useEffect(() => {
    let cancelled = false;

    const loadUsers = async () => {
      setLoadingUsers(true);
      setError(null);
      try {
        const response = await api.listLoginUsers();
        if (cancelled) return;
        setUsers(response.users);
        setSelectedUserId((current) => current ?? response.users[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(`Could not load login users: ${errorMessage(loadError)}`);
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    };

    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      setPassword('');
      window.requestAnimationFrame(() => passwordRef.current?.focus());
    }
  }, [selectedUserId]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedUserId || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await api.login(selectedUserId, password);
      onAuthenticated(response.user, response.mustChangePassword, response.csrfToken, response.passwordPolicy);
    } catch (loginError) {
      setPassword('');
      setError(errorMessage(loginError));
      window.requestAnimationFrame(() => passwordRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen" aria-label="Bear Castle AI sign in">
      <section className="auth-card login-card">
        <div className="auth-brand login-brand" aria-label="Bear Castle AI">
          <span className="app-brand-mark">BC</span>
          <h1>Bear Castle AI</h1>
        </div>

        <div className="login-copy">
          <h2>Choose your account</h2>
        </div>

        <div className="login-user-grid" aria-label="Available users">
          {loadingUsers && <div className="muted padded">Loading users...</div>}
          {!loadingUsers && users.length === 0 && (
            <div className="muted padded">No active login users are available. Check the server bootstrap logs.</div>
          )}
          {users.map((user) => {
            const selected = user.id === selectedUserId;
            return (
              <button
                key={user.id}
                className={`login-user-tile ${selected ? 'selected' : ''}`}
                type="button"
                onClick={() => {
                  setSelectedUserId(user.id);
                  setError(null);
                }}
                aria-pressed={selected}
              >
                <span className="login-avatar" aria-hidden="true">
                  {user.initials}
                </span>
                <span>{user.displayName}</span>
                {user.displayName.toLowerCase() === 'eric' && <small>Admin</small>}
              </button>
            );
          })}
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="login-copy" htmlFor="login-password">
            <h2>Password{selectedUser ? ` for ${selectedUser.displayName}` : ''}</h2>
          </label>
          <input
            id="login-password"
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={!selectedUserId || submitting}
          />
          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}
          <button className="primary-button full-width" type="submit" disabled={!selectedUserId || !password || submitting}>
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
};
