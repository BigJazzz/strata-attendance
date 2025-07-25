import {
  handleLogin,
  handleLogout,
  loadUsers,
  handleAddUser,
  handleChangePassword,
  handleChangeSpAccess,
  handleResetPassword,
  handleRemoveUser,
  handleImportCsv
} from './auth.js';

import { showModal, clearStrataCache, apiGet, showToast, debounce } from './utils.js';
import { renderStrataPlans, resetUiOnPlanChange, renderOwnerCheckboxes } from './ui.js';

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
const importCsvBtn = document.getElementById('import-csv-btn');
const csvFileInput = document.getElementById('csv-file-input');
const csvDropZone = document.getElementById('csv-drop-zone');
const strataPlanSelect = document.getElementById('strata-plan-select');
const lotNumberInput = document.getElementById('lot-number');

// --- App State ---
let currentStrataPlan = null;
let strataPlanCache = {};

// --- Core App Logic ---
async function handlePlanChange(event) {
    const spNumber = event.target.value;
    if (!spNumber) {
        resetUiOnPlanChange();
        return;
    }
    
    currentStrataPlan = spNumber;
    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    lotNumberInput.disabled = true;
    
    try {
        const cachedData = localStorage.getItem(`strata_${spNumber}`);
        if (cachedData) {
            strataPlanCache = JSON.parse(cachedData);
        } else {
            const data = await apiGet(`/strata-plans/${spNumber}/owners`);
            if (!data.success) throw new Error(data.error);

            if (Array.isArray(data.owners)) {
                strataPlanCache = data.owners.reduce((acc, owner) => {
                    acc[owner.lot_number] = [owner.main_contact_name, owner.name_on_title, owner.unit_number];
                    return acc;
                }, {});
            } else {
                strataPlanCache = {};
            }
            
            localStorage.setItem(`strata_${spNumber}`, JSON.stringify(strataPlanCache));
        }
        
        lotNumberInput.disabled = false;
        lotNumberInput.focus(); // Set focus to the lot number input
        showToast(`Loaded data for SP ${spNumber}`, 'success');
        
    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}`, 'error');
        resetUiOnPlanChange();
    }
}

// Debounced function to render owners as user types
const debouncedRenderOwners = debounce((lotValue) => {
    if (lotValue && strataPlanCache) {
        renderOwnerCheckboxes(lotValue, strataPlanCache);
    }
}, 300); // 300ms delay


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
    
    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            renderStrataPlans(data.plans);
            
            if (user.role !== 'Admin' && data.plans.length === 1) {
                strataPlanSelect.value = data.plans[0].sp_number;
                strataPlanSelect.disabled = true;
                strataPlanSelect.dispatchEvent(new Event('change'));
            } else {
                strataPlanSelect.disabled = false;
            }
        } else {
            throw new Error(data.error || 'Failed to load strata plans.');
        }
    } catch (err) {
        console.error('Failed to initialize strata plans:', err);
        strataPlanSelect.innerHTML = '<option value="">Error loading plans</option>';
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
    select.value = "";
}

// --- Initial Load & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginResult = await handleLogin(e);
    if (loginResult && loginResult.success) {
        initializeApp();
    }
  });
  
  logoutBtn.addEventListener('click', handleLogout);

  strataPlanSelect.addEventListener('change', handlePlanChange);
  
  // Listen for input in the lot number field
  lotNumberInput.addEventListener('input', (e) => {
      debouncedRenderOwners(e.target.value.trim());
  });

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
  
  // CSV Import Listeners
  importCsvBtn.addEventListener('click', () => {
      handleImportCsv(csvFileInput.files[0]);
  });
  
  csvDropZone.addEventListener('click', () => {
      csvFileInput.click();
  });
  
  csvFileInput.addEventListener('change', () => {
      if(csvFileInput.files.length > 0) {
        document.querySelector('.drop-zone p').textContent = `File selected: ${csvFileInput.files[0].name}`;
      }
  });

  csvDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      csvDropZone.classList.add('drag-over');
  });

  csvDropZone.addEventListener('dragleave', () => {
      csvDropZone.classList.remove('drag-over');
  });

  csvDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      csvDropZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
          csvFileInput.files = files;
          document.querySelector('.drop-zone p').textContent = `File selected: ${files[0].name}`;
          handleImportCsv(files[0]);
      }
  });

  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  }
});