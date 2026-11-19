import assert from 'node:assert/strict'
import test from 'node:test'

import { linkFor, resolveBuildEgress, resolveDeployLinkProxy } from '../src/lib/egress-plan.mjs'

const link = {
  server: { id: 'VM-0-2-ubuntu', name: 'VM-0-2-ubuntu', ip: '10.66.66.2' },
  client: { id: 'desktop-678cdf3', name: 'DESKTOP-678CDF3', ip: '10.66.66.4' },
  publicHost: '43.172.94.59',
  port: 8443,
  mode: 'socks',
  bandwidth: 30,
  httpProxy: 'http://127.0.0.1:8080',
  tunRoute: false,
  updatedAt: '2026-11-19T02:56:37.209Z',
}

const desktop = { id: 'desktop-678cdf3', name: 'DESKTOP-678CDF3', ip: '10.66.66.4' }
const server = { id: 'VM-0-2-ubuntu', name: 'VM-0-2-ubuntu', ip: '10.66.66.2' }
const beijing = { id: 'ecs-92994806', name: 'ecs-92994806', ip: '10.66.66.3' }

test('linkFor matches the client by VPN address, id, or name', () => {
  assert.equal(linkFor([link], desktop), link)
  assert.equal(linkFor([link], { id: 'desktop-678cdf3', name: 'x', ip: '10.9.9.9' }), link)
  assert.equal(linkFor([link], { id: 'other', name: 'DESKTOP-678CDF3', ip: '10.9.9.9' }), link)
  assert.equal(linkFor([link], { id: 'other', name: 'other', ip: '10.66.66.3' }), null)
  assert.equal(linkFor([link], null), null)
})

test('an explicit proxy URL and forced direct both beat the link', () => {
  assert.deepEqual(
    resolveBuildEgress({ links: [link], member: desktop, proxyUrl: 'http://127.0.0.1:9999', proxyMember: server }),
    { kind: 'explicit', url: 'http://127.0.0.1:9999', reason: '显式代理' },
  )
  assert.equal(resolveBuildEgress({ links: [link], member: desktop, proxyUrl: '', direct: true }).kind, 'direct')
})

test('the link is the default egress for its client', () => {
  const plan = resolveBuildEgress({ links: [link], member: desktop, proxyUrl: '' })
  assert.equal(plan.kind, 'link')
  assert.equal(plan.url, 'http://127.0.0.1:8080')
  assert.match(plan.reason, /直连 VM-0-2-ubuntu/)
})

test('choosing the link server keeps the link; another member wins over it', () => {
  assert.equal(resolveBuildEgress({ links: [link], member: desktop, proxyUrl: '', proxyMember: server }).kind, 'link')
  const other = resolveBuildEgress({ links: [link], member: desktop, proxyUrl: '', proxyMember: beijing })
  assert.equal(other.kind, 'proxyMember')
  assert.equal(other.proxyMember, beijing)
})

test('a member without a link still uses the proxy member or goes direct', () => {
  assert.equal(resolveBuildEgress({ links: [link], member: beijing, proxyUrl: '', proxyMember: server }).kind, 'proxyMember')
  assert.equal(resolveBuildEgress({ links: [link], member: beijing, proxyUrl: '' }).kind, 'direct')
})

test('a link without an HTTP proxy cannot serve build egress', () => {
  const bare = { ...link, httpProxy: undefined }
  assert.equal(resolveBuildEgress({ links: [bare], member: desktop, proxyUrl: '' }).kind, 'direct')
})

test('deploy prefers the link unless another proxy member is named', () => {
  const auto = resolveDeployLinkProxy({ links: [link], target: desktop, wanted: '' })
  assert.deepEqual(auto, { kind: 'link', url: 'http://127.0.0.1:8080', name: 'VM-0-2-ubuntu' })
  assert.equal(resolveDeployLinkProxy({ links: [link], target: desktop, wanted: 'auto' }).kind, 'link')
  assert.equal(resolveDeployLinkProxy({ links: [link], target: desktop, wanted: '10.66.66.2' }).kind, 'link')
  assert.equal(resolveDeployLinkProxy({ links: [link], target: desktop, wanted: 'ecs-92994806' }), null)
  assert.equal(resolveDeployLinkProxy({ links: [link], target: beijing, wanted: 'auto' }), null)
  assert.equal(resolveDeployLinkProxy({ links: [link], target: null, wanted: 'auto' }), null)
})
