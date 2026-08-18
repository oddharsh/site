/-!
# A verified compiler in 60 lines

Source: a tiny expression language with variables.
Target: a stack machine.
Theorem: the compiled code computes what the source means.

This is the same shape as CompCert and as Paradigm's `Solidus.compile_correct`,
minus about six years of work.
-/

/-! ## 1. The source language and its semantics -/

inductive Expr where
  | const : Nat → Expr
  | var   : String → Expr
  | plus  : Expr → Expr → Expr
  | minus : Expr → Expr → Expr      -- Nat subtraction: truncates at 0
  | times : Expr → Expr → Expr
deriving Repr

-- The SOURCE semantics. This is a specification, not an implementation.
def eval (env : String → Nat) : Expr → Nat
  | .const n   => n
  | .var x     => env x
  | .plus a b  => eval env a + eval env b
  | .minus a b => eval env a - eval env b
  | .times a b => eval env a * eval env b


/-! ## 2. The target machine and ITS semantics -/

inductive Instr where
  | push : Nat → Instr
  | load : String → Instr
  | add | sub | mul
deriving Repr

-- One instruction. Underflow leaves the stack alone (a real machine would trap).
def step (env : String → Nat) : Instr → List Nat → List Nat
  | .push n, s      => n :: s
  | .load x, s      => env x :: s
  | .add, a :: b :: s => (b + a) :: s
  | .sub, a :: b :: s => (b - a) :: s
  | .mul, a :: b :: s => (b * a) :: s
  | _, s            => s

def run (env : String → Nat) : List Instr → List Nat → List Nat
  | [],      s => s
  | i :: is, s => run env is (step env i s)


/-! ## 3. The compiler -/

def compile : Expr → List Instr
  | .const n   => [.push n]
  | .var x     => [.load x]
  | .plus a b  => compile a ++ compile b ++ [.add]
  | .minus a b => compile a ++ compile b ++ [.sub]
  | .times a b => compile a ++ compile b ++ [.mul]


/-! ## 4. Semantic preservation -/

-- Running two programs back to back is running one then the other.
-- Every compiler proof needs this, because `compile` emits concatenations.
theorem run_append (env : String → Nat) (p : List Instr) :
    ∀ (q : List Instr) (s : List Nat), run env (p ++ q) s = run env q (run env p s) := by
  induction p with
  | nil          => intro q s; rfl
  | cons i p ih  => intro q s; simp [run, ih]

-- THE LESSON OF COMPILER VERIFICATION: the statement you want is not the
-- statement you can prove by induction. You must generalize over the stack,
-- because the recursive calls run on a stack that is not empty.
theorem compile_correct_gen (env : String → Nat) (e : Expr) :
    ∀ (s : List Nat), run env (compile e) s = eval env e :: s := by
  induction e with
  | const n     => intro s; rfl
  | var x       => intro s; rfl
  | plus a b ia ib  => intro s; simp [compile, eval, run_append, ia, ib, run, step]
  | minus a b ia ib => intro s; simp [compile, eval, run_append, ia, ib, run, step]
  | times a b ia ib => intro s; simp [compile, eval, run_append, ia, ib, run, step]

-- The headline theorem. Compile from an empty stack, get the answer.
theorem compile_correct (env : String → Nat) (e : Expr) :
    run env (compile e) [] = [eval env e] :=
  compile_correct_gen env e []

#print axioms compile_correct


/-! ## 5. An optimization that survives the theorem -/

-- Constant folding: evaluate what you can at compile time.
def fold : Expr → Expr
  | .plus a b  => match fold a, fold b with
                  | .const m, .const n => .const (m + n)
                  | a', b'             => .plus a' b'
  | .minus a b => match fold a, fold b with
                  | .const m, .const n => .const (m - n)
                  | a', b'             => .minus a' b'
  | .times a b => match fold a, fold b with
                  | .const m, .const n => .const (m * n)
                  | a', b'             => .times a' b'
  | e => e

theorem fold_preserves (env : String → Nat) (e : Expr) : eval env (fold e) = eval env e := by
  induction e with
  | const n => rfl
  | var x   => rfl
  | plus a b ia ib  => simp only [fold]; split <;> simp_all [eval]
  | minus a b ia ib => simp only [fold]; split <;> simp_all [eval]
  | times a b ia ib => simp only [fold]; split <;> simp_all [eval]

-- The optimizing compiler, correct by composition. This is the Paradigm
-- puzzle in miniature: make the output better, keep the theorem.
def compileOpt (e : Expr) : List Instr := compile (fold e)

theorem compileOpt_correct (env : String → Nat) (e : Expr) :
    run env (compileOpt e) [] = [eval env e] := by
  simp [compileOpt, compile_correct, fold_preserves]

-- It really is shorter:
def sample : Expr := .plus (.times (.const 3) (.const 4)) (.var "x")
#eval (compile sample).map (fun i => reprStr i)
#eval (compileOpt sample).map (fun i => reprStr i)


/-! ## 6. An optimization that does NOT survive -/

-- A real optimizer move: emit the cheaper subtree first to shorten stack
-- lifetime. Correct for `plus` and `times`, because they commute.
def compileSwap : Expr → List Instr
  | .const n   => [.push n]
  | .var x     => [.load x]
  | .plus a b  => compileSwap b ++ compileSwap a ++ [.add]
  | .minus a b => compileSwap b ++ compileSwap a ++ [.sub]
  | .times a b => compileSwap b ++ compileSwap a ++ [.mul]

-- Try to prove the same theorem. Lean refuses.
theorem compileSwap_correct (env : String → Nat) (e : Expr) :
    ∀ (s : List Nat), run env (compileSwap e) s = eval env e :: s := by
  induction e with
  | const n     => intro s; rfl
  | var x       => intro s; rfl
  | plus a b ia ib  => intro s; simp [compileSwap, eval, run_append, ia, ib, run, step, Nat.add_comm]
  | minus a b ia ib => intro s; simp [compileSwap, eval, run_append, ia, ib, run, step]
  | times a b ia ib => intro s; simp [compileSwap, eval, run_append, ia, ib, run, step, Nat.mul_comm]

-- The counterexample the failed proof was pointing at: 10 - 3.
def bad : Expr := .minus (.const 10) (.const 3)
def noEnv : String → Nat := fun _ => 0

#eval eval noEnv bad                    -- what the source means
#eval run noEnv (compile bad) []        -- honest compiler
#eval run noEnv (compileSwap bad) []    -- "optimized" compiler
