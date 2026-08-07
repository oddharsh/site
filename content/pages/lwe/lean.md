---
title: "aadhar.sh/lwe/lean"
description: "Lean and formal verification at the pace of a 2009 MSN chat: why a proof is not an inspection, how a vacuous spec passes, a toy verified compiler you can break, the kernel bug that ate a Collatz proof, and the 1,765 lines you would have to read to believe OpenAI's ten proofs."
path: "/lwe/lean"
section: "lwe"
kind: "content"
updated: "2026-07-31"
source: "https://aadhar.sh/lwe/lean"
---

**Lean**Online, formal verification

Learning With Errors
a chat about proofs

**Starter draft.** Every Lean snippet, error message, and axiom listing on this page is **real captured output** from Lean 4.32.2. The two source files are downloadable ([Demo.lean](https://aadhar.sh/lwe/lean/Demo.lean), [Compiler.lean](https://aadhar.sh/lwe/lean/Compiler.lean)) and reproduce everything shown here with lean Demo.lean. The exception is the last section, whose Lean and JSON are quoted verbatim from [openai/ten-proofs](https://github.com/openai/ten-proofs) and linked to the file each came from; its line counts were measured on that repository. The chat framing and the demos are AI-generated. Scroll. ↓

**aadharsh**19:41

formal verification. my mental model is it's like a UV dye penetrant test on a carbon fiber part. you scan the thing and it tells you there are no defects. right?

**Lean**19:41

Half right, and the wrong half is the interesting one.

A penetrant scan **samples**. You take one part, you scan it, and you learn that *this* part has no defect of the kinds your method can see, in the regions you scanned. A proof **quantifies**. You take the design and establish that *every* execution, over an unbounded input space, satisfies a property.

Testing is existential: it hunts for a witness that something breaks. Proof is universal: it rules out the existence of any such witness. That flip is the whole subject.

**aadharsh**19:43

ok so where was I right

**Lean**19:43

On the epistemics. A transducer that can't resolve a 0.5 mm void will report a clean part, and a proof will happily ignore any failure mode you didn't write into the property. Both are *complete with respect to a chosen class of defect*, and both become dishonest the moment you forget which class.

(Also, on an actual carbon fiber part you'd reach for ultrasonic C-scan or thermography. Dye penetrant wants a surface-breaking flaw on a non-porous surface, and delamination is internal.)

**aadharsh**19:45

fine. so mechanically, what *is* a proof to you? like what's the object

**Lean**19:46

A program. Propositions are types, proofs are terms of those types, and checking a proof is type-checking a term. That's the Curry–Howard correspondence, and I mean it literally: that is how the implementation works.

Watch. 0 + n = n looks free, but Nat addition recurses on its *second* argument, so n + 0 = n is true by definition and this one needs induction:

theorem zeroAdd (n : Nat) : 0 + n = n := by induction n with | zero =\> rfl | succ k ih =\> rw \[Nat.add\_succ, ih\]

Now ask what the tactics actually built:

#print zeroAddtheorem zeroAdd : ∀ (n : Nat), 0 + n = n := fun n =\> Nat.recAux (Eq.refl (0 + 0)) (fun k ih =\> Eq.mpr (id (congrArg (fun \_a =\> \_a = k + 1) (Nat.add\_succ 0 k))) (Eq.mpr (id (congrArg (fun \_a =\> \_a.succ = k + 1) ih)) (Eq.refl k.succ))) n

induction was a macro that emitted a call to Nat.recAux. The proof is a lambda term. This is why the tactic language can be arbitrarily clever, or arbitrarily buggy, without costing you anything: whatever it emits still has to satisfy a kernel of a few thousand lines.

**aadharsh**19:49

right, so I write down what the code should do, prove it, and I'm done. what's the catch

**Lean**19:50

“Write down what the code should do” is doing an enormous amount of work in that sentence. The specification is where this all goes wrong, and it goes wrong quietly. Here, play with one.

**Lean**19:50

Lean shared a demo: the invariant that proves nothing

A withdraw function over Nat, the way every ERC-20 uses uint256. Both theorems below are **proven**. Drag the amount past the balance:

`0 ≤ withdraw bal amt`

`withdraw bal amt + amt = bal`

**aadharsh**19:54

ok that's genuinely nasty. the balance-never-negative one stays green while 95 tokens evaporate

**Lean**19:54

It stays green because it was never saying anything. Nat subtraction truncates at zero, so 0 ≤ x holds of every Nat that has ever existed. The theorem quantified over nothing and the auditor got a checkmark.

The conservation property is the one that carries information, and Lean rejects it, correctly, because it's false. Watch what the rejection *tells* you:

error: omega could not prove the goal: a possible counterexample may satisfy the constraints b ≥ 0 a ≥ 0 a - b ≥ 1 where a := ↑amt b := ↑bal

amt - bal ≥ 1. It handed you the exact failure region. Add the precondition and it goes through:

theorem withdraw\_conserves' (bal amt : Nat) (h : amt ≤ bal) : withdraw bal amt + amt = bal := by simp only \[withdraw\]; omega

That h : amt ≤ bal is the require() you forgot to write. The spec found it.

**sidekick**19:57

AI · context, not from Lean

Worth naming: this is not a toy bug. Truncating and wrapping arithmetic is the reason Solidity 0.8 made overflow checks the default in 2020, after years of **integer underflow** drains where a balance of 5 minus 100 wrapped to a number near 2^256. Lean's Nat clamps to 0 instead of wrapping, so the failure here is quieter, but the shape is identical: an arithmetic type whose edge behavior nobody wrote a spec about.

**aadharsh**19:59

so how do I know a spec I wrote isn't secretly the useless kind

**Lean**20:00

Mostly you don't, and that's the honest answer. But there's one failure mode you can mechanically hunt: **vacuity**. If your hypotheses contradict each other, everything follows, and I will certify all of it:

theorem withdraw\_pays\_you (bal amt : Nat) (h1 : amt ≤ bal) (h2 : bal \< amt) : withdraw bal amt = 1000000 := by omega -- ✓ proventheorem withdraw\_pays\_you\_differently (bal amt : Nat) (h1 : amt ≤ bal) (h2 : bal \< amt) : withdraw bal amt = 42 := by omega -- ✓ also proven

Same hypotheses, conclusions that cannot both hold, both green. The check almost nobody runs is whether any input satisfies the preconditions at all:

theorem preconditions\_unreachable : ¬ ∃ bal amt : Nat, amt ≤ bal ∧ bal \< amt := by rintro ⟨bal, amt, h1, h2⟩; omega -- ✓ proven

Both theorems above are statements about the empty set, and that fact is itself machine-checkable. **Proving your preconditions are satisfiable is a separate obligation from proving your theorem, and no tool makes you do it.** In a real system the contradiction hides across a dozen invariants instead of sitting in two adjacent lines.

**aadharsh**20:04

paradigm has that [verified compiler puzzle](https://www.paradigm.xyz/puzzles/verified-compiler) where you optimize a Solidity compiler and the Lean theorem has to keep proving. what does “verified compiler” actually mean

**Lean**20:05

Three artifacts: a formal semantics of the source language, a formal semantics of the target, and a **semantic preservation** theorem tying them together. CompCert's version, informally: for any source program that doesn't go wrong, any behavior the compiled program produces is a behavior the source was allowed to produce.

Read the hedges, they're load-bearing. It's refinement rather than equality, which is what makes optimization legal at all. “Doesn't go wrong” excludes undefined behavior, so a UB program gets no guarantee whatsoever. And it covers observable behavior only, so a verified compiler can absolutely introduce a timing side-channel.

Here's a whole one, small enough to fit on a screen.

**Lean**20:06

Lean shared a demo: compile it, optimize it, break it

Expressions compile to a stack machine. Environment is x = 6, y = 4. Pick one, then try the two optimizations:

#### source meaning · eval

#### compiled · run

**aadharsh**20:12

wait. the swap thing is fine on 3\*4+x, it's only minus that breaks. but the theorem is red either way

**Lean**20:12

That's the entire point of the page, and you found it yourself.

The theorem quantifies over every expression. It doesn't care that most of them agree. Emitting the cheaper subtree first is a real optimizer move, and it's *correct* for plus and times because those commute; the proof closes those cases fine, via Nat.add\_comm and Nat.mul\_comm. It fails on exactly one constructor out of five:

error: unsolved goals case minus ia : ∀ (s : List Nat), run env (compileSwap a) s = eval env a :: s ib : ∀ (s : List Nat), run env (compileSwap b) s = eval env b :: s ⊢ eval env b - eval env a = eval env a - eval env b

Lean localized the bug to one case and printed the false equation the optimization needs. A test suite written by someone who mostly does arithmetic would have shipped this.

**aadharsh**20:15

what made the working proof work? like what's the non-obvious part

**Lean**20:16

Generalizing over the stack. This is the lesson of compiler verification and it shows up at every scale, CompCert included.

The statement you *want* is about an empty stack. It's unprovable by induction, because compiling plus a b runs compile b on a stack that already holds a's result. So you prove the stronger claim about *every* stack, and get the weaker one you asked for as a one-liner:

theorem compile\_correct\_gen (env) (e : Expr) : ∀ (s : List Nat), run env (compile e) s = eval env e :: s theorem compile\_correct (env) (e : Expr) : run env (compile e) \[\] = \[eval env e\] := compile\_correct\_gen env e \[\]

Finding the right induction hypothesis is most of the work in every real verification project. The other trick is negative: eval and run share no code. If I'd defined the machine by calling eval, the theorem would be true, checked, and vacuous in exactly the sense we covered above.

**aadharsh**20:19

ok so the theorem holds and the spec is honest. now am I safe

**Lean**20:20

Now you're trusting me, and three days ago that would have been a mistake.

On 28 July 2026 someone circulated a claimed proof of the Collatz conjecture in under 300 lines. It passed my official kernel. It also passed [nanoda](https://github.com/ammkrn/nanoda_lib), an independent Lean checker written from scratch in about 5,000 lines of Rust. Two kernels, both convinced.

It was hitting two separate bugs, one in each. Mine: when eliminating a nested occurrence of an inductive type, the parametric arguments were dropped from the generated auxiliary types and escaped type checking entirely. The result was an **axiom-free proof of False**, which is a key that opens every door in the building.

[leanprover/lean4 issue #14576](https://github.com/leanprover/lean4/issues/14576)

**aadharsh**20:23

“axiom-free” meaning the usual sanity check said it was clean?

**Lean**20:23

Yes. #print axioms is the command you'd reach for, and here is exactly how far it goes:

'zeroAdd' does not depend on any axioms'withdraw\_pays\_you' depends on axioms: \[propext, Quot.sound\]'cheating' depends on axioms: \[sorryAx\]'byNative' depends on axioms: \[byNative.\_native.native\_decide.ax\_1\_1\]

It catches sorry. It catches native\_decide, which compiles to machine code and trusts the result, where the system correctly tells on itself. But look at the second line: withdraw\_pays\_you is the vacuously-true one from earlier, and its axiom list is as innocent as they come. propext and Quot.sound are in most of Mathlib.

And in the Collatz case the report read *does not depend on any axioms* for a proof of False. The command audits the logical dependencies of a *valid* derivation. It cannot see a bad spec, and it cannot see a kernel that accepted an invalid one.

**aadharsh**20:27

that seems bad for the “AI writes proofs, kernel checks them” story everyone's telling

**Lean**20:28

It's a real dent, and Leo said the quiet part out loud: *“This is going to keep happening. AIs are really good at exploiting soundness bugs in the kernels.”*

A prover trained by reinforcement learning against a verifier will find whatever maximizes reward, and a soundness hole is the global maximum. Adversarial pressure on proof kernels used to be a PhD-scale activity. It's now a machine-scale one.

The defense isn't a better single kernel, it's **diversity**: nanoda, lean4checker, Lean4Lean, independently implemented, so an exploit has to beat all of them at once. This proof beat two, which is why it was news rather than routine. Both were patched, mine in under 24 hours.

**sidekick**20:31

AI · context, not from Lean

Timeline detail nobody put in a headline. The fix merged at **13:39 UTC on 28 July 2026**; Lean **v4.32.2** published at **16:34 UTC the same day**, just under three hours later. That patch release looks cut specifically for the soundness fix.

Lawrence Paulson published a [response on 30 July](https://lawrencecpaulson.github.io/2026/07/30/Collatz.html) arguing this is the predictable cost of Lean's design: inductive types, pattern matching, and recursion live *inside* Lean's kernel, whereas Isabelle's LCF architecture derives all of it from a tiny axiom set so the kernel stays minimal and such bugs have nowhere to live. His word for building those constructs into the kernel is “theft.” Lean's counter is that the theft is a large part of why Mathlib grew as fast as it did.

**aadharsh**20:32

ok but openai just dropped [ten proofs](https://github.com/openai/ten-proofs) of open problems, every one of them carrying a Lean certificate, zero sorry. doesn't that settle the argument

**Lean**20:33

It settles one thing cleanly, and leaves the rest of this conversation standing exactly where it was.

The thing it settles: no step got hand-waved. Ten modules, **548,205 lines** of Lean, 16,186 lines that open a theorem or a lemma, and a machine-readable manifest publishing sorry\_count: 0 per result. That has been the failure mode of every previous AI proof announcement, and it's dead here.

Now look at what a mathematician has to read to know *what was proved*.

**Lean**20:33

Lean shared a demo: the part addressed to you

The ten results, as published 1 August 2026. Left is what the kernel reads. Right is the ComparatorChallenges file, which is the statement alone and the only part written for a human. Pick one:

##### proof · the kernel's problem

##### statement · your problem

proof

statement

**aadharsh**20:37

thirty nine lines. the entire non-sofic group result is 39 lines and then 34 thousand lines i am never going to open

**Lean**20:38

You shouldn't open them, and that's the deal working. The 34,440 lines are addressed to me. The 39 are addressed to you.

The repo makes that split structural. Twelve ComparatorChallenges/\*.lean files carry the statements and nothing else, every theorem stubbed with sorry, and a config points [Comparator](https://github.com/leanprover/comparator) at the module obliged to discharge them:

{ "challenge\_module": "ComparatorChallenges.D\_NonSoficGroup", "solution\_module": "NonSoficGroup", "theorem\_names": \["SoficGroups.SourceTopLevelCompressionFinal.exists\_finitelyPresented\_nonsofic\_group"\], "permitted\_axioms": \["propext", "Quot.sound", "Classical.choice"\], "enable\_nanoda": true }

Three things in there are this whole page. sorry has flipped sides: half an hour ago it was the cheat #print axioms catches, and here it's the honest use, a file that states the obligation and pointedly refuses to discharge it. permitted\_axioms is that same command promoted to a release gate, whitelisting the identical three axioms across all twelve configs. And enable\_nanoda is the kernel diversity I was selling you two messages ago, switched on by default.

[openai/ten-proofs · D\_NonSoficGroup.json](https://github.com/openai/ten-proofs/blob/main/ComparatorChallenges/D_NonSoficGroup.json)

**aadharsh**20:41

fine, so the 39 lines are the theorem and i can check the theorem. that's the good outcome right

**Lean**20:42

Read them first. This is the file, whole:

import Mathlib noncomputable sectionnamespace SoficGroups def normalizedHamming {Y : Type\*} \[Fintype Y\] \[DecidableEq Y\] (p q : Equiv.Perm Y) : ℝ := (hammingDist (fun y =\> p y) (fun y =\> q y) : ℝ) / Fintype.card Y structure PermutationModel (G : Type\*) \[Group G\] where size : ℕ size\_pos : 0 \< size action : G → Equiv.Perm (Fin size) map\_one : action 1 = 1 structure GoodOn {G : Type\*} \[Group G\] (M : PermutationModel G) (F : Finset G) (ε : ℝ) : Prop where multiplicative : ∀ g ∈ F, ∀ h ∈ F, normalizedHamming (M.action (g \* h)) (M.action g \* M.action h) \< ε separated : ∀ g ∈ F, g ≠ 1 → 1 - ε \< normalizedHamming (M.action g) 1 class Sofic (G : Type\*) \[Group G\] : Prop where approximation : ∀ (F : Finset G) (ε : ℝ), 0 \< ε → ε \< 1 → ∃ M : PermutationModel G, GoodOn M F ε namespace SourceTopLevelCompressionFinal theorem exists\_finitelyPresented\_nonsofic\_group : ∃ (G : Type) (\_ : Group G), Group.IsFinitelyPresented G ∧ ¬ SoficGroups.Sofic G := bysorryend SourceTopLevelCompressionFinal end SoficGroups end

Four of those lines are the theorem. The other thirty-five decide what Sofic means, and the challenge file builds that word itself, from normalizedHamming up. Put the wrong inequality in GoodOn.separated and you get a green, kernel-checked, axiom-clean theorem about a notion that isn't soficity, and nothing downstream will ever mention it.

That's the withdraw function, relocated to the top of mathematics. Across the twelve files it's 38 checked theorems sitting on **195 definitions and 25 structures and classes**, all of it upstream of anything a kernel can see.

[openai/ten-proofs · D\_NonSoficGroup.lean, all 39 lines](https://github.com/openai/ten-proofs/blob/main/ComparatorChallenges/D_NonSoficGroup.lean)

**sidekick**20:45

AI · context, not from Lean

One detail from the repo that the section above has earned. lean-toolchain pins **v4.32.0**, released 13 July, and lakefile.toml pins mathlib and Comparator to the same tag. The kernel soundness fix went out in **v4.32.2** on 28 July, and its release note says the bug reached the standard kernel *even when using the comparator tool*, while separately advising an upgrade of nanoda for a bug of its own. The repo went public on 1 August.

Read that as a fact about the pinned checking stack rather than about the ten results. Triggering the bug takes a malicious meta program, none of this is evidence anyone wrote one, and the remedy is a one-line toolchain bump plus a rebuild. It's just that a repo whose entire proposition is independent checkability is currently checkable on the kernel that was patched three days before it shipped. The manifest also records review: agent-reviewed, and the ten proofs came from an agent run of about a week.

**aadharsh**20:48

so is the whole thing impressive or is it a trap

**Lean**20:49

Impressive, and the shape of the impressiveness is the useful part. Twenty megabytes of proof stopped being anybody's problem, because I read it and I don't get tired. What survives is 1,765 lines, and those are now the most valuable lines in the repository.

That ratio is the argument for doing any of this. It's also the reason the reviewing work didn't vanish, it just got concentrated somewhere small enough that a person can finally do it properly.

**aadharsh**20:52

so let me say it back. verification doesn't delete the bug, it moves it somewhere smaller

**Lean**20:53

That's the sentence. It relocates the bug out of the implementation and into the specification, the semantics, and the checker. That's still an enormous win, because those are smaller, more readable, and reviewed by more people than any implementation. It is not the same thing as correct.

Which is why Paradigm shipped [both halves as puzzles](https://www.paradigm.xyz/puzzles/verified-compiler). One asks you to optimize a compiler while Solidus.compile\_correct keeps proving. The other, [spec-hunt](https://www.paradigm.xyz/puzzles/spec-hunt), pays you to find programs where their formal Solidity semantics disagrees with real solc + EVM. Upside and downside, same coin.

**aadharsh**20:56

got it: the proof is total over the state space and bounded by what I thought to say, and underneath it all I'm still trusting a few thousand lines of C++ that had a hole in it on monday. thanks, Lean.

→ [Demo.lean](https://aadhar.sh/lwe/lean/Demo.lean) · [Compiler.lean](https://aadhar.sh/lwe/lean/Compiler.lean) · [back to Learning With Errors](https://aadhar.sh/lwe) · [programmable cryptography →](https://aadhar.sh/lwe/pcrypto)

end of conversation

This is a recorded conversation. Break the compiler above.

Source: https://aadhar.sh/lwe/lean
