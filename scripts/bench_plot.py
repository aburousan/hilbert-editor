"""Render docs/performance.png from bench-results.json (see scripts/bench.mjs)."""
import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

FG, MUTED, ACCENT, ACCENT2 = "#1b2028", "#8a92a1", "#8b7cf6", "#34d399"
rows = json.load(open("bench-results.json"))
names = [r["workspace"] for r in rows]
files = [r["files"] for r in rows]
x = range(len(rows))

fig, axes = plt.subplots(1, 4, figsize=(15, 3.6))
fig.patch.set_facecolor("white")


def style(ax, title, ylabel):
    ax.set_title(title, fontsize=11, color=FG, pad=10, weight="bold")
    ax.set_ylabel(ylabel, fontsize=9, color=MUTED)
    ax.set_xticks(list(x))
    ax.set_xticklabels([f"{n}\n{f} files" for n, f in zip(names, files)], fontsize=8, color=MUTED)
    ax.tick_params(axis="y", labelsize=8, colors=MUTED)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#d7dbe0")
    ax.grid(axis="y", color="#eef0f3", linewidth=1)
    ax.set_axisbelow(True)


def bars(ax, vals, fmt, color=ACCENT):
    b = ax.bar(list(x), vals, color=color, width=0.58)
    for rect, v in zip(b, vals):
        ax.text(rect.get_x() + rect.get_width() / 2, v, fmt.format(v),
                ha="center", va="bottom", fontsize=8, color=FG)
    ax.set_ylim(0, max(vals) * 1.28)


bars(axes[0], [r["treeAvg"] for r in rows], "{:.1f}")
style(axes[0], "Index the file tree", "ms (avg)")

bars(axes[1], [r["searchAvg"] for r in rows], "{:.1f}")
style(axes[1], "Full-text search", "ms (avg)")

bars(axes[2], [r["compileAvg"] / 1000 for r in rows], "{:.2f}s")
style(axes[2], "Full compile", "seconds")

start = [r["rssStart"] for r in rows]
load = [r["rssLoad"] for r in rows]
w = 0.36
b1 = axes[3].bar([i - w / 2 for i in x], start, width=w, color=ACCENT, label="at start")
b2 = axes[3].bar([i + w / 2 for i in x], load, width=w, color=ACCENT2, label="after 100x load")
for rect, v in list(zip(b1, start)) + list(zip(b2, load)):
    axes[3].text(rect.get_x() + rect.get_width() / 2, v, f"{v:.0f}",
                 ha="center", va="bottom", fontsize=8, color=FG)
axes[3].set_ylim(0, max(load) * 1.35)
style(axes[3], "Memory (RSS)", "MB")
axes[3].legend(fontsize=8, frameon=False, labelcolor=MUTED, loc="upper left")

fig.suptitle("Hilbert backend: Apple Silicon, release build, Typst 0.15",
             fontsize=9, color=MUTED, y=1.02)
fig.tight_layout()
fig.savefig("docs/performance.png", dpi=170, bbox_inches="tight", facecolor="white")
print("wrote docs/performance.png")
