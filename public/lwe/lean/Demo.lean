/-! # Act 1: a real proof, and the term it compiles to -/

-- `0 + n = n` is NOT true by definition. Nat addition recurses on the
-- second argument, so `n + 0 = n` is `rfl` but `0 + n = n` needs induction.
theorem zeroAdd (n : Nat) : 0 + n = n := by
  induction n with
  | zero      => rfl
  | succ k ih => rw [Nat.add_succ, ih]

-- Curry-Howard: the proof is a TERM. This prints it.
#print zeroAdd


/-! # Act 2: the vacuous spec that ships -/

-- A withdraw function. Balances are Nat, like every ERC-20 uses uint256.
def withdraw (balance amount : Nat) : Nat := balance - amount

-- The safety property an auditor asks for: "balance can never go negative."
theorem balance_never_negative (bal amt : Nat) : 0 ≤ withdraw bal amt := by
  omega

-- Green checkmark. Now watch:
#eval withdraw 5 100

-- Someone with 5 withdrew 100. The invariant held perfectly.
-- Nat subtraction TRUNCATES at zero, so `0 ≤ x` is true for every Nat
-- that has ever existed. The theorem quantified over nothing.


/-! # Act 3: the spec that would have caught it -/

-- Conservation: the money that left plus the money that stayed equals
-- the money that was there. This one is FALSE, and Lean says so.
theorem withdraw_conserves (bal amt : Nat) : withdraw bal amt + amt = bal := by
  simp only [withdraw]
  omega

-- With the precondition it becomes true, and the precondition is the
-- require() statement you forgot to write.
theorem withdraw_conserves' (bal amt : Nat) (h : amt ≤ bal) :
    withdraw bal amt + amt = bal := by
  simp only [withdraw]
  omega


/-! # Act 4: vacuity, the failure mode you cannot see -/

-- Contradictory hypotheses. Anything follows. This proves the contract
-- mints you a million tokens on every withdrawal, and it is machine-checked.
theorem withdraw_pays_you (bal amt : Nat) (h1 : amt ≤ bal) (h2 : bal < amt) :
    withdraw bal amt = 1000000 := by
  omega

-- Same hypotheses, incompatible conclusion. Also green.
theorem withdraw_pays_you_differently (bal amt : Nat) (h1 : amt ≤ bal) (h2 : bal < amt) :
    withdraw bal amt = 42 := by
  omega

-- The check nobody runs: is there ANY input satisfying the preconditions?
-- There is not, and here is the machine-checked proof that there is not.
-- Both theorems above are statements about the empty set.
theorem preconditions_unreachable : ¬ ∃ bal amt : Nat, amt ≤ bal ∧ bal < amt := by
  rintro ⟨bal, amt, h1, h2⟩
  omega


/-! # Act 5: what `#print axioms` sees, and what it misses -/

theorem cheating : 2 + 2 = 5 := by sorry

#print axioms zeroAdd
#print axioms withdraw_pays_you
#print axioms cheating

-- native_decide compiles to machine code and trusts the result.
-- It shows up in the axiom list, which is the system working as designed.
theorem byNative : (List.range 100).length = 100 := by native_decide

#print axioms byNative
