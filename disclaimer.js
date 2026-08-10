import {
  getDisclaimerAccepted,
  saveDisclaimerAccepted
} from './src/disclaimer.js';

const params = new URLSearchParams(window.location.search);
const readonlyMode = params.get('readonly') === '1';

const scrollArea = document.getElementById('disclaimer-scroll');
const scrollHint = document.getElementById('scroll-hint');
const agreementBox = document.getElementById('agreement-box');
const agreementCheck = document.getElementById('agreement-check');
const acceptButton = document.getElementById('accept-button');
const cancelButton = document.getElementById('cancel-button');
const closeButton = document.getElementById('close-button');
const pageStatus = document.getElementById('page-status');
const headerMessage = document.getElementById('header-message');

const state = {
  reachedBottom: false,
  processing: false
};

function showStatus(message, type = '') {
  pageStatus.textContent = message;
  pageStatus.className = `page-status${type ? ` ${type}` : ''}`;
}

function refreshControls() {
  acceptButton.disabled = state.processing ||
    !(state.reachedBottom && agreementCheck.checked);
  cancelButton.disabled = state.processing;
}

function checkScrollPosition() {
  if (readonlyMode || state.reachedBottom) return;
  const atBottom = scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight - 5;
  const allVisible = scrollArea.scrollHeight <= scrollArea.clientHeight + 5;
  if (!atBottom && !allVisible) return;

  state.reachedBottom = true;
  agreementCheck.disabled = false;
  scrollHint.textContent = allVisible
    ? '✓ 已顯示全部內容，請勾選下方同意聲明'
    : '✓ 已捲動到底，請勾選下方同意聲明';
  scrollHint.classList.add('complete');
  refreshControls();
}

async function closeCurrentDisclaimerTab() {
  let removeError = null;

  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (Number.isInteger(currentTab?.id)) {
      try {
        await chrome.tabs.remove(currentTab.id);
        return;
      } catch (error) {
        removeError = error;
        console.error('無法使用 chrome.tabs.remove 關閉免責聲明分頁：', error);
      }
    }
  } catch (error) {
    removeError = error;
    console.error('無法取得目前免責聲明分頁：', error);
  }

  window.close();
  if (removeError) throw removeError;
  throw new Error('無法取得目前分頁 ID。');
}

async function handleCloseFailure(message) {
  state.processing = false;
  showStatus(message, 'error');
  refreshControls();
}

async function acceptDisclaimer() {
  if (state.processing || !state.reachedBottom || !agreementCheck.checked) return;

  state.processing = true;
  refreshControls();
  showStatus('正在儲存同意紀錄…');

  try {
    await saveDisclaimerAccepted();
  } catch (error) {
    console.error('儲存同意紀錄失敗：', error);
    state.processing = false;
    showStatus('無法儲存同意紀錄，請確認擴充功能儲存權限後再試。', 'error');
    refreshControls();
    return;
  }

  acceptButton.textContent = '已完成同意';
  showStatus('同意紀錄已儲存，正在關閉此分頁…', 'success');

  try {
    await closeCurrentDisclaimerTab();
  } catch {
    await handleCloseFailure('同意已儲存，但無法自動關閉此分頁，請手動關閉。');
  }
}

async function closeWithoutSaving() {
  if (state.processing) return;
  state.processing = true;
  refreshControls();

  try {
    await closeCurrentDisclaimerTab();
  } catch {
    await handleCloseFailure('無法自動關閉此分頁，請手動關閉。');
  }
}

function enableReadonlyMode() {
  document.title = 'AdMirror 使用須知與免責聲明';
  headerMessage.textContent = '完整使用須知與免責聲明';
  scrollHint.hidden = true;
  agreementBox.hidden = true;
  cancelButton.hidden = true;
  acceptButton.hidden = true;
  closeButton.hidden = false;
}

scrollArea.addEventListener('scroll', checkScrollPosition, { passive: true });
window.addEventListener('resize', checkScrollPosition);
agreementCheck.addEventListener('change', refreshControls);
acceptButton.addEventListener('click', acceptDisclaimer);
cancelButton.addEventListener('click', closeWithoutSaving);
closeButton.addEventListener('click', closeWithoutSaving);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') event.preventDefault();
}, true);

if (readonlyMode) {
  enableReadonlyMode();
} else {
  requestAnimationFrame(checkScrollPosition);
  scrollArea.focus({ preventScroll: true });

  getDisclaimerAccepted().then((accepted) => {
    if (!accepted) return;
    showStatus('你已完成首次同意，可關閉此分頁後開始使用。', 'success');
    acceptButton.textContent = '已完成同意';
    acceptButton.disabled = true;
  }).catch((error) => {
    console.error('讀取同意紀錄失敗：', error);
  });
}
