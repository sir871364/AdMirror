# 產生 Network 攔截版的圖示。
# 設計：沿用同系列的圓角方形 + 雙文件（比對）造型，但底色改成青綠，
#       右下角徽章換成訊號弧線（代表 Network 攔截），與橘色的 AdMirror / OCR 版區分。
# 用法：python make_icon.py
from PIL import Image, ImageDraw

S = 512  # 先畫大張再縮，小尺寸才銳利

TOP = (34, 197, 214)     # 漸層上緣 青
BOT = (13, 116, 140)     # 漸層下緣 深青
CARD = (255, 255, 255)
LINE = (13, 116, 140)
BADGE_BG = (255, 255, 255)
BADGE_FG = (8, 145, 178)


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([8, 8, size - 8, size - 8], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bottom):
    g = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def build(size=S):
    base = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad = vertical_gradient(size, TOP, BOT).convert('RGBA')
    base.paste(grad, (0, 0), rounded_mask(size, int(size * 0.22)))

    d = ImageDraw.Draw(base)

    # 兩張文件卡（左右並排 = 比對）
    card_w, card_h = int(size * 0.255), int(size * 0.40)
    gap = int(size * 0.055)
    total = card_w * 2 + gap
    x0 = (size - total) // 2
    y0 = int(size * 0.20)
    r = int(size * 0.045)

    for i in range(2):
        cx = x0 + i * (card_w + gap)
        d.rounded_rectangle([cx, y0, cx + card_w, y0 + card_h], radius=r, fill=CARD)
        # 卡片內的文字線
        lw = int(size * 0.022)
        for k in range(3):
            ly = y0 + int(card_h * (0.26 + k * 0.22))
            pad = int(card_w * 0.18)
            right = cx + card_w - pad - (int(card_w * 0.22) if k == 2 else 0)
            d.rounded_rectangle([cx + pad, ly, right, ly + lw], radius=lw // 2, fill=LINE)

    # 右下徽章：訊號弧線（Network）
    br = int(size * 0.215)
    bcx, bcy = int(size * 0.755), int(size * 0.745)
    d.ellipse([bcx - br, bcy - br, bcx + br, bcy + br], fill=BADGE_BG)

    # 三道由小到大的弧 + 中心點，弧心在徽章下緣附近
    ox, oy = bcx, bcy + int(br * 0.42)
    w = max(2, int(size * 0.026))
    for k, rad in enumerate((br * 0.34, br * 0.60, br * 0.86)):
        d.arc([ox - rad, oy - rad, ox + rad, oy + rad], start=205, end=335, fill=BADGE_FG, width=w)
    dot = int(size * 0.026)
    d.ellipse([ox - dot, oy - dot, ox + dot, oy + dot], fill=BADGE_FG)

    return base


if __name__ == '__main__':
    icon = build()
    for px in (128, 48, 32, 16):
        icon.resize((px, px), Image.LANCZOS).save(f'icon{px}.png')
    icon.resize((256, 256), Image.LANCZOS).save('icon.png')
    print('wrote icon.png, icon128.png, icon48.png, icon32.png, icon16.png')
