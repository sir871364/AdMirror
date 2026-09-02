# 產生上架用的 zip。
#
# 不用寫死清單，而是從 manifest 出發追依賴：
#   manifest → service_worker / default_popup / icons
#   JS       → import ... from '...'、chrome.runtime.getURL('...')
#   HTML     → src=、href=
# 遞迴到收斂為止。這樣新增檔案不會忘記放進包裡，
# 移除檔案也不會留下孤兒。
#
# 反過來說，測試、產生器、說明文件、截圖、README 都不會被收進去——
# 上架包只放擴充執行時真正需要的東西。
#
# 用法（在專案根目錄）：python tools/package.py

import json
import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

IMPORT_RE = re.compile(r"""from\s+['"]([^'"]+)['"]""")
GETURL_RE = re.compile(r"""getURL\(\s*['"]([^'"]+)['"]""")
ASSET_RE = re.compile(r"""(?:src|href)\s*=\s*["']([^"']+)["']""")


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def norm(rel):
    return os.path.normpath(rel).replace('\\', '/')


def refs_of(rel):
    """回傳這個檔案引用到的其他檔案（已轉成相對專案根目錄）。"""
    if rel.endswith(('.png', '.json')):
        return []
    text = read(rel)
    base = os.path.dirname(rel)
    out = []
    patterns = [ASSET_RE] if rel.endswith('.html') else [IMPORT_RE, GETURL_RE]
    for pattern in patterns:
        for m in pattern.finditer(text):
            target = m.group(1)
            if target.startswith(('http://', 'https://', 'data:', '#')):
                continue
            out.append(norm(os.path.join(base, target)))
    return out


def main():
    manifest = json.loads(read('manifest.json'))

    seeds = ['manifest.json', manifest['background']['service_worker'],
             manifest['action']['default_popup']]
    seeds += list(manifest.get('icons', {}).values())
    seeds += list(manifest.get('action', {}).get('default_icon', {}).values())

    included, queue, missing = set(), [norm(s) for s in seeds], []
    while queue:
        rel = queue.pop()
        if rel in included:
            continue
        if not os.path.isfile(os.path.join(ROOT, rel)):
            missing.append(rel)
            continue
        included.add(rel)
        queue.extend(refs_of(rel))

    if missing:
        print('以下被引用的檔案不存在：')
        for m in sorted(missing):
            print('  -', m)
        sys.exit(1)

    # 防呆：開發用檔案不該進上架包
    banned = [f for f in included
              if f.startswith(('tests/', 'tools/')) or f.endswith(('.md', '.py'))]
    if banned:
        print('上架包混入了開發用檔案：', banned)
        sys.exit(1)

    out = os.path.join(ROOT, f"AdMirror-{manifest['version']}-store.zip")
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for rel in sorted(included):
            z.write(os.path.join(ROOT, rel), rel)  # manifest.json 位於壓縮檔根目錄

    total = os.path.getsize(out)
    print(f"版本   {manifest['version']}")
    print(f"檔案   {len(included)} 個")
    print(f"輸出   {os.path.basename(out)}  ({total / 1024:.0f} KB)")
    print()
    for rel in sorted(included):
        size = os.path.getsize(os.path.join(ROOT, rel))
        print(f"  {rel:<32} {size / 1024:7.1f} KB")


if __name__ == '__main__':
    main()
