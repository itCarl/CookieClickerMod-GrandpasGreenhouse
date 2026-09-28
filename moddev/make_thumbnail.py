"""
Generates thumbnail.png for the Grandpa's Greenhouse mod.

The picture is the mod's thesis: eight mature queenbeets ringing one empty
tile, and the juicy queenbeet the arrangement just bred coming up in the
middle. That is a real recipe the mod recovers from the game's own getMuts,
and the layout it plants for you.

Nothing here is drawn by hand. The soil, the plots, the plants and the inner
shadow are the game's own art, so the tile looks like the minigame it belongs
to. Pixel sprites are scaled with NEAREST at whole multiples to stay crisp;
only the soft pieces (plot blobs, shadows, glow) are resampled smoothly.

    python moddev/make_thumbnail.py
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

GAME_IMG = os.environ.get(
    "CC_IMG",
    r"C:\Program Files (x86)\Steam\steamapps\common\Cookie Clicker\resources\app\src\img")

OUT_SIZE = 512
SS = 4                      # supersampling, used for the outline and corners only

CELL = 124                  # one garden tile, in output pixels
PLOT_PX = 104               # the soil blob inside it (gardenPlots is 40px art)
PLANT_SCALE = 2             # gardenPlants is 48px art -> 96px
BED_TOP = 26                # the bed sits high; the caption owns the bottom

QUEENBEET = 17              # plant.icon rows in gardenPlants.png
JUICY = 18
MATURE_COL = 4              # column 4 is the fully grown sprite
SPROUT_COL = 2

TITLE = "Grandpa's Greenhouse"
SUBTITLE = "GARDEN"
TITLE_FONT = r"C:\Windows\Fonts\georgiab.ttf"

SOIL_TINT = (176, 128, 82)
GOLD = (255, 206, 106)
BORDER = (122, 174, 70)


def asset(name):
    path = os.path.join(GAME_IMG, name)
    if not os.path.exists(path):
        raise SystemExit(
            "Cookie Clicker art not found: %s\n"
            "Set CC_IMG to the game's src/img folder." % path)
    return Image.open(path)


def tiled(name, size):
    """The minigame's own background texture, repeated to fill a square."""
    src = asset(name).convert("RGB")
    out = Image.new("RGB", (size, size))
    for y in range(0, size, src.height):
        for x in range(0, size, src.width):
            out.paste(src, (x, y))
    return out


def sprite(sheet, col, row, size, scale):
    """One cell of a sprite sheet, scaled by a whole number so pixels stay hard."""
    c = sheet.crop((col * size, row * size, (col + 1) * size, (row + 1) * size))
    return c.resize((size * scale, size * scale), Image.NEAREST)


def soil_plot(plots, index, size, lift=1.0):
    """A plot blob from gardenPlots.png, recoloured to turned soil.

    The source art is a dark greyscale blob meant to be tinted by the game.
    Multiplying it straight through loses the tile entirely, so the grey is
    used only as shading around a lighter soil base.
    """
    cell = plots.crop((index * 40, 0, (index + 1) * 40, 40))
    cell = cell.resize((size, size), Image.BICUBIC)
    shade = cell.convert("L")
    out = Image.new("RGBA", cell.size, (0, 0, 0, 0))
    px = out.load()
    sp = shade.load()
    ap = cell.split()[3].load()
    for y in range(size):
        for x in range(size):
            a = ap[x, y]
            if not a:
                continue
            k = (0.62 + 0.85 * (sp[x, y] / 255.0)) * lift
            px[x, y] = (min(255, int(SOIL_TINT[0] * k)),
                        min(255, int(SOIL_TINT[1] * k)),
                        min(255, int(SOIL_TINT[2] * k)), a)
    return out


def drop_shadow(layer, offset, blur, opacity):
    """A soft shadow cast by whatever is on `layer`, the way the game shades sprites."""
    a = layer.split()[3].filter(ImageFilter.GaussianBlur(blur))
    a = a.point(lambda v: int(v * opacity))
    sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    sh.putalpha(a)
    return ImageChops.offset(sh, offset[0], offset[1])


def glow(size, at, radius, colour, strength):
    g = Image.new("L", (size, size), 0)
    ImageDraw.Draw(g).ellipse(
        [at[0] - radius, at[1] - radius, at[0] + radius, at[1] + radius], fill=strength)
    g = g.filter(ImageFilter.GaussianBlur(radius * 0.55))
    layer = Image.new("RGBA", (size, size), colour + (0,))
    layer.putalpha(g)
    return layer


def sparkle(d, at, r, colour):
    """A four-pointed twinkle - the game marks a new mutation with one."""
    x, y = at
    d.polygon([(x, y - r), (x + r * 0.24, y - r * 0.24), (x + r, y),
               (x + r * 0.24, y + r * 0.24), (x, y + r),
               (x - r * 0.24, y + r * 0.24), (x - r, y),
               (x - r * 0.24, y - r * 0.24)], fill=colour)


def font(size):
    """Georgia Bold - the face the Quant Broker tile already uses."""
    try:
        return ImageFont.truetype(TITLE_FONT, size)
    except (OSError, IOError):
        return ImageFont.load_default()


def scrim(size, top, colour, strength):
    """A soft dark band along the bottom so the caption stays readable."""
    g = Image.new("L", (1, size), 0)
    for y in range(top, size):
        t = (y - top) / float(size - top)
        g.putpixel((0, y), int(strength * (t ** 1.35)))
    layer = Image.new("RGBA", (size, size), colour + (0,))
    layer.putalpha(g.resize((size, size)))
    return layer


def tracked(d, text, centre, f, fill, tracking, shadow):
    """Letterspaced caps - PIL has no tracking, so glyphs are placed one by one."""
    widths = [d.textlength(ch, font=f) for ch in text]
    x = centre[0] - (sum(widths) + tracking * (len(text) - 1)) / 2.0
    for ch, w in zip(text, widths):
        d.text((x + shadow[0], centre[1] + shadow[1]), ch, font=f, fill=shadow[2],
               anchor="lm")
        d.text((x, centre[1]), ch, font=f, fill=fill, anchor="lm")
        x += w + tracking


def caption(base, accent, shade):
    S = base.size[0]
    base.alpha_composite(scrim(S, S - 170, shade, 236))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    size = 40
    f = font(size)
    while d.textlength(TITLE, font=f) > S - 88 and size > 20:
        size -= 1
        f = font(size)
    d.text((S // 2 + 2, 432), TITLE, font=f, fill=(0, 0, 0, 160), anchor="mm")
    d.text((S // 2, 430), TITLE, font=f, fill=(240, 246, 234, 255), anchor="mm")

    tracked(d, SUBTITLE, (S // 2, 470), font(15), accent + (255,), 5.0,
            (1, 1, (0, 0, 0, 150)))
    base.alpha_composite(layer)


def rounded_mask(size, radius):
    m = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size * SS - 1, size * SS - 1], radius=radius * SS, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def outline(size, radius, colour, width):
    layer = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    inset = width * SS // 2
    ImageDraw.Draw(layer).rounded_rectangle(
        [inset, inset, size * SS - inset, size * SS - inset],
        radius=radius * SS, outline=colour + (255,), width=width * SS)
    return layer.resize((size, size), Image.LANCZOS)


def main():
    S = OUT_SIZE
    base = tiled("BGgarden.jpg", S).convert("RGBA")

    plots = asset("gardenPlots.png").convert("RGBA")
    plants = asset("gardenPlants.png").convert("RGBA")

    ox = (S - CELL * 3) // 2
    centres = [(ox + CELL * c + CELL // 2, BED_TOP + CELL * r + CELL // 2)
               for r in range(3) for c in range(3)]

    # --- the nine plots ---------------------------------------------------
    bed = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    for i, (cx, cy) in enumerate(centres):
        blob = soil_plot(plots, i % 4, PLOT_PX, lift=1.22 if i == 4 else 1.0)
        bed.alpha_composite(blob, (cx - PLOT_PX // 2, cy - PLOT_PX // 2))
    base.alpha_composite(drop_shadow(bed, (0, 3), 4, 0.55))
    base.alpha_composite(bed)

    # the middle tile is the one being bred into - warm it up and ring it
    mid = centres[4]
    base.alpha_composite(glow(S, mid, 126, GOLD, 150))

    ring = Image.new("RGBA", (S * SS, S * SS), (0, 0, 0, 0))
    r = int(CELL * 0.44) * SS
    ImageDraw.Draw(ring).ellipse(
        [mid[0] * SS - r, mid[1] * SS - r, mid[0] * SS + r, mid[1] * SS + r],
        outline=GOLD + (150,), width=3 * SS)
    base.alpha_composite(ring.resize((S, S), Image.LANCZOS))

    # --- eight mature queenbeets around one sprouting juicy queenbeet -----
    crop = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grown = sprite(plants, MATURE_COL, QUEENBEET, 48, PLANT_SCALE)
    for i, (cx, cy) in enumerate(centres):
        if i == 4:
            continue
        crop.alpha_composite(grown, (cx - grown.width // 2, cy - grown.height // 2 + 6))

    baby = sprite(plants, SPROUT_COL, JUICY, 48, PLANT_SCALE)
    crop.alpha_composite(baby, (mid[0] - baby.width // 2, mid[1] - baby.height // 2 + 6))

    base.alpha_composite(drop_shadow(crop, (2, 4), 3, 0.5))
    base.alpha_composite(crop)

    # --- twinkles on the new plant ---------------------------------------
    tw = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(tw)
    sparkle(td, (mid[0] + 44, mid[1] - 40), 17, GOLD + (255,))
    sparkle(td, (mid[0] - 46, mid[1] - 16), 11, GOLD + (215,))
    sparkle(td, (mid[0] + 20, mid[1] + 46), 8, GOLD + (180,))
    base.alpha_composite(tw.filter(ImageFilter.GaussianBlur(0.6)))

    # --- the game's own inner shading, then the frame ---------------------
    caption(base, BORDER, (14, 10, 6))

    borders = asset("shadedBorders.png").convert("RGBA").resize((S, S), Image.BICUBIC)
    base.alpha_composite(borders)
    base.alpha_composite(outline(S, 46, BORDER, 7))
    base.putalpha(ImageChops.multiply(base.split()[3], rounded_mask(S, 46)))

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "mod", "thumbnail.png")
    base.save(out, "PNG", optimize=True)
    print("wrote %s (%dx%d, %d bytes)" % (out, S, S, os.path.getsize(out)))


if __name__ == "__main__":
    main()
