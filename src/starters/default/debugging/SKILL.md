---
name: debugging
description: Use when something behaves differently than expected (a failing test, an error, wrong output) to find the cause rather than patch the symptom.
---

# Debugging

## 1. Reproduce
Get a reliable, minimal reproduction before changing anything: the exact command, input and output. If you can't reproduce it, gather more evidence (logs, versions, environment) instead of guessing.

## 2. Read the evidence
Read the whole error and stack trace, starting from the first frame in your own code. Check what changed recently: `git log`, dependency updates, config.

## 3. Narrow it down
- Form one hypothesis at a time, and the observation that would disprove it.
- Bisect: inputs, code paths, or commits (`git bisect`) until the cause is small enough to see.
- Print or inspect actual values; don't assume them.

## 4. Fix the cause
Change the smallest thing that addresses the cause, not the symptom. If the fix is a workaround, say so.

## 5. Prove it
Add a test that fails without the fix and passes with it. Re-run the original reproduction. Remove temporary logging.

## When stuck
Write down what you've ruled out and why. If two attempts on the same hypothesis fail, step back and question an assumption before trying a third.
