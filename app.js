// --- Configuration ---
// IMPORTANT: Replace this with the URL of your deployed Vercel backend
const API_BASE_URL = 'https://your-backend-project.vercel.app';

// --- DOM Elements ---
const loginSection = document.getElementById('login-section');
const mainAppSection = document.getElementById('main-app');
const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const userDisplay = document.getElementById('user-display');
const logoutBtn = document.getElementById('logout-btn');
const strataPlanSelect = document.getElementById('strata-plan-select');

// --- Helper for API calls ---
const apiRequest = async (endpoint, method = 'GET', body = null) => {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, options);

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'An API error occurred.');
    }

    return response.json();
};

// --- Main Application Logic ---
const handleLogin = async (event) => {
    event.preventDefault();
    loginStatus.textContent = 'Logging in...';
    loginStatus.style.color = '#333';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    if (!username || !password) {
        loginStatus.textContent = 'Username and password are required.';
        return;
    }

    try {
        const result = await apiRequest('/api/login', 'POST', { username, password });

        if (result.success && result.user) {
            sessionStorage.setItem('attendanceUser', JSON.stringify(result.user));
            showMainApp(result.user);
        } else {
            throw new Error(result.error || 'Login failed.');
        }
    } catch (error) {
        console.error('Login failed:', error);
        loginStatus.textContent = `Login failed: ${error.message}`;
    }
};

const handleLogout = () => {
    sessionStorage.removeItem('attendanceUser');
    showLogin();
};

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
            strataPlanSelect.disabled = false;
        } else {
            throw new Error(result.error || 'Could not load plans.');
        }
    } catch (error) {
        console.error('Failed to load plans:', error);
        strataPlanSelect.innerHTML = `<option value="">${error.message}</option>`;
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
    loginForm.reset();
};

// --- Initial Load ---
document.addEventListener('DOMContentLoaded', () => {
    loginForm.addEventListener('submit', handleLogin);
    logoutBtn.addEventListener('click', handleLogout);

    const userString = sessionStorage.getItem('attendanceUser');
    if (userString) {
        const user = JSON.parse(userString);
        showMainApp(user);
    } else {
        showLogin();
    }
});