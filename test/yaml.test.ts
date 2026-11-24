import { describe, expect, it } from 'vitest'
import { locate } from '../src/yaml/locate.js'
import { readField, readObject, readValue, stripFiles } from '../src/yaml/read.js'

const TEXT = 'id: erika\nname: Erika\ntags:\n  - a\n  - b\nfiles:\n  - sha256: x\n'

describe('reading YAML', () => {
  it('reads a field of any kind, or all of it', () => {
    expect(readField(TEXT, 'name')).toBe('Erika')
    expect(readField(TEXT, 'tags')).toBeUndefined()
    expect(readValue(TEXT, 'tags')).toEqual(['a', 'b'])
    expect(readValue(TEXT, 'nothing')).toBeUndefined()
    expect(readObject(TEXT)).toMatchObject({ id: 'erika', tags: ['a', 'b'] })
    expect(readObject('not: [valid')).toBeUndefined()
    expect(readObject('- a\n- b\n')).toBeUndefined()
  })

  it('takes the files out for a reader that does not need them', () => {
    expect(stripFiles(TEXT)).not.toContain('files')
    expect(stripFiles('a: [')).toBe('a: [')
  })
})

describe('finding where an issue belongs', () => {
  it('walks the path, and marks the parent of what is missing', () => {
    expect(TEXT.slice(locate(TEXT, '/name').from, locate(TEXT, '/name').to)).toBe('name: Erika')
    const item = locate(TEXT, '/tags/1')
    expect(TEXT.slice(item.from, item.to)).toBe('b')
    const missing = locate(TEXT, '/nothing/deeper')
    expect(missing.from).toBe(0)
  })
})
