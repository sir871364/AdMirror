export const DISCLAIMER_VERSION = 1;
export const DISCLAIMER_STORAGE_KEY =
  `admirror_disclaimer_accepted_v${DISCLAIMER_VERSION}`;

export async function getDisclaimerAccepted() {
  try {
    const stored = await chrome.storage.local.get([DISCLAIMER_STORAGE_KEY]);
    const record = stored?.[DISCLAIMER_STORAGE_KEY];
    return record?.accepted === true && record?.version === DISCLAIMER_VERSION;
  } catch {
    return false;
  }
}

export async function saveDisclaimerAccepted() {
  const record = {
    accepted: true,
    version: DISCLAIMER_VERSION,
    timestamp: Date.now(),
    date: new Date().toISOString()
  };

  await chrome.storage.local.set({ [DISCLAIMER_STORAGE_KEY]: record });
  return record;
}
