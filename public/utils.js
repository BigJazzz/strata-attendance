// Add this new function to your public/utils.js file

export function showMeetingModal() {
  const modal = document.getElementById('meeting-modal');
  const form = document.getElementById('meeting-form');
  const typeSelect = document.getElementById('meeting-type-select');
  const otherGroup = document.getElementById('other-meeting-type-group');
  const otherInput = document.getElementById('other-meeting-type-input');
  const quorumLabel = document.getElementById('quorum-total-label');
  const quorumInput = document.getElementById('quorum-total-input');
  const btnConfirm = document.getElementById('meeting-confirm-btn');
  const btnCancel = document.getElementById('meeting-cancel-btn');

  // Reset form state
  form.reset();
  otherGroup.classList.add('hidden');
  quorumLabel.textContent = 'Quorum Total';
  
  modal.style.display = 'flex';

  return new Promise(resolve => {
    typeSelect.onchange = () => {
        const type = typeSelect.value;
        if (type === 'Other') {
            otherGroup.classList.remove('hidden');
            otherInput.required = true;
        } else {
            otherGroup.classList.add('hidden');
            otherInput.required = false;
        }

        if (type === 'SCM') {
            quorumLabel.textContent = 'Number of Committee Members';
        } else {
            quorumLabel.textContent = 'Number of Financial Units';
        }
    };

    form.onsubmit = (e) => {
        e.preventDefault();
        let meetingType = typeSelect.value;
        if (meetingType === 'Other') {
            meetingType = otherInput.value.trim();
        }
        
        if (!meetingType) {
            showToast('Please specify a meeting type.', 'error');
            return;
        }

        modal.style.display = 'none';
        resolve({
            meetingType: meetingType,
            quorumTotal: parseInt(quorumInput.value, 10)
        });
    };

    btnCancel.onclick = () => {
        modal.style.display = 'none';
        resolve(null); // Resolve with null if cancelled
    };
  });
}