商店截圖產生器
================

用真正的 popup.html / report.html + CSS 渲染，只把 chrome.* API 打樁餵入
範例資料，所以截出來的畫面跟實際執行一致，不是手工拼的示意圖。
UI 改版後重跑一次即可，不用手動修圖。

檔案：
  shim.js     chrome.* 打樁與範例資料（全部使用「範例／示範」字樣，
              不含任何真實物件資料）
  shot1.html  1280x800，popup 實際畫面 + 文案
  shot2.html  1280x800，比對報表實際畫面

產生方式（在專案根目錄執行）：

  mkdir -p /tmp/shots
  cp popup.html popup.js report.html report.js tools/shim.js /tmp/shots/
  cp -r src lib /tmp/shots/
  cp tools/shot1.html tools/shot2.html /tmp/shots/
  cd /tmp/shots

  # 把 shim 插在真正的腳本之前（markup 與 CSS 完全不動）
  sed -i 's|<script type="module" src="popup.js"></script>|<script src="shim.js"></script>\n<script type="module" src="popup.js"></script>|' popup.html
  sed -i 's|<script src="report.js"></script>|<script src="shim.js"></script>\n<script src="report.js"></script>|' report.html
  mv popup.html stub-popup.html
  mv report.html stub-report.html

  CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
  WINW=$(cygpath -w "$PWD"); WINM=$(cygpath -m "$PWD")
  for n in 1 2; do
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --force-device-scale-factor=1 --window-size=1280,800 \
      --screenshot="$WINW\out$n.png" --virtual-time-budget=5000 \
      --allow-file-access-from-files "file:///$WINM/shot$n.html"
  done

輸出為 1280x800、RGB（24 位元、無 alpha），符合 Chrome Web Store 規格。
