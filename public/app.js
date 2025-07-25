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

import { showModal, clearStrataCache, apiGet } from './utils.js';
import { renderStrataPlans } from './ui.js';

// --- DOM Elements ---
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const adminTabBtn = document.getElementById('admin-tab-btn');
const changePasswordBtn = document.getElementById('change-password-btn');
const addUserBtn = document.getElementById('add-user-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const userListBody = document.getElementById('user-list-body');
const loginSection = document.getElementById('login-section');
const mainApp = document.getElementById('main-app');
const userDisplay = document.getElementById('user-display');
const adminPanel = document.getElementById('admin-panel');

// --- UI & App Initialization ---

function openTab(evt, tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).style.display = 'block';
    evt.currentTarget.classList.add('active');
}

async function initializeApp() {
    loginSection.classList.add('hidden');
    mainApp.classList.remove('hidden');

    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    if (user) {
        userDisplay.textContent = user.username;
        if (user.role === 'Admin') {
            adminPanel.classList.remove('hidden');
        }
    }
    
    // Fetch and render strata plans
    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            renderStrataPlans(data.plans);
            document.getElementById('strata-plan-select').disabled = false;
        } else {
            throw new Error(data.error || 'Failed to load strata plans.');
        }
    } catch (err) {
        console.error('Failed to initialize strata plans:', err);
        document.getElementById('strata-plan-select').innerHTML = '<option value="">Error loading plans</option>';
    }
}

// --- Admin Panel & Other Logic ---

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

function handleUserActions(e) {
    if (!e.target.matches('.user-actions-select')) return;
    
    const select = e.target;
    const username = select.dataset.username;
    const action = select.value;

    if (!action) return;

    switch (action) {
        case 'change_sp':
            handleChangeSpAccess(username);
            break;
        case 'reset_password':
            handleResetPassword(username);
            break;
        case 'remove':
            handleRemoveUser(e);
            break;
    }
    select.value = ""; // Reset dropdown after action
}

// --- Initial Load & Event Listeners ---

document.addEventListener('DOMContentLoaded', () => {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginResult = await handleLogin(e); // Pass the event to handleLogin
    if (loginResult && loginResult.success) {
        initializeApp();
    }
  });
  
  logoutBtn.addEventListener('click', handleLogout);

  document.getElementById('check-in-tab-btn').addEventListener('click', (e) => openTab(e, 'check-in-tab'));
  adminTabBtn.addEventListener('click', (e) => {
      openTab(e, 'admin-tab');
      const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
      if (user && user.role === 'Admin') {
          loadUsers();
      }
  });

  changePasswordBtn.addEventListener('click', handleChangePassword);
  addUserBtn.addEventListener('click', handleAddUser);
  clearCacheBtn.addEventListener('click', handleClearCache);
  userListBody.addEventListener('change', handleUserActions);
  
  // Check if already logged in (e.g., page refresh)
  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  }
});