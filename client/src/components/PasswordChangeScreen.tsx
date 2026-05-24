import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiClientError } from '../lib/api.js';
import type { AuthUser } from '../lib/types.js';

interface PasswordChangeScreenProps {
  user: AuthUser;
  required?: boolean;
  onChanged: (user: AuthUser, csrfToken: string) => void;
  onCancel?: () => void;
}

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

export const PasswordChangeScreen = ({ user, required = false, onChanged, onCancel }: PasswordChangeScreenProps) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.changePassword(currentPassword, newPassword, confirmPassword);
      onChanged(response.user, response.csrfToken);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (changeError) {
      setError(errorMessage(changeError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className={required ? 'auth-screen' : 'modal-body'} aria-label="Change password">
      <section className={required ? 'auth-card password-card' : 'password-card embedded'}>
        <div className="auth-brand">
          <span className="app-brand-mark">BC</span>
          <div>
            <p className="eyebrow">{required ? 'Required password update' : 'Account security'}</p>
            <h1>{required ? 'Change your password' : 'Change password'}</h1>
          </div>
        </div>

        <p className="auth-help">
          {required
            ? 'You must change your password before continuing to Bear Castle AI.'
            : `Update the password for ${user.displayName}.`}
        </p>

        <form className="auth-form" onSubmit={submit}>
          <label className="field-label" htmlFor="current-password">
            Current password
          </label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
          />

          <label className="field-label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
          />

          <label className="field-label" htmlFor="confirm-password">
            Confirm new password
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
          />

          {error && (
            <div className="auth-error" role="alert">
              {error}
            </div>
          )}

          <div className="button-row">
            {onCancel && !required && (
              <button className="secondary-button" type="button" onClick={onCancel} disabled={submitting}>
                Cancel
              </button>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={!currentPassword || !newPassword || !confirmPassword || submitting}
            >
              {submitting ? 'Saving...' : 'Save password'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
};
