# Stale runners and fencing

A plain explanation of a problem the PRD mentions ("Stale runners cannot continue to act as authorized task owners after losing their lease", PRD §7.8, §9.3, §10) and how to solve it.

## The problem

1. A developer agent claims task #12 and gets a 15-minute lease.
2. The laptop goes to sleep. Heartbeats stop.
3. The lease expires. Corral gives task #12 to a new agent.
4. The laptop wakes up. The **old** agent doesn't know it lost the task and keeps working.

Now two agents are working on the same task. The old one can do damage in two ways.

## Way 1: writing to Corral (easy to block)

The old agent reports "PR opened", updates status, posts comments, and so on.

**Fix: fencing tokens.** Every lease gets an increasing number (lease #1, lease #2, ...). Every write a run makes to the control plane includes its lease number, and the control plane rejects any write whose number isn't the current lease for that task.

## Way 2: pushing to GitHub (Corral can't block this directly)

The push goes straight from the laptop to GitHub, so the control plane never sees it. If the old agent has a GitHub token that works, it can push over the new agent's work.

**Fix: short-lived, scoped credentials.** Don't give agents a long-lived GitHub token. For each run, the control plane issues a short-lived token that can only push to that task's branch, and revokes it when the lease expires. The old agent's push then fails.

## What to do in the POC

The POC is local and single-user (D1), so the risk is much lower:

- Fencing tokens on control-plane writes are cheap and worth building from the start. They also cover the case where the runner process restarts.
- The runner should kill its own agent processes when it can't heartbeat, and reconcile with the control plane before taking new work (PRD §7.4, §9.3).
- Short-lived, branch-scoped GitHub tokens can wait until hosting. **Keep this as a hosting requirement so it doesn't get lost.** See R10 in [open-recommendations.md](open-recommendations.md).
