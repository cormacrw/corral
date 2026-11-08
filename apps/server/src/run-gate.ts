import type { GlobalStatus } from '@corral/contracts'

// The kill switch (PRD §7.11), the update hold, and the hold's final phase,
// read by everything that starts work: the scheduler, PM turns and merges
export class RunGate {
  stopped = false
  updating = false
  finishingUpdate = false

  // Nothing new is claimed and nothing merges
  get halted(): boolean {
    return this.stopped || this.updating
  }

  get status(): GlobalStatus {
    return { stopped: this.stopped, updating: this.updating }
  }
}
