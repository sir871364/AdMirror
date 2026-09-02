function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function link591(ad) { return ad && ad.code ? 'https://user.591.com.tw/ware/open?keywords=' + encodeURIComponent(ad.code) : ''; }
// i智慧 連結：有 caseKey(UUID) 就直接開明細頁 /is/case/detail/{uuid}；
// 沒有 UUID（舊資料或欄位沒抓到）才退回用編號搜尋，確保不會產生死連結。
function iLink(o) {
  if (o && o.caseKey) return 'https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(o.caseKey);
  return o && o.code ? 'https://is.ycut.com.tw/is/case/search/all-case?keyword=' + encodeURIComponent(o.code) : '';
}

function fmt(o, ismart) {
  if (!o) return '<span class="empty">— 無 —</span>';
  const price = o.price ? o.price + '萬' : '?';
  const area = (o.area || o.area2) ? ((o.area || o.area2) + '坪') : '?';
  const fl = o.floor ? (o.floor + 'F') : '';
  let codePart = '';
  if (o.code) {
    const href = iLink(o);
    codePart = (ismart && href)
      ? ' <a class="sub2" href="' + href + '" target="_blank">' + esc(o.code) + ' ↗</a>'
      : ' <span class="sub2">' + esc(o.code) + '</span>';
  }
  return '<b>' + esc(o.community || '(無社區名)') + '</b>' + codePart +
    '<br>' + price + ' / ' + area + (fl ? ' / ' + fl : '');
}

chrome.storage.local.get(['compareResult', 'compareError', 'capError'], (d) => {
  const sub = document.getElementById('sub');
  const cards = document.getElementById('cards');
  const body = document.getElementById('body');

  if (d.compareError) { body.innerHTML = '<p class="empty">⚠ 比對失敗：' + esc(d.compareError) + '</p>'; return; }
  if (d.capError) { body.innerHTML = '<p class="empty">⚠ 擷取失敗：' + esc(d.capError) + '</p>'; return; }
  const cmp = d.compareResult;
  if (!cmp) { body.innerHTML = '<p>還沒有比對結果。請在 i智慧 關注清單頁按擴充的「🚀 自動擷取並比對」。</p>'; return; }

  const t = cmp.at ? new Date(cmp.at) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const iCount = (cmp.ismartTotal && cmp.ismartTotal !== cmp.nIsmart)
    ? `i智慧 關注 ${cmp.ismartTotal} 筆（攔截到 ${cmp.nIsmart}）`
    : `i智慧 關注 ${cmp.nIsmart} 筆`;
  sub.innerHTML = (t ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}　` : '') +
    `591 廣告 ${cmp.n591}${cmp.s591Total ? ' / 共 ' + cmp.s591Total : ''} 筆　vs　${iCount}` +
    '　<span style="color:#1565c0">· i智慧：' + (cmp.ismartMode === 'api' ? '注入 API' : 'Network 攔截')
    + '　· 591：' + (cmp.s591Mode === 'intercept' ? 'Network 攔截' : '注入 API') + '</span>';

  const s = cmp.summary;
  cards.innerHTML =
    `<div class="card c-ok"><div class="n">${s.perfect}</div><div class="l">完美匹配</div></div>` +
    `<div class="card c-price"><div class="n">${s.priceDiff}</div><div class="l">價格不一致（要改價）</div></div>` +
    `<div class="card c-check"><div class="n">${s.check || 0}</div><div class="l">需人工確認</div></div>` +
    `<div class="card c-extra"><div class="n">${s.extra}</div><div class="l">591 多出（要下架）</div></div>` +
    `<div class="card c-noad"><div class="n">${s.noAd}</div><div class="l">i智慧關注沒對應</div></div>`;

  const results = cmp.results || [];
  const order = { '價格不一致': 0, '需確認': 1, '591多出': 2, '完美匹配': 3 };
  results.sort((a, b) => (order[a.type] - order[b.type]));

  let html = '';

  // 沒讀到 i智慧 的「共 N 筆」就無法確認資料收齊了。
  // 少收一頁 = 那頁的物件會被誤判成「591 多出 → 應下架」，代價很高，所以明講。
  if (!cmp.ismartTotal) {
    html += '<div style="background:#fff3e0;border:1px solid #ff9800;border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px;line-height:1.6;">'
      + '<b style="color:#e65100;">⚠ 無法確認 i智慧 資料是否收齊</b><br>'
      + '這次沒有從回應中讀到總筆數，所以無法驗證是不是每一頁都攔到了。'
      + '<b>若有漏頁，漏掉的物件會被誤判成「591 多出 → 應下架」。</b><br>'
      + '動手下架前，請先確認 i智慧 關注清單的實際筆數是否等於 <b>' + cmp.nIsmart + '</b> 筆。'
      + '</div>';
  }

  html += '<div class="sec">📋 591 廣告逐筆對照（要處理的排在前面）</div>';
  html += '<table><thead><tr><th style="width:110px">狀態</th><th>591 廣告</th><th>i智慧 關注</th><th>建議動作</th></tr></thead><tbody>';
  for (const r of results) {
    let badge, act = '';
    if (r.type === '完美匹配') {
      badge = '<span class="badge b-ok">✓ 完美匹配</span>';
      act = '<span class="sub2">無須動作' + (r.byPrice ? '（靠唯一價格配對，可順手瞄一眼）' : '') + '</span>';
    } else if (r.type === '價格不一致') {
      badge = '<span class="badge b-price">價格不一致</span>';
      act = '<span class="act act-price">改價 → ' + (r.w ? r.w.price : '?') + '萬</span><br><span class="sub2">' + esc(r.reason || '') + '</span>';
    } else if (r.type === '需確認') {
      badge = '<span class="badge b-check">⚠ 需確認</span>';
      act = '<span class="act act-check">請人工確認</span><br><span class="sub2">' + esc(r.reason || '') + '</span>';
    } else {
      badge = '<span class="badge b-extra">591 多出</span>';
      act = '<span class="act act-extra">下架</span><br><span class="sub2">' + esc(r.reason || '') + '</span>';
    }
    const adCell = fmt(r.ad) + (link591(r.ad) ? '<br><a href="' + link591(r.ad) + '" target="_blank">開 591 廣告</a>' : '');
    let iCell = fmt(r.w, true);
    if (!r.w && r.cand) iCell = '<span class="sub2">最接近(未達標，分數 ' + r.candScore + '):</span><br>' + fmt(r.cand, true);
    html += '<tr><td>' + badge + '</td><td>' + adCell + '</td><td>' + iCell + '</td><td>' + act + '</td></tr>';
  }
  html += '</tbody></table>';

  if (cmp.noAd && cmp.noAd.length) {
    html += '<div class="sec">🔵 i智慧 有關注、但 591 沒有對應廣告（' + cmp.noAd.length + ' 筆）</div>';
    html += '<table><thead><tr><th>i智慧 關注</th><th>說明</th></tr></thead><tbody>';
    for (const w of cmp.noAd) {
      html += '<tr><td>' + fmt(w, true) + '</td><td class="sub2">i智慧 有此物件，591 沒找到對應廣告（可能需補做廣告，或已成交待確認）</td></tr>';
    }
    html += '</tbody></table>';
  }
  body.innerHTML = html;
});
