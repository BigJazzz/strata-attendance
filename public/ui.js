import { getSubmissionQueue } from './utils.js';

/**
 * Renders the owner checkboxes based on the lot number entered.
 */
export const renderOwnerCheckboxes = (lot, ownersCache) => {
    const checkboxContainer = document.getElementById('checkbox-container');
    const companyRepGroup = document.getElementById('company-rep-group');
    const ownerData = ownersCache[lot];

    companyRepGroup.style.display = 'none';
    checkboxContainer.innerHTML = '';

    if (!ownerData) {
        checkboxContainer.innerHTML = '<p>Lot not found in this strata plan.</p>';
        return;
    }

    const [mainContact, titleName] = ownerData;
    const companyKeywords = /\b(P\/L|PTY LTD|LIMITED|INVESTMENTS|MANAGEMENT|SUPERANNUATION FUND)\b/i;
    let namesToDisplay = new Set();

    const stripSalutation = (name) => {
        if (!name) return '';
        return name.replace(/^(Mr|Mrs|Ms|Miss|Dr)\.?\s+/i, '').trim();
    };

    const mainContactIsCompany = mainContact && companyKeywords.test(mainContact);
    const titleNameIsCompany = titleName && companyKeywords.test(titleName);
    let companyName = '';

    if (mainContactIsCompany) {
        companyName = (titleNameIsCompany && titleName.length > mainContact.length) ? titleName : mainContact;
    } else if (titleNameIsCompany) {
        companyName = titleName;
    }

    if (companyName) {
        checkboxContainer.innerHTML = `
            <p><b>Company Lot:</b> ${companyName}</p>
            <input type="hidden" id="company-name-hidden" value="${companyName}">
        `;
        companyRepGroup.style.display = 'block';
        return;
    }

    let primaryName = mainContact;
    const initialOnlyRegex = /^(?:(Mr|Mrs|Ms|Miss|Dr)\.?\s+)?([A-Z]\.?\s*)+$/i;
    if (mainContact && initialOnlyRegex.test(mainContact.trim()) && titleName) {
        primaryName = titleName;
    }

    if (primaryName) {
        primaryName.split(/\s*&\s*|\s+and\s+/i).forEach(name => {
            namesToDisplay.add(stripSalutation(name));
        });
    }

    if (namesToDisplay.size === 0 && titleName) {
        titleName.split(/\s*&\s*|\s+and\s+/i).forEach(name => {
            namesToDisplay.add(stripSalutation(name));
        });
    }

    let checkboxHTML = '';
    namesToDisplay.forEach(name => {
        if (name) {
            checkboxHTML += `<label class="checkbox-item"><input type="checkbox" name="owner" value="${name}"> ${name}</label>`;
        }
    });

    checkboxContainer.innerHTML = checkboxHTML || '<p>No owner names found for this lot.</p>';
};

/**
 * Main function to update the entire display.
 */
export const updateDisplay = (sp, currentSyncedAttendees, currentTotalLots, strataPlanCache) => {
    if (!sp) return;

    const queuedAttendees = getSubmissionQueue()
        .filter(s => s.sp === sp)
        .map(s => ({...s, status: 'queued'}));

    const allAttendees = [...currentSyncedAttendees, ...queuedAttendees];

    const attendedLots = new Set(allAttendees.map(attendee => String(attendee.lot)));

    renderAttendeeTable(allAttendees, strataPlanCache);
    updateQuorumDisplay(attendedLots.size, currentTotalLots);
    updateSyncButton();
};

/**
 * Resets the UI to its initial state.
 */
export const resetUiOnPlanChange = () => {
    document.getElementById('attendee-table-body').innerHTML = `<tr><td colspan="5" style="text-align:center;">Select a plan to see attendees.</td></tr>`;
    document.getElementById('person-count').textContent = `(0 people)`;
    document.getElementById('quorum-display').innerHTML = `Quorum: ...%`;
    document.getElementById('quorum-display').style.backgroundColor = '#6c757d';
    document.getElementById('checkbox-container').innerHTML = '<p>Select a Strata Plan to begin.</p>';
    document.getElementById('lot-number').value = '';
    document.getElementById('lot-number').disabled = true;
    document.getElementById('financial-label').lastChild.nodeValue = " Is Financial?";
    document.getElementById('meeting-title').textContent = 'Attendance Form';
    document.getElementById('meeting-date').textContent = '';
    document.getElementById('company-rep-group').style.display = 'none';
};

/**
 * Populates the strata plan dropdown.
 */
export const renderStrataPlans = (plans) => {
    const strataPlanSelect = document.getElementById('strata-plan-select');
    if (!plans || plans.length === 0) {
        strataPlanSelect.innerHTML = '<option value="">No plans available</option>';
        strataPlanSelect.disabled = true;
        return;
    };

    strataPlanSelect.innerHTML = '<option value="">Select a plan...</option>';
    plans.sort((a, b) => a.sp_number - b.sp_number);
    plans.forEach(plan => {
        const option = document.createElement('option');
        option.value = plan.sp_number;
        option.textContent = `${plan.sp_number} - ${plan.suburb}`;
        strataPlanSelect.appendChild(option);
    });

    strataPlanSelect.disabled = false;

    const savedSP = document.cookie.split('; ').find(row => row.startsWith('selectedSP='))?.split('=')[1];

    if (savedSP && strataPlanSelect.querySelector(`option[value="${savedSP}"]`)) {
        strataPlanSelect.value = savedSP;
        strataPlanSelect.dispatchEvent(new Event('change'));
    }
};

/**
 * Renders the table of attendees.
 */
export const renderAttendeeTable = (attendees, strataPlanCache) => {
    const attendeeTableBody = document.getElementById('attendee-table-body');
    const personCountSpan = document.getElementById('person-count');

    const syncedCount = attendees.filter(item => item.status !== 'queued').length;
    personCountSpan.textContent = `(${syncedCount} ${syncedCount === 1 ? 'person' : 'people'})`;
    attendeeTableBody.innerHTML = '';

    if (!attendees || attendees.length === 0) {
        attendeeTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;">No attendees yet.</td></tr>`;
        return;
    }

    attendees.sort((a, b) => a.lot - b.lot);

    attendees.forEach(item => {
        const lotData = strataPlanCache ? strataPlanCache[item.lot] : null;
        const unitNumber = lotData ? (lotData[2] || 'N/A') : 'N/A';
        const isQueued = item.status === 'queued';

        const isProxy = item.is_proxy;
        const isCompany = !isProxy && item.rep_name && item.rep_name !== 'N/A';

        let ownerRepName = item.owner_name;
        let companyName = isCompany ? item.rep_name : '';
        let rowColor = '#d4e3c1';

        if(isQueued) rowColor = '#f5e0df';
        else if(isProxy) rowColor = '#c1e1e3';
        else if(isCompany) rowColor = '#cbc1e3';

        const row = document.createElement('tr');
        row.style.backgroundColor = rowColor;

        const deleteButton = isQueued
            ? `<button class="delete-btn" data-type="queued" data-submission-id="${item.submissionId}">Delete</button>`
            : `<button class="delete-btn" data-type="synced" data-id="${item.id}" data-lot="${item.lot}">Delete</button>`;

        row.innerHTML = `
            <td>${item.lot}</td>
            <td>${unitNumber}</td>
            <td>${ownerRepName}</td>
            <td>${companyName}</td>
            <td>${deleteButton}</td>
        `;
        attendeeTableBody.appendChild(row);
    });
};

/**
 * Updates the quorum display.
 */
export const updateQuorumDisplay = (count = 0, total = 0) => {
    const quorumDisplay = document.getElementById('quorum-display');
    const percentage = total > 0 ? Math.floor((count / total) * 100) : 0;

    const quorumThreshold = Math.ceil(total * 0.25);
    const isQuorumMet = count >= quorumThreshold;

    quorumDisplay.innerHTML = `Financial Lots Quorum: ${percentage}%<br><small>(${count}/${total})</small>`;
    quorumDisplay.style.backgroundColor = isQuorumMet ? '#28a745' : '#dc3545';
};

/**
 * Updates the sync button's state.
 */
export const updateSyncButton = (isSyncing = false) => {
    const syncBtn = document.getElementById('sync-btn');
    if (!syncBtn) return;

    const queue = getSubmissionQueue();
    if (queue.length > 0) {
        syncBtn.disabled = isSyncing;
        syncBtn.textContent = isSyncing ? 'Syncing...' : `Sync ${queue.length} Item${queue.length > 1 ? 's' : ''}`;
    } else {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Synced';
    }
};
