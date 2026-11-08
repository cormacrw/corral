import { ciExcerpt } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { CiLogScanner, logLine } from './ci-log.ts'

const stamp = '2026-10-30T12:00:00.1234567Z '
const lines = (...text: string[]) => text.map(line => `${stamp}${line}\n`).join('')
const noise = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label} ok ${i}`)

const scan = (log: string, chunk = 1024) => {
  const scanner = new CiLogScanner(256_000)
  for (let i = 0; i < log.length; i += chunk) scanner.write(log.slice(i, i + chunk))
  return scanner.finish()
}

// Shape reported from job 125066364374: passing groups, a bare failing
// package header, ungrouped output with an early ELIFECYCLE, the final
// ELIFECYCLE, then the next passing group.
const turboLog = lines(
  '##[group]Run pnpm run test', 'pnpm run test', '##[endgroup]',
  '##[group]@corral/core:test', ' ✓ core.test.ts', '##[endgroup]',
  '@corral/web:test',
  ...noise('web', 25),
  ' ERROR  run failed: command  exited (1)',
  '[ELIFECYCLE] Test failed',
  ...noise('web', 25),
  '\u001B[41m\u001B[1m FAIL \u001B[22m\u001B[49m  app/utils/labels.test.ts > labels > says which fix stopped',
  'AssertionError: expected \'Fix stopped\' to be \'Rebase stopped\'',
  ' - Expected', ' + Received', '',
  ...noise('web after', 20),
  ' Test Files  1 failed | 80 passed (81)',
  '[ELIFECYCLE] Test failed',
  '##[group]@corral/server:test',
  ...noise('server', 2000),
  '##[endgroup]'
) + lines(...noise('server', 20_000)) + lines(
  ' Tasks:    3 successful, 4 total',
  ' Failed:    @corral/web#test',
  '##[error]Process completed with exit code 1.'
)

describe('CiLogScanner', () => {
  it('finds the failing test in a package printed long before the end, past the tail', () => {
    const scanner = new CiLogScanner(2000)
    scanner.write(turboLog)
    const { tail, failureLines } = scanner.finish()
    expect(tail).not.toContain('FAIL')
    expect(failureLines).toEqual(expect.arrayContaining([
      ' FAIL   app/utils/labels.test.ts > labels > says which fix stopped',
      'AssertionError: expected \'Fix stopped\' to be \'Rebase stopped\'',
      ' Test Files  1 failed | 80 passed (81)',
      ' Failed:    @corral/web#test',
      '##[error]Process completed with exit code 1.'
    ]))
    expect(failureLines.join('\n')).not.toContain('server ok')
  })

  it('keeps an unmatched startup error before ELIFECYCLE despite a long exit stack', () => {
    const log = lines(
      '##[group]@corral/core:test', 'passed', '##[endgroup]',
      '@corral/web:test', ...noise('web', 2000),
      'Error: Cannot find module ./generated/routes',
      '[ELIFECYCLE] Test failed',
      ...noise('    at shutdown', 500),
      '##[group]@corral/server:test', ...noise('server', 20_000),
      '##[endgroup]', ' Failed:    @corral/web#test',
      '##[error]Process completed with exit code 1.'
    )
    const { tail, failureLines } = scan(log, 4096)
    expect(tail).not.toContain('Cannot find module')
    const excerpt = ciExcerpt(tail, failureLines)
    expect(excerpt).toContain('Error: Cannot find module ./generated/routes')
    expect(excerpt).toContain('Process completed with exit code 1.')
    expect(excerpt.length).toBeLessThanOrEqual(8000)
  })

  // Job 125066364374 prints ELIFECYCLE right after turbo's `ERROR run failed`,
  // then hundreds of thousands of lines more, then again at the true end
  const twoExits = (stack: string[]) => lines(
    '##[group]@corral/core:test', 'passed', '##[endgroup]',
    '@corral/web:test', ...noise('web', 7000),
    ' ERROR  run failed: command  exited (1)',
    '[ELIFECYCLE] Test failed',
    ...Array.from({ length: 5000 }, (_, i) => `[Vue warn] ${i} ${'w'.repeat(160)}`),
    'Error: Cannot find module ./generated/routes',
    ...stack,
    '[ELIFECYCLE] Test failed',
    '##[group]@corral/server:test', ...noise('server', 20_000),
    '##[endgroup]', ' Failed:    @corral/web#test',
    '##[error]Process completed with exit code 1.'
  )
  const frames = (n: number) => Array.from({ length: n }, (_, i) => `    at frame${i} (/home/runner/work/corral/node_modules/vitest/dist/chunks/runner.js:${i}:${i}) ${'.'.repeat(65)}`)

  it.each([0, 9, 12, 18])('keeps an unmatched error above the last of two ELIFECYCLEs, with %i stack frames', (n) => {
    const { tail, failureLines } = scan(twoExits(frames(n)), 4096)
    expect(tail).not.toContain('Cannot find module')
    const excerpt = ciExcerpt(tail, failureLines)
    expect(excerpt).toContain('Error: Cannot find module ./generated/routes')
    expect(excerpt).toContain('Process completed with exit code 1.')
    expect(excerpt.length).toBeLessThanOrEqual(8000)
  })

  it('loses nothing when the last line of a failed section is its ELIFECYCLE', () => {
    const { failureLines } = scan(lines('@corral/web:test', ...noise('web', 500), 'Error: broken at the end', '[ELIFECYCLE] Test failed', '##[group]b:test', 'x', '##[endgroup]', ' Failed:    @corral/web#test'))
    const text = failureLines.join('\n')
    expect(text).toContain('Error: broken at the end')
    expect(text).toContain('[ELIFECYCLE] Test failed')
    expect(new Set(failureLines).size).toBe(failureLines.length)
  })

  it('reserves FAIL headers and assertions despite ten noisy progress failures', () => {
    const log = lines(
      '@corral/web:test',
      ...Array.from({ length: 10 }, (_, i) => [
        ` × app/test${i}.test.ts > fails 12ms`,
        ...Array.from({ length: 8 }, () => `[Vue warn] ${'w'.repeat(170)}`),
        ` ✓ app/passed${i}.test.ts 12ms`
      ]).flat(),
      ...Array.from({ length: 10 }, (_, i) => [
        ` FAIL app/test${i}.test.ts > fails`,
        `ReferenceError: missingValue${i} is not defined`,
        ` ✓ app/contextPassed${i}.test.ts`,
        '  at index.vue:28'
      ]).flat(),
      '[ELIFECYCLE] Test failed',
      '##[group]@corral/server:test', ...noise('server', 20_000),
      '##[endgroup]', ' Failed:    @corral/web#test',
      '##[error]Process completed with exit code 1.'
    )
    const { tail, failureLines } = scan(log)
    const excerpt = ciExcerpt(tail, failureLines)
    for (let i = 0; i < 10; i++) {
      expect(excerpt).toContain(`FAIL app/test${i}.test.ts > fails`)
      expect(excerpt).toContain(`ReferenceError: missingValue${i} is not defined`)
    }
    const markersEnd = failureLines.indexOf('##[error]Process completed with exit code 1.')
    expect(failureLines.slice(0, markersEnd).join('\n')).not.toMatch(/Vue warn|✓/)
    expect(failureLines.join('\n')).not.toContain('✓')
    expect(excerpt.length).toBeLessThanOrEqual(8000)
  })

  it('leaves passing tests and the next group out of what it keeps', () => {
    const { failureLines } = scan(lines('##[group]a:test', ' ✓ passed 1ms', 'FAIL a.test.ts', '##[endgroup]', '##[group]b:test', 'unrelated', '##[endgroup]', ' Failed:    a:x#test', ' Failed:    a#test'))
    expect(failureLines.join('\n')).not.toMatch(/passed|unrelated/)
  })

  it('keeps later FAIL headers when earlier assertion context fills its budget', () => {
    const { failureLines } = scan(lines(
      ...Array.from({ length: 10 }, (_, i) => [
        `FAIL test${i}.test.ts`,
        ...Array.from({ length: 8 }, () => `Assertion detail ${'x'.repeat(280)}`)
      ]).flat()
    ))
    for (let i = 0; i < 10; i++) expect(failureLines).toContain(`FAIL test${i}.test.ts`)
    expect(failureLines.join('\n').length).toBeLessThanOrEqual(3000)
  })

  it('reads a line split across chunks', () => {
    const log = lines('@corral/web:test', 'FAIL a.test.ts', 'AssertionError: wrong', '[ELIFECYCLE] Test failed', '##[group]server:test', 'passing', '##[endgroup]', ' Failed:    @corral/web#test')
    expect(scan(log, 7).failureLines).toEqual(scan(log).failureLines)
  })

  it('takes the Failed: package from line prefixes when turbo doesn\'t group', () => {
    const { failureLines } = scan(lines('@corral/web:test: something went wrong', '@corral/web:test: exited', '@corral/server:test: fine', ' Failed:    @corral/web#test'))
    expect(failureLines).toEqual([' Failed:    @corral/web#test', '@corral/web:test: something went wrong', '@corral/web:test: exited'])
  })

  it('recognises vitest, tsc and eslint failures, not lines that only mention one', () => {
    const { failureLines } = scan(lines(
      '@corral/web:test:  × app/a.test.ts > a 12ms',
      'src/a.ts(1,2): error TS2322: Type string is not number.',
      '  12:3  error  Unexpected any  no-explicit-any',
      'this test should FAIL loudly but passed',
      'Error handling ok'
    ))
    expect(failureLines).toEqual([
      '@corral/web:test:  × app/a.test.ts > a 12ms',
      'src/a.ts(1,2): error TS2322: Type string is not number.',
      '  12:3  error  Unexpected any  no-explicit-any'
    ])
  })

  it('stays bounded however many tests fail, keeping the first', () => {
    const { failureLines } = scan(lines(...Array.from({ length: 5000 }, (_, i) => `FAIL test ${i} ${'y'.repeat(1000)}`)))
    expect(failureLines[0]).toContain('FAIL test 0')
    expect(failureLines.join('\n').length).toBeLessThanOrEqual(6000)
  })

  it('finds no failures in a clean log', () => {
    expect(scan(lines(...noise('a', 100))).failureLines).toEqual([])
  })
})

it('strips colours and the timestamp from a log line', () => {
  expect(logLine(`${stamp}\u001B[31mred\u001B[0m\r`)).toBe('red')
})
