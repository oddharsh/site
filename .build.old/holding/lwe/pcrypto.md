---
title: "aadhar.sh/lwe/pcrypto"
description: "Programmable cryptography explained at the pace of a 2009 MSN chat: 2PC and garbled circuits, SNARKs, FHE, and ORAM as one toolkit. A fair-use walkthrough of the 0xPARC primer, with a live SHA-256 preimage demo."
path: "/lwe/pcrypto"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/pcrypto"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**programmable crypto**Online, programmable cryptography

Learning With Errors  
one toolkit, four pieces

**How to read this:** a first-pass walkthrough of ["Programmable Cryptography: Four Easy Pieces"](https://otavi.ooo/files/programmable-cryptography.pdf) by Evan Chen, Brian Lawrence, and Yan X Zhang (0xPARC, 2025), summarized under fair use with credit. The learner lines and pacing are AI; the SHA-256 demo hashes for real.

**aadharsh**22:30

people keep saying "programmable cryptography" like it's one thing. RSA is cryptography, MPC is cryptography. what's the second word doing?

**programmable crypto**22:30

0xPARC coined it for the **second generation** of crypto, roughly the last 15 years. First-generation crypto hand-builds a protocol per problem: RSA signs a message, and Yao's millionaire problem gets its own bespoke protocol to compare two incomes. Second-generation crypto hands you primitives you can *program* for any function you can write as code.

[\[src\]](https://otavi.ooo/files/programmable-cryptography.pdf)

**programmable crypto**22:30

Their analogy: it's the jump from single-purpose hardware (a digital alarm clock) to a general-purpose one (a smartphone that runs whatever you compile for it). You stop inventing a new algorithm per problem and start compiling the problem you have.

**aadharsh**22:31

ok, what are the pieces?

**programmable crypto**22:31

The primer picks four: **2PC** (two-party computation), **SNARKs** (succinct proofs), **FHE** (compute on encrypted data), and **ORAM** (hide which data you touch). Two of those already have rooms here, so I'll wire them up as we go.

**aadharsh**22:32

start with 2PC.

**programmable crypto**22:32

Two people compute F(x1, x2) where each knows only their own input, and neither learns the other's. Yao's millionaire problem is the classic: F is "who earns more," the inputs are the two incomes, and both walk away knowing the winner but not the number. The engine underneath is a **garbled circuit** (one party encrypts a boolean circuit gate by gate, the other evaluates it blind) plus **oblivious transfer**. Scale 2PC past two parties and you land on the [MPC one room over](https://aadhar.sh/lwe/mpc).

[\[src\]](https://otavi.ooo/files/programmable-cryptography.pdf)

**aadharsh**22:33

you keep saying proofs. what's a SNARK?

**programmable crypto**22:33

Read a signature as a proof: Alice's signature proves "I know Alice's private key." A **SNARK** generalizes that to a proof of any statement shaped like "I know X such that F(X, Y) = Z," with F, Y, Z public, once you encode F as equations. The primer's headline example is "I know M such that sha(M) = Y." PLONK is one such scheme. Try the hash half live:

[\[src\]](https://otavi.ooo/files/programmable-cryptography.pdf)

SNARK · prove you know a preimage

A **SNARK** proves "I know X such that F(X) = Y" while revealing nothing about X. Here F is **SHA-256**. Type a secret M and the page hashes it live (real Web Crypto). A SNARK would let you prove you know *some* M with this exact digest, without ever showing M.

sha256(M) =

…

**aadharsh**22:34

so the hash is public but the M behind it stays secret. and FHE + ORAM?

**programmable crypto**22:34

**FHE** you've met: [encrypt your data, let a server compute on the ciphertext, decrypt the result](https://aadhar.sh/lwe/fhe), and the server reads nothing. The primer's example is private machine translation: send Enc(x), get back Enc(translation). **ORAM** is the piece with no room here yet. Even with the data encrypted, the server still watches your *access pattern*: which records you read, how often, which ones together. Oblivious RAM scrambles each request into a batch of reads and writes, so the server can't tell which one you actually wanted.

[\[src\]](https://otavi.ooo/files/programmable-cryptography.pdf)

**aadharsh**22:35

if it does all that, why isn't it everywhere?

**programmable crypto**22:35

Cost, and the primer is blunt about it: proving a computation in a SNARK can run millions of times the cost of just doing the computation. For a decade it was mostly theory with little implementation, until blockchains and other decentralized systems started demanding it and pulled the practical work forward.

[\[src\]](https://otavi.ooo/files/programmable-cryptography.pdf)

**aadharsh**22:36

so the throughline is: one toolkit, privacy and proofs from math instead of trusted hardware.

**programmable crypto**22:36

That's the frame. 2PC and MPC, SNARKs, FHE, and ORAM are different tools, but each earns its guarantee from **protocols and math** rather than a chip you have to trust, the far end from a [TEE](https://aadhar.sh/lwe/tee). Same goal, compute on data nobody should see, with a different bet on where the trust lives.

**aadharsh**22:37

got it. the four pieces are one compiler target, not four gadgets. thanks.

→ [the 0xPARC primer (PDF)](https://otavi.ooo/files/programmable-cryptography.pdf) · [FHE](https://aadhar.sh/lwe/fhe) · [MPC](https://aadhar.sh/lwe/mpc) · [TEEs](https://aadhar.sh/lwe/tee) · [back to Learning With Errors](https://aadhar.sh/lwe)

end of first pass

This is a recorded conversation. Hash a secret in the demo above.

Source: https://aadhar.sh/lwe/pcrypto
