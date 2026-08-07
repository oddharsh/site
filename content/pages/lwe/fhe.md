---
title: "aadhar.sh/lwe/fhe"
description: "Fully Homomorphic Encryption, explained at the pace of a 2009 MSN conversation. The teacher's lines are verbatim from an Archetype essay; the learner and demos are AI."
path: "/lwe/fhe"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/fhe"
---

**FHE**Online, Fully Homomorphic Encryption

Learning With Errors
a chat about PETs

**How to read this:** the **FHE** teacher's messages are **verbatim** excerpts from [“Privacy 2.0: PETs and the Promise of Private Shared State”](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) by Aadharsh Pannirselvam. The learner's lines and the demos are AI-generated to pace the read. Scroll the conversation. ↓

**aadharsh**20:41

everyone keeps calling FHE magic. explain it like it's 2009 and we're on MSN. what is it, actually?

**FHE**20:41

Fully Homomorphic Encryption (FHE) is a form of encryption which uses a bunch of addition and multiplication on lattices and really high order polynomials with random noise and rounding to perform actions on encrypted data without ever decrypting it.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:42

wait. a server runs math on the encrypted data and never decrypts it? that sounds fake. show me.

**FHE**20:42

FHE shared a demo: add two secret numbers

Pick two numbers. We **encrypt** each as a big noisy value, hand **only the ciphertexts** to a server, let it **add them**, and decrypt the result. The server never sees your numbers. (toy LWE: c = m×1000 + small noise; rounding recovers m)

your secrets5 and 8

Enc(a)—

Enc(b)—

🖧 the **server** sees only the ciphertexts. it computes Enc(a) + Enc(b) with no key and no plaintext:
—

🔑 you decrypt (round &divide;1000): —

**aadharsh**20:44

ok, that's wild. the server adds my scrambled numbers and never sees the real ones. who figured this out?

**FHE**20:44

The concept of homomorphic encryption was first theorized in the late 1970s with “privacy homomorphisms” which could enable untrusted computers to perform operations on sensitive data without needing to reveal it in plaintext. However, homomorphic encryption would remain an open problem until 2009, when cryptographer Craig Gentry described a feasible homomorphic encryption scheme using lattices to express arbitrary circuits—a *fully* homomorphic encryption scheme.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:45

2009, lattices, got it. so why doesn't *everything* run on FHE already? what's the catch?

**FHE**20:45

However, a core challenge in implementing this scheme came from the randomly distributed noise that enabled Gentry’s implementation of homomorphic addition and multiplication operations. Specifically, homomorphic *additions* add small amounts of randomly generated noise to the noise accumulated over a circuit’s execution, while homomorphic *multiplications* multiply the same accumulated noise. Critically, when an FHE program’s noise accumulates past a certain threshold in binary, it becomes indistinguishable from the encrypted data used for the underlying computation. Simply put, adding too much noise will corrupt the encrypted data, and homomorphic multiplication will do this faster than homomorphic addition.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:46

so the noise *eats* the data if I pile on too much math? and multiply is the dangerous op. let me try to break it.

**FHE**20:46

FHE shared a demo: noise vs the plaintext (encode → operate → decode)

Your **secret** rides in the HIGH bits; **noise** fills the LOW bits, with a gap between them. Every op grows the noise: **add** nudges it, **multiply** blows it up. Once the noise climbs past the gap, **decoding rounds to the WRONG number** and corrupts the plaintext. (toy: ciphertext = m×256 + noise; decode = round(&divide;256))

secret **m** = 9 encode → ciphertext below

ciphertext 2307 = 9×256 \+ noise 3

🔑 **decode**: round(2307 &divide; 256) = **9**✓ matches the secret

noise 3 / 128 · ops 0 · bootstraps 0

**aadharsh**20:48

I corrupted it in 3 multiplies. so how does a real program ever finish?

**FHE**20:48

To mitigate this, Gentry proposed *bootstrapping*, a process that “refreshes” ciphertexts by homomorphically re-encrypting them using a different private key, effectively resetting a program’s noise before it can bleed into the critical data and corrupt it. However, bootstrapping came at the cost of speed and computational resources—it made FHE theoretically limitless but enshrined a structural tradeoff between security and usability for complicated programs. With the rate of noise accumulation and the computational overhead in bootstrapping, this tradeoff was initially massive, as Gentry’s initial scheme needed 30 minutes to evaluate each bit operation when it was finally implemented two years later.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:49

30 minutes. per bit. in 2011. please tell me it got faster.

**FHE**20:49

Given all of this, early FHE research largely focused on improving efficiency by way of noise management, both by increasing the separation between noise and information to reduce the number of bootstrapping operations and by speeding up the actual process of managing noise. The 2013 Gentry-Sahai-Waters (GSW) scheme was a prime example of this as it accelerated FHE operations from minutes to milliseconds via “leveled” circuits. However, like some of the FHE schemes that followed, such as BGV and CKKS, it fragmented FHE into standards based on differing compilers and problem spaces. This fragmentation ultimately forced developers to trade a single standard of FHE for lower levels of friction. That being said, at this stage homomorphic millisecond-level logic gates remained a million times slower than traditional computing’s nanosecond-level operations, and as such, these early schemes were impractical for use in crypto.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:50

a million times slower. ok, but even if it gets fast enough one day, can't I just read the answer out at the end?

**FHE**20:50

Another caveat with practically applying FHE to shared state lies in decrypting outputs for use in non-FHE applications—to do so one naturally needs a decryption key. This decryption key becomes a limiter of trust assumptions and, in practice, is either controlled by a single party or a set of nodes in an MPC setting, which brings FHE back to the trust assumptions of MPC whilst being slower.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**20:51

so you still need a key to read the answer, and *that* key is the whole trust catch. the server computes on the ciphertext fine, but the moment you want a plaintext answer you're back to trusting whoever holds the key. ok, I get FHE now. thanks.

→ [read the whole essay (Privacy 2.0, part 1)](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) · [back to Learning With Errors](https://aadhar.sh/lwe) · [FHE in 0xPARC's "four pieces"](https://aadhar.sh/lwe/pcrypto)

end of conversation

This is a recorded conversation. Start your own with the demos above.

Source: https://aadhar.sh/lwe/fhe
