import React, { useState, useEffect } from 'react';
import { detectApiBase } from '../utils/apiConfig';
import './UserManagement.css';

const ALL_PAGES = [
  { id: 'vault', label: 'Vault' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'bgremover', label: 'Artwork Editor' },
  { id: 'mockupv2', label: 'Mockup Preview' },
  { id: 'garments', label: 'Garment Manager' },
  { id: 'gangsheet', label: 'Gang Sheet' },
  { id: 'gscalc', label: 'GS Price Calculator' },
  { id: 'gsoptimize', label: 'GS Optimizer' },
  { id: 'orders', label: 'Mockup Preview (OLD)' },
  { id: 'qa', label: 'QA Analysis' },
  { id: 'contrast', label: 'Contrast Checker' },
  { id: 'ailab', label: 'AI Artwork Lab' },
  { id: 'tasks', label: 'Task Manager' },
  { id: 'users', label: 'User Management' },
];

const ROLES = ['superadmin', 'admin', 'editor', 'viewer'];

function UserManagement({ authUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [formData, setFormData] = useState({ username: '', email: '', password: '', full_name: '', role: 'viewer', page_access: ['tasks', 'bgremover', 'orders'] });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const token = localStorage.getItem('auth_token');
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  const loadUsers = async () => {
    setLoading(true);
    try {
      const base = await detectApiBase();
      const res = await fetch(`${base}/users.php`, { headers });
      if (res.ok) { setUsers(await res.json()); }
      else { const d = await res.json(); setError(d.error || 'Failed to load users'); }
    } catch (e) { setError('Connection failed'); }
    setLoading(false);
  };

  useEffect(() => { loadUsers(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      const base = await detectApiBase();
      const isEdit = !!editUser;
      const url = `${base}/users.php`;
      const method = isEdit ? 'PUT' : 'POST';
      const body = isEdit ? { ...formData, id: editUser.id } : formData;
      // Don't send empty password on edit
      if (isEdit && !body.password) delete body.password;

      const res = await fetch(url, { method, headers, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Operation failed'); return; }
      setSuccess(isEdit ? 'User updated successfully' : 'User created successfully');
      setShowForm(false); setEditUser(null);
      setFormData({ username: '', email: '', password: '', full_name: '', role: 'viewer', page_access: ['tasks', 'bgremover', 'orders'] });
      loadUsers();
    } catch (e) { setError('Connection failed'); }
  };

  const handleEdit = (user) => {
    setEditUser(user);
    setFormData({ username: user.username, email: user.email, password: '', full_name: user.full_name || '', role: user.role, page_access: user.page_access || [] });
    setShowForm(true);
    setError(''); setSuccess('');
  };

  const handleDelete = async (user) => {
    if (!confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      const base = await detectApiBase();
      const res = await fetch(`${base}/users.php`, { method: 'DELETE', headers, body: JSON.stringify({ id: user.id }) });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      setSuccess('User deleted');
      loadUsers();
    } catch (e) { setError('Failed to delete'); }
  };

  const handleToggleActive = async (user) => {
    try {
      const base = await detectApiBase();
      await fetch(`${base}/users.php`, { method: 'PUT', headers, body: JSON.stringify({ id: user.id, is_active: !user.is_active }) });
      loadUsers();
    } catch (e) {}
  };

  const togglePageAccess = (pageId) => {
    setFormData(prev => {
      const access = prev.page_access || [];
      return { ...prev, page_access: access.includes(pageId) ? access.filter(p => p !== pageId) : [...access, pageId] };
    });
  };

  return (
    <div className="um-page">
      <header className="um-header">
        <div>
          <h1 className="um-title">User Management</h1>
          <p className="um-subtitle">{users.length} users registered</p>
        </div>
        <button className="um-btn um-btn-primary" onClick={() => { setShowForm(true); setEditUser(null); setFormData({ username:'', email:'', password:'', full_name:'', role:'viewer', page_access:['tasks','bgremover','orders'] }); setError(''); setSuccess(''); }}>
          + Create User
        </button>
      </header>

      {error && <div className="um-alert um-alert-error">{error}</div>}
      {success && <div className="um-alert um-alert-success">{success}</div>}

      {/* User Form Modal */}
      {showForm && (
        <div className="um-modal-overlay" onClick={() => setShowForm(false)}>
          <div className="um-modal" onClick={e => e.stopPropagation()}>
            <div className="um-modal-header">
              <h2>{editUser ? 'Edit User' : 'Create New User'}</h2>
              <button className="um-modal-close" onClick={() => setShowForm(false)}>×</button>
            </div>
            <form onSubmit={handleSubmit} className="um-form">
              <div className="um-form-grid">
                <div className="um-field">
                  <label>Username</label>
                  <input type="text" value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} required disabled={!!editUser} />
                </div>
                <div className="um-field">
                  <label>Email</label>
                  <input type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} required />
                </div>
                <div className="um-field">
                  <label>Full Name</label>
                  <input type="text" value={formData.full_name} onChange={e => setFormData({...formData, full_name: e.target.value})} />
                </div>
                <div className="um-field">
                  <label>{editUser ? 'New Password (leave blank to keep)' : 'Password'}</label>
                  <input type="password" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} {...(!editUser ? {required: true} : {})} minLength="6" />
                </div>
                <div className="um-field">
                  <label>Role</label>
                  <select value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}>
                    {ROLES.map(r => <option key={r} value={r} disabled={r === 'superadmin' && authUser?.role !== 'superadmin'}>{r}</option>)}
                  </select>
                </div>
              </div>

              <div className="um-field">
                <label>Page Access</label>
                <div className="um-page-grid">
                  {ALL_PAGES.map(page => (
                    <label key={page.id} className="um-page-check">
                      <input type="checkbox" checked={(formData.page_access || []).includes(page.id)} onChange={() => togglePageAccess(page.id)} />
                      <span>{page.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="um-form-actions">
                <button type="button" className="um-btn um-btn-outline" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="um-btn um-btn-primary">{editUser ? 'Update User' : 'Create User'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Users Table */}
      <div className="um-table-wrap">
        <table className="um-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Pages</th>
              <th>Last Login</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan="7" className="um-loading">Loading...</td></tr> :
              users.map(user => (
                <tr key={user.id} className={!user.is_active ? 'um-inactive' : ''}>
                  <td>
                    <div className="um-user-cell">
                      <span className="um-user-name">{user.full_name || user.username}</span>
                      <span className="um-user-username">@{user.username}</span>
                    </div>
                  </td>
                  <td>{user.email}</td>
                  <td><span className={`um-role-badge um-role-${user.role}`}>{user.role}</span></td>
                  <td>
                    <button className={`um-status-btn ${user.is_active ? 'active' : 'inactive'}`} onClick={() => handleToggleActive(user)} title={user.is_active ? 'Click to deactivate' : 'Click to activate'}>
                      {user.is_active ? '● Active' : '○ Inactive'}
                    </button>
                  </td>
                  <td><span className="um-pages-count">{(user.page_access || []).length} pages</span></td>
                  <td className="um-date">{user.last_login ? new Date(user.last_login).toLocaleDateString() : '—'}</td>
                  <td>
                    <div className="um-actions">
                      <button className="um-btn um-btn-sm" onClick={() => handleEdit(user)}>Edit</button>
                      {user.id !== authUser?.id && <button className="um-btn um-btn-sm um-btn-danger" onClick={() => handleDelete(user)}>Delete</button>}
                    </div>
                  </td>
                </tr>
              ))
            }
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UserManagement;
