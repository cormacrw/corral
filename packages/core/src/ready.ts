// Definition of Ready (PRD §5.3, adjusted by D10): the parts Corral can check
// mechanically. Whether criteria are truly verifiable is the human's call at
// approval. Dependencies need not be merged yet; the scheduler waits for them.
export interface TaskContent {
  title: string
  description: string
  acceptanceCriteria: readonly string[]
}

export type ReadyProblem =
  | 'missing_title'
  | 'missing_description'
  | 'missing_acceptance_criteria'
  | 'blank_acceptance_criterion'

export function checkDefinitionOfReady(content: TaskContent): ReadyProblem[] {
  const problems: ReadyProblem[] = []
  if (!content.title.trim()) problems.push('missing_title')
  if (!content.description.trim()) problems.push('missing_description')
  if (content.acceptanceCriteria.length === 0) {
    problems.push('missing_acceptance_criteria')
  } else if (content.acceptanceCriteria.some(c => !c.trim())) {
    problems.push('blank_acceptance_criterion')
  }
  return problems
}
