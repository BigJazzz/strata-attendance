import { API_BASE } from './config.js';
import { handleLogout } from './auth.js';

/**
 * Helper to fetch JWT token from cookies.
 */
function getAuthToken() {
  return document.cookie
    .split('; ')
    .find(row => row.startsWith('authToken='))
    ?.split('=')[1];
}

/**
 * Unified fetch helper for API requests.
 */
async function apiRequest(path, { method = 'GET', body = null } = {}) {
  const token = getAuthToken();
  const headers = {
    ...(body && { 'Content-Type': 'application/json' }),
    ...(token && { Authorization: `Bearer ${token}` })
  };

  const config = {
      method,
      headers,
      ...(body && { body: JSON.stringify(body) })
  };

  const response = await fetch(`${API_BASE}${path}`, config);

  if (response.status === 204) {
      return { success: true };
  }
  
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }

  if (data.error && data.error.includes('Authentication failed')) {
    handleLogout();
  }

  return data;
}

/**
 * Helper for GET requests.
 */
export function apiGet(path) {
  return apiRequest(path, { method: 'GET' });
}

/**
 * Helper for POST requests.
 */
export function apiPost(path, body) {
  return apiRequest(path, { method: 'POST', body });
}

/**
 * Helper for DELETE requests.
 */
export function apiDelete(path) {
    return apiRequest(path, { method: 'DELETE' });
}


/**
 * Debounce utility to limit how often a function runs.
 */
export const debounce = (func, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
};

/**
 * Display a generic modal dialog.
 */
export function showModal(
  text,
  {
    showInput = false,
    inputType = 'text',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    isHtml = false
  } = {}
) {
  const modal = document.getElementById('custom-modal');
  const modalText = document.getElementById('modal-text');
  const modalInput = document.getElementById('modal-input');
  const btnConfirm = document.getElementById('modal-confirm-btn');
  const btnCancel = document.getElementById('modal-cancel-btn');

  modalText[isHtml ? 'innerHTML' : 'textContent'] = text;
  modalInput.style.display = showInput ? 'block' : 'none';
  modalInput.type = inputType;
  modalInput.value = '';
  btnConfirm.textContent = confirmText;
  btnCancel.textContent = cancelText;
  modal.style.display = 'flex';

  return new Promise(resolve => {
    btnConfirm.onclick = () => {
      modal.style.display = 'none';
      resolve({ confirmed: true, value: modalInput.value });
    };
    btnCancel.onclick = () => {
      modal.style.display = 'none';
      resolve({ confirmed: false, value: null });
    };
    modalInput.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnConfirm.click();
      }
    };
  });
}

/**
 * Display the specialized modal for setting up a new meeting.
 */
export function showMeetingModal() {
  const modal = document.getElementById('meeting-modal');
  const form = document.getElementById('meeting-form');
  const dateInput = document.getElementById('meeting-date-input');
  const typeSelect = document.getElementById('meeting-type-select');
  const otherGroup = document.getElementById('other-meeting-type-group');
  const otherInput = document.getElementById('other-meeting-type-input');
  const quorumLabel = document.getElementById('quorum-total-label');
  const quorumInput = document.getElementById('quorum-total-input');
  const btnConfirm = document.getElementById('meeting-confirm-btn');
  const btnCancel = document.getElementById('meeting-cancel-btn');

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;
  
  form.reset();
  dateInput.value = todayStr;
  otherGroup.classList.add('hidden');
  quorumLabel.textContent = 'Quorum Total';
  
  modal.style.display = 'flex';

  return new Promise(resolve => {
    typeSelect.onchange = () => {
        const type = typeSelect.value;
        otherGroup.classList.toggle('hidden', type !== 'Other');
        otherInput.required = type === 'Other';
        quorumLabel.textContent = type === 'SCM' ? 'Number of Committee Members' : 'Number of Financial Units';
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
            meetingDate: dateInput.value,
            meetingType: meetingType,
            quorumTotal: parseInt(quorumInput.value, 10)
        });
    };

    btnCancel.onclick = () => {
        modal.style.display = 'none';
        resolve(null);
    };
  });
}

/**
 * Ensures there's a toast container in the DOM.
 */
function ensureToastContainer() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Shows a toast notification.
 */
export function showToast(message, type = 'info', duration = 3000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove());
  }, duration);
}

/**
 * Submission queue helpers for offline support.
 */
export const getSubmissionQueue = () =>
  JSON.parse(localStorage.getItem('submissionQueue') || '[]');

export const saveSubmissionQueue = queue =>
  localStorage.setItem('submissionQueue', JSON.stringify(queue));

/**
 * Clears all strata plan related caches from localStorage.
 */
export const clearStrataCache = () => {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('strata_') || key === 'strataPlans') {
      localStorage.removeItem(key);
    }
  });
};