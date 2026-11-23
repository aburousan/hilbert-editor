"""Paints the background of the Christmas theme: a lit tree through a frozen window.

Seen from a dark hallway through an open door: a bare room, moonlight and snow
at the window, and far off a little tree whose lights are the only warm thing
in the picture, all of it seen through window glass that has frozen over:
frost ferns growing in from every edge and snow drifting past. Cold, but with a
little hope in it. Drawn here from shapes, branches and noise rather than taken
from a photograph, so it belongs to nobody else. Everything is seeded: running this again gives the
same picture.

    python3 scripts/make-christmas-theme.py   (writes public/themes/christmas*.webp)

Needs numpy, scipy and Pillow.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.ndimage import zoom

W, H = 3840, 2160
rng = np.random.default_rng(1225)
out = Path(__file__).resolve().parent.parent / "public" / "themes"
f32 = np.float32


def noise(h, w, cells, seed):
    """Smooth noise in 0..1, a few cells across."""
    r = np.random.default_rng(seed)
    base = r.standard_normal((cells, max(2, int(cells * w / h)))).astype(f32)
    up = zoom(base, (h / base.shape[0], w / base.shape[1]), order=3)[:h, :w]
    return (up - up.min()) / (up.max() - up.min())


def blurred(mask: Image.Image, radius: float) -> np.ndarray:
    return np.asarray(mask.filter(ImageFilter.GaussianBlur(radius)), dtype=f32) / 255


def over(img, colour, alpha):
    """Lays a colour over the picture where alpha (0..1) says."""
    a = np.clip(alpha, 0, 1)[..., None]
    return img * (1 - a) + np.asarray(colour, dtype=f32) / 255 * a


def add(img, colour, amount):
    """Light added (a glow), not painted over."""
    return img + np.clip(amount, 0, None)[..., None] * (np.asarray(colour, dtype=f32) / 255)


y = (np.arange(H, dtype=f32) / H)[:, None] * np.ones((1, W), f32)
x = np.ones((H, 1), f32) * (np.arange(W, dtype=f32) / W)[None, :]

# ---- the room beyond the door ---------------------------------------------
# A plain wall, cold blue-grey, a touch warmer towards the tree.
room = np.empty((H, W, 3), f32)
room[:] = np.array([52, 66, 92], f32) / 255
tree_x, tree_y = 0.30, 0.56            # the middle of the tree: left of centre, behind the editor
d = np.sqrt(((x - tree_x) * W / H) ** 2 + (y - tree_y) ** 2)
room = add(room, (150, 104, 70), 0.30 * np.exp(-(d / 0.30) ** 2) + 0.10 * np.exp(-(d / 0.75) ** 2))
room *= (0.92 + 0.10 * noise(H, W, 5, 1))[..., None]

# The floor: darker, from a line a little below the tree's foot.
floor_y = 0.74
floor = np.clip((y - floor_y) / 0.02, 0, 1)
room = over(room, (30, 38, 56), 0.85 * floor)
# The tree's lights on the floor, a soft warm smear.
smear = np.exp(-(((x - tree_x) * W / H) / 0.10) ** 2) * np.exp(-((y - (floor_y + 0.03)) / 0.035) ** 2)
room = add(room, (190, 120, 70), 0.22 * smear)

# A window on the left wall: moonlight and snow, the cold part of the room.
win = Image.new("L", (W, H), 0)
ImageDraw.Draw(win).rectangle([int(0.40 * W), int(0.22 * H), int(0.52 * W), int(0.53 * H)], fill=255)
win_a = blurred(win, 18)
sky = np.empty((H, W, 3), f32)
sky[:] = np.array([70, 104, 150], f32) / 255
sky *= (0.80 + 0.35 * noise(H, W, 4, 2) * (1 - (y - 0.22) / 0.31).clip(0, 1))[..., None]
room = over(room, (0, 0, 0), 0)                    # (keeps the array float32)
room = room * (1 - win_a[..., None]) + sky * win_a[..., None]
# Frost creeping in from the window's corners.
frost = noise(H, W, 40, 3) * noise(H, W, 9, 4)
fx = np.minimum(np.abs(x - 0.40), np.abs(x - 0.52)) * W / H
fy = np.minimum(np.abs(y - 0.22), np.abs(y - 0.53))
corner = np.exp(-(np.minimum(fx, fy) / 0.03) ** 2)
room = add(room, (190, 215, 240), 0.35 * win_a * corner * frost)
# The window's cross bars, out of focus.
bars = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(bars)
g.rectangle([int(0.457 * W), int(0.22 * H), int(0.463 * W), int(0.53 * H)], fill=255)
g.rectangle([int(0.40 * W), int(0.368 * H), int(0.52 * W), int(0.376 * H)], fill=255)
room = over(room, (16, 18, 26), 0.85 * blurred(bars, 6))
# Snow falling outside, soft dots inside the window only.
snow = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(snow)
for _ in range(110):
    sx, sy = rng.uniform(0.40, 0.52) * W, rng.uniform(0.22, 0.53) * H
    r = rng.uniform(1.5, 5) * (1 + 0.6 * rng.random() ** 4)
    g.ellipse([sx - r, sy - r, sx + r, sy + r], fill=int(rng.uniform(70, 200)))
room = add(room, (225, 235, 250), 0.75 * blurred(snow, 5) * win_a)
# Moonlight from the window spilling on the floor, a pale cold patch.
patch = np.exp(-(((x - 0.47) * W / H) / 0.16) ** 2) * np.exp(-((y - 0.82) / 0.05) ** 2) * floor
room = add(room, (70, 90, 130), 0.30 * patch)

# ---- the tree --------------------------------------------------------------
tw, th = 0.215, 0.37                    # width and height, as fractions of H
top = tree_y - th / 2
tree = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(tree)
cx = tree_x * W
for k in range(5):                      # five tiers, each a little wider, ragged
    t0 = top + k * th * 0.16
    t1 = top + th * (0.28 + k * 0.165)
    half = tw * H * (0.26 + 0.185 * k) / 2
    lean = rng.uniform(-0.06, 0.06) * half
    pts = [(cx, t0 * H)]
    for side in (-1, 1):
        pts.append((cx + side * half * 0.55 + lean, (t0 + 0.62 * (t1 - t0)) * H))
        pts.append((cx + side * half * 0.42, (t0 + 0.70 * (t1 - t0)) * H))
        pts.append((cx + side * half + lean, t1 * H + rng.uniform(-4, 6)))
        pts.append((cx + side * half * 0.15, t1 * H - 0.012 * H))
    g.polygon([pts[0], pts[1], pts[2], pts[3], pts[4], pts[8], pts[7], pts[6], pts[5]], fill=255)
g.rectangle([cx - 0.012 * H, (top + th * 0.96) * H, cx + 0.012 * H, (floor_y + 0.012) * H], fill=200)
tree_a = blurred(tree, 14)
room = over(room, (12, 22, 18), 0.92 * tree_a)

# The lights: soft discs as an unfocused lens draws them, mostly warm white,
# a few amber, all on the tree.
lights = np.zeros((H, W, 3), f32)
spots = []
while len(spots) < 40:
    lx, ly = rng.uniform(-0.5, 0.5), rng.uniform(0.10, 0.95)
    if abs(lx) > 0.46 * ly ** 0.9:         # inside the cone
        continue
    spots.append((cx + lx * tw * H, (top + ly * th) * H))
for i, (sx, sy) in enumerate(spots):
    r = rng.uniform(11, 21)
    disc = Image.new("L", (int(6 * r), int(6 * r)), 0)
    ImageDraw.Draw(disc).ellipse([2 * r, 2 * r, 4 * r, 4 * r], fill=255)
    a = np.asarray(disc.filter(ImageFilter.GaussianBlur(r * 0.45)), dtype=f32) / 255
    warm = (255, 236, 196) if i % 5 else (255, 190, 120)
    x0, y0 = int(sx - 3 * r), int(sy - 3 * r)
    sl = lights[y0:y0 + a.shape[0], x0:x0 + a.shape[1]]
    sl += a[: sl.shape[0], : sl.shape[1], None] * (np.asarray(warm, f32) / 255) * rng.uniform(0.75, 1.0)
# A wide glow round the whole tree, then the lights themselves.
halo = np.exp(-(((x - tree_x) * W / H) / 0.11) ** 2 - ((y - tree_y) / 0.20) ** 2)
room = add(room, (255, 190, 120), 0.20 * halo)
room = room + lights * 0.95
# The star on top: red, with a small warm glow.
star = np.exp(-((((x - tree_x) * W / H) / 0.010) ** 2 + ((y - (top - 0.005)) / 0.010) ** 2))
room = over(room, (200, 40, 36), 0.85 * star)
room = add(room, (255, 120, 90), 0.35 * np.exp(-((((x - tree_x) * W / H) / 0.03) ** 2 + ((y - top) / 0.03) ** 2)))

# ---- the doorway and the hallway -------------------------------------------
# Most of the picture is the dark hall we look from: the door frame cuts the
# room off at the left and right, and the near wall is in deep, cold shade.
door = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(door)
g.rectangle([0, 0, int(0.155 * W), H], fill=255)
g.rectangle([int(0.585 * W), 0, W, H], fill=255)
g.rectangle([0, 0, W, int(0.07 * H)], fill=255)
door_a = blurred(door, 40)
hall = np.empty((H, W, 3), f32)
hall[:] = np.array([28, 40, 62], f32) / 255
hall *= (0.85 + 0.3 * noise(H, W, 6, 5))[..., None]
# A faint edge of light on the door frame, the room's warmth reaching it.
edge = np.exp(-(((x - 0.585) * W / H) / 0.012) ** 2) * np.clip(1 - np.abs(y - 0.55) / 0.5, 0, 1)
hall = add(hall, (90, 70, 56), 0.25 * edge)
img = room * (1 - door_a[..., None]) + hall * door_a[..., None]

# ---- the frozen glass ----------------------------------------------------------
# Everything beyond is seen through frosted glass: soft, and a little lighter.
pil = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
img = np.asarray(pil.filter(ImageFilter.GaussianBlur(14)), dtype=f32) / 255
img = img * 0.88 + np.array([0.06, 0.09, 0.14], f32)            # the glass's own cold haze
vignette = 1 - 0.30 * np.clip(np.sqrt(((x - 0.40) * 1.2) ** 2 + ((y - 0.5) * 1.1) ** 2) / 0.8, 0, 1) ** 2
img *= vignette[..., None]

# Frost ferns: each grows from the frame inwards and branches at about sixty
# degrees, its side shoots shorter, as frost does on a window pane.
ferns = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(ferns)


def fern(px, py, angle, length, width, depth):
    steps = max(3, int(length / 10))
    for i in range(steps):
        angle += rng.normal(0, 0.06)
        nx, ny = px + np.cos(angle) * length / steps, py + np.sin(angle) * length / steps
        g.line([(px, py), (nx, ny)], fill=int(150 + 90 * rng.random()), width=max(1, int(width)))
        # Feathery: a shoot at nearly every step, both sides in turn.
        if depth > 0 and rng.random() < 0.85:
            side = 1 if i % 2 else -1
            fern(nx, ny, angle + side * rng.uniform(0.85, 1.05), length * rng.uniform(0.30, 0.50) * (1 - i / steps),
                 width * 0.65, depth - 1)
        px, py = nx, ny


def inward(px, py):
    """The direction from a point on the frame towards the middle, roughly."""
    return np.arctan2(H * 0.5 - py, W * 0.42 - px) + rng.normal(0, 0.5)


for _ in range(170):
    edge = rng.integers(4)
    t = rng.random()
    px, py = [(t * W, 0), (t * W, H), (0, t * H), (W, t * H)][edge]
    # Thicker towards the corners, as frost is.
    corner = min(t, 1 - t)
    length = rng.uniform(120, 420) * (1.6 - 1.2 * corner)
    fern(px, py, inward(px, py), length, rng.uniform(1.5, 3), 3)
frost_sharp = blurred(ferns, 1.2)
frost_glow = blurred(ferns, 10)
img = add(img, (205, 228, 250), 0.50 * frost_sharp + 0.45 * frost_glow)
# The tree's warmth, still coming through the frosted glass: the little hope.
img = add(img, (255, 186, 110), 0.16 * np.exp(-(((x - tree_x) * W / H) / 0.13) ** 2 - ((y - tree_y) / 0.22) ** 2))
# The glass is milky with frost near the frame, clear in the middle.
dx = np.minimum(x, 1 - x) * W / H
dy = np.minimum(y, 1 - y)
near_frame = np.exp(-np.minimum(dx, dy) / 0.10)
haze = noise(H, W, 30, 6) * 0.6 + noise(H, W, 7, 7) * 0.4
img = add(img, (170, 200, 235), 0.20 * near_frame * haze)

# Snow drifting past outside: soft flakes of every size, and a few sparkles of
# ice on the glass.
snow = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(snow)
for _ in range(700):
    sx, sy = rng.random() * W, rng.random() * H
    r = rng.uniform(1.5, 4.0) * (1 + 3 * rng.random() ** 6)
    g.ellipse([sx - r, sy - r, sx + r, sy + r], fill=int(rng.uniform(60, 190)))
img = add(img, (230, 240, 255), 0.55 * blurred(snow, 2.5))
sparkle = Image.new("L", (W, H), 0)
g = ImageDraw.Draw(sparkle)
for _ in range(220):
    sx, sy = rng.random() * W, rng.random() * H
    if rng.random() > 0.35 + 0.6 * np.exp(-min(sx / W, 1 - sx / W, sy / H, 1 - sy / H) / 0.15):
        continue
    r = rng.uniform(3, 9)
    g.line([(sx - r, sy), (sx + r, sy)], fill=230, width=1)
    g.line([(sx, sy - r), (sx, sy + r)], fill=230, width=1)
img = add(img, (240, 248, 255), 0.8 * blurred(sparkle, 0.8))
grain = rng.standard_normal((H, W)).astype(f32) * 0.010
img += grain[..., None]

final = Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))
out.mkdir(parents=True, exist_ok=True)
final.save(out / "christmas.webp", quality=82, method=6)
final.resize((1920, 1080), Image.LANCZOS).save(out / "christmas-1080.webp", quality=84, method=6)
print("wrote", out / "christmas.webp", "and christmas-1080.webp")
