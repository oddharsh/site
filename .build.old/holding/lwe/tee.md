---
title: "aadhar.sh/lwe/tee"
description: "Trusted Execution Environments explained at the pace of a 2009 MSN chat: the secret room in the chip, and the side-channels that leak it. Teacher lines verbatim from an Archetype essay."
path: "/lwe/tee"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/tee"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**TEEs**Online, Trusted Execution Environments

Learning With Errors  
a chat about PETs

**How to read this:** the **TEEs** teacher's messages are **verbatim** excerpts from [“Privacy 2.0”](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) by Aadharsh Pannirselvam. The learner's lines, the **AI-noted** side-channel taxonomy, and the demo are AI-generated. Scroll. ↓

**aadharsh**21:22

TEEs. the "secure enclave" thing in my phone? explain it MSN-style.

**TEEs**21:22

Trusted Execution Environments (TEEs) are secure sections of physical chips that use a static but unique “root of trust” as a base secret to encrypt things. Apple has been using TEEs to locally verify and store biometrics and credit card information on their hardware since 2013’s iPhone 5s and 2017’s T2 desktop enclave.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:23

so it's a secret room inside the chip. has anyone tried to break in?

**TEEs**21:23

This eventually gave way to Secret Network, a network that used a set of SGX nodes for private transactions and smart contracts. Crucially, the SGX nodes held a “consensus seed” in their protected memory which functioned akin to a Secret Network-wide decryption key. In October of 2022, a group of researchers used a previously disclosed processor architecture exploit called Aepicleak to build a proof of concept attack in which malicious actors could emulate Secret Network nodes in software to ultimately extract the network’s consensus seed from memory.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:24

wait, they pulled the master key *out of memory*? how do you even attack a sealed chip?

**TEEs**21:24

In many of these examples, researchers measured heat, cache activity, power consumption, and other side effects of executing programs to infer and extract secrets from operational SGX units. Though it may seem easy to solely fault Intel, SGX isn’t alone in being exploited via so-called “side-channels”. Last year, a set of researchers similarly attacked AMD’s SEV using malicious memory units and firmware, while a security team focused on jailbreaking exploits found a physical exploit chain for Apple’s hardware enclaves aboard their mobile chips.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:25

heat, cache, power... so the chip leaks the secret just by *running*? what are the actual flavors of side-channel? show me.

**TEEs**21:25

TEEs shared a demo: watch the enclave leak

A secret PIN lives inside the enclave, and you **can't read it directly**. But running it leaks physical side effects. Pick an attack and watch the secret fall out:

🔒 **SGX enclave**, root of trust sealed

• • • •

memory reads as encrypted ciphertext

no probe running, the enclave looks opaque.

**sidekick**21:27

AI · expanding the essay

the essay names the symptoms (heat, cache, power); here's the loose **taxonomy** of side-channels:

• **Timing**: secret-dependent branches take measurably different times.  
 • **Cache**: what got cached vs evicted reveals which memory the secret touched (this family powers Spectre/Meltdown-style attacks and the Aepicleak-era tricks).  
 • **Power**: the current draw traces the exact operations (classic on smartcards and SIMs).  
 • **EM / thermal**: radiated emissions and heat leak the same thing, contactlessly.  
 • **Fault injection**: glitch the voltage, clock, or memory (Rowhammer, AMD SEV's BadRAM) to make the chip mis-compute and spill secrets.

all of them read the *physics around* the computation instead of breaking the math. that's why a sealed chip stays so hard to fully trust.

**TEEs**21:28

These attacks collectively speak to how complex TEEs are, as well as how difficult it can be to use TEEs as the sole layer of security for a network. Given the limited capacity to update a TEE’s hardware and firmware, as well as its unique and immutable root of trust, fully trusting a closed source TEE implies trusting the TEE’s firmware maintainers as well as manufacturers, who feasibly could have a log matching TEEs to their unique roots of trust. Further, fully trusting a network of closed source TEEs in operation implies fully trusting that the TEE isn’t compromised and is operated by a non-malicious actor. As such, **the value for malicious actors to exploit a TEE must be lower than the cost to perform said exploit** at each of these layers.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:29

so the security really comes down to "attacking it costs more than the secret is worth," and you're trusting the manufacturer on top of that. got it, that's why people pair TEEs with MPC. thanks, TEEs.

→ [read the essay](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) · [← MPC](https://aadhar.sh/lwe/mpc) · [back to Learning With Errors](https://aadhar.sh/lwe) · [the crypto alternative (0xPARC)](https://aadhar.sh/lwe/pcrypto)

end of conversation

This is a recorded conversation. Run a side-channel above.

Source: https://aadhar.sh/lwe/tee
