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

import { 
    showModal, 
    clearStrataCache, 
    apiGet, 
    apiPost, 
    apiDelete,
    showToast, 
    debounce, 
    showMeetingModal,
    getSubmissionQueue,
    saveSubmissionQueue
} from './utils.js';

import { 
    renderStrataPlans, 
    resetUiOnPlanChange, 
    renderOwnerCheckboxes,
    updateDisplay,
    updateSyncButton
} from './ui.js';

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
let currentStrataPlan = null;
let currentMeetingDate = null;
let strataPlanCache = {};
let currentSyncedAttendees = [];
let currentTotalLots = 0;
let isSyncing = false;
let autoSyncIntervalId = null;
let isAppInitialized = false;

/**
 * Handles the main form submission for checking in an attendee.
 * Instead of sending to the server, it adds the submission to the local queue.
 */
function handleFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const lotNumberInput = document.getElementById('lot-number');
    const companyRepInput = document.getElementById('company-rep');
    const proxyHolderLotInput = document.getElementById('proxy-holder-lot');
    
    const lot = lotNumberInput.value.trim();
    if (!currentStrataPlan || !lot) {
        showToast('Please select a plan and enter a lot number.', 'error');
        return;
    }

    const selectedNames = Array.from(document.querySelectorAll('input[name="owner"]:checked')).map(cb => cb.value);
    const isFinancial = document.getElementById('is-financial').checked;
    const isProxy = document.getElementById('is-proxy').checked;
    const companyRep = companyRepInput.value.trim();
    const proxyHolderLot = proxyHolderLotInput.value.trim();

    if (isProxy && !proxyHolderLot) {
        showToast('Please enter the Proxy Holder Lot Number.', 'error');
        return;
    }
    if (!isProxy && selectedNames.length === 0) {
        showToast('Please select at least one owner.', 'error');
        return;
    }

    const submission = {
        submissionId: `sub_${Date.now()}_${Math.random()}`,
        sp: currentStrataPlan,
        meetingDate: currentMeetingDate,
        lot_number: lot,
        names: selectedNames,
        is_financial: isFinancial,
        is_proxy: isProxy,
        proxyHolderLot: proxyHolderLot,
        companyRep: companyRep
    };

    const queue = getSubmissionQueue();
    queue.push(submission);
    saveSubmissionQueue(queue);

    updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
    showToast(`Lot ${lot} queued for submission.`, 'info');
    
    // Reset form fields
    form.reset();
    document.getElementById('company-rep-group').style.display = 'none';
    document.getElementById('proxy-holder-group').style.display = 'none';
    document.getElementById('checkbox-container').innerHTML = '<p>Enter a Lot Number.</p>';
    lotNumberInput.focus();
}

/**
 * Sends the queued submissions to the server.
 */
async function syncSubmissions() {
    if (isSyncing || !navigator.onLine) return;
    const queue = getSubmissionQueue();
    if (queue.length === 0) {
        updateSyncButton();
        return;
    }

    isSyncing = true;
    updateSyncButton(true);
    showToast(`Syncing ${queue.length} item(s)...`, 'info');

    document.querySelectorAll('.delete-btn[data-type="queued"]').forEach(btn => btn.disabled = true);

    try {
        const result = await apiPost('/attendees/batch', { submissions: queue });
        if (result.success) {
            saveSubmissionQueue([]);
            showToast('Sync successful!', 'success');
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        console.error('[SYNC FAILED]', error);
        showToast(`Sync failed. Items remain queued.`, 'error');
    } finally {
        isSyncing = false;
        if (currentStrataPlan && currentMeetingDate) {
            const data = await apiGet(`/attendees/${currentStrataPlan}/${currentMeetingDate}`);
            if (data.success) {
                currentSyncedAttendees = data.attendees.map(a => ({...a, status: 'synced'}));
            }
        }
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        document.querySelectorAll('.delete-btn').forEach(btn => btn.disabled = false);
    }
}


/**
 * Handles deleting an attendee record. Differentiates between a queued item
 * (local deletion) and a synced item (remote deletion).
 */
async function handleDelete(event) {
    const button = event.target;
    if (!button.matches('.delete-btn')) return;

    const type = button.dataset.type;

    if (type === 'queued') {
        const submissionId = button.dataset.submissionId;
        let queue = getSubmissionQueue();
        queue = queue.filter(item => item.submissionId !== submissionId);
        saveSubmissionQueue(queue);
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        showToast('Queued item removed.', 'info');
    } else if (type === 'synced') {
        const lotNumber = button.dataset.lot;
        const confirm = await showModal(`Are you sure you want to delete the record for Lot ${lotNumber}? This cannot be undone.`, { confirmText: 'Yes, Delete' });
        if (!confirm.confirmed) return;
        
        try {
            await apiDelete(`/attendees/${currentStrataPlan}/${currentMeetingDate}/${lotNumber}`);
            currentSyncedAttendees = currentSyncedAttendees.filter(a => a.lot_number != lotNumber);
            updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
            showToast(`Record for Lot ${lotNumber} deleted.`, 'success');
        } catch (error) {
            console.error('Delete failed:', error);
            showToast(`Failed to delete record: ${error.message}`, 'error');
        }
    }
}


async function handlePlanChange(event) {
    const spNumber = event.target.value;
    resetUiOnPlanChange();

    if (autoSyncIntervalId) clearInterval(autoSyncIntervalId);

    if (!spNumber) {
        currentStrataPlan = null;
        currentMeetingDate = null;
        return;
    }
    
    currentStrataPlan = spNumber;
    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    
    try {
        const newMeetingData = await showMeetingModal();
        if (!newMeetingData) {
            document.getElementById('strata-plan-select').value = '';
            currentStrataPlan = null;
            return;
        }

        const { meetingDate, meetingType, quorumTotal } = newMeetingData;
        currentMeetingDate = meetingDate;

        const meetingCheck = await apiGet(`/meetings/${spNumber}/${meetingDate}`);
        let meetingDetails;

        if (meetingCheck.success && meetingCheck.meeting) {
            meetingDetails = meetingCheck.meeting;
            currentTotalLots = meetingDetails.quorum_total;
            showToast(`Resuming meeting: ${meetingDetails.meeting_type}`, 'info');
        } else {
            await apiPost('/meetings', { spNumber, meetingDate, meetingType, quorumTotal });
            meetingDetails = { meeting_type: meetingType, quorum_total: quorumTotal };
            currentTotalLots = quorumTotal;
            showToast('New meeting started!', 'success');
        }

        const formattedDate = new Date(meetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        document.getElementById('meeting-title').textContent = `${meetingDetails.meeting_type} - SP ${spNumber}`;
        document.getElementById('meeting-date').textContent = formattedDate;

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
        
        const attendeesData = await apiGet(`/attendees/${spNumber}/${meetingDate}`);
        if (attendeesData.success) {
            currentSyncedAttendees = attendeesData.attendees.map(a => ({...a, status: 'synced'}));
        }

        updateDisplay(spNumber, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        document.getElementById('lot-number').disabled = false;
        document.getElementById('lot-number').focus();

        autoSyncIntervalId = setInterval(syncSubmissions, 60000);
        
    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}`, 'error');
        resetUiOnPlanChange();
    }
}

async function initializeApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;

    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');

    // --- Setup event listeners for elements that are ALWAYS visible in the main app ---
    document.getElementById('check-in-tab-btn').addEventListener('click', (e) => openTab(e, 'check-in-tab'));
    
    // --- Setup event listeners for elements within the check-in tab ---
    document.getElementById('strata-plan-select').addEventListener('change', handlePlanChange);
    document.getElementById('lot-number').addEventListener('input', debounce((e) => {
        if (e.target.value.trim() && strataPlanCache) {
            renderOwnerCheckboxes(e.target.value.trim(), strataPlanCache);
        }
    }, 300));
    document.getElementById('attendance-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('attendee-table-body').addEventListener('click', handleDelete);
    document.getElementById('sync-btn').addEventListener('click', syncSubmissions);
    document.getElementById('is-proxy').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        document.getElementById('proxy-holder-group').style.display = isChecked ? 'block' : 'none';
        document.getElementById('checkbox-container').style.display = isChecked ? 'none' : 'block';
        document.getElementById('owner-label').style.display = isChecked ? 'none' : 'block';
    });


    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    if (user) {
        document.getElementById('user-display').textContent = user.username;
        if (user.role === 'Admin') {
            document.getElementById('admin-panel').classList.remove('hidden');
            setupAdminEventListeners();
        }
    }
    
    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            renderStrataPlans(data.plans);
            if (user && user.role !== 'Admin' && data.plans.length === 1) {
                const strataPlanSelect = document.getElementById('strata-plan-select');
                strataPlanSelect.value = data.plans[0].sp_number;
                strataPlanSelect.disabled = true;
                strataPlanSelect.dispatchEvent(new Event('change'));
            }
        } else {
            throw new Error(data.error || 'Failed to load strata plans.');
        }
    } catch (err) {
        console.error('Failed to initialize strata plans:', err);
        showToast('Error: Could not load strata plans.', 'error');
    }
    
    syncSubmissions();
}

function setupAdminEventListeners() {
    // --- Setup listeners for elements inside the admin tab ---
    const adminTabBtn = document.getElementById('admin-tab-btn');
    if (adminTabBtn) {
        adminTabBtn.addEventListener('click', (e) => {
            openTab(e, 'admin-tab');
            loadUsers();
        });
    }
    document.getElementById('logout-btn').addEventListener('click', handleLogout);
    document.getElementById('change-password-btn').addEventListener('click', handleChangePassword);
    document.getElementById('add-user-btn').addEventListener('click', handleAddUser);
    document.getElementById('clear-cache-btn').addEventListener('click', handleClearCache);
    document.getElementById('user-list-body').addEventListener('change', handleUserActions);
    
    const collapsibleToggle = document.querySelector('.collapsible-toggle');
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

function openTab(evt, tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.style.display = 'none');
    document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
    document.getElementById(tabName).style.display = 'block';
    if (evt.currentTarget) {
      evt.currentTarget.classList.add('active');
    }
}

function handleUserActions(e) {
    if (!e.target.matches('.user-actions-select')) return;
    const select = e.target;
    const username = select.dataset.username;
    const action = select.value;
    if (!action) return;
    switch (action) {
        case 'change_sp': handleChangeSpAccess(username); break;
        case 'reset_password': handleResetPassword(username); break;
        case 'remove': handleRemoveUser(e); break;
    }
    select.value = "";
}

function handleClearCache() {
    showModal("Are you sure you want to clear all cached data? This includes unsynced submissions.", { confirmText: 'Yes, Clear' })
        .then(res => {
            if (res.confirmed) {
                clearStrataCache();
                saveSubmissionQueue([]);
                document.cookie = 'selectedSP=; max-age=0; path=/;';
                location.reload();
            }
        });
}

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const loginResult = await handleLogin(e);
        if (loginResult && loginResult.success) {
            initializeApp();
        }
      });
  } else {
      console.error("Fatal Error: The login form with id 'login-form' was not found in the DOM. Check public/index.html.");
  }
  
  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  }
});
