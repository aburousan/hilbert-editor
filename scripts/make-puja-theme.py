"""Paints the background of the Puja theme: kash flowers in a field at dusk.

Kash (Saccharum spontaneum) flowers in Bengal in early autumn, and its white
plumes against an evening sky are what Durga Puja season looks like. The picture
is drawn here from noise and strokes rather than taken from a photograph, so it
belongs to nobody else. Everything is seeded: running this again gives the same
picture.

    python3 scripts/make-puja-theme.py        (writes public/themes/puja*.webp)

Needs numpy, scipy and Pillow.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import gaussian_filter, zoom

W, H = 3840, 2160
rng = np.random.default_rng(1936)
out = Path(__file__).resolve().parent.parent / "public" / "themes"


def fbm(h, w, octaves, stretch=1.0, seed=0):
    """Smooth noise summed over scales; `stretch` widens it, for layered cloud."""
    r = np.random.default_rng(seed)
    total = np.zeros((h, w))
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        cells_y = max(2, int(3 * 2 ** o))
        cells_x = max(2, int(3 * 2 ** o / stretch * w / h))
        base = r.standard_normal((cells_y, cells_x))
        up = zoom(base, (h / cells_y, w / cells_x), order=3)[:h, :w]
        total += amp * up
        norm += amp
        amp *= 0.55
    total /= norm
    return (total - total.min()) / (total.max() - total.min())


def mix(a, b, t):
    t = np.clip(t, 0, 1)[..., None]
    return a * (1 - t) + b * t


# ---- sky -------------------------------------------------------------------
y = np.linspace(0, 1, H)[:, None] * np.ones((1, W))
x = np.ones((H, 1)) * np.linspace(0, 1, W)[None, :]
horizon = 0.60
zenith = np.array([58, 66, 84]) / 255
middle = np.array([176, 150, 118]) / 255
low = np.array([246, 205, 132]) / 255
sky = mix(zenith, middle, np.clip(y / horizon, 0, 1) ** 1.4)
sky = mix(sky, low, np.clip((y - 0.30) / (horizon - 0.30), 0, 1) ** 1.6)

# The sun, low and behind cloud: a wide warm glow rather than a disc.
sun_x, sun_y = 0.47, 0.50
d = np.sqrt(((x - sun_x) * W / H) ** 2 + (y - sun_y) ** 2)
glow = np.exp(-(d / 0.20) ** 2) * 0.55 + np.exp(-(d / 0.55) ** 2) * 0.35
sky = sky + glow[..., None] * (np.array([255, 214, 150]) / 255 - sky) * 0.85

# Cloud: two layers of stretched noise, dark bodies with gold-lit undersides.
for layer, (lo, hi, dark, seed) in enumerate([(0.05, 0.42, 0.62, 11), (0.18, 0.55, 0.48, 23)]):
    n = fbm(H, W, 6, stretch=3.2 + layer, seed=seed)
    band = np.clip((y - lo) / (hi - lo), 0, 1)
    band = np.sin(band * np.pi) ** 0.8 * (y < hi)
    cover = np.clip((n - dark) / 0.22, 0, 1) * band
    body = mix(np.array([92, 92, 104]) / 255, np.array([150, 128, 110]) / 255, y / horizon)
    lit = np.clip(np.roll(n, -18, axis=0) - n, 0, None) * 9
    edge = np.array([255, 220, 160]) / 255
    cloud = mix(body, edge, np.clip(lit + glow * 0.8, 0, 1))
    sky = mix(sky, cloud, cover * 0.85)

img = np.clip(sky, 0, 1)

# ---- land ------------------------------------------------------------------
# Distant trees and a pylon line, all one dark silhouette along the horizon.
ridge = horizon + 0.012 + 0.02 * (fbm(1, W, 5, stretch=0.02, seed=5)[0] - 0.5)
far = (y > ridge[None, :]).astype(float)
img = mix(img, np.array([52, 58, 40]) / 255, far * 0.92)

# One tree standing on the horizon, a little left of the sun: a canopy whose
# outline comes from noise, so it reads as leaves rather than a shape, on a
# trunk that widens towards the ground.
cx, cy = 0.37, horizon - 0.10
rx, ry = 0.13, 0.085
canopy = ((x - cx) * W / H / rx) ** 2 + ((y - cy) / ry) ** 2
leafy = fbm(H, W, 8, seed=9)
tree = (canopy + (leafy - 0.5) * 2.4 < 1).astype(float)
half = 0.0035 + 0.004 * np.clip((y - cy) / (horizon - cy), 0, 1)
trunk = (np.abs(x - cx) * W / H < half) & (y > cy) & (y < horizon + 0.03)
tree = np.maximum(tree, trunk.astype(float))
tree = gaussian_filter(tree, 1.2)
img = mix(img, np.array([28, 38, 24]) / 255, np.clip(tree, 0, 1) * 0.96)

# Near field: green, darker towards the bottom, warmed where the light falls.
field_top = horizon + 0.03
field = np.clip((y - field_top) / 0.04, 0, 1)
green = mix(np.array([96, 118, 62]) / 255, np.array([38, 56, 30]) / 255, (y - field_top) / (1 - field_top))
img = mix(img, green, field)

base = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))

# ---- grass blades and kash plumes, drawn as strokes ------------------------
WIND = 0.35  # how far everything leans to the right


def blade(draw, x0, y0, height, lean, width, colour):
    pts = []
    for t in np.linspace(0, 1, 9):
        pts.append((x0 + lean * height * t ** 1.8, y0 - height * t))
    draw.line(pts, fill=colour, width=width, joint="curve")


grass = Image.new("RGBA", (W, H), (0, 0, 0, 0))
g = ImageDraw.Draw(grass)
for _ in range(12000):
    x0 = rng.uniform(-0.05, 1.05) * W
    y0 = rng.uniform(field_top + 0.02, 1.08) * H
    depth = (y0 / H - field_top) / (1 - field_top)
    height = rng.uniform(0.03, 0.09) * H * (0.6 + depth)
    shade = rng.uniform(0.55, 1.0)
    colour = tuple(int(c * shade) for c in (rng.choice([96, 110, 128]), rng.choice([128, 142, 160]), 70)) + (230,)
    blade(g, x0, y0, height, WIND * rng.uniform(0.4, 1.2), max(2, int(3 + 4 * depth)), colour)
base = Image.alpha_composite(base.convert("RGBA"), grass)

plumes = Image.new("RGBA", (W, H), (0, 0, 0, 0))
p = ImageDraw.Draw(plumes)
core = Image.new("RGBA", (W, H), (0, 0, 0, 0))
c = ImageDraw.Draw(core)
stems = []
# Far off, along the horizon: small plumes, just a hint of white.
for _ in range(70):
    x0 = rng.uniform(-0.02, 1.02) * W
    y0 = (field_top + rng.uniform(0.0, 0.03)) * H
    stems.append((y0, x0, rng.uniform(0.03, 0.06) * H, 0.0))
# Kash grows in clumps with grass between them.
for _ in range(22):
    clump_x = rng.uniform(-0.05, 1.05)
    clump_y = field_top + rng.uniform(0.04, 0.40)
    for _ in range(int(rng.integers(3, 8))):
        x0 = (clump_x + rng.normal(0, 0.018)) * W
        y0 = (clump_y + abs(rng.normal(0, 0.02))) * H
        depth = (y0 / H - field_top) / (1 - field_top)
        height = rng.uniform(0.12, 0.30) * H * (0.6 + 1.1 * depth)
        stems.append((y0, x0, height, depth))
for y0, x0, height, depth in sorted(stems):
    lean = WIND * rng.uniform(0.5, 1.1)
    ts = np.linspace(0, 1, 60)
    spine = [(x0 + lean * height * t ** 2.2, y0 - height * t + 0.05 * height * t ** 4) for t in ts]
    start = int(rng.integers(40, 46))  # where the head begins on this stalk
    p.line(spine[:start + 2], fill=(138, 150, 96, 235), width=max(2, int(2 + 3 * depth)), joint="curve")
    scale = 0.7 + 0.8 * depth
    # A soft white body first, so the head reads as fluff from a distance.
    span = 60 - start
    for i in range(start, 60, 2):
        sx, sy = spine[i]
        r = (0.003 + 0.007 * np.sin(np.pi * (i - start) / span)) * H * scale
        c.ellipse([sx - r * 1.4, sy - r, sx + r * 1.4, sy + r], fill=(252, 247, 236, 48))
    # Then the silk: fine strands off the upper stem, streaming downwind.
    for i in range(start, 60):
        sx, sy = spine[i]
        fullness = np.sin(np.pi * (i - start) / span) ** 0.8
        for _ in range(int((30 + 48 * depth) * (0.3 + fullness))):
            length = rng.uniform(0.008, 0.030) * H * scale * (0.5 + fullness)
            ang = np.radians(rng.normal(-10, 38))
            ex = sx + np.cos(ang) * length
            ey = sy - np.sin(ang) * length * 0.7 + length * 0.12
            midx, midy = (sx + ex) / 2, (sy + ey) / 2 + length * 0.07
            lit = rng.uniform(0, 1)
            colour = (int(238 + 17 * lit), int(232 + 18 * lit), int(214 + 22 * lit), int(rng.uniform(120, 215)))
            p.line([(sx, sy), (midx, midy), (ex, ey)], fill=colour, width=1 if rng.uniform() < 0.85 else 2)
core = core.filter(ImageFilter.GaussianBlur(14))
plumes = plumes.filter(ImageFilter.GaussianBlur(0.8))
base = Image.alpha_composite(base, core)
base = Image.alpha_composite(base, plumes)

# The nearest grass in front of the stems, so the plumes stand in the field
# rather than on it.
front = Image.new("RGBA", (W, H), (0, 0, 0, 0))
f = ImageDraw.Draw(front)
for _ in range(5000):
    x0 = rng.uniform(-0.05, 1.05) * W
    y0 = rng.uniform(0.90, 1.06) * H
    height = rng.uniform(0.05, 0.13) * H
    shade = rng.uniform(0.45, 0.85)
    colour = tuple(int(v * shade) for v in (rng.choice([88, 104, 120]), rng.choice([122, 138, 152]), 64)) + (240,)
    blade(f, x0, y0, height, WIND * rng.uniform(0.5, 1.3), int(rng.uniform(4, 9)), colour)
base = Image.alpha_composite(base, front)

# A last warm wash, and a soft vignette so the corners do not compete with the UI.
arr = np.asarray(base.convert("RGB")).astype(float) / 255
vig = 1 - 0.35 * (((x - 0.5) * 1.3) ** 2 + ((y - 0.48) * 1.1) ** 2)
arr = np.clip(arr * vig[..., None] * np.array([1.02, 1.0, 0.95]), 0, 1)
final = Image.fromarray((arr * 255).astype(np.uint8))

out.mkdir(parents=True, exist_ok=True)
final.save(out / "puja.webp", quality=82, method=6)
final.resize((1920, 1080), Image.LANCZOS).save(out / "puja-1080.webp", quality=84, method=6)
print("wrote", out / "puja.webp", out / "puja-1080.webp")
