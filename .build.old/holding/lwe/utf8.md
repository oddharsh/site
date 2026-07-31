---
title: "aadhar.sh/lwe/utf8"
description: "Text encoding explained at the pace of a 2009 MSN chat: ASCII vs UTF-32 vs UTF-8, with live byte demos. First-pass draft; the demos compute real bytes."
path: "/lwe/utf8"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/utf8"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**UTF-8**Online, text encoding

Learning With Errors  
bytes & characters

**Heads up:** this conversation is a **first-pass AI draft**, so Aadharsh will swap in his own words. The demos compute **real bytes live** (via the browser's own encoder), so the numbers are ground truth. It grew out of his [four-corner-flashcards](https://github.com/oddharsh/four-corner-flashcards) project and some jamming on Chinese-character recall; those demos were the original spark for Learning With Errors.

**aadharsh**22:10

dumb question: why is text encoding a whole *thing*? why not give every letter a number and call it a day?

**UTF-8**22:10

That's basically what **ASCII** did in 1963: 7 bits gave it 128 slots, so `A` = 65, `a` = 97, space = 32. Clean and tiny. The catch is that 128 slots only cover English, punctuation, and a few control codes. No `é`, no `中`, no `😀`. The whole world had to share 128 numbers, and they didn't fit.

**aadharsh**22:11

so how do you fit every character of every language?

**UTF-8**22:11

Step one is **Unicode**: give every character one universal number, a *code point*, written `U+XXXX`. `A` is U+0041, `中` is U+4E2D, `😀` is U+1F600. That's about 150,000 characters and counting. A code point is still just a *number*, so you have to decide how to store it as **bytes**, and that choice is the encoding. Poke at it:

**UTF-8**22:11

UTF-8 shared a demo: same text, different bytes

Type anything (or pick a preset). See each character's code point, and how three encodings store it as bytes:

| char | code point | ASCII | UTF-8 | UTF-32 |
| --- | --- | --- | --- | --- |

**aadharsh**22:13

wait, UTF-32 is always 4 bytes? why not use that everywhere, it's simple.

**UTF-8**22:13

You *could*. UTF-32 is dead simple: one code point is exactly 4 bytes, so indexing is trivial. But it wastes space: plain English text becomes **4× bigger** (every `A` stored as `00 00 00 41`), and it breaks ASCII compatibility, so every old tool and file chokes on it. For something that's 99% of the internet's text, 4× is a lot of wasted bandwidth.

**aadharsh**22:14

so UTF-8 is the compromise?

**UTF-8**22:14

Exactly. UTF-8 is **variable-width**: 1 byte for ASCII (so old English text stays byte-for-byte identical, backwards compatibility for free), 2 bytes for most Latin and accented letters, 3 for most CJK like `中`, 4 for emoji and rare scripts. It's also **self-synchronizing**: every byte announces whether it's a start byte or a continuation, so you can drop into the middle of a stream and still find the next character. That combination is why it ate the web. Look at how the bits actually pack:

**UTF-8**22:14

UTF-8 shared a demo: how the bits pack

One character, byte by byte. grey = structure bits (the prefix that says "start of N-byte char" or "continuation"); gold = the actual code-point payload. Read the gold bits in order and you rebuild the character:

**aadharsh**22:16

ohh, so `中` is 3 bytes in UTF-8. that's the thing I kept hitting in the flashcards app: indexing Chinese characters by byte position is a nightmare.

**UTF-8**22:16

Right: in UTF-8 a CJK character is 3 bytes but **one** code point and (usually) one visual glyph, so "length" depends on what you count, bytes, code points, or grapheme clusters. That's exactly why the [four-corner method](https://github.com/oddharsh/four-corner-flashcards) indexes characters by their *shape* (the strokes in each corner) instead of their bytes or pronunciation, a lookup scheme that sidesteps encoding entirely. \[first pass, Aadharsh has the real story here\]

→ [four-corner-flashcards on GitHub](https://github.com/oddharsh/four-corner-flashcards) · [back to Learning With Errors](https://aadhar.sh/lwe)

end of conversation (first pass)

This is a recorded conversation. Type into the demos above.

Source: https://aadhar.sh/lwe/utf8
