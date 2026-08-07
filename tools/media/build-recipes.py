#!/usr/bin/env python3
"""
build-recipes.py — derive a self-documenting Fuji film-recipe card for every
photo in assets/photos/data/metadata.json, in the idiom fujixweekly.com publishes
recipes in, and write it back under each photo's "recipe" key.

Why: the raw EXIF strings are a lossy, inconsistent way to read a recipe back.
"Standard" is not a dynamic range, "Soft" is not a sharpness value, and
"Red +40, Blue -100" is not how anyone writes a WB shift. This turns what the
camera recorded into what the photographer actually set, so a person (or a
model given nothing but this file, the image, and Fuji's manual) can back out
the recipe and re-shoot it.

Key names and their ORDER match the recipe-card convention:

  Film Simulation: Reala Ace
  Dynamic Range: DR200
  Grain Effect: Weak, Small
  Color Chrome Effect: Strong
  Color Chrome FX Blue: Off
  White Balance: Auto, +1 Red & -2 Blue
  Highlight: -1
  Shadow: -1
  Color: +4
  Sharpness: -1
  High ISO NR: -4
  Clarity: -2
  ISO: 6400
  Exposure Compensation: +2/3

Honesty rules (same discipline as the rest of the photo pipeline):
  - every line is omitted when the camera didn't record it. never invent a
    default. a Leica frame has no Fuji recipe, so it gets no recipe block.
  - values are TRANSFORMED, never guessed: the numbers come from the numeric
    EXIF tags (FujiFilm:Sharpness, Clarity, DevelopmentDynamicRange), not from
    mapping friendly words back to numbers we assume.
  - B&W sims (Acros / Monochrome) live in the Saturation tag with FilmMode
    blank, so they are routed to Film Simulation and drop the Color line.

usage:
  ./build-recipes.py            # rewrite recipes in images/metadata.json
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
METADATA = REPO / "assets" / "photos" / "data" / "metadata.json"

# Fuji's WB fine-tune is stored in units of 20 per on-camera step
# (Red +40 == "+2 Red"). Confirmed against the numeric tag: "-20 80".
WB_STEP = 20

BW_SIM = re.compile(r"\b(acros|monochrome|b\s*&\s*w|bw|sepia)\b", re.I)
# friendly Fuji values embed the real number: "-2 (soft)", "+3 (very high)"
LEADING_NUM = re.compile(r"^\s*([+-]?\d+)")


def signed(n):
    """0 -> '0', 2 -> '+2', -2 -> '-2' (recipe cards always show the sign)."""
    return f"+{n}" if n > 0 else str(n)


def num_from(value):
    """Pull the setting number out of a friendly Fuji string, else None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    m = LEADING_NUM.match(str(value))
    return int(m.group(1)) if m else None


def thirds(ev):
    """EV as the fraction a recipe card prints: -0.67 -> '-2/3', 1.0 -> '+1'."""
    if ev is None:
        return None
    steps = round(float(ev) * 3)          # EV is set in 1/3-stop clicks
    if steps == 0:
        return "0"
    whole, rem = divmod(abs(steps), 3)
    sign = "+" if steps > 0 else "-"
    if rem == 0:
        return f"{sign}{whole}"
    frac = f"{rem}/3"
    return f"{sign}{frac}" if whole == 0 else f"{sign}{whole} {frac}"


def film_name(raw):
    """'F0/Standard (Provia)' -> 'Provia/Standard'; other names pass through."""
    if not raw:
        return None
    m = re.search(r"\(([^)]+)\)", raw)              # trailing paren holds the real name
    if m and "/" in raw:
        return f"{m.group(1)}/{raw.split('/')[1].split(' (')[0]}"
    return raw


def white_balance(record):
    """'Kelvin (5900K), -1 Red & +4 Blue' — base mode, then the fine-tune shift."""
    base = record.get("white_balance")
    if not base:
        return None
    if base == "Kelvin" and record.get("color_temp"):
        base = f"Kelvin ({record['color_temp']}K)"
    shift = record.get("wb_shift")
    m = re.search(r"Red\s*([+-]?\d+),\s*Blue\s*([+-]?\d+)", str(shift or ""))
    if not m:
        return base
    r, b = int(m.group(1)) // WB_STEP, int(m.group(2)) // WB_STEP
    if r == 0 and b == 0:
        return f"{base}, 0 shift"
    return f"{base}, {signed(r)} Red & {signed(b)} Blue"


def grain(record):
    """'Weak, Small' — roughness then size; 'Off' collapses to one word."""
    rough, size = record.get("grain"), record.get("grain_size")
    if not rough:
        return None
    if str(rough).lower() == "off":
        return "Off"
    return f"{rough}, {size}" if size and str(size).lower() != "off" else str(rough)


def build_recipe(record):
    """One photo's EXIF record -> an ordered recipe card, or None if not Fuji."""
    sat = record.get("saturation")
    is_bw = bool(sat) and bool(BW_SIM.search(str(sat)))
    # a B&W sim is the FILM, not a color setting (Fuji leaves FilmMode blank)
    film = film_name(record.get("film")) or (str(sat) if is_bw else None)

    dr = record.get("dr_value")
    lines = [
        ("Film Simulation",      film),
        ("Dynamic Range",        f"DR{dr}" if dr else None),
        ("Grain Effect",         grain(record)),
        ("Color Chrome Effect",  record.get("chrome")),
        ("Color Chrome FX Blue", record.get("chrome_blue")),
        ("White Balance",        white_balance(record)),
        ("Highlight",            record.get("highlight_tone")),
        ("Shadow",               record.get("shadow_tone")),
        ("Color",                None if is_bw else sat),
        ("Sharpness",            record.get("sharpness")),
        ("High ISO NR",          record.get("noise_reduction")),
        ("Clarity",              record.get("clarity")),
    ]
    # the tone/color/sharpness/NR/clarity rows print as bare signed numbers
    numeric = {"Highlight", "Shadow", "Color", "Sharpness", "High ISO NR", "Clarity"}
    recipe = {}
    for key, value in lines:
        if value is None or value == "":
            continue
        if key in numeric:
            n = num_from(value)
            if n is None:
                continue
            recipe[key] = signed(n)
        else:
            recipe[key] = str(value)

    # exposure rides along: it's what the card's last two lines carry
    if record.get("iso"):
        recipe["ISO"] = str(record["iso"])
    ec = thirds(record.get("ev"))
    if ec is not None:
        recipe["Exposure Compensation"] = ec

    # no film sim and no recipe knobs == not a Fuji frame; emit nothing
    if not film and not any(k in recipe for k in ("Dynamic Range", "Grain Effect", "Color Chrome Effect")):
        return None
    return recipe


def main():
    metadata = json.loads(METADATA.read_text())
    built = skipped = 0
    for record in metadata.values():
        record.pop("recipe", None)          # rebuild from scratch, never merge stale
        recipe = build_recipe(record)
        if recipe:
            record["recipe"] = recipe
            built += 1
        else:
            skipped += 1
    # preserve the pipeline's existing key order (jq's, both for stems and for
    # fields) and the card order inside each recipe. sorting here would reorder
    # the whole index and bury a small addition in thousands of moved lines.
    METADATA.write_text(json.dumps(metadata, indent=2) + "\n")
    sys.stderr.write(f"built recipe cards for {built} photos ({skipped} without a Fuji recipe)\n")


if __name__ == "__main__":
    main()
