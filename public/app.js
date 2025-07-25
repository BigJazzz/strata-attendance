import {
  handleLogin,
  handleLogout,
  loadUsers,
  handleAddUser,
  handleChangePassword,
  handleChangeSpAccess,
  handleResetPassword,
  handleRemoveUser
} from './auth.js';

import { showModal, clearStrataCache } from './utils.js';

// --- DOM Elements ---
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const adminTabBtn = document.getElementById('admin-tab-btn');
const changePasswordBtn = document.getElementById('change-password-btn');
const addUserBtn = document.getElementById('add-user-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const userListBody = document.getElementById('user-list-body');

// --- Tab Switching Logic ---
function openTab(evt, tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).style.display = 'block';
    evt.currentTarget.classList.add('active');
}

// --- Admin Panel Logic ---
async function handleClearCache() {
    const res = await showModal(
        "Are you sure you want to clear all cached data? This includes unsynced submissions.",
        { confirmText: 'Yes, Clear Data' }
    );
    if (res.confirmed) {
        clearStrataCache();
        localStorage.removeItem('submissionQueue');
        document.cookie = 'selectedSP=; max-age=0; path=/;';
        location.reload();
    }
}

// This function handles the dropdown actions in the user list
function handleUserActions(e) {
    if (!e.target.matches('.user-actions-select')) return;
    
    const select = e.target;
    const username = select.dataset.username;
    const action = select.value;

    // Return if no action is selected
    if (!action) return;

    switch (action) {
        case 'change_sp':
            handleChangeSpAccess(username);
            break;
        case 'reset_password':
            handleResetPassword(username);
            break;
        case 'remove':
            // The remove handler in auth.js is designed to take an event object.
            // We pass the event object 'e' directly.
            handleRemoveUser(e);
            break;
    }
}

// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
  // Main listeners
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);

  // Tab listeners
  document.getElementById('check-in-tab-btn').addEventListener('click', (e) => openTab(e, 'check-in-tab'));
  adminTabBtn.addEventListener('click', (e) => {
      openTab(e, 'admin-tab');
      // Load users when admin tab is opened for the first time
      const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
      if (user && user.role === 'Admin') {
          loadUsers();
      }
  });

  // Admin panel listeners
  changePasswordBtn.addEventListener('click', handleChangePassword);
  addUserBtn.addEventListener('click', handleAddUser);
  clearCacheBtn.addEventListener('click', handleClearCache);
  userListBody.addEventListener('change', handleUserActions);
});
