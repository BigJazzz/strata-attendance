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
        console.log('[CLIENT LOG] apiRequest: Request body:', body);
    }
    
    console.log('[CLIENT LOG] apiRequest: Fetch options prepared:', options);

    try {
        console.log('[CLIENT LOG] apiRequest: Executing fetch...');
        const response = await fetch(url, options);
        console.log('[CLIENT LOG] apiRequest: Fetch call completed. Response received.');
        console.log(`[CLIENT LOG] apiRequest: Response Status: ${response.status} ${response.statusText}`);

        if (!response.ok) {
            console.error('[CLIENT LOG] apiRequest: Response was not OK. Attempting to read error body.');
            const errorText = await response.text(); // Get raw text to see what server sent
            console.error(`[CLIENT LOG] apiRequest: Raw error response from server:`, errorText);
            throw new Error(`Server responded with status ${response.status}`);
        }
        
        console.log('[CLIENT LOG] apiRequest: Response is OK. Parsing JSON...');
        const data = await response.json();
        console.log('[CLIENT LOG] apiRequest: JSON parsed successfully.');
        return data;

    } catch (error) {
        console.error('[CLIENT LOG] apiRequest: A critical error occurred during the fetch process.');
        console.error(`[CLIENT LOG] apiRequest: Error type: ${error.name}`);
        console.error(`[CLIENT LOG] apiRequest: Error message: ${error.message}`);
        console.error('[CLIENT LOG] apiRequest: Full error object:', error);
        // Re-throw the error so the calling function can handle it
        throw error;
    }
};

// --- Main Application Logic ---
const handleLogin = async (event) => {
    console.log('[CLIENT LOG] handleLogin: Function started.');
    event.preventDefault();
    loginStatus.textContent = 'Logging in...';

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    console.log(`[CLIENT LOG] handleLogin: Captured username: "${username}".`);

    try {
        console.log('[CLIENT LOG] handleLogin: Calling apiRequest for /login.');
        const result = await apiRequest('/login', 'POST', { username, password });
        console.log('[CLIENT LOG] handleLogin: apiRequest returned successfully.', result);

        if (result.success && result.user) {
            sessionStorage.setItem('attendanceUser', JSON.stringify(result.user));
            showMainApp(result.user);
        } else {
            throw new Error(result.error || 'Login failed due to unexpected server response.');
        }
    } catch (error) {
        console.error('[CLIENT LOG] handleLogin: Login process failed.');
        loginStatus.textContent = `Login failed: ${error.message}`;
    }
    console.log('[CLIENT LOG] handleLogin: Function finished.');
};

const handleLogout = () => {
    sessionStorage.removeItem('attendanceUser');
    showLogin();
};

const populateStrataPlans = async () => {
    strataPlanSelect.disabled = true;
    strataPlanSelect.innerHTML = '<option value="">Loading plans...</option>';

    try {
        const result = await apiRequest('/strata-plans');
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
