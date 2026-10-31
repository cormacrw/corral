// Lease timing (PRD §7.8 defaults). A run renews its lease with each
// heartbeat; a lease that isn't renewed expires and the task is reconciled.
export const LEASE_DURATION_MS = 15 * 60 * 1000
