import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MEMBER_ROSTER_PATH,
  formatMemberGapLines,
  memberHostUsable,
  memberRosterGaps,
  memberRosterHost,
  parseMemberRoster,
  readMemberRoster,
} from '../src/lib/member-roster.mjs'

const ROSTER = `# 主对话
身份：leader
工作范围：负责 .coder；不做耗时操作

# 成员1
工作区名称：ai-cad-kernel1
身份：内核开发1
工作范围：kernel/topology、kernel/modeling

# 成员4
工作区名称：ai-cad-kernel4
身份：内核开发4
工作范围：kernel/geometry
备注：宿主 10.66.66.3；与另三位内核开发避免同时改同一文件

# 成员5
工作区名称：ai-cad-web1
身份：前端开发1
工作范围：web/**

# 没有工作区的块不算成员
身份：空闲
`

const HOSTS = [
  { id: 'local', name: 'hub', ip: '10.66.66.1', kind: 'self', online: true, dsh: true },
  { id: '10.66.66.3', name: 'ecs-92994806', ip: '10.66.66.3', kind: 'peer', online: true, dsh: true },
]

test('the roster parser reads the main scope and each member block', () => {
  const roster = parseMemberRoster(ROSTER)
  assert.deepEqual(roster.main, { identity: 'leader', scope: '负责 .coder；不做耗时操作' })
  assert.deepEqual(roster.members.map(member => member.workspace), ['ai-cad-kernel1', 'ai-cad-kernel4', 'ai-cad-web1'])
  assert.deepEqual(roster.members.map(member => member.identity), ['内核开发1', '内核开发4', '前端开发1'])
  assert.deepEqual(roster.members.map(member => member.host), [null, '10.66.66.3', null])
  assert.match(roster.members[1].note, /宿主 10.66.66.3/u)
})

test('a note names its host only when it says so', () => {
  assert.equal(memberRosterHost('宿主 10.66.66.4；只读'), '10.66.66.4')
  assert.equal(memberRosterHost('host build-win'), 'build-win')
  assert.equal(memberRosterHost('不要动 web/** 的脚本'), null)
  assert.equal(memberRosterHost(null), null)
})

test('the roster file is optional and a document without members is not a roster', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesh-roster-'))
  try {
    assert.equal(await readMemberRoster(dir), null)
    assert.equal(await readMemberRoster(''), null)
    await mkdir(path.join(dir, '.coder', 'members'), { recursive: true })
    await writeFile(path.join(dir, MEMBER_ROSTER_PATH), '# 主对话\n身份：leader\n', 'utf8')
    assert.equal(await readMemberRoster(dir), null, 'a document with no member block is no roster')
    await writeFile(path.join(dir, MEMBER_ROSTER_PATH), ROSTER, 'utf8')
    const roster = await readMemberRoster(dir)
    assert.equal(roster.members.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a member with a conversation for its workspace is covered', () => {
  const roster = parseMemberRoster(ROSTER)
  const tasks = [
    { conversationId: 'c1', workspace: 'ai-cad-kernel1', status: 'running' },
    { conversationId: 'c2', workspace: 'ai-cad-kernel4', status: 'completed' },
    { conversationId: 'c3', workspace: 'ai-cad-web1', status: 'interrupted' },
  ]
  const gaps = memberRosterGaps(roster, tasks, {}, { hosts: HOSTS })
  assert.deepEqual(gaps.missing, [])
  assert.deepEqual(gaps.excused, [])
  assert.equal(gaps.total, 3)
})

test('a member without a conversation is reported, and an old record matches by identity', () => {
  const roster = parseMemberRoster(ROSTER)
  // The old record keeps no workspace name; its stored identity still proves
  // which member it belongs to.
  const tasks = [
    { conversationId: 'c1', workspace: 'ai-cad-kernel1', status: 'running' },
    { conversationId: 'c2', workspace: 'unknown', status: 'completed' },
  ]
  const scopes = { c2: { identity: '内核开发4' } }
  const gaps = memberRosterGaps(roster, tasks, scopes, { hosts: HOSTS })
  assert.deepEqual(gaps.missing.map(member => member.title), ['成员5'])
  const lines = formatMemberGapLines(gaps)
  assert.match(lines[0], /记录了 3 个成员，其中 1 个还没有成员对话/u)
  assert.match(lines[1], /成员5（工作区 ai-cad-web1，身份 前端开发1）还没有成员对话/u)
  assert.match(lines[1], /call_member \{ "workspace": "ai-cad-web1", "identity": "前端开发1" \}/u)
})

test('a member whose named host is unusable is excused, not missing', () => {
  const roster = parseMemberRoster(ROSTER)
  const offline = [
    { id: '10.66.66.3', name: 'ecs-92994806', ip: '10.66.66.3', online: false, dsh: false },
    { id: '10.66.66.2', name: 'VM-0-2-ubuntu', ip: '10.66.66.2', online: true, dsh: true },
  ]
  const gaps = memberRosterGaps(roster, [], {}, { hosts: offline })
  assert.deepEqual(gaps.missing.map(member => member.title), ['成员1', '成员5'])
  assert.deepEqual(gaps.excused.map(entry => entry.member.title), ['成员4'])
  assert.match(gaps.excused[0].reason, /10\.66\.66\.3 当前不可用/u)
  const lines = formatMemberGapLines(gaps)
  assert.match(lines.join('\n'), /暂时建不了对话：成员4（宿主 10\.66\.66\.3 当前不可用/u)
})

test('a named host outside the mesh is excused too', () => {
  const roster = parseMemberRoster(ROSTER)
  const gaps = memberRosterGaps(roster, [], {}, { hosts: HOSTS.filter(row => row.id !== '10.66.66.3') })
  assert.deepEqual(gaps.excused.map(entry => entry.member.title), ['成员4'])
  assert.match(gaps.excused[0].reason, /不在组网里/u)
})

test('with no usable host at all every gap is excused', () => {
  const roster = parseMemberRoster(ROSTER)
  const hosts = [
    { id: '10.66.66.2', name: 'a', ip: '10.66.66.2', online: false, dsh: false },
    { id: '10.66.66.4', name: 'b', ip: '10.66.66.4', online: true, dsh: false },
  ]
  const gaps = memberRosterGaps(roster, [], {}, { hosts })
  assert.deepEqual(gaps.missing, [])
  assert.equal(gaps.excused.length, 3)
  assert.match(gaps.excused[0].reason, /没有可以创建成员对话的主机/u)
  // Only the excuse line is added, and it says why nothing is expected.
  const lines = formatMemberGapLines(gaps)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /名册里 3 个成员暂时建不了对话/u)
})

test('without a host snapshot a gap is reported rather than excused', () => {
  const roster = parseMemberRoster(ROSTER)
  const gaps = memberRosterGaps(roster, [], {}, { hosts: [] })
  assert.equal(gaps.missing.length, 3)
  assert.deepEqual(gaps.excused, [])
  assert.equal(memberHostUsable({ online: true, dsh: true }), true)
  assert.equal(memberHostUsable({ online: true, dsh: false }), false)
  assert.equal(memberHostUsable({ online: false, dsh: true }), false)
  assert.equal(memberHostUsable(null), false)
})

test('no roster means no gaps', () => {
  assert.equal(memberRosterGaps(null, [], {}), null)
  assert.equal(memberRosterGaps({ members: [] }, [], {}), null)
  assert.deepEqual(formatMemberGapLines(null), [])
})
