// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { moveRadioSelection } from './radio'

describe('radio keyboard selection', () => {
  it('wraps in both directions, selects and focuses, and leaves Tab alone', () => {
    const group = document.createElement('div')
    group.innerHTML = '<button role="radio">First</button><button role="radio">Second</button><select><option>Other control</option></select>'
    document.body.append(group)
    const radios = Array.from(group.querySelectorAll('button'))
    const select = (selected: HTMLButtonElement) => radios.forEach((r) => {
      r.setAttribute('aria-checked', String(r === selected))
      r.tabIndex = r === selected ? 0 : -1
    })
    radios.forEach(r => r.addEventListener('click', () => select(r)))
    group.addEventListener('keydown', moveRadioSelection)
    select(radios[0]!)
    radios[0]!.focus()
    for (const [key, index] of [['ArrowLeft', 1], ['ArrowRight', 0], ['ArrowUp', 1], ['ArrowDown', 0]] as const) {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(radios[index])
      expect(group.querySelectorAll('[aria-checked="true"]')).toHaveLength(1)
      expect(radios.filter(r => r.tabIndex === 0)).toEqual([radios[index]])
    }
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    radios[0]!.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    group.remove()
  })
})
