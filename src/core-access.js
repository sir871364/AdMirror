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
