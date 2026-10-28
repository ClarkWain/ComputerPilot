#!/usr/bin/env python3
"""Render the README's conceptual semantic-action diagrams (requires Pillow)."""
from pathlib import Path
import argparse
import json

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--font', default='/System/Library/Fonts/Hiragino Sans GB.ttc')
parser.add_argument('--mono-font', default='/System/Library/Fonts/Menlo.ttc')
args = parser.parse_args()
OUTPUT = ROOT / 'docs/media'
OUTPUT.mkdir(parents=True, exist_ok=True)


def render(number, slug, title, steps, action, code, kind):
    im = Image.new('RGB', (1400, 680), '#f8fafc')
    d = ImageDraw.Draw(im)

    def text(x, y, value, size=23, color='#0f172a', mono=False):
        font = ImageFont.truetype(args.mono_font if mono else args.font, size)
        d.text((x, y), value, font=font, fill=color)

    def box(bounds, fill, outline=None, radius=18):
        d.rounded_rectangle(bounds, radius=radius, fill=fill, outline=outline, width=2)

    text(36, 25, f'{number:02d}   {title}', 38)
    text(38, 87, '多个界面步骤，由本地执行器封装为一个应用语义动作。', 23, '#475569')
    box((36, 145, 570, 611), '#ffffff', '#e2e8f0')
    box((710, 145, 1364, 611), '#ecfdf5', '#a7f3d0')
    text(62, 168, '基础操作 · 逐步描述界面交互', 26, '#475569')
    text(737, 168, '1 个语义动作 · 直接描述目标', 26, '#047857')

    for i, label in enumerate(steps):
        y = 225 + i * 60
        box((62, y, 543, y + 45), '#f1f5f9', radius=10)
        d.ellipse((74, y + 8, 102, y + 36), fill='#cbd5e1')
        text(82, y + 7, str(i + 1), 18, '#334155', mono=True)
        text(117, y + 6, label, 22, '#334155')
        if i < len(steps) - 1:
            d.line((302, y + 46, 302, y + 57), fill='#94a3b8', width=2)
            d.polygon([(297, y + 53), (307, y + 53), (302, y + 58)], fill='#94a3b8')

    d.line((598, 379, 677, 379), fill='#10b981', width=7)
    d.polygon([(662, 364), (662, 394), (684, 379)], fill='#10b981')
    text(605, 407, '封装', 22, '#047857')

    box((737, 222, 1337, 421), '#0f172a', radius=14)
    text(759, 239, action, 27, '#6ee7b7', mono=True)
    for i, line in enumerate(code):
        text(759, 288 + i * 34, line, 23, '#e2e8f0', mono=True)
    box((737, 441, 1337, 585), '#ffffff', '#d1fae5', radius=14)
    text(760, 458, '结果示意', 19, '#64748b')
    if kind == 'circle':
        d.ellipse((802, 494, 872, 564), fill='#ec5f8c', outline='#1e1e1e', width=2)
        text(903, 502, '圆形 + 填充 + 描边', 25)
        text(903, 542, '位置与样式一次给出', 20, '#64748b')
    elif kind == 'text':
        text(802, 505, 'Hello DesktopPilot', 36, '#1e1e1e')
    else:
        box((791, 496, 859, 563), '#e0f2fe', '#7dd3fc', radius=8)
        text(800, 516, 'PNG', 22, '#0369a1', mono=True)
        text(889, 502, 'new-drawing.png', 26, mono=True)
        text(889, 543, '新文件 · PNG 解码验证', 20, '#64748b')
    text(38, 636, '流程示意：经典中文版 Paint profile；具体步骤随当前状态变化，图形与文字仍需截图验收。', 19, '#64748b')
    im.save(OUTPUT / f'{slug}.png', optimize=True)

    # Keep the illustrated intent machine-readable and tied to an implemented action.
    manifest = json.loads((ROOT / 'profiles/mspaint-classic-zh-CN/profile.json').read_text())
    assert action in {item['action'] for item in manifest['actions']}


render(1, 'semantic-circle', '画一个圆：从选工具到绘制，一次表达',
       ['选择椭圆工具', '设置轮廓与填充模式', '打开调色板，填写 RGB',
        '设置描边颜色与线宽', '移动到画布起点并拖绘', '松开鼠标，提交形状'],
       'drawing.drawCircle',
       ['center: [80, 80], radius: 24', 'fill: [236, 95, 140]',
        'stroke: {color: [30, 30, 30], width: 1}'], 'circle')
render(2, 'semantic-text', '在画布写字：内容与位置，一次表达',
       ['选择文字工具', '设置文字颜色', '在指定位置拖出文字框',
        '向文字框输入内容', '结束文字编辑，提交到画布'],
       'drawing.drawText',
       ['position: [20, 20], size: [360, 70]', 'text: "Hello DesktopPilot"',
        'stroke: {color: [30, 30, 30]}'], 'text')
render(3, 'semantic-save', '另存 PNG：从打开对话框到校验，一次表达',
       ['打开“另存为”对话框', '等待并定位文件名输入框', '填写新的绝对文件路径',
        '回读并核对文件名', '确认保存，等待对话框关闭', '读取文件，验证 PNG 可解码'],
       'document.saveAs',
       ['path: "C:/Pictures/new-drawing.png"', 'format: "png"',
        'overwrite: false'], 'save')
print('Rendered 3 semantic diagrams into docs/media/')
