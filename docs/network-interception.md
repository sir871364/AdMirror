# Network 攔截：用 CDP 讀取頁面自己收到的回應

> 給接手的 AI／工程師的技術說明。目標：在**不注入腳本、不主動呼叫 API** 的前提下，
> 從一個需要登入的網站取得結構化資料。參考實作：`background.js`（AdMirror 1.7.x）。

---

## 0. 一句話

> 附加 Chrome DevTools Protocol 到使用者已開啟的分頁，開啟 `Network` 網域，
> 用模擬滑鼠翻頁讓**頁面自己**去要資料，然後讀取瀏覽器**已經收到**的 JSON 回應。

等同於：按 F12 → Network 分頁 → 翻頁 → 點開請求看 Response → 複製。只是由程式做。

---

## 1. 為什麼不用其他方法

| 方法 | 對伺服器發出的請求 | 資料品質 | 對目標網站 | 缺點 |
|---|---|---|---|---|
| **直接呼叫內部 API** | 擴充自己發，參數可自訂（例如 `take:100`） | 原始 JSON | 需注入腳本、需 host permission | 請求形狀與真人明顯不同，log 上一眼可辨；管理員可能反對 |
| **Network 攔截（本文）** | 頁面在模擬操作下自己發，與真人翻頁相同 | 原始 JSON | 零注入、零 host permission | 需要 `debugger` 權限；有翻頁時間 |
| **DOM 讀取** | 同上 | 文字（已渲染） | 需注入 content script、需 host permission | 版面一改就壞；拿不到畫面上沒顯示的欄位（如內部 key） |
| **截圖 + OCR** | 同上 | 文字（辨識，有誤差） | 零注入 | 760MB 引擎、慢、`0/O` 誤判、版面一改就壞 |

攔截版的定位：**對伺服器的可見度等於 OCR 版，資料品質等於 API 版。**

---

## 2. 原理與正確的心智模型

### 2.1 它在資料流的哪一段

```
伺服器 ──TLS──▶ 瀏覽器收到 JSON ──▶ 頁面 JS 解析 ──▶ 寫進 DOM ──▶ 排版 ──▶ 螢幕像素
                     ▲ 在這裡抄一份               ▲ DOM 版          ▲ OCR 版
```

攔截在 ①：資料剛到達瀏覽器、TLS 已正常結束、頁面尚未處理。不經過渲染，所以沒有辨識誤差。

### 2.2 它**不是**中間人攻擊

| | 中間人攻擊 | Network 攔截 |
|---|---|---|
| 位置 | 兩個端點**之間**的網路路徑 | **端點內部**（使用者自己的瀏覽器） |
| TLS | 必須破壞／偽造憑證 | 完全不碰，正常完成 |
| 能否改資料 | 可以 | 唯讀 |
| 資料屬於誰 | 別人的 | 執行者自己的 |

比喻：信送到你家信箱，你拆開看的同時影印一份放抽屜。中間人是攔郵車拆別人的信。

### 2.3 對伺服器來說什麼是「看得到」的

**請求照樣發生、照樣進 log。** 攔截不會讓流量隱形。差別只在請求的「形狀」：

- 直接打 API：幾秒內連發 20 次、`take:100`（前端 UI 給不出的參數）→ 一看就是機器
- 攔截：每頁一次、`take:30`、間隔數秒、由頁面自己組參數 → 與真人翻頁**完全相同，因為它就是**

誠實的說法是「不增加伺服器負擔、不使用非公開的呼叫方式」，**不是**「管理員看不見」。
若管理員反對的是「自動化工具存在」本身，這個方法一樣過不了關——那是政策問題，不是技術問題。

### 2.4 `debugger` 權限的真實範圍

技術上它能看到該分頁的**全部**網路活動。只讀特定端點是**程式碼自我約束**，不是平台強制。
隱私政策與使用須知必須主動揭露這一點。

---

## 3. 核心流程

```
1. 使用者停在目標清單頁（已登入）
2. chrome.debugger.attach(tab, '1.3')
3. Page.enable + Network.enable
4. Page.reload                      ← 確保第 1 頁的請求在 Network.enable 之後發生
5. 監聽 Network.responseReceived   → URL 符合目標端點就記下 requestId
   監聽 Network.loadingFinished    → Network.getResponseBody(requestId) → JSON.parse → 收進 Map
6. 若 count < total：模擬點「下一頁」→ 等新回應 → 回到 5
7. detach；比對 count 與 total；不足就不出結果
```

關鍵約束：**`Network.enable` 之前發生的請求拿不到 body**，所以一定要在 enable 之後觸發第一次載入（reload 最穩）。

---

## 4. 參考實作骨架

### 4.1 CDP 基礎

```js
function sendCmd(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(method + ': ' + err.message));
      resolve(res || {});
    });
  });
}
// attach / detach 同樣包成 Promise；detach 要吞掉 lastError（分頁可能已關）
```

### 4.2 Collector：用 spec 參數化，兩個網站共用同一支

```js
// spec = { urlRe, pickList, mapRow, storeKeys }
function createCollector(target, spec) {
  const byCode = new Map();      // 用穩定主鍵去重（翻頁重複、重試都不會多算）
  const wanted = new Set();      // 等待 body 的 requestId
  let total = 0, responses = 0, pending = 0, rawSample = null, envelopeKeys = [];

  async function readBody(requestId) {
    pending++;
    try {
      const r = await sendCmd(target, 'Network.getResponseBody', { requestId });
      let text = r.body;
      if (r.base64Encoded) {                       // 二進位／壓縮回應會是 base64
        const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0));
        text = new TextDecoder('utf-8').decode(bytes);
      }
      const json = JSON.parse(text);
      const data = json && json.data;
      const list = spec.pickList(data) || [];
      if (!rawSample && list.length) {             // 第一筆原始物件 + 外層欄位名 → 診斷用
        rawSample = list[0];
        envelopeKeys = Object.keys(data || {});
      }
      const t = pickTotal(data);                   // 試 total / totalCount / count …
      if (t) total = t;
      for (const c of list) {
        const row = spec.mapRow(c);
        if (row && row.code) byCode.set(row.code, row);
      }
      responses++;
      // 逐頁落地：MV3 service worker 隨時可能被回收，已收到的不能只放記憶體
      const k = spec.storeKeys;
      chrome.storage.local.set({ [k.rows]: [...byCode.values()], [k.total]: total,
                                 [k.raw]: rawSample, [k.envelope]: envelopeKeys });
    } catch (e) {
      console.warn('[capture] body 讀取失敗', requestId, e && e.message); // buffer 可能已淘汰
    } finally { pending--; }
  }

  function onEvent(source, method, params) {
    if (!source || source.tabId !== target.tabId) return;
    if (method === 'Network.responseReceived') {
      if (spec.urlRe.test(params.response?.url || '')) wanted.add(params.requestId);
    } else if (method === 'Network.loadingFinished') {
      if (wanted.delete(params.requestId)) readBody(params.requestId);
    } else if (method === 'Network.loadingFailed') {
      wanted.delete(params.requestId);
    }
  }
  chrome.debugger.onEvent.addListener(onEvent);

  return {
    get count() { return byCode.size; }, get total() { return total; },
    get responses() { return responses; }, get rows() { return [...byCode.values()]; },
    get rawSample() { return rawSample; }, get envelopeKeys() { return envelopeKeys; },
    async settle(ms = 1200) {                     // 等仍在讀的 body 收完
      const until = Date.now() + ms;
      while (pending > 0 && Date.now() < until) await sleep(80);
    },
    stop() { chrome.debugger.onEvent.removeListener(onEvent); }
  };
}
```

### 4.3 等待「新的一頁進來了」

不要用固定 sleep。用 `responses` 計數當訊號：

```js
async function waitForResponse(col, baseline, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (abortFlag) return false;
    if (col.responses > baseline) { await col.settle(600); return true; }
    await sleep(150);
  }
  return false;
}
```

### 4.4 主迴圈

```js
await attach(target);
try {
  await sendCmd(target, 'Page.enable');
  await sendCmd(target, 'Network.enable');
  const col = createCollector(target, SPEC);
  await sendCmd(target, 'Page.reload', { ignoreCache: false });
  if (!await waitForResponse(col, 0, 25000)) throw new Error('等不到清單回應');

  let page = 1, noGain = 0;
  while (page < MAX_PAGES) {
    if (abortFlag) break;
    if (col.total && col.count >= col.total) break;          // 收滿就停
    const before = col.count, respBefore = col.responses;
    page++;
    const moved = await clickNextPage(target);               // 見 §5
    if (!moved) break;                                        // 「下一頁」已停用＝最後一頁
    const got = await waitForResponse(col, respBefore);
    if (!got || col.count === before) { if (++noGain >= 2) break; } else noGain = 0;
  }
  await col.settle(1500);
  return finish(col);
} finally {
  col?.stop();
  await detach(target);
}
```

---

## 5. 翻頁：怎麼讓頁面自己去要下一頁

原則：**只用滑鼠事件，不用鍵盤，不用 `Runtime.evaluate`。**

### 5.1 定位按鈕：DOM 網域優先，像素備援

`DOM.querySelector` / `DOM.getBoxModel` 是**唯讀檢視**（等同 Elements 面板），不執行頁面 JS，不違反零注入。
不受視窗寬度、縮放、版面微調影響。

```js
const NEXT_SELECTORS = ['button.btn-next', '.el-pagination .btn-next', '.pagination .next',
                        'li.next > a', 'a.next', '[aria-label="下一頁"]', '[aria-label="Next"]'];

async function findNextByDom(target) {
  await sendCmd(target, 'DOM.enable');
  const { root } = await sendCmd(target, 'DOM.getDocument', { depth: 1 });
  const m = await getMetrics(target);                        // Page.getLayoutMetrics
  for (const selector of NEXT_SELECTORS) {
    const { nodeId } = await sendCmd(target, 'DOM.querySelector', { nodeId: root.nodeId, selector }).catch(() => ({}));
    if (!nodeId) continue;
    const { attributes } = await sendCmd(target, 'DOM.getAttributes', { nodeId }).catch(() => ({}));
    const disabled = isDisabledAttrs(attributes);            // disabled / aria-disabled / .is-disabled
    const { model } = await sendCmd(target, 'DOM.getBoxModel', { nodeId }).catch(() => ({}));
    if (!model?.content || !(model.width > 0)) continue;     // display:none 會丟錯或 0 寬
    const q = model.content;
    const cx = Math.round((Math.min(q[0], q[2], q[4], q[6]) + Math.max(q[0], q[2], q[4], q[6])) / 2);
    let cy = Math.round((Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2);
    // 不同 Chrome 版本 getBoxModel 的原點不同（文件 vs 視埠）；用「必須落在視埠內」判斷要不要扣捲動量
    if (cy < 0 || cy > m.vh) { const s = cy - (m.pageY || 0); if (s >= 0 && s <= m.vh) cy = s; }
    if (cx < 0 || cx > m.vw || cy < 0 || cy > m.vh) continue;
    return { x: cx, y: cy, disabled, selector };
  }
  return null;                                               // 退回像素搜尋（截圖找「›」字形）
}
```

像素備援（截圖底部細帶找深色字形叢）只在 DOM 找不到時用；它依賴寫死的偏移量，換視窗尺寸就失效。

### 5.2 點擊：press 與 release 之間**不能有間隔**

```js
async function clickAt(target, x, y) {
  // 先補一次 release，清掉上一輪可能卡住的「左鍵按著」狀態（沒按下時多送是無害的）
  await sendCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' }).catch(() => {});
  await sendCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
  await sleep(60);
  await sendCmd(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  // 不要 sleep：點的是會立刻換頁的按鈕，任何間隔都可能夾在換頁中間
  await sendCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
```

### 5.3 換頁前先 `settle()`

若翻頁是**整頁導覽**（例如 `?page=N` 的網址參數），導覽會清掉前一頁的 Network buffer。
一定要先 `await col.settle()` 把 body 讀完，再 `chrome.tabs.update(tabId, { url })`。SPA 換頁沒這問題。

---

## 6. 踩過的坑（每個都真的發生過）

| 症狀 | 原因 | 修法 |
|---|---|---|
| `Failed to fetch` | 用 `fetch('data:image/png;base64,…')` 解截圖，被 manifest 的 `connect-src` 擋 | base64 手動轉 `Uint8Array` → `Blob` → `createImageBitmap`，不用 fetch |
| 整頁被反選、翻頁沒發生 | 用 Ctrl+A 選頁碼框內容；點擊偏掉時焦點在 document，Ctrl+A 變成全選 | **完全不送鍵盤事件**；改點「下一頁」按鈕 |
| 整頁反選、停在第 1 頁（第二次） | `mousePressed` 與 `mouseReleased` 之間 70ms，夾在換頁中；release 落在新文件，舊文件以為左鍵還按著，下次 `mouseMoved` 變拖曳選取 | press 後立即 release；每次點擊前補送 release |
| 同事電腦翻不過去 | 像素定位靠寫死的「距右緣 348px」，視窗尺寸／縮放不同就找不到 | DOM 定位優先，像素只當備援 |
| 手動模式收到一半資料消失 | MV3 service worker 閒置約 30 秒被回收，監聽器一起沒了 | 逐頁寫進 `chrome.storage`；手動模式期間用 20 秒心跳撐住 worker |
| 漏頁但報表照出 | 沒比對 `total` | 讀不到 `total` → 報表頂端橘色警告；讀到但 `count < total × 0.9` → **不出報表** |
| 截圖是空的 | `Page.captureScreenshot({ fromSurface: true })` 需要分頁可見 | 需要截圖的流程讓分頁保持在前景；純攔截不需要截圖，可在背景跑 |

---

## 7. 完整性防呆（這是安全問題，不是 UX）

漏抓的後果依方向不同：

- 漏抓「應該存在」那邊的資料 → 對應項目被判成「多出／應下架」→ **誤刪有效資料**
- 漏抓「對照」那邊的資料 → 少提醒一筆 → 無害

所以對「應該存在」那邊：

1. 從回應讀 `total`（試 `total` / `totalCount` / `count` …，把外層欄位名存起來供診斷）
2. `count < total × 0.9` → 中止、不出結果、要求重跑
3. 讀不到 `total` → 結果頂端顯眼警告：「無法確認收齊，下架前請自行核對筆數」
4. 提供**手動模式**：只掛攔截、翻頁交給使用者、按完成才收工——自動翻頁壞了也有路走

---

## 8. 合規與揭露（不可省）

- manifest **不含**目標網站的 `host_permissions`——這是「零注入」的物證，寫測試鎖住它
- 不用 `chrome.scripting.executeScript`、不用 `Runtime.evaluate` 對目標網站；`DOM.*` 唯讀檢視可以
- 只比對並讀取**特定端點**的回應；程式碼註明這是自我約束
- 使用須知與隱私政策明寫：使用 `debugger` 權限、會出現黃色提示列、技術上可見該分頁全部流量、實際只讀哪個端點、資料留在本機不上傳
- 攔截到的業務資料若存在 `chrome.storage`，也要揭露
- 說明用詞：不要說「攔截」「中間人」——說「讀取已送達瀏覽器、我本來就看得到的資料；不額外向伺服器要任何東西」

---

## 9. 移植到新網站的檢查清單

1. **F12 → Network** 手動翻兩頁，找出清單端點的 URL pattern、回應結構（`data.list`？`data.items`？）、主鍵欄位、`total` 欄位名
2. 確認翻頁方式：SPA 內部換頁（需模擬點擊）還是網址參數（`tabs.update` 導頁即可，更簡單）
3. 寫 `spec = { urlRe, pickList, mapRow, storeKeys }`；`mapRow` 用穩定主鍵，映射成內部格式
4. 找「下一頁」按鈕的選擇器，放進 `NEXT_SELECTORS`；確認停用狀態怎麼表示
5. 第一次跑：把 `rawSample` 與 `envelopeKeys` 顯示在 UI，核對欄位對應
6. 驗證完整性：`count === total`；與另一種方式（API 或人工）對一次筆數
7. 加手動模式
8. 加完整性防呆與警告
9. 更新 manifest（`debugger`、不含目標 host）、使用須知、隱私政策
10. 寫測試鎖住：manifest 不含目標 host、不送鍵盤事件、`clickAt` 無間隔、fail-closed

---

## 10. 權限與架構摘要

```json
"permissions": ["debugger", "tabs", "storage"],
"host_permissions": [ /* 不含目標網站 */ ]
```

- 攔截邏輯、翻頁、閘門（授權／須知）全部放 **service worker**；popup 只是顯示層，關掉也繞不過
- `chrome.debugger.onDetach` 要處理：使用者按提示列的「取消」或關分頁時清理狀態
- 手動模式用 `setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)` 撐住 worker

---

## 11. 一句話給接手的人

> 讓頁面自己去要資料，你只負責在瀏覽器裡抄一份；翻頁只用滑鼠、按鈕位置問 DOM、
> 每一頁立刻落地、收不齊就不要出結果、manifest 裡不准出現目標網站。
