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
 * Unified fetch helper for GET and POST requests.
 */
async function apiRequest(path, { method = 'GET', body = null } = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` })
  };

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${method} ${path} failed: ${response.statusText} – ${errorText}`);
  }

  const data = await response.json();

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
 * Display a modal dialog with optional input.
 * Resolves with { confirmed: boolean, value: string|null }.
 */
let modalResolve;
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
    modalResolve = resolve;
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
 * Ensure there's a toast container in the DOM.
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
 * Show a toast notification.
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
 * Submission queue stored in localStorage for offline-first support.
 */
export const getSubmissionQueue = () =>
  JSON.parse(localStorage.getItem('submissionQueue') || '[]');

export const saveSubmissionQueue = queue =>
  localStorage.setItem('submissionQueue', JSON.stringify(queue));

/**
 * Clear all strata plan caches from localStorage.
 */
export const clearStrataCache = () => {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('strata_')) {
      localStorage.removeItem(key);
    }
  });
};
