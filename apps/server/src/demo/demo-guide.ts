// A canned PR guide for the demo, built from the guide prompt itself
// (COR-525): one step per file in the prompt's order, citing each file's first
// hunk, so later hunks land in Other changes. It answers in the same JSON the
// small model is asked for, so the server's validation runs as it does for real.
export function demoGuideAnswer(prompt: string, stepLimit = 5): string {
  const criteria = [...prompt.matchAll(/^- \[([0-9a-f-]{36})\] /gm)].map(m => m[1]!)
  const files = [...new Set([...prompt.matchAll(/^### (.+) · hunk \d+$/gm)].map(m => m[1]!))]
  const steps = files.slice(0, stepLimit).map((path, i) => ({
    title: `${i === 0 ? 'Start with' : 'Then'} ${path.split('/').at(-1)}`,
    why: `This is where ${path.split('/').at(-1)} changes for the task, read in the order the change builds up.`,
    criterionIds: criteria.length ? [criteria[i % criteria.length]] : [],
    hunks: [{ path, hunk: 0 }]
  }))
  return JSON.stringify({ steps })
}
