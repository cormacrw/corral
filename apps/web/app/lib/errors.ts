// What to show a human for anything a catch or a mutation received
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
