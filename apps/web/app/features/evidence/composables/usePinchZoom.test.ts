import { expect, it } from 'vitest'
import { bounded, MAX_SCALE, pinched } from '~/features/evidence/composables/usePinchZoom'

const frame = { width: 400, height: 300 }

it('zooms about the fingers\' midpoint, keeping the point under them in place', () => {
  // Fingers 100px apart around (50, 0) spread to 200px apart: twice the size
  const zoom = pinched({ scale: 1, x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: -50, y: 0 }, { x: 150, y: 0 }])
  expect(zoom.scale).toBe(2)
  // The image point at (50, 0) is still at (50, 0): x + 2 * 50 = 50
  expect(zoom.x + zoom.scale * 50).toBe(50)
  expect(zoom.y).toBe(0)
})

it('stays between actual size and the most zoom', () => {
  expect(pinched({ scale: 1, x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 40, y: 0 }, { x: 60, y: 0 }]).scale).toBe(1)
  expect(pinched({ scale: 4, x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 100, y: 0 }]).scale).toBe(MAX_SCALE)
})

it('pans only as far as the zoomed image\'s edges', () => {
  // At 2x the image overhangs the frame by half its size on each side
  expect(bounded({ scale: 2, x: 999, y: -999 }, frame)).toEqual({ scale: 2, x: 200, y: -150 })
  expect(bounded({ scale: 1, x: 30, y: 30 }, frame)).toEqual({ scale: 1, x: 0, y: 0 })
})
