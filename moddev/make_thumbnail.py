"""
Generates thumbnail.png for Grandpa's Greenhouse.

The mod's thesis in one picture: a plot that is deliberately not full. Two
parent species are placed so that the gaps between them each touch both, and a
new species has just sprouted in one of those gaps - which is the whole point,
since the game only ever mutates into an empty tile.

Drawn at 4x and downsampled for antialiasing, in the garden's own palette.

    python moddev/make_thumbnail.py
"""
import math
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUT_SIZE = 512
SS = 4
S = OUT_SIZE * SS

# The Farm's palette, plus the two plan colours the panel uses.
SOIL_DARK  = (34, 26, 18)
SOIL_LIGHT = (58, 44, 30)
TILE_EMPTY = (46, 36, 25)
TILE_EDGE  = (78, 62, 42)
PARENT_A   = (79, 163, 209)      # the panel's first plan colour
PARENT_B   = (224, 160, 60)      # the panel's second
SPROUT     = (148, 205, 80)
SPROUT_HOT = (196, 235, 140)
DASH       = (108, 92, 66)

GRID = 6
MARGIN = int(S * 0.085)
CELL = (S - 2 * MARGIN) / GRID
PAD = CELL * 0.09


def rr(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def cell_box(cx, cy, inset=0.0):
    x0 = MARGIN + cx * CELL + PAD + inset
    y0 = MARGIN + cy * CELL + PAD + inset
    return [x0, y0, x0 + CELL - 2 * PAD - 2 * inset, y0 + CELL - 2 * PAD - 2 * inset]


def dashed_rect(d, box, colour, width, dash, gap):
    """A dashed outline - the panel marks tiles it leaves empty this way."""
    x0, y0, x1, y1 = box
    for (ax, ay, bx, by) in ((x0, y0, x1, y0), (x1, y0, x1, y1),
                             (x1, y1, x0, y1), (x0, y1, x0, y0)):
        length = math.hypot(bx - ax, by - ay)
        if length <= 0:
            continue
        ux, uy = (bx - ax) / length, (by - ay) / length
        t = 0.0
        while t < length:
            seg = min(dash, length - t)
            d.line([ax + ux * t, ay + uy * t,
                    ax + ux * (t + seg), ay + uy * (t + seg)],
                   fill=colour, width=width)
            t += dash + gap


def leaf(d, box, colour, hot):
    """
    A plant, drawn as a small clustered bush rather than a flat square, so the
    grid reads as a garden and not as a spreadsheet.
    """
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    r = w * 0.30
    for (ox, oy, rr_) in ((-0.22, 0.10, 0.30), (0.22, 0.10, 0.30),
                          (0.0, -0.16, 0.34), (0.0, 0.22, 0.26)):
        d.ellipse([cx + ox * w - rr_ * w, cy + oy * h - rr_ * h,
                   cx + ox * w + rr_ * w, cy + oy * h + rr_ * h], fill=colour)
    # A highlight on the crown, so the shape has a light source.
    d.ellipse([cx - r * 0.55, cy - h * 0.34, cx + r * 0.15, cy - h * 0.02], fill=hot)


def lighten(c, f):
    return tuple(min(255, int(v + (255 - v) * f)) for v in c)


img = Image.new('RGB', (S, S), SOIL_DARK)
d = ImageDraw.Draw(img)

# Soil, lit from the top left.
for i in range(S):
    t = i / S
    shade = tuple(int(SOIL_DARK[k] + (SOIL_LIGHT[k] - SOIL_DARK[k]) * (1 - t) ** 1.4)
                  for k in range(3))
    d.line([0, i, S, i], fill=shade)

# The plot. Rows 0..5, and the layout below is the shape the assistant
# actually produces for a two-parent recipe: parents in pairs, with every gap
# touching both of them.
#   A B .  A B .
#   . . .  . . .
LAYOUT = [
    ['A', 'B', '.', 'A', 'B', '.'],
    ['.', '.', '*', '.', '.', '.'],
    ['A', 'B', '.', 'A', 'B', '.'],
    ['.', '.', '.', '.', '.', '.'],
    ['A', 'B', '.', 'A', 'B', '.'],
    ['.', '.', '.', '.', '.', '.'],
]

for cy in range(GRID):
    for cx in range(GRID):
        box = cell_box(cx, cy)
        kind = LAYOUT[cy][cx]
        rr(d, box, radius=CELL * 0.16, fill=TILE_EMPTY, outline=TILE_EDGE,
           width=max(1, int(SS * 0.9)))
        if kind == 'A':
            leaf(d, box, PARENT_A, lighten(PARENT_A, 0.35))
        elif kind == 'B':
            leaf(d, box, PARENT_B, lighten(PARENT_B, 0.35))
        elif kind == '.':
            dashed_rect(d, [box[0] + PAD, box[1] + PAD, box[2] - PAD, box[3] - PAD],
                        DASH, max(1, int(SS * 1.6)), CELL * 0.13, CELL * 0.09)

# The new species, mid-sprout in a gap. Drawn last and given a glow, because it
# is the thing the whole layout exists to produce.
sx, sy = 2, 1
box = cell_box(sx, sy)

glow = Image.new('RGB', (S, S), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([box[0] - CELL * 0.55, box[1] - CELL * 0.55,
            box[2] + CELL * 0.55, box[3] + CELL * 0.55], fill=(70, 110, 30))
glow = glow.filter(ImageFilter.GaussianBlur(CELL * 0.42))
img = ImageChops.add(img, glow)
d = ImageDraw.Draw(img)

# Sprout: a stem with two leaves, smaller than the mature bushes around it.
x0, y0, x1, y1 = box
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
stem_w = max(2, int(CELL * 0.055))
d.line([cx, y1 - CELL * 0.14, cx, cy - CELL * 0.02], fill=SPROUT, width=stem_w)
leaf_w, leaf_h = CELL * 0.22, CELL * 0.16
# One leaf either side of the stem, the far one lighter so it reads as lit.
d.ellipse([cx - CELL * 0.05 - leaf_w, cy - CELL * 0.10,
           cx - CELL * 0.05,          cy - CELL * 0.10 + leaf_h], fill=SPROUT)
d.ellipse([cx + CELL * 0.05,          cy - CELL * 0.14,
           cx + CELL * 0.05 + leaf_w, cy - CELL * 0.14 + leaf_h], fill=SPROUT_HOT)
d.ellipse([cx - CELL * 0.09, cy - CELL * 0.30, cx + CELL * 0.09, cy - CELL * 0.12],
          fill=SPROUT_HOT)

# A ring around it, the way the panel highlights a tile that just changed.
d.ellipse([x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD],
          outline=SPROUT, width=max(2, int(SS * 1.8)))

img = img.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)

here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(here, '..', 'mod', 'thumbnail.png')
img.save(out, optimize=True)
print('wrote', os.path.normpath(out), img.size,
      str(os.path.getsize(out) // 1024) + ' KB')
