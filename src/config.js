export const LICENSE_API_BASE_URL = 'https://ycut-license-api.sir8713642.workers.dev';
export const LICENSE_REQUEST_API = `${LICENSE_API_BASE_URL}/api/request-license`;
export const LICENSE_STATUS_API = `${LICENSE_API_BASE_URL}/api/license-status`;
export const TRIAL_STATUS_API = `${LICENSE_API_BASE_URL}/api/trial-status`;

// 沿用 AdMirror 的產品代號：本工具是 591 比對工具的新實作，不是新產品。
// 後台的授權、試用、到期日、緊急停止都掛在這個代號下。
export const PRODUCT_ID = 'listing_compare';
export const TRIAL_DAYS = 3;
