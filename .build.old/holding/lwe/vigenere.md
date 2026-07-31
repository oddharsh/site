---
title: "aadhar.sh/lwe/vigenere"
description: "The Vigenère cipher (and Kryptos) explained at the pace of a 2009 MSN chat: keyed alphabets, autokeys, K1–K3, and how you crank a Kryptos-shaped problem and score the noise. Live workbench and statistics demos."
path: "/lwe/vigenere"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/vigenere"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**Vigenère**Online, polyalphabetic ciphers & Kryptos

Learning With Errors  
keys & keystreams

**Heads up:** a **first-pass** walkthrough. **K1–K3** are the publicly-solved parts of [Kryptos](https://en.wikipedia.org/wiki/Kryptos) (Jim Sanborn, CIA HQ), so their mechanisms are public. The unsolved, private "Paradigm" work stays **abstract** here: methods only, no solutions. The demos compute **real ciphertext and real statistics** live.

**aadharsh**23:01

every time I bring up **Kryptos**, people go "oh, a Caesar cipher." it's so much more than a shift, right?

**Vigenère**23:01

Right. A **Caesar** cipher shifts every letter by *one fixed amount* (`A→D`, shift 3). That's **monoalphabetic**: the same plaintext letter always maps to the same ciphertext letter, so a frequency count cracks it in seconds (E stays the most common letter, just relabeled).

A **Vigenère** cipher uses a *repeating key* of shifts: position 1 shifts by the 1st key letter, position 2 by the 2nd, and so on. The same plaintext letter lands as *different* ciphertext depending on its position. That's **polyalphabetic**, and it flattens the frequency signal.

Here's the unifying trick: a **Caesar is just a Vigenère with a one-letter key**. Key `J` repeats into the keystream `JJJJJJ…`, shifting every letter by the same 9, exactly a Caesar shift of 9. Key `JJJ` is identical, since it repeats into the same stream. A Caesar is the period-1 case; Vigenère is what you get once the key has more than one letter. Try it:

**Vigenère**23:02

Vigenère shared a demo: keystream workbench

Type a plaintext, a key, and an **alphabet** (the cipher uses the alphabet's *order*, so a keyed alphabet scrambles it). See the keystream and the ciphertext, computed live.

presets:

**aadharsh**23:04

and Kryptos K1–K3 are these?

**Vigenère**23:04

**K1** and **K2** are Vigenère on a **keyed alphabet**: the tableau is built on the keyword `KRYPTOS`, so the alphabet becomes `KRYPTOSABCDEFGHIJLMNQUVWXZ` instead of `A…Z`. K1's running key is `PALIMPSEST`; K2's is `ABSCISSA`. Hit the **Kryptos K1** preset above and it reproduces the real sculpture ciphertext EMUFPHZLRFAXYUSDJKZLD…; decrypt that and you get Sanborn's line ending in the deliberate misspelling *"…the nuance of iqlusion."*

**K3** plays a different game: it's a **transposition** (not a substitution). The letters are all correct, just rearranged by a route or columnar scheme. That split, substitution versus transposition, becomes the whole game once you reach the unsolved parts.

**aadharsh**23:05

plain Vigenère gets broken through the repeating key though, right? what's an **autokey**?

**Vigenère**23:05

Exactly: a repeating key has a **period**, and that period is its weakness. Kasiski spacing and the Friedman test recover the key length, and then it's 26 little Caesars you solve separately. An **autokey** kills the period, because instead of repeating the keyword you *extend* the key with the message itself (the key, then the plaintext). No repeat means no period to find. Switch the demo's mode to *autokey* and watch the keystream stop repeating.

**aadharsh**23:06

ok, the unsolved Kryptos-style stuff. how do you even *start* when you don't know anything?

**sidekick**23:07

AI · general method, not the PK solutions

you treat it as a **search over a pipeline**, because you don't know the alphabet, the key, *or* the order of operations. the toolkit, in the abstract:

• **transposition**: columnar, route, rotation, skip-reads (rearrange the letters)  
 • **substitution**: Vigenère and the **Quagmire I–IV** family, which differ in *which* of the plaintext, ciphertext, or key alphabets are keyed (QIII is the Kryptos one; **QIV** keys all three)  
 • **running keys**: a long text used as the key, plus **autokeys**  
 • **order**: transpose-then-Vig, Vig-then-transpose, "Vig first" versus "Vig last," stacked stages

you compose a candidate *pipeline* from those, run the text through it, and **score the output**. then crank the next combination. (the specific Paradigm PK1–PK6 pipelines we've run stay off this page.)

**aadharsh**23:07

let me actually try that, stack a couple of those ops, paste a ciphertext, and crank it by hand.

**Vigenère**23:07

Here's the workbench. Each **stage** is one operation, a **transposition**, a **substitution**, a **Vigenère**, or a plain **Caesar** shift, set to encrypt or decrypt. The pipeline runs top to bottom, so the *order* is yours: a Vigenère above a transposition is "Vig first," below it is "Vig last," and the two give different ciphertext. Watch a **transposition** keep every letter but shuffle the order, and a **substitution** swap the letters but keep the order.

Vigenère shared a demo: the cranking workbench

Stack operations, paste text, and run it. To **decode**, set every stage to *dec* and list them in the reverse of how it was encoded. Set the right recipe and a Kryptos-shaped ciphertext falls out as plaintext. The Paradigm PK recipes stay off this page; the tool is general enough to run them once you know the recipe.

presets:

**aadharsh**23:08

"score the output," sure, but every candidate is just a wall of letters. how do you tell signal from noise?

**Vigenère**23:08

By the **statistical shape** of the letters. Random, polyalphabetic text reads *flat*, every letter roughly equally likely. Real language reads *lumpy*, with E, T, A spiking. The single number that captures this is the **Index of Coincidence**: the chance two random letters of the text match. English ≈ **0.067**; uniform random ≈ **0.038**. A correct (mono-alphabetic) decrypt jumps to ~0.067; a wrong, polyalphabetic one sits near 0.04. Paste candidates in and watch the noise:

**Vigenère**23:08

Vigenère shared a demo: the statistical shape of noise

Drop in any text. The **Index of Coincidence** and the frequency **shape** tell you how language-like it is, exactly the score you'd crank candidate decrypts against.

presets:

**Index of Coincidence**—English ≈ .067 · random ≈ .038

**letters scored**—χ² vs English: —

A B C D E F G H I J K L M N O P Q R S T U V W X Y Z

—

**aadharsh**23:09

back up to the **transposition** stage for a sec. K3 of Kryptos is pure transposition, no substitution at all, right? show me **columnar** specifically, and the double version.

**Vigenère**23:09

Right: in K3 no letter ever changes, only its *position*. Columnar is the workhorse. Write the message into a grid **row by row** under a keyword, then read it back **column by column**, taking the columns in the **alphabetical order of the keyword's letters**. `KRYPTOS` ranks its seven columns `1 4 7 3 6 2 5`, so you read the **K** column first, then **O**, then **P**, and so on. Same letters, new order, and a ragged last row is the only bookkeeping. **Double** columnar just runs that twice, the first ciphertext poured into a fresh grid under a second keyword; the two passes scramble the column structure enough that the hand version resisted cryptanalysis for decades. There's a clean step-by-step [walkthrough here](https://mathweb.ucsd.edu/~crypto/Projects/KarlWang/index2.html). Drag the grid:

**Vigenère**23:09

Vigenère shared a demo: columnar transposition

In by rows, out by columns. The keyword numbers the columns by alphabetical order and you read them **lowest number first**. Flip **double** to pour the first ciphertext into a second grid under a second keyword, the way K3-style ciphers stack stages.

presets:

**aadharsh**23:10

so cranking Kryptos really means searching the space of (transposition × substitution × key × order), then ranking every candidate by how English-shaped its stats are. thanks, Vigenère.

→ [Kryptos](https://en.wikipedia.org/wiki/Kryptos) · [Vigenère cipher](https://en.wikipedia.org/wiki/Vigen%C3%A8re_cipher) · [Index of coincidence](https://en.wikipedia.org/wiki/Index_of_coincidence) · [columnar transposition (Karl Wang, UCSD)](https://mathweb.ucsd.edu/~crypto/Projects/KarlWang/index2.html) · [back to Learning With Errors](https://aadhar.sh/lwe)

end of conversation (first pass)

This is a recorded conversation. Crank the workbench and stats above.

Source: https://aadhar.sh/lwe/vigenere
