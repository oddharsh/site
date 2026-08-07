---
title: "Pixel Peeper"
description: "A small compression eye exam using real, scored image encodes."
path: "/pixel-peeper"
section: "pixel-peeper"
kind: "utility"
updated: "2026-08-07"
source: "https://aadhar.sh/pixel-peeper"
---

# Pixel Peeper

Image metrics are useful and incomplete. This exercise asks the simpler
question first: when several real encodes are shown without their labels, which
one does your eye choose?

Trials compare quality levels, encoders, and chroma subsampling. Their byte
sizes, SSIMULACRA2 values, Butteraugli values, crops, and image files are public
in `/pixel-peeper/manifest.json`. The labels are revealed only after a choice so
the metric cannot make the choice for you.

This is the site's one genuinely client-side interaction: a small route-scoped
module advances trials and keeps the current score in memory. Without
JavaScript, the manifest remains readable and every image remains directly
addressable; no core site navigation or prose depends on the exercise.

Source: https://aadhar.sh/pixel-peeper
