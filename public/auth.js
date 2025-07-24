import { apiGet, apiPost } from './utils.js';
import { showModal, showToast } from './utils.js';
import { API_BASE } from './config.js';

// --- Helpers ---

function getAuthToken() {
  return document.cookie
    .split('; ')
    .find(r => r.startsWith('authToken='))
    ?.split('=')[1];
}

function authHeaders(json = true) {
  const token = getAuthToken();
  return {
    ...(json && { 'Content-Type': 'application/json' }),
    ...(token && { Authorization: `Bearer ${token}` })
  };
}

// --- Login & Logout ---

export async function handleLogin(event) {
  if (event) event.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const loginStatus = document.getElementById('login-status');

  if (!username || !password) {
    loginStatus.textContent = 'Username and password are required.';
    loginStatus.style.color = 'red';
    return null;
  }

  loginStatus.textContent = 'Logging in…';

  try {
    const data = await apiPost('/login', { username, password });
    if (data.success && data.token) {
      document.cookie = `authToken=${data.token};max-age=604800;path=/;SameSite=Lax`;
      sessionStorage.setItem('attendanceUser', JSON.stringify(data.user));
      if (data.scriptVersion) {
        sessionStorage.setItem('scriptVersion', data.scriptVersion);
      }
      return data;
    } else {
      throw new Error(data.error || 'Invalid username or password.');
    }
  } catch (err) {
    loginStatus.textContent = `Login failed: ${err.message}`;
    loginStatus.style.color = 'red';
    return null;
  }
}

export function handleLogout() {
  sessionStorage.removeItem('attendanceUser');
  document.cookie = 'authToken=; max-age=0; path=/;';
  location.reload();
}

// --- User Management (Admin) ---

export async function loadUsers() {
  try {
    const data = await apiGet('/users');
    if (!data.success) throw new Error(data.error || 'Failed to load users.');

    const currentUser = JSON.parse(sessionStorage.getItem('attendanceUser'));
    const tbody = document.getElementById('user-list-body');
    tbody.innerHTML = '';

    data.users.forEach(user => {
      const isSelf = user.username === currentUser.username;
      const actions = `
        <select class="user-actions-select" data-username="${user.username}">
          <option value="">Select Action</option>
          <option value="change_sp">Change SP Access</option>
          <option value="reset_password">Reset Password</option>
          ${!isSelf ? '<option value="remove">Remove User</option>' : ''}
        </select>
      `;
      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${user.username}</td>
          <td>${user.role}</td>
          <td>${user.spAccess || 'All'}</td>
          <td>${actions}</td>
        </tr>
      `);
    });
  } catch (err) {
    console.error('loadUsers error:', err);
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleAddUser() {
  const uRes = await showModal("Enter new user's username:", { showInput: true, confirmText: 'Next' });
  if (!uRes.confirmed || !uRes.value) return;

  const pRes = await showModal("Enter new user's password:", { showInput: true, inputType: 'password', confirmText: 'Next' });
  if (!pRes.confirmed || !pRes.value) return;

  const rRes = await showModal("Enter role (Admin or User):", { showInput: true, confirmText: 'Next' });
  if (!rRes.confirmed || !rRes.value) return;

  const role = rRes.value.trim();
  if (!['Admin', 'User'].includes(role)) {
    showToast('Role must be "Admin" or "User".', 'error');
    return;
  }

  let spAccess = '';
  if (role === 'User') {
    const spRes = await showModal("Enter SP Access number:", { showInput: true, confirmText: 'Add User' });
    if (!spRes.confirmed || !spRes.value) {
      showToast('SP Access is required for User role.', 'error');
      return;
    }
    spAccess = spRes.value;
  }

  try {
    const data = await apiPost('/users', { username: uRes.value, password: pRes.value, role, spAccess });
    if (data.success) {
      showToast('User added successfully.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to add user: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleRemoveUser(e) {
  if (!e.target.matches('.user-actions-select')) return;
  if (e.target.value !== 'remove') {
    e.target.value = '';
    return;
  }

  const username = e.target.dataset.username;
  const confirm = await showModal(`Remove user "${username}"?`, { confirmText: 'Yes, Remove' });
  if (!confirm.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}`, {
      method: 'DELETE',
      headers: authHeaders(false)
    });
    const data = await res.json();

    if (data.success) {
      showToast('User removed successfully.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to remove user: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  } finally {
    e.target.value = '';
  }
}

// --- Password & Access Updates ---

export async function handleChangePassword() {
  const pRes = await showModal("Enter your new password:", {
    showInput: true, inputType: 'password', confirmText: 'Change Password'
  });
  if (!pRes.confirmed || !pRes.value) {
    showToast('Password cannot be blank.', 'error');
    return;
  }

  try {
    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    const res = await fetch(`${API_BASE}/users/${user.username}/password`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ newPassword: pRes.value })
    });
    const data = await res.json();
    if (data.success) showToast('Password changed successfully.', 'success');
    else throw new Error(data.error);
  } catch (err) {
    showToast(`Failed to change password: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleChangeSpAccess(username) {
  const spRes = await showModal(`Enter new SP Access for ${username} (blank for All):`, {
    showInput: true, confirmText: 'Update'
  });
  if (!spRes.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}/plan`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ plan_id: spRes.value || null })
    });
    const data = await res.json();
    if (data.success) {
      showToast('SP Access updated.', 'success');
      loadUsers();
    } else {
      throw new Error(data.error);
    }
  } catch (err) {
    showToast(`Failed to update SP Access: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}

export async function handleResetPassword(username) {
  const confirm = await showModal(`Reset password for ${username}?`, {
    confirmText: 'Yes, Reset'
  });
  if (!confirm.confirmed) return;

  try {
    const res = await fetch(`${API_BASE}/users/${username}/reset-password`, {
      method: 'POST',
      headers: authHeaders(false)
    });
    const data = await res.json();
    if (data.success) showToast('Password reset.', 'success');
    else throw new Error(data.error);
  } catch (err) {
    showToast(`Failed to reset password: ${err.message}`, 'error');
    if (err.message.includes('Authentication failed')) handleLogout();
  }
}
