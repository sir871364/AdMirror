// v2：新增「四、瀏覽器偵錯工具的使用」一節。
// 版號一併調升，讓已同意 v1 的使用者重新確認一次——
// 否則新增的揭露內容對既有使用者等於不存在，加了也沒有意義。
export const DISCLAIMER_VERSION = 2;
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
