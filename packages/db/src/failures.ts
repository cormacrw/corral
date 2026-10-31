// Runs every step in order, even after one fails, and returns what failed
export async function attemptAll(steps: (() => Promise<unknown>)[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

// Like attemptAll, but throws the first failure as the operation's error
export async function runAll(operation: string, url: string, steps: (() => Promise<unknown>)[]): Promise<void> {
  const [failure, ...cleanupFailures] = await attemptAll(steps)
  if (failure !== undefined) throw operationError(operation, failure, cleanupFailures, url)
}

// The error for a failed operation. `failure` stays the cause; failures while
// cleaning up after it never replace it. Drivers can put the connection string
// in their errors, so anything mentioning the password in `url` is scrubbed,
// including the original errors.
export function operationError(operation: string, failure: unknown, cleanupFailures: unknown[], url?: string): Error {
  const secrets = url === undefined ? [] : passwordForms(url)
  const cause = scrubbed(failure, secrets)
  const message = `${operation}: ${cause.message}`
  if (cleanupFailures.length === 0) return new Error(message, { cause })

  const others = cleanupFailures.map(error => scrubbed(error, secrets))
  const summary = others.map(error => error.message).join('; ')
  return new AggregateError([cause, ...others], `${message} (cleanup also failed: ${summary})`, { cause })
}

// The password as written in the URL and decoded, since either can be quoted
function passwordForms(url: string): string[] {
  const password = urlPassword(url)
  if (!password) return []
  try {
    return [password, decodeURIComponent(password)]
  } catch {
    return [password]
  }
}

function urlPassword(url: string): string | undefined {
  try {
    return new URL(url).password
  } catch {
    // A URL too malformed to parse is exactly the one that ends up in an error
    return /^[^:]+:\/\/[^:/?#]*:(.*)@/.exec(url)?.[1]
  }
}

function scrubbed(failure: unknown, secrets: string[]): Error {
  if (!(failure instanceof Error)) return new Error(redact(String(failure), secrets))
  scrub(failure, secrets, new Set())
  return failure
}

// In place, so the error keeps its class and fields such as the Postgres code
function scrub(error: Error, secrets: string[], seen: Set<Error>): void {
  if (seen.has(error)) return
  seen.add(error)

  const fields = error as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(error)) {
    const value = fields[key]
    if (typeof value === 'string') fields[key] = redact(value, secrets)
  }

  const nested = [error.cause, ...(error instanceof AggregateError ? error.errors : [])]
  for (const inner of nested) {
    if (inner instanceof Error) scrub(inner, secrets, seen)
  }
}

function redact(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.replaceAll(secret, '***'), text)
}
