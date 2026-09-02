// 商店截圖用的 chrome.* 打樁。
// 目的是讓真實的 popup.js / report.js 原封不動跑起來，
// 截出來的畫面才會跟實際執行一致，而不是手工拼的假圖。
// 資料一律用「範例／示範」字樣，不使用任何真實物件。

const CAPTURE_TIME = new Date('2026-09-02T10:24:00');

const STORE = {
  capStatus: '比對完成',
  capError: '',
  capPct: null,
  lastCaptureAt: CAPTURE_TIME.getTime(),
  ismartTotal: 66,
  ismartRows: new Array(66).fill(0).map((_, i) => ({ code: String(1000000 + i) })),
  ismartRaw: { caseKey: '', caseNoNumber: '', buildingName: '', totPrice: 0 },
  ismartEnvelopeKeys: ['total', 'caseList', 'conditions'],
  license_expires_on: '2027-09-01'
};

function ad(code, community, price, area, floor) {
  return { code, community, price, area, floor };
}
function watch(code, community, price, area, area2, floor) {
  return { code, caseKey: '', community, price, area, area2, floor };
}

const COMPARE = {
  at: CAPTURE_TIME.getTime(),
  n591: 64,
  nIsmart: 66,
  ismartTotal: 66,
  ismartMode: 'intercept',
  s591Mode: 'api',
  summary: { perfect: 58, priceDiff: 3, check: 1, extra: 2, noAd: 4 },
  results: [
    {
      type: '價格不一致',
      ad: ad('S13240915', '示範花園社區', 1180, 38.18, 11),
      w: watch('0025862', '示範花園社區', 1160, 38.18, 18.64, 11),
      reason: 'i智慧 1160萬 → 591 應改為 1160萬(目前 1180)'
    },
    {
      type: '價格不一致',
      ad: ad('S13118804', '範例景觀大樓', 1438, 45.46, 2),
      w: watch('0397486', '範例景觀大樓', 1388, 45.46, 22.00, 2),
      reason: 'i智慧 1388萬 → 591 應改為 1388萬(目前 1438)'
    },
    {
      type: '需確認',
      ad: ad('S13077412', '示範學區華廈', 968, 30.52, 5),
      w: null,
      cand: watch('1040070', '示範學區華廈NO.2', 998, 33.02, 25.57, 4),
      candScore: 118,
      reason: 'i智慧 有很相似的物件（可能是同一個、或你重複刊登了）→ 請人工確認再決定要不要下架'
    },
    {
      type: '591多出',
      ad: ad('S12996533', '範例河岸首排', 1288, 41.30, 8),
      w: null,
      cand: null,
      candScore: 42,
      reason: 'i智慧 關注找不到對應 → 591 應下架'
    },
    {
      type: '完美匹配',
      ad: ad('S13201766', '示範捷運三房', 1160, 38.18, 11),
      w: watch('0025991', '示範捷運三房', 1160, 38.18, 18.64, 11)
    },
    {
      type: '完美匹配',
      ad: ad('S13188420', '範例電梯車墅', 2380, 62.44, 3),
      w: watch('0398112', '範例電梯車墅', 2380, 62.44, 40.10, 3)
    },
    {
      type: '完美匹配',
      ad: ad('S13150337', '示範公園首排', 858, 27.66, 14),
      w: watch('1041233', '示範公園首排', 858, 27.66, 16.92, 14)
    }
  ],
  noAd: [
    watch('1042870', '範例都心廣場', 1088, 34.21, 20.55, 7),
    watch('0399015', '示範綠意山莊', 1650, 52.08, 33.14, 6)
  ]
};

const ACCESS = {
  ok: true,
  allowed: true,
  mode: 'license',
  message: '授權有效。',
  installId: '8f3c1a02-4d7e-4b19-9a6c-2e5f70b18c44',
  expiresOn: '2027-09-01'
};

function pick(keys, source) {
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in source) out[k] = source[k];
  return out;
}

window.chrome = {
  runtime: {
    lastError: undefined,
    getManifest: () => ({ version: '1.7.0' }),
    getURL: (p) => p,
    sendMessage: (msg, cb) => {
      const cmd = msg && msg.cmd;
      let res = { ok: false, error: 'stub' };
      if (cmd === 'accessStatus') res = ACCESS;
      else if (cmd === 'manualStatus') res = { ok: true, active: false, count: 0, total: 0 };
      if (cb) setTimeout(() => cb(res), 0);
    }
  },
  storage: {
    local: {
      get: (keys, cb) => {
        const out = pick(keys, { ...STORE, compareResult: COMPARE });
        if (cb) { setTimeout(() => cb(out), 0); return; }
        return Promise.resolve(out);
      },
      set: () => Promise.resolve(),
      remove: () => Promise.resolve()
    },
    onChanged: { addListener: () => {} }
  },
  tabs: { create: () => {}, query: () => Promise.resolve([]) }
};
