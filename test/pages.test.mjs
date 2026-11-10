import assert from 'node:assert/strict'
import test from 'node:test'
import { page } from '../code/gate/pages.mjs'

test('page escapes body text and keeps trusted rawBody markup', () => {
  const escaped = page({ title: 't', heading: 'h', body: '<b>no</b>' })
  assert.match(escaped, /&lt;b&gt;no&lt;\/b&gt;/u)
  const raw = page({ title: 't', heading: 'h', rawBody: '<a href="/__gate/reset">返回本机</a>' })
  assert.match(raw, /<a href="\/__gate\/reset">/u)
})
