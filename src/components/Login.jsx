import React, { useState } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import './Login.css';

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) { setError('Please enter username and password'); return; }
    setLoading(true);
    setError('');

    try {
      const apiBase = await detectApiBase();
      const res = await fetch(`${apiBase}/auth.php?action=login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed'); setLoading(false); return; }
      // Store token
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch (err) {
      setError('Connection failed. Please check server.');
    }
    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
            <rect width="24" height="24" rx="6" fill="#2563eb" />
            <path d="M7 8h10M7 12h10M7 16h6" stroke="white" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <h1>Design Studio</h1>
        </div>
        <p className="login-subtitle">Sign in to your account</p>
        {error && <div className="login-error">{error}</div>}
        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>Username or Email</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              placeholder="admin" autoFocus autoComplete="username" />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••" autoComplete="current-password" />
          </div>
          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
        <p className="login-footer">Print Production System</p>
      </div>
    </div>
  );
}

export default Login;
