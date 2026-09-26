from PIL import Image, ImageDraw

w, h = 32, 32
img = Image.new('RGB', (w, h), (255, 255, 255))
d = ImageDraw.Draw(img)

body = ((3, 4), (28, 4), (31, 9), (31, 24), (27, 29), (5, 29), (1, 24), (1, 9))
d.polygon(body, fill=(220, 20, 20), outline=(35, 35, 35), width=2)

face = ((8, 8), (23, 8), (27, 12), (27, 22), (23, 27), (8, 27), (4, 22), (4, 12))
d.polygon(face, fill=(255, 255, 255), outline=(35, 35, 35), width=1)

beak = ((24, 16), (31, 18), (24, 22))
d.polygon(beak, fill=(255, 220, 0), outline=(0, 0, 0), width=1)

d.ellipse((6, 11, 13, 18), fill=(0, 0, 0))
d.ellipse((8, 13, 10, 15), fill=(255, 255, 255))
d.ellipse((19, 11, 26, 18), fill=(0, 0, 0))
d.ellipse((21, 13, 23, 15), fill=(255, 255, 255))

img.save('e:/My_Project/DesktopPilot/bird_reference_generated.png')
print('saved to e:/My_Project/DesktopPilot/bird_reference_generated.png')
