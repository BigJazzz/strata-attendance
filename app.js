// --- Configuration ---
const API_BASE_URL = 'https://strata-attendance.vercel.app';

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
    const url = `${API_BASE_URL}${endpoint}`;
    console.log(`[CLIENT LOG] apiRequest: Starting request. Method: ${method}, URL: ${url}`);

    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    try {
        const response = await fetch(url, options);
        console.log(`[CLIENT LOG] apiRequest: Fetch call completed. Response Status: ${response.status}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[CLIENT LOG] apiRequest: Raw error response from server:`, errorText);
            throw new Error(`Server responded with status ${response.status}`);
        }
        
        const data = await response.json();
        return data;

    } catch (error) {
        console.error(`[CLIENT LOG] apiRequest: A critical error occurred during the fetch process:`, error);
        throw error;
    }
};

// --- Main Application Logic ---
const handleLogin = async (event) => {
    event.preventDefault();
    loginStatus.textContent = 'Logging in...';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    try {
        // CORRECTED: Added /api/ to the endpoint path
        const result = await apiRequest('/api/login', 'POST', { username, password });

        if (result.success && result.user) {
            sessionStorage.setItem('attendanceUser', JSON.stringify(result.user));
            showMainApp(result.user);
        } else {
            throw new Error(result.error || 'Login failed due to unexpected server response.');
        }
    } catch (error) {
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
        // CORRECTED: Added /api/ to the endpoint path
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
