# -*- coding: utf-8 -*-
"""
把两张 Cursor 截图（汉化前 / 汉化后）做成宣传素材：
  1. 打码：侧栏对话标题、用户名头像 → 马赛克；对话正文 → 高斯模糊
  2. 01-before-after.png   左右对比图（GitHub README，1200x850）
  3. 02-toggle.gif         前后切换 GIF（README 顶部）
  4. 03-toggle.mp4         同内容横版视频（B 站 / 推文）
  5. 04-vertical.mp4       竖版 1080x1920（抖音 / 小红书视频）
  6. 05-xhs-cover.png      小红书封面 1080x1440

用法：python make-promo.py <before.png> <after.png> [outdir]
换更高分辩率的截图时，打码坐标按 1024x711 标定、自动按比例缩放；布局若变化需调整 SIDEBAR_ROWS 等。
依赖：pip install pillow imageio-ffmpeg
"""
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

BEFORE, AFTER = sys.argv[1], sys.argv[2]
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

FONT_R = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"


def font(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT_R, size)


# ---------------- 1. 打码 ----------------
# 坐标基于 1024x711 截图；两张图布局一致
SIDEBAR_ROWS = [(316, 338), (348, 370), (465, 487), (496, 518), (570, 592), (602, 624)]  # 需打码的对话/仓库名行
SIDEBAR_X = (30, 208)
USER_BOX = (8, 664, 128, 704)  # 头像 + 用户名


def mosaic(img, box, block=8):
    region = img.crop(box)
    w, h = region.size
    small = region.resize((max(1, w // block), max(1, h // block)), Image.BILINEAR)
    img.paste(small.resize((w, h), Image.NEAREST), box)


def blur(img, box, radius=9):
    region = img.crop(box).filter(ImageFilter.GaussianBlur(radius))
    img.paste(region, box)


def redact(path, body_boxes):
    img = Image.open(path).convert("RGB")
    sx, sy = img.width / 1024, img.height / 711
    S = lambda b: tuple(int(round(v * (sx if i % 2 == 0 else sy))) for i, v in enumerate(b))
    for y0, y1 in SIDEBAR_ROWS:
        mosaic(img, S((SIDEBAR_X[0], y0, SIDEBAR_X[1], y1)), block=max(2, int(7 * sx)))
    mosaic(img, S(USER_BOX), block=max(2, int(8 * sx)))
    for b in body_boxes:
        blur(img, S(b), radius=9 * sx)
    return img


before = redact(BEFORE, body_boxes=[(232, 68, 968, 330)])  # 英文图：保留下方 "7 Files Changed" 卡片
after = redact(AFTER, body_boxes=[(232, 68, 968, 618)])  # 中文图：正文全部模糊
before.save(os.path.join(OUT, "redacted-before.png"))
after.save(os.path.join(OUT, "redacted-after.png"))

W, H = before.size  # 1024x711

# 截图里真正体现"翻译"的区域是左侧栏 + 顶栏 + 底部输入区；正文是 AI 回复（本来就是中文）且已模糊。
# 宣传图用裁切放大，让 13px 的 UI 文字看得清。
CROP_MAIN = (0, 0, 640, H)  # 侧栏 + 对话标题 + 输入区左半
CROP_SIDE = (0, 0, 215, H)  # 只要侧栏
before_main, after_main = before.crop(CROP_MAIN), after.crop(CROP_MAIN)
before_side, after_side = before.crop(CROP_SIDE), after.crop(CROP_SIDE)

# ---------------- 通用绘制 ----------------
BG = (15, 17, 21)
ACCENT = (99, 179, 237)  # 淡蓝
GREEN = (72, 199, 142)
GRAY = (150, 156, 168)
WHITE = (240, 242, 245)


def rounded(img, r=14):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), r, fill=255)
    out = Image.new("RGBA", img.size)
    out.paste(img, (0, 0), mask)
    return out


def shadow_paste(canvas, img, xy, blur_r=18, offset=(0, 10), alpha=140):
    x, y = xy
    sh = Image.new("RGBA", (img.width + blur_r * 4, img.height + blur_r * 4), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        (blur_r * 2, blur_r * 2, blur_r * 2 + img.width, blur_r * 2 + img.height), 14, fill=(0, 0, 0, alpha)
    )
    sh = sh.filter(ImageFilter.GaussianBlur(blur_r))
    canvas.alpha_composite(sh, (x - blur_r * 2 + offset[0], y - blur_r * 2 + offset[1]))
    canvas.alpha_composite(img, (x, y))


def pill(draw, xy, text, f, fill, fg=WHITE, pad=(16, 7)):
    x, y = xy
    tw = draw.textlength(text, font=f)
    th = f.size
    draw.rounded_rectangle((x, y, x + tw + pad[0] * 2, y + th + pad[1] * 2), (th + pad[1] * 2) // 2, fill=fill)
    draw.text((x + pad[0], y + pad[1] - 1), text, font=f, fill=fg)
    return tw + pad[0] * 2


def center_text(draw, cx, y, text, f, fill):
    tw = draw.textlength(text, font=f)
    draw.text((cx - tw / 2, y), text, font=f, fill=fill)


# ---------------- 2. 左右对比图 1200x850 ----------------
def make_side_by_side():
    cw, ch = 1200, 850
    c = Image.new("RGBA", (cw, ch), BG + (255,))
    d = ImageDraw.Draw(c)
    for x in range(cw):  # 顶部渐变装饰线
        t = x / cw
        col = tuple(int(ACCENT[i] * (1 - t) + GREEN[i] * t) for i in range(3))
        d.line((x, 0, x, 5), fill=col)
    d.text((60, 42), "cursor-zh", font=font(40, True), fill=WHITE)
    d.text((262, 52), "Cursor 界面实时汉化 · 不改安装文件 · 一个 exe", font=font(24), fill=GRAY)
    d.text((60, 104), "Agent 面板、Settings、菜单全部中文 — 官方语言包管不到的地方，它来补", font=font(20), fill=(190, 196, 208))

    y0 = 208
    sw = (cw - 60 * 2 - 120) // 2  # 两图之间留 120
    sh_ = int(before_main.height * sw / before_main.width)
    b = rounded(before_main.resize((sw, sh_), Image.LANCZOS))
    a = rounded(after_main.resize((sw, sh_), Image.LANCZOS))
    shadow_paste(c, b, (60, y0))
    shadow_paste(c, a, (cw - 60 - sw, y0))
    d = ImageDraw.Draw(c)
    pill(d, (60, y0 - 50), "汉化前", font(20, True), (70, 74, 84))
    pill(d, (cw - 60 - sw, y0 - 50), "汉化后", font(20, True), GREEN, fg=(10, 30, 20))
    cx = cw // 2
    ay = y0 + sh_ // 2
    d.rounded_rectangle((cx - 26, ay - 26, cx + 26, ay + 26), 26, fill=(30, 33, 40))
    d.polygon([(cx - 8, ay - 11), (cx + 10, ay), (cx - 8, ay + 11)], fill=ACCENT)
    center_text(d, cx, ch - 52, "github.com/Ver3ce/cursor-zh   ·   MIT   ·   Windows", font(18), GRAY)
    c.convert("RGB").save(os.path.join(OUT, "01-before-after.png"), optimize=True)


# ---------------- 3/4. 横版切换 GIF + MP4 ----------------
def framed(img, label, label_fill, fg=WHITE):
    """截图 + 底部说明条"""
    bar = 60
    c = Image.new("RGBA", (W, H + bar), BG + (255,))
    c.paste(img, (0, 0))
    d = ImageDraw.Draw(c)
    pill(d, (18, H + 13), label, font(18, True), label_fill, fg=fg)
    tag = "github.com/Ver3ce/cursor-zh"
    d.text((W - 18 - d.textlength(tag, font=font(17)), H + 20), tag, font=font(17), fill=GRAY)
    return c.convert("RGB")


def crossfade(a, b, n):
    return [Image.blend(a, b, (i + 1) / (n + 1)) for i in range(n)]


def write_video(seq, fps, out):
    tmp = os.path.join(OUT, "_frames_" + os.path.splitext(os.path.basename(out))[0])
    os.makedirs(tmp, exist_ok=True)
    idx = 0
    for f, dm in seq:
        for _ in range(max(1, round(dm * fps / 1000))):
            f.save(os.path.join(tmp, f"f{idx:04d}.png"))
            idx += 1
    ffmpeg(tmp, fps, out)


def make_toggle():
    fb = framed(before, "汉化前：Agent 面板全是英文", (70, 74, 84))
    fa = framed(after, "汉化后：cursor-zh 实时翻译", GREEN, fg=(10, 30, 20))
    fps = 12
    seq = [(fb, 1800)] + [(f, 1000 // fps) for f in crossfade(fb, fa, 8)] + [(fa, 2600)] + [(f, 1000 // fps) for f in crossfade(fa, fb, 8)]
    gif_frames = [f.convert("P", palette=Image.ADAPTIVE, colors=256) for f, _ in seq]
    gif_frames[0].save(
        os.path.join(OUT, "02-toggle.gif"), save_all=True, append_images=gif_frames[1:],
        duration=[dm for _, dm in seq], loop=0, optimize=False,
    )
    write_video(seq, fps, os.path.join(OUT, "03-toggle.mp4"))


# ---------------- 5. 竖版视频 1080x1920 ----------------
def vertical_frame(img, label, label_fill, fg=WHITE):
    cw, ch = 1080, 1920
    c = Image.new("RGBA", (cw, ch), BG + (255,))
    d = ImageDraw.Draw(c)
    center_text(d, cw // 2, 150, "Cursor 的 Agent 面板", font(72, True), WHITE)
    center_text(d, cw // 2, 250, "还在看英文？", font(72, True), ACCENT)
    center_text(d, cw // 2, 370, "官方中文包只翻菜单，Agent / Settings 不管", font(30), GRAY)
    sw = 920
    sh_ = int(img.height * sw / img.width)  # 640x711 → 920x1022
    y0 = 450
    shadow_paste(c, rounded(img.resize((sw, sh_), Image.LANCZOS), 18), ((cw - sw) // 2, y0))
    d = ImageDraw.Draw(c)
    pw = d.textlength(label, font=font(30, True)) + 44
    pill(d, (int((cw - pw) // 2), y0 + sh_ + 36), label, font(30, True), label_fill, fg=fg, pad=(22, 12))
    center_text(d, cw // 2, 1600, "cursor-zh", font(60, True), WHITE)
    center_text(d, cw // 2, 1690, "一个 exe · 实时翻译 · 不改 Cursor 任何文件", font(30), (190, 196, 208))
    center_text(d, cw // 2, 1750, "开源免费 · github.com/Ver3ce/cursor-zh", font(30), GREEN)
    return c.convert("RGB")


def make_vertical():
    vb = vertical_frame(before_main, "汉化前", (70, 74, 84))
    va = vertical_frame(after_main, "汉化后", GREEN, fg=(10, 30, 20))
    fps = 15
    seq = [(vb, 2200)] + [(f, 1000 // fps) for f in crossfade(vb, va, 10)] + [(va, 3200)] + [(f, 1000 // fps) for f in crossfade(va, vb, 10)]
    write_video(seq, fps, os.path.join(OUT, "04-vertical.mp4"))
    va.save(os.path.join(OUT, "04-vertical-still.png"))


# ---------------- 6. 小红书封面 1080x1440 ----------------
def make_xhs_cover():
    cw, ch = 1080, 1440
    c = Image.new("RGBA", (cw, ch), BG + (255,))
    d = ImageDraw.Draw(c)
    d.text((70, 90), "Cursor 界面", font=font(88, True), fill=WHITE)
    d.text((70, 200), "一键中文", font=font(88, True), fill=ACCENT)
    d.text((70, 330), "Agent 面板 · Settings · 菜单 全部汉化", font=font(34), fill=(190, 196, 208))
    d.text((70, 385), "不改安装文件，不怕更新，开源免费", font=font(34), fill=(190, 196, 208))
    # 两条侧栏并排：New Chat / Search / Automations… 对 新建对话 / 搜索 / 自动化…
    sh_ = 800
    sw = int(before_side.width * sh_ / before_side.height)
    gap = 150
    x1 = (cw - (sw * 2 + gap)) // 2
    x2 = x1 + sw + gap
    y0 = 500
    shadow_paste(c, rounded(before_side.resize((sw, sh_), Image.LANCZOS), 12), (x1, y0))
    shadow_paste(c, rounded(after_side.resize((sw, sh_), Image.LANCZOS), 12), (x2, y0))
    d = ImageDraw.Draw(c)
    pill(d, (x1, y0 - 56), "汉化前", font(24, True), (70, 74, 84))
    pill(d, (x2, y0 - 56), "汉化后", font(24, True), GREEN, fg=(10, 30, 20))
    cx, ay = cw // 2, y0 + sh_ // 2
    d.rounded_rectangle((cx - 34, ay - 34, cx + 34, ay + 34), 34, fill=(30, 33, 40))
    d.polygon([(cx - 10, ay - 14), (cx + 13, ay), (cx - 10, ay + 14)], fill=ACCENT)
    center_text(d, cw // 2, ch - 100, "github.com/Ver3ce/cursor-zh", font(40, True), GREEN)
    c.convert("RGB").save(os.path.join(OUT, "05-xhs-cover.png"), optimize=True)


# ---------------- ffmpeg ----------------
def ffmpeg(frames_dir, fps, out):
    import imageio_ffmpeg

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(frames_dir, "f%04d.png"),
         "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",  # yuv420p 要求偶数尺寸
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out],
        check=True,
    )
    for f in os.listdir(frames_dir):
        os.remove(os.path.join(frames_dir, f))
    os.rmdir(frames_dir)


make_side_by_side()
make_toggle()
make_vertical()
make_xhs_cover()
for f in sorted(os.listdir(OUT)):
    p = os.path.join(OUT, f)
    print(f"{os.path.getsize(p)/1024:8.0f} KB  {f}")
