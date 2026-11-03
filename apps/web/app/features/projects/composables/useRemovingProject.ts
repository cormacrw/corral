// The slug of the project Settings is removing, from the confirm until it has
// moved on: its list entry goes first, and its routes shouldn't say not found
export const useRemovingProject = () => useState<string | null>('removing-project', () => null)
