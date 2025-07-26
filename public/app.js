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

    const companyNameHidden = document.getElementById('company-name-hidden');
    const companyName = companyNameHidden ? companyNameHidden.value : null;
    const selectedNames = Array.from(document.querySelectorAll('input[name="owner"]:checked')).map(cb => cb.value);
    const isFinancial = document.getElementById('is-financial').checked;
    const isProxy = document.getElementById('is-proxy').checked;
    const companyRep = companyRepInput.value.trim();
    const proxyHolderLot = proxyHolderLotInput.value.trim();

    if (isProxy && !proxyHolderLot) {
        showToast('Please enter the Proxy Holder Lot Number.', 'error');
        return;
    }
    if (!isProxy && !companyName && selectedNames.length === 0) {
        showToast('Please select at least one owner.', 'error');
        return;
    }

    const submission = {
        submissionId: `sub_${Date.now()}_${Math.random()}`,
        sp: currentStrataPlan,
        meetingDate: currentMeetingDate,
        lot: lot,
        owner_name: companyName || selectedNames.join(', '),
        rep_name: companyRep || (proxyHolderLot ? `Proxy by Lot ${proxyHolderLot}` : ''),
        is_financial: isFinancial,
        is_proxy: isProxy,
    };

    const queue = getSubmissionQueue();
    queue.push(submission);
    saveSubmissionQueue(queue);

    updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
    showToast(`Lot ${lot} queued for submission.`, 'info');
    
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
        const result = await apiPost('/attendance/batch', { submissions: queue });
        // **THE FIX**: Only clear the queue if the server explicitly confirms success.
        if (result && result.success) {
            saveSubmissionQueue([]);
            showToast('Sync successful!', 'success');
        } else {
            // Throw an error if success is not explicitly true, to prevent clearing the queue.
            throw new Error(result.error || 'Sync failed: Server did not confirm success.');
        }
    } catch (error) {
        console.error('[SYNC FAILED]', error);
        showToast(`Sync failed. Items remain queued.`, 'error');
    } finally {
        isSyncing = false;
        if (currentStrataPlan && currentMeetingDate) {
            const data = await apiGet(`/attendance/${currentStrataPlan}/${currentMeetingDate}`);
            if (data.success) {
                currentSyncedAttendees = data.attendees.map(a => ({...a, status: 'synced'}));
            }
        }
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        document.querySelectorAll('.delete-btn').forEach(btn => btn.disabled = false);
    }
}

/**
 * Handles deleting an attendee record.
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
        const lotValue = button.dataset.lot;
        const confirm = await showModal(`Are you sure you want to delete the record for Lot ${lotValue}? This cannot be undone.`, { confirmText: 'Yes, Delete' });
        if (!confirm.confirmed) return;
        
        try {
            await apiDelete(`/attendance/${currentStrataPlan}/${currentMeetingDate}/${lotValue}`);
            currentSyncedAttendees = currentSyncedAttendees.filter(a => a.lot != lotValue);
            updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
            showToast(`Record for Lot ${lotValue} deleted.`, 'success');
        } catch (error) {
            console.error('Delete failed:', error);
            showToast(`Failed to delete record: ${error.message}`, 'error');
        }
    }
}

/**
 * Loads the main application view for a given meeting.
 */
async function loadMeeting(spNumber, meetingData) {
    try {
        const { meetingDate, meetingType, quorumTotal } = meetingData;
        currentStrataPlan = spNumber;
        currentMeetingDate = meetingDate;
        currentTotalLots = quorumTotal;

        const formattedDate = new Date(meetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        document.getElementById('meeting-title').textContent = `${meetingType} - SP ${spNumber}`;
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
        
        const attendeesData = await apiGet(`/attendance/${spNumber}/${meetingDate}`);
        if (attendeesData.success) {
            currentSyncedAttendees = attendeesData.attendees.map(a => ({...a, status: 'synced'}));
        }

        updateDisplay(spNumber, currentSyncedAttendees, currentTotalLots, strataPlanCache);
        document.getElementById('lot-number').disabled = false;
        document.getElementById('lot-number').focus();

        if (autoSyncIntervalId) clearInterval(autoSyncIntervalId);
        autoSyncIntervalId = setInterval(syncSubmissions, 60000);

    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}: ${err.message}`, 'error');
        resetUiOnPlanChange();
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
    
    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;

    const today = new Date().toISOString().split('T')[0];
    try {
        const meetingCheck = await apiGet(`/meetings/${spNumber}/${today}`);
        
        if (meetingCheck.success && meetingCheck.meeting) {
            showToast(`Auto-loading today's meeting: ${meetingCheck.meeting.meeting_type}`, 'info');
            const meetingData = {
                meetingDate: today,
                meetingType: meetingCheck.meeting.meeting_type,
                quorumTotal: meetingCheck.meeting.quorum_total
            };
            await loadMeeting(spNumber, meetingData);
        } else {
            const allMeetingsResult = await apiGet(`/meetings/${spNumber}`);
            const existingMeetings = allMeetingsResult.success ? allMeetingsResult.meetings : [];
            
            const chosenMeetingData = await showMeetingModal(existingMeetings);

            if (!chosenMeetingData) {
                document.getElementById('strata-plan-select').value = '';
                currentStrataPlan = null;
                return;
            }
            
            if (chosenMeetingData.isNew) {
                await apiPost('/meetings', { spNumber, ...chosenMeetingData });
            }
            
            await loadMeeting(spNumber, chosenMeetingData);
        }
    } catch (err) {
        console.error(`Failed during meeting setup for SP ${spNumber}:`, err);
        showToast(`Error setting up meeting: ${err.message}`, 'error');
        resetUiOnPlanChange();
    }
}

async function initializeApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;

    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');

    document.getElementById('check-in-tab-btn').addEventListener('click', (e) => openTab(e, 'check-in-tab'));
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
    
    const cachedPlans = localStorage.getItem('strataPlans');
    if (cachedPlans) {
        try {
            renderStrataPlans(JSON.parse(cachedPlans));
        } catch (e) {
            console.error("Failed to parse cached strata plans", e);
            localStorage.removeItem('strataPlans');
        }
    }
    
    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            localStorage.setItem('strataPlans', JSON.stringify(data.plans));
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
        if (!cachedPlans) {
             showToast('Error: Could not load strata plans.', 'error');
        }
    }
    
    syncSubmissions();
}

function setupAdminEventListeners() {
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