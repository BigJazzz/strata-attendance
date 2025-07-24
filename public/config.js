// config.js

/**
 * Base URL for all API requests.
 * On Vercel, this will point to your serverless functions.
 */
export const API_BASE = '/api';

 /**
  * Frontend application version.
  * Useful for cache busting or display.
  */
export const APP_VERSION = '3.0.0';

/**
 * How long to keep strata plan data in browser cache (6 hours).
 */
export const CACHE_DURATION_MS = 6 * 60 * 60 * 1000;

/**
 * Regular expression to validate email addresses.
 * Used in your “Email PDF Report” flow.
 */
export const EMAIL_REGEX =
  /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
