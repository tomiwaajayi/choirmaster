import { describe, expect, it } from 'vitest'

import { detectCapacityError } from './capacity.js'

describe('detectCapacityError', () => {
  it('returns no hit when exit status is 0, regardless of stderr content', () => {
    expect(detectCapacityError({ exitStatus: 0, stderr: 'usage limit reached' }))
      .toEqual({ hit: false })
  })

  it('flags rate-limit phrases on stderr with non-zero exit', () => {
    const result = detectCapacityError({ exitStatus: 1, stderr: 'You have hit the rate limit. Try again in 5 minutes.' })
    expect(result.hit).toBe(true)
    expect(result.signal?.toLowerCase()).toContain('rate limit')
  })

  it('flags 5-hour limit phrasing', () => {
    expect(detectCapacityError({ exitStatus: 1, stderr: 'Reached your 5-hour limit; please wait.' }).hit).toBe(true)
  })

  it('flags 429 status as a word boundary match', () => {
    expect(detectCapacityError({ exitStatus: 1, stderr: 'HTTP 429 Too Many Requests' }).hit).toBe(true)
  })

  it('does not flag 4290 or 1429 (false-positive guard)', () => {
    expect(detectCapacityError({ exitStatus: 1, stderr: 'Connected on port 4290' }).hit).toBe(false)
    expect(detectCapacityError({ exitStatus: 1, stderr: 'PID 1429 exited' }).hit).toBe(false)
  })

  it('returns no hit when stderr is empty regardless of status', () => {
    expect(detectCapacityError({ exitStatus: 1, stderr: '' })).toEqual({ hit: false })
  })

  it('does not flag content-style phrases on stdout (caller passes only stderr)', () => {
    // detectCapacityError doesn't see stdout at all, but we encode the
    // intent here so callers don't accidentally pass stdout content.
    expect(detectCapacityError({ exitStatus: 1, stderr: '' }).hit).toBe(false)
  })
})
