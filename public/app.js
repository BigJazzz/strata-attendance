// In public/app.js, make sure to import the new function
import { showMeetingModal } from './utils.js';
import { apiPost } from './utils.js'; // Also import apiPost

// Replace your existing handlePlanChange function with this new version
async function handlePlanChange(event) {
    const spNumber = event.target.value;
    resetUiOnPlanChange();

    if (!spNumber) {
        return;
    }
    
    currentStrataPlan = spNumber;
    document.cookie = `selectedSP=${spNumber};max-age=2592000;path=/;SameSite=Lax`;
    
    try {
        // 1. Check if a meeting exists for today
        const meetingCheck = await apiGet(`/api/meetings/${spNumber}/today`);
        let meetingDetails;

        if (meetingCheck.success) {
            meetingDetails = meetingCheck.meeting;
            showToast(`Resuming meeting: ${meetingDetails.meeting_type}`, 'info');
        } else {
            // 2. If no meeting, show the modal to create one
            const newMeetingData = await showMeetingModal();
            if (!newMeetingData) {
                strataPlanSelect.value = ''; // Deselect if user cancels
                return;
            }
            
            await apiPost('/api/meetings', { spNumber, ...newMeetingData });
            meetingDetails = {
                meeting_type: newMeetingData.meetingType,
                quorum_total: newMeetingData.quorumTotal
            };
            showToast('New meeting started!', 'success');
        }

        // 3. Update UI with meeting details
        document.getElementById('meeting-title').textContent = `${meetingDetails.meeting_type} - SP ${spNumber}`;
        // We will update the quorum display later when attendees are loaded

        // 4. Load owner data for the check-in form
        const cachedData = localStorage.getItem(`strata_${spNumber}`);
        if (cachedData) {
            strataPlanCache = JSON.parse(cachedData);
        } else {
            const data = await apiGet(`/api/strata-plans/${spNumber}/owners`);
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
        lotNumberInput.focus();
        
    } catch (err) {
        console.error(`Failed to load data for SP ${spNumber}:`, err);
        showToast(`Error loading data for SP ${spNumber}`, 'error');
        resetUiOnPlanChange();
    }
}