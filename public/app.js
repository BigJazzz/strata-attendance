// --- DOM Elements ---
const loginSection = document.getElementById('login-section');
const mainAppSection = document.getElementById('main-app');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const userDisplay = document.getElementById('user-display');
const logoutBtn = document.getElementById('logout-btn');
const strataPlanSelect = document.getElementById('strata-plan-select');

// --- Helper for API calls ---
function getAuthToken() {
  return document.cookie
    .split('; ')
    .find(row => row.startsWith('authToken='))
    ?.split('=')[1];
}

const apiRequest = async (endpoint, method = 'GET', body = null) => {
  const headers = {
    'Content-Type': 'application/json',
    ...(getAuthToken() && { 'Authorization': `Bearer ${getAuthToken()}` })
  };

  const response = await fetch(endpoint, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (!response.ok) {
    let errorMessage = `API request to ${endpoint} failed (${response.status})`;
    try {
      const errorData = await response.json();
      if (errorData.error) errorMessage = errorData.error;
    } catch (_) {
      // Fallback to generic message
    }
    throw new Error(errorMessage);
  }

  return response.json();
};

// --- Main Application Logic ---
const handleLogin = async (event) => {
  event.preventDefault();
  loginStatus.textContent = 'Logging in...';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  if (!username || !password) {
    loginStatus.textContent = 'Username and password are required.';
    loginStatus.style.color = 'red';
    return;
  }

  try {
    const result = await apiRequest('/api/login', 'POST', { username, password });

    if (result.success && result.user && result.token) {
      document.cookie = `authToken=${result.token};max-age=604800;path=/;SameSite=Lax`;
      sessionStorage.setItem('attendanceUser', JSON.stringify(result.user));
      showMainApp(result.user);
    } else {
      throw new Error(result.error || 'Login failed.');
    }
  } catch (error) {
    console.error('Login failed:', error);
    loginStatus.textContent = `Login failed: ${error.message}`;
    loginStatus.style.color = 'red';
  }
};

const handleLogout = () => {
  sessionStorage.removeItem('attendanceUser');
  document.cookie = 'authToken=; max-age=0; path=/;';
  showLogin();
};

// --- Load Available Strata Plans ---
const populateStrataPlans = async () => {
  strataPlanSelect.disabled = true;
  strataPlanSelect.innerHTML = '<option value="">Loading plans...</option>';

  try {
    const result = await apiRequest('/api/strata-plans');

    if (result.success && result.plans) {
      strataPlanSelect.innerHTML = '<option value="">Select a plan...</option>';
      result.plans.forEach(plan => {
        const option = document.createElement('option');
        option.value = plan.sp;
        option.textContent = `${plan.sp} - ${plan.suburb}`;
        strataPlanSelect.appendChild(option);
      });
    } else {
      throw new Error(result.error || 'No plans returned.');
    }
  } catch (error) {
    console.error('Failed to load strata plans:', error);
    strataPlanSelect.innerHTML = `<option value="">${error.message}</option>`;
  } finally {
    strataPlanSelect.disabled = false;
  }
};

// --- UI Management ---
const showMainApp = (user) => {
  loginSection.classList.add('hidden');
  mainAppSection.classList.remove('hidden');
  userDisplay.textContent = `Logged in as: ${user.username} (${user.role})`;
  populateStrataPlans();
};

const showLogin = () => {
  mainAppSection.classList.add('hidden');
  loginSection.classList.remove('hidden');
  loginStatus.textContent = '';
  loginStatus.style.color = '';
  loginForm.reset();
};

// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);

  const userString = sessionStorage.getItem('attendanceUser');
  if (getAuthToken() && userString) {
    const user = JSON.parse(userString);
    showMainApp(user);
  } else {
    showLogin();
  }
});
