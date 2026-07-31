---
title: "aadhar.sh/lwe/mpc"
description: "Multi-Party Computation explained at the pace of a 2009 MSN chat: honest majority, dishonest majority, and traitor tracing, with a live node demo. Teacher lines verbatim from an Archetype essay."
path: "/lwe/mpc"
section: "lwe"
kind: "content"
updated: "2026-06-21"
source: "https://aadhar.sh/lwe/mpc"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/lwe/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

**MPC**Online, Multi-Party Computation

Learning With Errors  
a chat about PETs

**How to read this:** the **MPC** teacher's messages are **verbatim** excerpts from [“Privacy 2.0”](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) by Aadharsh Pannirselvam. The learner's lines, the **AI-noted** asides (e.g. traitor tracing, which isn't in the essay), and the demo are AI-generated. Scroll. ↓

**aadharsh**21:03

ok, MPC. a bunch of nodes compute on one secret together? explain it like it's MSN 2009.

**MPC**21:03

Multi Party Computation (MPC) involves partitioning a secret or task over a set of distributed compute nodes to collectively perform computational work—somewhat like BitTorrent over computation.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:04

BitTorrent for computation, lol. but if the work is split across nodes, how many of them do I have to *trust*?

**MPC**21:04

Secure MPC as we know it today was first developed in the early 1980s, after cryptographer Adi Shamir developed a “threshold scheme” for sharing secret data across multiple parties with some redundancy, specifically for the purpose of managing cryptographic keys. In 1982, Andrew Yao extended this approach to computation by demonstrating a mathematical proof for a “Millionaire’s Problem” where two parties could compare their wealth without revealing their actual net worths. Five years later, Goldreich et al. built upon Yao by extending fault-tolerant computation to arbitrarily many parties. Critically, the paper’s result only extended to situations where over half of the N parties, or an *honest majority,* are not adversarial. By proposing a solution to this toy problem for two, and eventually N party compute, Yao and Goldreich et al. respectively highlighted the **core idea behind MPC: enabling computation that depends on shared information while preserving individual data privacy.**

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:05

so an "honest majority" means over half have to stay honest. what happens if more than half go rogue?

**MPC**21:05

By the late 1980s, protocols like that of Ben-Or, Goldwasser, and Wigderson (BGW) formally proved the ability to compute arbitrary functions under an honest majority assumption where, as long as more than two-thirds of the participants are honest, a protocol could remain secure. As practical efficiency concerns mounted, SPDZ (pronounced speedz) was eventually created as a more viable MPC scheme for even larger majorities of dishonest actors. SPDZ introduced preprocessing techniques which allowed secure computation even with only one honest actor, provided that the malicious parties did not collude. The domain specific applications that became possible ranged from secure auctions to privacy-preserving machine learning. But despite decades of progress, MPC remains constrained by fundamental trade-offs: efficiency, trust assumptions, and coordination complexity.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:06

wait, there's a whole spectrum: BGW needs 2/3 honest, but SPDZ survives on even *one* honest node as long as the bad ones don't collude? let me see that.

**MPC**21:06

MPC shared a demo: who do you have to trust?

7 nodes share one secret. **Click a node** to flip it honest ⋔ ↔ traitor ☠. Watch when each trust model still holds:

**BGW · honest majority**—needs \> 2/3 honest (≥ 5 of 7)

**SPDZ · dishonest majority**—needs ≥ 1 honest & no collusion

Each share is watermarked. When a key leaks, the watermark says **who** leaked it: that's traitor tracing. Make a node a traitor, then hit trace.

**sidekick**21:08

AI · not in the essay

**traitor tracing**, loosely: hand every party a *uniquely watermarked* share of the secret (or key), and whenever a leaked share or a pirated key surfaces, the watermark fingerprints which party leaked it. A traitor can still leak; the watermark just names them afterward, which deters collusion up front. Same energy as the honest-majority assumption: MPC leans on bad actors fearing exposure as much as on the math.

**aadharsh**21:09

ok, but if all the nodes secretly live in one datacenter, "distributed trust" is kind of a lie, right?

**MPC**21:09

In contrast to TEEs, which externalize trust to the hardware manufacturer and operator of a specific node, MPC protocols decentralize trust across *multiple* nodes. Much like validators for blockchains, they do so with the trust assumption that a proportion of nodes aren’t colluding or being controlled by a malicious third party. Given this last point, selecting a set of robust nodes can mean that geographically dense sets of nodes implicitly carry stronger trust assumptions—if a majority of nodes live under the same roof, an MPC network’s trust assumptions start to look similar to TEEs or a very centralized blockchain. However, an MPC network with tens of distributed nodes will encounter greater communication overheads (simply put, latency) relative to a two-party compute network.

[from the article](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i)

**aadharsh**21:10

got it: more nodes buy stronger trust but more latency, and "decentralized" only counts if the nodes are actually independent. thanks, MPC.

→ [read the essay](https://www.archetype.fund/media/privacy-2-0-pets-and-the-promise-of-private-shared-state-i) · [back to Learning With Errors](https://aadhar.sh/lwe) · [next: TEEs →](https://aadhar.sh/lwe/tee) · [2PC → MPC, the 0xPARC view](https://aadhar.sh/lwe/pcrypto)

end of conversation

This is a recorded conversation. Poke the node demo above.

Source: https://aadhar.sh/lwe/mpc
