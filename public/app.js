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
const meetingDateBtn = document.getElementById('meeting-date-btn');

// --- App State ---
let currentStrataPlan = null;
let currentMeetingId = null;
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

    const lot = lotNumberInput.value.trim();
    if (!currentStrataPlan || !lot) {
        showToast('Please select a plan and enter a lot number.', 'error');
        return;
    }

    const companyRep = document.getElementById('company-rep').value.trim();
    const proxyHolderLot = document.getElementById('proxy-holder-lot').value.trim();
    const isFinancial = document.getElementById('is-financial').checked;
    const isProxy = document.getElementById('is-proxy').checked;

    const companyNameHidden = document.getElementById('company-name-hidden');
    const companyName = companyNameHidden ? companyNameHidden.value : null;
    const selectedNames = Array.from(document.querySelectorAll('input[name="owner"]:checked')).map(cb => cb.value);

    let owner_name = companyName || selectedNames.join(', ');

    // If it's a proxy vote, the owner name isn't selected in the UI.
    // We must retrieve it from the cache to know who is GIVING the proxy.
    if (isProxy) {
        const ownerData = strataPlanCache[lot];
        if (ownerData) {
            // Use the main contact or title name from the cache.
            owner_name = ownerData[0] || ownerData[1];
        }
    }

    // Now, run validation with the potentially retrieved owner_name.
    if (!owner_name) {
        showToast(`Could not find owner data for Lot ${lot}. Please check the lot number.`, 'error');
        return;
    }
     if (isProxy && !proxyHolderLot) {
        showToast('Please enter the Proxy Holder Lot Number.', 'error');
        return;
    }

    let rep_name;
    if (isProxy) {
        rep_name = `Proxy - Lot ${proxyHolderLot}`;
    } else if (companyName) {
        rep_name = companyRep;
    } else {
        rep_name = 'N/A';
    }

    const submission = {
        submissionId: `sub_${Date.now()}_${Math.random()}`,
        sp: currentStrataPlan,
        lot: lot,
        owner_name: owner_name,
        rep_name: rep_name,
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
    
    // Manually reset the UI for the owner's box to ensure it's visible for the next entry.
    document.getElementById('checkbox-container').style.display = 'block';
    document.getElementById('owner-label').style.display = 'block';

    lotNumberInput.focus();
}

/**
 * Sends the queued submissions to the server and verifies success.
 */
async function syncSubmissions() {
    if (isSyncing || !navigator.onLine) return;

    // Isolate the batch to be synced.
    const batchToSync = getSubmissionQueue();
    if (batchToSync.length === 0) {
        updateSyncButton();
        return;
    }

    // Immediately clear the main queue. New items can now be added safely.
    saveSubmissionQueue([]);

    isSyncing = true;
    updateSyncButton(true);
    showToast(`Syncing ${batchToSync.length} item(s)...`, 'info');

    document.querySelectorAll('.delete-btn[data-type="queued"]').forEach(btn => btn.disabled = true);

    try {
        const postResult = await apiPost('/attendance/batch', {
            meetingId: currentMeetingId,
            submissions: batchToSync
        });

        if (!postResult || !postResult.success) {
            throw new Error(postResult.error || 'Batch submission failed.');
        }

        // On success, the items are already gone from the queue. We're done.
        showToast(`Successfully synced ${batchToSync.length} item(s).`, 'success');

    } catch (error) {
        console.error('[SYNC FAILED]', error);
        showToast(`Sync failed: ${error.message}. Items have been re-queued.`, 'error');

        // On failure, add the failed batch back to the start of the queue.
        const currentQueue = getSubmissionQueue();
        saveSubmissionQueue([...batchToSync, ...currentQueue]);

    } finally {
        isSyncing = false;
        // Always refresh the display with the latest data from the server.
        if (currentStrataPlan && currentMeetingDate) {
            const data = await apiGet(`/attendance/${currentStrataPlan}/${currentMeetingDate}`);
            if (data.success) {
                currentSyncedAttendees = data.attendees.map(a => ({...a, status: 'synced'}));
            }
        }
        updateDisplay(currentStrataPlan, currentSyncedAttendees, currentTotalLots, strataPlanCache);
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
        const attendanceId = button.dataset.id;
        const lotValue = button.dataset.lot;
        const confirm = await showModal(`Are you sure you want to delete the record for Lot ${lotValue}? This cannot be undone.`, { confirmText: 'Yes, Delete' });
        if (!confirm.confirmed) return;

        try {
            await apiDelete(`/attendance/${attendanceId}`);
            currentSyncedAttendees = currentSyncedAttendees.filter(a => a.id != attendanceId);
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
        const { id, meetingDate, meetingType, quorumTotal } = meetingData;
        
        // Save the active meeting to sessionStorage
        sessionStorage.setItem('activeMeeting', JSON.stringify({ spNumber, ...meetingData }));

        currentStrataPlan = spNumber;
        currentMeetingId = id;
        currentMeetingDate = meetingDate;
        currentTotalLots = quorumTotal;

        const formattedDate = new Date(meetingDate + 'T00:00:00').toLocaleDateString('en-AU', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        document.getElementById('meeting-title').textContent = `${meetingType} - SP ${spNumber}`;
        meetingDateBtn.textContent = formattedDate;
        meetingDateBtn.style.display = 'inline-block';

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

/**
 * Prompts the user to select or create a meeting.
 */
async function promptForMeeting(spNumber) {
    try {
        const allMeetingsResult = await apiGet(`/meetings/${spNumber}`);
        const existingMeetings = allMeetingsResult.success ? allMeetingsResult.meetings : [];

        const chosenMeetingResult = await showMeetingModal(existingMeetings);

        if (!chosenMeetingResult) {
            strataPlanSelect.value = '';
            currentStrataPlan = null;
            return;
        }

        let meetingDataToLoad;

        if (chosenMeetingResult.isNew) {
            const newMeetingResponse = await apiPost('/meetings', { spNumber, ...chosenMeetingResult });
            if (!newMeetingResponse.success) {
                throw new Error(newMeetingResponse.error || 'Failed to create new meeting.');
            }
            meetingDataToLoad = {
                id: newMeetingResponse.meeting.id,
                meetingDate: chosenMeetingResult.meetingDate,
                meetingType: newMeetingResponse.meeting.meeting_type,
                quorumTotal: newMeetingResponse.meeting.quorum_total,
            };
        } else {
            meetingDataToLoad = {
                id: chosenMeetingResult.id,
                meetingDate: chosenMeetingResult.meeting_date,
                meetingType: chosenMeetingResult.meeting_type,
                quorumTotal: chosenMeetingResult.quorum_total
            };
        }

        await loadMeeting(spNumber, meetingDataToLoad);
    } catch (err) {
        console.error(`Failed during meeting setup for SP ${spNumber}:`, err);
        showToast(`Error setting up meeting: ${err.message}`, 'error');
        resetUiOnPlanChange();
    }
}

async function handlePlanChange(event) {
    const spNumber = event.target.value;
    resetUiOnPlanChange();
    sessionStorage.removeItem('activeMeeting'); // Clear meeting cache on plan change

    if (autoSyncIntervalId) clearInterval(autoSyncIntervalId);

    if (!spNumber) {
        currentStrataPlan = null;
        currentMeetingDate = null;
        currentMeetingId = null;
        return;
    }

    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    await promptForMeeting(spNumber);
}

async function initializeApp() {
    if (isAppInitialized) return;
    isAppInitialized = true;

    loginSection.classList.add('hidden');
    mainApp.classList.remove('hidden');

    checkInTabBtn.addEventListener('click', (e) => openTab(e, 'check-in-tab'));
    strataPlanSelect.addEventListener('change', handlePlanChange);
    meetingDateBtn.addEventListener('click', () => {
        if (currentStrataPlan) {
            promptForMeeting(currentStrataPlan);
        }
    });
    lotNumberInput.addEventListener('input', debounce((e) => {
        if (e.target.value.trim() && strataPlanCache) {
            renderOwnerCheckboxes(e.target.value.trim(), strataPlanCache);
        }
    }, 300));
    document.getElementById('attendance-form').addEventListener('submit', handleFormSubmit);
    document.getElementById('attendee-table-body').addEventListener('click', handleDelete);
    document.getElementById('sync-btn').addEventListener('click', syncSubmissions);
    
    // Hide owner selection UI when proxy is checked.
    document.getElementById('is-proxy').addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        document.getElementById('proxy-holder-group').style.display = isChecked ? 'block' : 'none';
        document.getElementById('checkbox-container').style.display = isChecked ? 'none' : 'block';
        document.getElementById('owner-label').style.display = isChecked ? 'none' : 'block';
    });

    const user = JSON.parse(sessionStorage.getItem('attendanceUser'));
    if (user) {
        userDisplay.textContent = user.username;
        if (user.role === 'Admin') {
            adminPanel.classList.remove('hidden');
            setupAdminEventListeners();
        }
    }

    try {
        const data = await apiGet('/strata-plans');
        if (data.success) {
            localStorage.setItem('strataPlans', JSON.stringify(data.plans));
            renderStrataPlans(data.plans);

            // Restore SP selection from cookie
            const savedSP = document.cookie.split('; ').find(row => row.startsWith('selectedSP='))?.split('=')[1];
            if (savedSP && strataPlanSelect.querySelector(`option[value="${savedSP}"]`)) {
                strataPlanSelect.value = savedSP;
            }

            // Check for a cached meeting
            const cachedMeeting = JSON.parse(sessionStorage.getItem('activeMeeting'));
            if (cachedMeeting && cachedMeeting.spNumber === strataPlanSelect.value) {
                showToast('Resuming previous meeting session.', 'info');
                await loadMeeting(cachedMeeting.spNumber, cachedMeeting);
            } else if (strataPlanSelect.value) {
                // If SP is selected but no meeting is cached, prompt for one
                await promptForMeeting(strataPlanSelect.value);
            }

            if (user && user.role !== 'Admin' && data.plans.length === 1) {
                strataPlanSelect.value = data.plans[0].sp_number;
                strataPlanSelect.disabled = true;
                if (!cachedMeeting) { // Trigger change only if no meeting is cached
                    strataPlanSelect.dispatchEvent(new Event('change'));
                }
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
    const adminTabBtn = document.getElementById('admin-tab-btn');
    if (adminTabBtn) {
        adminTabBtn.addEventListener('click', (e) => {
            openTab(e, 'admin-tab');
            loadUsers();
        });
    }
    logoutBtn.addEventListener('click', handleLogout);
    changePasswordBtn.addEventListener('click', handleChangePassword);
    addUserBtn.addEventListener('click', handleAddUser);
    clearCacheBtn.addEventListener('click', handleClearCache);
    userListBody.addEventListener('change', handleUserActions);

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
                sessionStorage.removeItem('activeMeeting');
                saveSubmissionQueue([]);
                document.cookie = 'selectedSP=; max-age=0; path=/;';
                location.reload();
            }
        });
}

document.addEventListener('DOMContentLoaded', () => {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginResult = await handleLogin(e);
    if (loginResult && loginResult.success) {
        initializeApp();
    }
  });

  const token = document.cookie.split('; ').find(r => r.startsWith('authToken='))?.split('=')[1];
  if (token) {
      initializeApp();
  }
});
