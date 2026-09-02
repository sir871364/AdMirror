export function classifyCoreLicenseStatus(data) {
  if (!data?.success || typeof data.global_suspended !== 'boolean' || typeof data.product_suspended !== 'boolean') {
    return { decision: 'unavailable', message: '目前無法確認授權狀態，請稍後再試。' };
  }
  if (data.global_suspended) {
    return { decision: 'suspended', message: '系統目前處於緊急停止狀態。\n\n請稍後再試。' };
  }
  if (data.product_suspended) {
    return { decision: 'suspended', message: '目前此工具已由系統管理員暫時停止使用。\n\n請稍後再試。' };
  }
  if (data.active === true) {
    return { decision: 'licensed', message: '授權有效。' };
  }
  return { decision: 'unlicensed', message: '' };
}

// 帳號綁定政策，由授權伺服器在 license-status 回應裡的 account_policy 欄位下達：
//   { "trial": "required" | "optional", "license": "required" | "optional" }
//
// 刻意 fail-open：欄位不存在、格式不對、值不是精確的 "required"，一律視為 optional。
// 這讓擴充可以先部署、伺服器之後再決定要不要強制——伺服器沒說話之前，行為與現在完全相同。
export function readAccountPolicy(data) {
  const raw = data && typeof data === 'object' && data.account_policy && typeof data.account_policy === 'object'
    ? data.account_policy
    : null;
  const norm = (value) => (value === 'required' ? 'required' : 'optional');
  return {
    trial: norm(raw ? raw.trial : undefined),
    license: norm(raw ? raw.license : undefined)
  };
}

// 使用者看得懂的登入提示。瀏覽器中性：Chrome 是 Google 帳號、Edge 是 Microsoft 帳號。
export const ACCOUNT_REQUIRED_MESSAGE =
  '請先登入瀏覽器帳號（Chrome 用 Google、Edge 用 Microsoft），再重新開啟擴充功能。';
