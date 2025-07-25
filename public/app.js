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

import { showModal, clearStrataCache, apiGet, apiPost, showToast, debounce, showMeetingModal } from './utils.js';
import { renderStrataPlans, resetUiOnPlanChange, renderOwnerCheckboxes } from './ui.js';

// --- DOM Elements ---
// It's good practice to declare all DOM element variables at the top.
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const changePasswordBtn = document.getElementById('change-password-btn');
const addUserBtn = document.getElementById('add-user-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const userListBody = document.getElementById('user-list-body');
const loginSection = document.getElementById('login-section');
const mainApp = document.getElementById('main-app');
const userDisplay = document.getElementById('user-display');
const adminPanel = document.getElementById('admin-panel');
const strataPlanSelect = document.getElementById('strata-plan-select');
const lotNumberInput = document.getElementById('lot-number');
const checkInTabBtn = document.getElementById('check-in-tab-btn');

// --- App State ---
// Using a simple object for app state can be very effective.
let currentStrataPlan = null;
let strataPlanCache = {};

// --- Core App Logic ---

/**
 * Handles the logic when a new strata plan is selected from the dropdown.
 * It checks for an existing meeting or prompts to create a new one,
 * then fetches and caches the owner data for that plan.
 * @param {Event} event - The change event from the select element.
 */
async function handlePlanChange(event) {
    const spNumber = event.target.value;
    resetUiOnPlanChange(); // Clear the UI first

    if (!spNumber) {
        return; // Exit if the user selected the placeholder
    }
    
    currentStrataPlan = spNumber;
    // Save the selected plan to a cookie for persistence
    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    
    try {
        // Show a modal to get meeting details from the user.
        const newMeetingData = await showMeetingModal();
        if (!newMeetingData) {
            strataPlanSelect.value = ''; // Reset dropdown if user cancels
            return;
        }

        const { meetingDate, meetingType, quorumTotal } = newMeetingData;

        // Check if a meeting already exists for this plan on the selected date.
        const meetingCheck = await apiGet(`/meetings/${spNumber}/${meetingDate}`);
        let meetingDetails;

        if (meetingCheck.success && meetingCheck.meeting) {
            // If a meeting exists, resume it.
            meetingDetails = meetingCheck.meeting;
            showToast(`Resuming meeting: ${meetingDetails.meeting_type}`, 'info');
        } else {
            // Otherwise, create a new meeting.
            await apiPost('/meetings', { spNumber, meetingDate, meetingType, quorumTotal });
            meetingDetails = {
                meeting_type: meetingType,
                quorum_total: quorumTotal
            };
            showToast('New meeting started!', 'success');
        }

        // Update the UI with the meeting details.
        const formattedDate = new Date(meetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        document.getElementById('meeting-title').textContent = `${meetingDetails.meeting_type} - SP ${spNumber}`;
        document.getElementById('meeting-date').textContent = formattedDate;

        // Fetch owner data, using localStorage as a cache to reduce API calls.
        const cachedData = localStorage.getItem(`strata_${spNumber}`);
        if (cachedData) {
            strataPlanCache = JSON.parse(cachedData);
        } else {
            const data = await apiGet(`/strata-plans/${spNumber}/owners`);
            if (!data.success) throw new Error(data.error);

            // Transform the array of owner objects into a more efficient lookup map.
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
        
        // Enable the lot number input now that data is loaded.
        lotNumberInput.disabled = false;
        lotNumberInput.focus();
        
    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}`, 'error');
        resetUiOnPlanChange(); // Reset UI on error
    }
}

/**
 * A debounced function to render owner checkboxes. This prevents the UI from
 * updating on every single keystroke in the lot number input, improving performance.
 */
const debouncedRenderOwners = debounce((lotValue) => {
    if (lotValue && strataPlanCache) {
        renderOwnerCheckboxes(lotValue, strataPlanCache);
    }
}, 300);

// --- UI & App Initialization ---

/**
 * Handles switching between the main "Check-in" and "Admin" tabs.
 * @param {Event} evt - The click event from the tab button.
 * @param {string} tabName - The ID of the tab content to display.
 */
function openTab(evt, tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).style.display = 'block';
    if (evt.currentTarget) {
      evt.currentTarget.classList.add('active');
    }
}

/**
 * Sets up event listeners for elements that only exist in the admin panel.
 * This should only be called after confirming the user is an admin.
 */
function setupAdminEventListeners() {
    const importCsvBtn = document.getElementById('import-csv-btn');
    const csvFileInput = document.getElementById('csv-file-input');
    const csvDropZone = document.getElementById('csv-drop-zone');
    const collapsibleToggle = document.querySelector('.collapsible-toggle');
    const adminTabBtn = document.getElementById('admin-tab-btn'); // Get admin button here

    // Listener for the admin tab itself
    if (adminTabBtn) {
        adminTabBtn.addEventListener('click', (e) => {
            openTab(e, 'admin-tab');
            loadUsers(); // Load user list when tab is opened
        });
    }

    if (importCsvBtn) {
        importCsvBtn.addEventListener('click', () => {
            handleImportCsv(csvFileInput.files[0]);
        });
    }
    
    if (csvDropZone) {
        csvDropZone.addEventListener('click', () => csvFileInput.click());
        
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
    }
    
    if (collapsibleToggle) {
        collapsibleToggle.addEventListener('click', function() {
            this.classList.toggle('active');
            const content = this.nextElementSibling;
            if (content.style.maxHeight) {
                content.style.maxHeight = null;
            } else {
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
    }
}

/**
 * Main application initialization function. Hides the login form, shows the
 * main app, and fetches initial data like the list of strata plans.
 */
async function initializeApp() {
    loginSection.classList.add('hidden');
    mainApp.classList.remove('hidden');

    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    if (user) {
        userDisplay.textContent = user.username;
        // If the user is an Admin, show the admin panel and set up its specific event listeners.
        if (user.role === 'Admin') {
            adminPanel.classList.remove('hidden');
            setupAdminEventListeners(); // This is where admin listeners are now safely added.
        }
    }
    
    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            renderStrataPlans(data.plans);
            
            // If a non-admin user only has access to one plan, auto-select it.
            if (user && user.role !== 'Admin' && data.plans.length === 1) {
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
        showToast('Error: Could not load strata plans.', 'error');
        strataPlanSelect.innerHTML = '<option value="">Error loading plans</option>';
    }
}

// --- Admin Panel & Other Logic ---

/**
 * Handles the "Clear Cache" button click, showing a confirmation modal first.
 */
async function handleClearCache() {
    const res = await showModal(
        "Are you sure you want to clear all cached data? This includes unsynced submissions.",
        { confirmText: 'Yes, Clear Data' }
    );
    if (res.confirmed) {
        clearStrataCache();
        localStorage.removeItem('submissionQueue');
        document.cookie = 'selectedSP=; max-age=0; path=/;'; // Clear selected SP cookie
        location.reload();
    }
}

/**
 * Event delegation for user action dropdowns in the admin panel.
 * @param {Event} e - The change event from the select element.
 */
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
            handleRemoveUser(e); // Pass the event for target access
            break;
    }
    select.value = ""; // Reset dropdown after action
}

// --- Initial Load & Event Listeners ---

/**
 * This runs when the page's DOM is fully loaded. It sets up all the
 * primary event listeners for the application.
 */
document.addEventListener('DOMContentLoaded', () => {
  // --- Always-Present Element Listeners ---
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginResult = await handleLogin(e);
    if (loginResult && loginResult.success) {
        initializeApp();
    }
  });
  
  logoutBtn.addEventListener('click', handleLogout);
  strataPlanSelect.addEventListener('change', handlePlanChange);
  lotNumberInput.addEventListener('input', (e) => {
      debouncedRenderOwners(e.target.value.trim());
  });
  
  checkInTabBtn.addEventListener('click', (e) => openTab(e, 'check-in-tab'));
  
  // --- Admin-Only or Dynamic Element Listeners ---
  // These are for elements that might not be visible initially.
  changePasswordBtn.addEventListener('click', handleChangePassword);
  addUserBtn.addEventListener('click', handleAddUser);
  clearCacheBtn.addEventListener('click', handleClearCache);
  
  // Use event delegation for the user list, as its content is dynamic.
  userListBody.addEventListener('change', handleUserActions);
  
  // --- Auto-Login Check ---
  // Check for an existing auth token in cookies to automatically log the user in.
  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  } else {
      // If no token, make sure the check-in tab is active by default.
      checkInTabBtn.classList.add('active');
      document.getElementById('check-in-tab').style.display = 'block';
  }
});
