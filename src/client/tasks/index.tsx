/**
 * 发起任务: edit one task as an object tree, keep templates, launch it through
 * a member's DSH SDK, and read back what each launch did.
 *
 * The panel keeps the document in local state and saves it with a short debounce,
 * so structural edits (add, delete, reorder, re-parent) never wait on the
 * network. Everything that reads the tree comes from `task-model`, i.e. the same
 * code the gateway uses to render the markdown that is actually launched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Input,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BranchesOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SendOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import {
  addNode,
  attachProblem,
  findNode,
  moveChildRef,
  moveNode,
  removeNode,
  renderTaskMarkdown,
  rootIds,
  setNode,
  summarize,
  taskTree,
  type TaskChildRef,
  type TaskDoc,
  type TaskRun,
  type TaskRunSummary,
  type TaskSnapshot,
  type TaskTemplate,
  type TaskTreeRow,
} from '../../wireguard/lib/task-model'
import { TaskApiError, taskApi } from './api'

const { Text, Paragraph } = Typography

/** One member a task can be launched on. */
export interface TaskMemberOption {
  id: string
  name: string
  ip: string
}

/**
 * Track the narrow layout the panel switches to on phones.
 * @returns whether the viewport is narrow.
 */
function useNarrow(): boolean {
  const query = '(max-width: 760px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return narrow
}

/**
 * Format an ISO timestamp for the panel.
 * @param value ISO timestamp.
 * @returns local time, or a dash.
 */
function when(value: string | null | undefined): string {
  if (typeof value !== 'string' || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { hour12: false })
}

/**
 * A short one-line label for an object, used wherever the id is not enough.
 * @param doc document.
 * @param id object id.
 * @returns the source, or a placeholder.
 */
function labelOf(doc: TaskDoc, id: number): string {
  const node = findNode(doc, id)
  if (node === undefined) return `#${String(id)}`
  return node.source === '' ? `#${String(id)}（未命名）` : node.source
}

/**
 * One row of the 平铺 view.
 *
 * Every object is a top-level row, and its direct children hang below it as
 * Antd Table child rows — one level only. An object therefore appears both as
 * its own row and under each parent, which is what "flat list of references"
 * means once edges are shown in place.
 */
interface FlatDisplayRow {
  key: string
  node: TaskDoc['nodes'][number]
  /** The remark of the edge that reached this row; empty for top-level rows. */
  remark: string
  parentId: number | null
  edgeIndex: number | null
  /** Undefined (not empty) on leaf rows so Antd draws no expander for them. */
  children?: FlatDisplayRow[]
}

/**
 * Build the 平铺 view rows: all objects, each with its direct children nested.
 * @param doc document.
 * @returns rows.
 */
function flatDisplayRows(doc: TaskDoc): FlatDisplayRow[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  return doc.nodes.map((node) => {
    const kids: FlatDisplayRow[] = node.children.flatMap((edge, index) => {
      const child = byId.get(edge.id)
      if (child === undefined) return []
      return [{
        key: `flat-${String(node.id)}-${String(index)}-${String(edge.id)}`,
        node: child,
        remark: edge.remark,
        parentId: node.id,
        edgeIndex: index,
        // Deliberately absent: the 平铺 view stops at one level, so a shared
        // subtree is not repeated under every row that reaches it.
      }]
    })
    return {
      key: `flat-${String(node.id)}`,
      node,
      remark: '',
      parentId: null,
      edgeIndex: null,
      // An empty array would still make Antd draw an expander.
      ...(kids.length > 0 ? { children: kids } : {}),
    }
  })
}

/**
 * The direct children of one object, one level only.
 *
 * The 平铺 view shows what hangs below an object without walking further:
 * anything deeper belongs to the 树形 view, and a recursive list would repeat
 * the same subtree under every row that reaches it.
 * @param node object.
 * @param doc whole document, for the child labels.
 * @returns rows ready to render.
 */
function childLines(node: TaskDoc['nodes'][number], doc: TaskDoc): ChildLine[] {
  return node.children.map((child, index) => ({
    key: `${String(node.id)}-${String(index)}-${String(child.id)}`,
    id: child.id,
    label: labelOf(doc, child.id),
    remark: child.remark,
  }))
}

/** One row of the 树形 view, ready for an Antd table. */
interface TreeDisplayRow {
  key: string
  row: TaskTreeRow
  children: TreeDisplayRow[]
}

/**
 * Convert the model tree into table rows with stable keys.
 *
 * Ids repeat when an object has several parents, so the key is the path down
 * from the root, not the id.
 * @param rows model rows.
 * @param prefix parent path.
 * @returns display rows.
 */
function treeRows(rows: TaskTreeRow[], prefix = 't'): TreeDisplayRow[] {
  return rows.map((row, index) => {
    const key = `${prefix}-${String(row.node.id)}-${String(index)}`
    return { key, row, children: treeRows(row.children, key) }
  })
}

/**
 * Every row key in a table that has nested rows, for "expand everything".
 * @param rows display rows.
 * @returns keys.
 */
function expandableKeys<T extends { key: string; children?: T[] }>(rows: T[]): string[] {
  const keys: string[] = []
  const walk = (items: T[]) => {
    for (const item of items) {
      keys.push(item.key)
      if (item.children !== undefined) walk(item.children)
    }
  }
  walk(rows)
  return keys
}

/** One line of a child edge: id, the child's source, and this edge's remark. */
interface ChildLine {
  key: string
  id: number
  label: string
  remark: string
}

/**
 * Render one object's direct children as a compact list.
 * @param props lines from `childLines`.
 */
function ChildLines({ lines }: { lines: ChildLine[] }) {
  if (lines.length === 0) return <Text type="secondary">—</Text>
  return (
    <div className="dsh-task-childlines">
      {lines.map((line) => (
        <div className="dsh-task-childline" key={line.key}>
          <Text code className="dsh-task-childid">#{line.id}</Text>
          <span className="dsh-task-childlabel" title={line.label}>{line.label}</span>
          {line.remark === '' ? null : <span className="dsh-task-childremark" title={line.remark}>{line.remark}</span>}
        </div>
      ))}
    </div>
  )
}

/** The status tag of one launch. */
function RunStatus({ status }: { status: TaskRunSummary['status'] }) {
  if (status === 'completed') return <Tag color="success">已完成</Tag>
  if (status === 'failed') return <Tag color="error">失败</Tag>
  return <Tag color="processing">运行中</Tag>
}

/**
 * The 发起任务 tab.
 * @param props members available as launch targets.
 */
export function TasksPanel({ members }: { members: TaskMemberOption[] }) {
  const narrow = useNarrow()
  const [msg, holder] = message.useMessage()
  const [doc, setDoc] = useState<TaskDoc>({ nodes: [] })
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [runs, setRuns] = useState<TaskRunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'task' | 'templates' | 'history'>('task')
  const [view, setView] = useState<'flat' | 'tree'>('flat')
  const [editing, setEditing] = useState<number | null>(null)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [updateTemplateOpen, setUpdateTemplateOpen] = useState(false)
  const [detail, setDetail] = useState<TaskRun | null>(null)
  // null means "everything expanded"; a list is the user's own choice.
  const [flatExpanded, setFlatExpanded] = useState<string[] | null>(null)
  const [treeExpanded, setTreeExpanded] = useState<string[] | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applySnapshot = useCallback((snapshot: TaskSnapshot, keepDoc: boolean) => {
    setTemplates(snapshot.templates)
    setRuns(snapshot.runs)
    if (!keepDoc) setDoc(snapshot.draft)
  }, [])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const snapshot = await taskApi.snapshot()
      applySnapshot(snapshot, false)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setLoading(false)
    }
  }, [applySnapshot])

  useEffect(() => { void load() }, [load])

  // Keep history statuses fresh while a launch is in flight.
  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return
    const timer = setInterval(() => {
      taskApi.snapshot().then((snapshot) => applySnapshot(snapshot, true)).catch(() => {})
    }, 8000)
    return () => clearInterval(timer)
  }, [runs, applySnapshot])

  const persist = useCallback(async (next: TaskDoc) => {
    setSaving(true)
    try {
      const snapshot = await taskApi.setDraft(next)
      applySnapshot(snapshot, true)
      setDirty(false)
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }, [applySnapshot])

  const commit = useCallback((next: TaskDoc) => {
    setDoc(next)
    setDirty(true)
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void persist(next)
    }, 600)
  }, [persist])

  const stats = useMemo(() => summarize(doc), [doc])
  const flat = useMemo(() => flatDisplayRows(doc), [doc])
  const tree = useMemo(() => treeRows(taskTree(doc)), [doc])
  const roots = useMemo(() => rootIds(doc), [doc])

  const addRoot = () => {
    const created = addNode(doc)
    commit(created.doc)
    setEditing(created.id)
  }

  const addChild = (parentId: number) => {
    const created = addNode(doc, { parentId })
    commit(created.doc)
    setEditing(created.id)
  }

  const remove = (id: number) => {
    commit(removeNode(doc, id))
  }

  const move = (id: number, delta: number) => commit(moveNode(doc, id, delta))

  const moveEdge = (parentId: number, index: number, delta: number) => commit(moveChildRef(doc, parentId, index, delta))

  const saveObject = (patch: { source: string; define: string; children: TaskChildRef[] }) => {
    if (editing === null) return
    try {
      commit(setNode(doc, editing, patch))
      setEditing(null)
    } catch (failure) {
      msg.error(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const useTemplate = (template: TaskTemplate) => {
    if (doc.nodes.length > 0 && !window.confirm(`用模板「${template.name}」替换当前任务？当前内容会被覆盖。`)) return
    commit(template.doc)
    setTab('task')
    msg.success(`已套用模板「${template.name}」`)
  }

  const toolbar = (
    <Flex className="dsh-task-toolbar" gap={8} wrap align="center">
      <Button icon={<PlusOutlined />} onClick={addRoot}>新建对象</Button>
      <Segmented
        value={view}
        onChange={(value) => setView(value as 'flat' | 'tree')}
        options={[
          { value: 'flat', label: <Space size={4}><UnorderedListOutlined />平铺</Space> },
          { value: 'tree', label: <Space size={4}><BranchesOutlined />树形</Space> },
        ]}
      />
      <Text type="secondary" className="dsh-task-count">
        {stats.nodes} 个对象 · {stats.roots} 个根 · {stats.edges} 条引用
        {saving ? ' · 保存中…' : dirty ? ' · 待保存' : ' · 已保存'}
      </Text>
      <span style={{ flex: '1 1 auto' }} />
      <Space wrap size={8}>
        <Button icon={<FileAddOutlined />} onClick={() => setSaveTemplateOpen(true)} disabled={doc.nodes.length === 0}>另存为模板</Button>
        <Button
          onClick={() => setUpdateTemplateOpen(true)}
          disabled={doc.nodes.length === 0 || templates.length === 0}
        >
          更新模板
        </Button>
        <Button type="primary" icon={<SendOutlined />} onClick={() => setLaunchOpen(true)} disabled={doc.nodes.length === 0}>
          发起任务
        </Button>
        <Tooltip title="重新从网关读取">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
        </Tooltip>
      </Space>
    </Flex>
  )

  const actions = (row: { id: number; parentId: number | null; edgeIndex: number | null; nodeIndex: number }, showAddChild: boolean) => {
    const edge = row.parentId === null ? null : { parentId: row.parentId, index: row.edgeIndex ?? 0 }
    const siblings = edge === null ? doc.nodes.length : (findNode(doc, edge.parentId)?.children.length ?? 1)
    const position = edge === null ? row.nodeIndex : edge.index
    const canUp = position > 0
    const canDown = position < siblings - 1
    return (
      <Space size={2} wrap>
        <Tooltip title="编辑"><Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(row.id)} /></Tooltip>
        {showAddChild ? (
          <Tooltip title="新建子对象"><Button size="small" type="text" icon={<PlusOutlined />} onClick={() => addChild(row.id)} /></Tooltip>
        ) : null}
        <Tooltip title="上移">
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            disabled={!canUp}
            onClick={() => {
              if (edge !== null) moveEdge(edge.parentId, edge.index, -1)
              else move(row.id, -1)
            }}
          />
        </Tooltip>
        <Tooltip title="下移">
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            disabled={!canDown}
            onClick={() => {
              if (edge !== null) moveEdge(edge.parentId, edge.index, 1)
              else move(row.id, 1)
            }}
          />
        </Tooltip>
        <Popconfirm
          title="删除这个对象？"
          description="它下面的对象会保留，并成为根对象（除非还有别的对象引用它们）。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => remove(row.id)}
        >
          <Tooltip title="删除"><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Tooltip>
        </Popconfirm>
      </Space>
    )
  }

  const flatColumns = [
    { title: 'id', dataIndex: ['node', 'id'], width: 84, render: (id: number) => <Text code className="dsh-task-id">#{id}</Text> },
    {
      title: 'source',
      dataIndex: ['node', 'source'],
      width: 240,
      ellipsis: true,
      render: (source: string, row: FlatDisplayRow) => (
        <span className="dsh-task-source" onClick={() => setEditing(row.node.id)} role="button" tabIndex={0} onKeyDown={() => {}}>
          {source === '' ? <Text type="secondary">（未填）</Text> : source}
        </span>
      ),
    },
    {
      title: 'define',
      dataIndex: ['node', 'define'],
      ellipsis: true,
      render: (define: string) => <Text type="secondary" ellipsis>{define === '' ? '—' : define.replace(/\n/gu, ' ')}</Text>,
    },
    {
      title: '备注',
      width: 200,
      ellipsis: true,
      render: (_: unknown, row: FlatDisplayRow) => (row.remark === '' ? <Text type="secondary">—</Text> : row.remark),
    },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, row: FlatDisplayRow) => actions({
        id: row.node.id,
        parentId: row.parentId,
        edgeIndex: row.edgeIndex,
        nodeIndex: doc.nodes.findIndex((node) => node.id === row.node.id),
      }, true),
    },
  ]

  const treeColumns = [
    {
      title: '对象',
      dataIndex: ['row', 'node', 'source'],
      ellipsis: true,
      render: (source: string, row: TreeDisplayRow) => (
        <Space size={6}>
          <Text code>#{row.row.node.id}</Text>
          <span className="dsh-task-source" onClick={() => setEditing(row.row.node.id)} role="button" tabIndex={0} onKeyDown={() => {}}>
            {source === '' ? <Text type="secondary">（未填）</Text> : source}
          </span>
        </Space>
      ),
    },
    {
      title: '备注',
      dataIndex: ['row', 'remark'],
      ellipsis: true,
      render: (remark: string) => (remark === '' ? <Text type="secondary">—</Text> : remark),
    },
    {
      title: '操作',
      width: 170,
      render: (_: unknown, row: TreeDisplayRow) => actions({
        id: row.row.node.id,
        parentId: row.row.parentId,
        edgeIndex: row.row.edgeIndex,
        nodeIndex: doc.nodes.findIndex((node) => node.id === row.row.node.id),
      }, true),
    },
  ]

  const cards = (isTree: boolean) => {
    const rows: Array<{ id: number; source: string; define: string; remark: string; depth: number; parentId: number | null; edgeIndex: number | null; childRows: ChildLine[] }> = []
    if (isTree) {
      const walk = (items: TreeDisplayRow[]) => {
        for (const item of items) {
          rows.push({
            id: item.row.node.id,
            source: item.row.node.source,
            define: item.row.node.define,
            remark: item.row.remark,
            depth: item.row.depth,
            parentId: item.row.parentId,
            edgeIndex: item.row.edgeIndex,
            // The tree already nests the children; repeating them would
            // read as duplicates.
            childRows: [],
          })
          walk(item.children)
        }
      }
      walk(tree)
    } else {
      for (const row of flat) {
        rows.push({
          id: row.node.id,
          source: row.node.source,
          define: row.node.define,
          remark: '',
          depth: 0,
          parentId: null,
          edgeIndex: null,
          childRows: childLines(row.node, doc),
        })
      }
    }
    if (rows.length === 0) return <Empty description="还没有对象" />
    return (
      <List
        className="dsh-task-cards"
        dataSource={rows}
        renderItem={(row) => (
          <Card size="small" className="dsh-task-card">
            <Flex justify="space-between" align="flex-start" gap={8}>
              <div style={{ minWidth: 0, flex: '1 1 auto', paddingLeft: row.depth * 12 }}>
                <Space size={6} wrap>
                  <Text code>#{row.id}</Text>
                  <Text strong ellipsis>{row.source === '' ? '（未填 source）' : row.source}</Text>
                </Space>
                {row.remark === '' ? null : <div className="dsh-task-muted">{row.remark}</div>}
                {row.define === '' ? null : <div className="dsh-task-muted dsh-task-clamp">{row.define}</div>}
                {row.childRows.length === 0 ? null : (
                  <div className="dsh-task-muted">
                    <ChildLines lines={row.childRows} />
                  </div>
                )}
              </div>
            </Flex>
            <div style={{ marginTop: 8 }}>
              {actions({
                id: row.id,
                parentId: row.parentId,
                edgeIndex: row.edgeIndex,
                nodeIndex: doc.nodes.findIndex((node) => node.id === row.id),
              }, isTree)}
            </div>
          </Card>
        )}
      />
    )
  }

  const taskBody = (
    <div className="dsh-task-tabbody">
      {toolbar}
      <div style={{ marginTop: 12 }}>
        {loading && doc.nodes.length === 0 ? (
          <Skeleton active />
        ) : narrow ? (
          cards(view === 'tree')
        ) : view === 'flat' ? (
          <Table<FlatDisplayRow>
            className="dsh-task-flat"
            size="middle"
            rowKey="key"
            dataSource={flat}
            columns={flatColumns as never}
            pagination={false}
            expandable={{
              expandedRowKeys: flatExpanded ?? expandableKeys(flat),
              onExpandedRowsChange: (keys) => setFlatExpanded([...keys] as string[]),
              indentSize: 22,
            }}
            locale={{ emptyText: <Empty description="还没有对象，点「新建对象」开始" /> }}
          />
        ) : (
          <Table<TreeDisplayRow>
            size="middle"
            rowKey="key"
            dataSource={tree}
            columns={treeColumns as never}
            pagination={false}
            expandable={{
              expandedRowKeys: treeExpanded ?? expandableKeys(tree),
              onExpandedRowsChange: (keys) => setTreeExpanded([...keys] as string[]),
              indentSize: 18,
            }}
            locale={{ emptyText: <Empty description="没有根对象（每个对象都被别人引用了）" /> }}
          />
        )}
      </div>
      {roots.length === 0 && doc.nodes.length > 0 ? (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="没有根对象"
          description="每个对象都被别的对象引用了（出现了环）。树形视图会为空，请删掉一条引用。"
        />
      ) : null}
    </div>
  )

  const templatesBody = (
    <div className="dsh-task-tabbody">
      {templates.length === 0 ? (
        <Empty description="还没有模板。在「任务」里编辑好对象后点「另存为模板」。" />
      ) : (
        <List
          dataSource={templates}
          renderItem={(template) => (
            <List.Item
              actions={[
                <Button key="use" size="small" onClick={() => useTemplate(template)}>使用</Button>,
                <Button
                  key="rename"
                  size="small"
                  onClick={() => {
                    const name = window.prompt('模板名', template.name)
                    if (name === null || name.trim() === '' || name.trim() === template.name) return
                    taskApi.renameTemplate(template.id, name.trim())
                      .then((snapshot) => { setTemplates(snapshot.templates); msg.success('已重命名') })
                      .catch((failure: unknown) => msg.error(failure instanceof Error ? failure.message : String(failure)))
                  }}
                >
                  重命名
                </Button>,
                <Popconfirm
                  key="delete"
                  title={`删除模板「${template.name}」？`}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    taskApi.deleteTemplate(template.id)
                      .then((snapshot) => { setTemplates(snapshot.templates); msg.success('已删除') })
                      .catch((failure: unknown) => msg.error(failure instanceof Error ? failure.message : String(failure)))
                  }}
                >
                  <Button size="small" danger>删除</Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={<Space size={8}><Text strong ellipsis>{template.name}</Text><Tag>{summarize(template.doc).nodes} 个对象</Tag></Space>}
                description={`更新于 ${when(template.updatedAt)}`}
              />
            </List.Item>
          )}
        />
      )}
    </div>
  )

  const openRun = async (id: string) => {
    try {
      setDetail(await taskApi.readRun(id))
    } catch (failure) {
      msg.error(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const historyBody = (
    <div className="dsh-task-tabbody">
      {runs.length === 0 ? (
        <Empty description="还没有发起过任务。" />
      ) : narrow ? (
        <List
          dataSource={runs}
          renderItem={(run) => (
            <Card size="small" className="dsh-task-card">
              <Space size={6} wrap>
                <RunStatus status={run.status} />
                <Text strong ellipsis>{run.title}</Text>
              </Space>
              <div className="dsh-task-muted">{run.member?.name ?? '—'} · {when(run.createdAt)} · {run.nodeCount} 个对象</div>
              {run.resultPreview === '' ? null : <Paragraph ellipsis={{ rows: 2 }} className="dsh-task-muted">{run.resultPreview}</Paragraph>}
              <Button size="small" icon={<HistoryOutlined />} onClick={() => { void openRun(run.id) }}>查看</Button>
            </Card>
          )}
        />
      ) : (
        <Table<TaskRunSummary>
          size="middle"
          rowKey="id"
          dataSource={runs}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            { title: '标题', dataIndex: 'title', ellipsis: true },
            { title: '状态', dataIndex: 'status', width: 100, render: (status: TaskRunSummary['status']) => <RunStatus status={status} /> },
            { title: '成员', width: 160, render: (_: unknown, run) => run.member?.name ?? '—' },
            { title: '对象', dataIndex: 'nodeCount', width: 80 },
            { title: '发起时间', dataIndex: 'createdAt', width: 180, render: (value: string) => when(value) },
            { title: '结果', dataIndex: 'resultPreview', ellipsis: true, render: (value: string) => value === '' ? '—' : value },
            {
              title: '操作',
              width: 90,
              render: (_: unknown, run) => <Button size="small" icon={<HistoryOutlined />} onClick={() => { void openRun(run.id) }}>查看</Button>,
            },
          ]}
        />
      )}
    </div>
  )

  return (
    <div className="dsh-task-root">
      {holder}
      {error !== null ? (
        <Alert
          type="error"
          showIcon
          closable
          className="dsh-task-error"
          message="任务数据读取失败"
          description={error}
          onClose={() => setError(null)}
        />
      ) : null}
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as 'task' | 'templates' | 'history')}
        items={[
          { key: 'task', label: '任务', children: taskBody },
          { key: 'templates', label: '模板', children: templatesBody },
          { key: 'history', label: '历史', children: historyBody },
        ]}
      />

      {editing === null ? null : (
        <ObjectDrawer
          key={`obj-${String(editing)}`}
          doc={doc}
          id={editing}
          onClose={() => setEditing(null)}
          onSave={saveObject}
          onDelete={() => { commit(removeNode(doc, editing)); setEditing(null) }}
        />
      )}

      <LaunchModal
        open={launchOpen}
        doc={doc}
        members={members}
        onClose={() => setLaunchOpen(false)}
        onLaunched={(run) => {
          setLaunchOpen(false)
          setTab('history')
          msg.success(`已发起：${run.title}`)
          taskApi.snapshot().then((snapshot) => applySnapshot(snapshot, true)).catch(() => {})
        }}
      />

      <SaveTemplateModal
        open={saveTemplateOpen}
        doc={doc}
        onClose={() => setSaveTemplateOpen(false)}
        onSaved={(snapshot) => { setTemplates(snapshot.templates); msg.success('已存为模板') }}
      />

      <Modal
        open={updateTemplateOpen}
        title="更新模板"
        okText="覆盖"
        cancelText="取消"
        onCancel={() => setUpdateTemplateOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Paragraph type="secondary">用一个模板的名字保存当前任务，原内容会被覆盖。</Paragraph>
        <Select
          style={{ width: '100%' }}
          placeholder="选择要覆盖的模板"
          options={templates.map((template) => ({ value: template.id, label: `${template.name} · ${summarize(template.doc).nodes} 个对象` }))}
          onChange={(id) => {
            taskApi.updateTemplate(id, doc)
              .then((snapshot) => {
                setTemplates(snapshot.templates)
                setUpdateTemplateOpen(false)
                msg.success('模板已更新')
              })
              .catch((failure: unknown) => msg.error(failure instanceof Error ? failure.message : String(failure)))
          }}
        />
      </Modal>

      <RunDetailDrawer run={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

/**
 * Edit one object: source, define, and every child edge.
 * @param props document, object id, and callbacks.
 */
function ObjectDrawer({ doc, id, onClose, onSave, onDelete }: {
  doc: TaskDoc
  id: number
  onClose: () => void
  onSave: (patch: { source: string; define: string; children: TaskChildRef[] }) => void
  onDelete: () => void
}) {
  const node = findNode(doc, id)
  const [source, setSource] = useState(node?.source ?? '')
  const [define, setDefine] = useState(node?.define ?? '')
  const [children, setChildren] = useState<TaskChildRef[]>(node?.children ?? [])
  const [pick, setPick] = useState<number | null>(null)
  const [pickRemark, setPickRemark] = useState('')

  if (node === undefined) return null

  const candidates = doc.nodes.filter((candidate) => candidate.id !== id && attachProblem(doc, id, candidate.id) === null)

  const attach = () => {
    if (pick === null) return
    setChildren((current) => [...current, { id: pick, remark: pickRemark }])
    setPick(null)
    setPickRemark('')
  }

  return (
    <Drawer
      open
      width={Math.min(560, typeof window === 'undefined' ? 560 : window.innerWidth - 24)}
      title={<Space size={8}><Text code>#{id}</Text><Text>编辑对象</Text></Space>}
      onClose={onClose}
      destroyOnHidden
      extra={<Button type="primary" icon={<SaveOutlined />} onClick={() => onSave({ source, define, children })}>保存</Button>}
      footer={(
        <Flex justify="space-between">
          <Popconfirm title="删除这个对象？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={onDelete}>
            <Button danger icon={<DeleteOutlined />}>删除对象</Button>
          </Popconfirm>
          <Button onClick={onClose}>取消</Button>
        </Flex>
      )}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <div>
          <Text strong>source</Text>
          <Paragraph type="secondary" style={{ margin: '2px 0 6px' }}>
            这个对象指向什么：一个文件、一个 git 仓库，或代码里的某个类。
          </Paragraph>
          <Input value={source} onChange={(event) => setSource(event.target.value)} placeholder="src/wireguard/lib/task-service.ts 或 git@github.com:owner/repo.git" />
        </div>
        <div>
          <Text strong>define</Text>
          <Paragraph type="secondary" style={{ margin: '2px 0 6px' }}>
            这个对象要做的事。会被原样写进发起的 markdown。
          </Paragraph>
          <Input.TextArea value={define} onChange={(event) => setDefine(event.target.value)} rows={6} placeholder="读一遍，把 SSH 授权改成双向……" />
        </div>
        <div>
          <Text strong>children</Text>
          <Paragraph type="secondary" style={{ margin: '2px 0 6px' }}>
            这个对象包含哪些对象。同一个对象可以挂多次，每次的备注可以不同。
          </Paragraph>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {children.length === 0 ? <Text type="secondary">还没有子对象</Text> : null}
            {children.map((child, index) => (
              <Card key={`${String(child.id)}-${String(index)}`} size="small">
                <Flex gap={6} align="center">
                  <Tag>#{child.id}</Tag>
                  <Text ellipsis style={{ flex: '1 1 auto', minWidth: 0 }}>{labelOf(doc, child.id)}</Text>
                  <Tooltip title="上移">
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowUpOutlined />}
                      disabled={index === 0}
                      onClick={() => setChildren((current) => {
                        const next = [...current]
                        const [edge] = next.splice(index, 1) as [TaskChildRef]
                        next.splice(index - 1, 0, edge)
                        return next
                      })}
                    />
                  </Tooltip>
                  <Tooltip title="下移">
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowDownOutlined />}
                      disabled={index === children.length - 1}
                      onClick={() => setChildren((current) => {
                        const next = [...current]
                        const [edge] = next.splice(index, 1) as [TaskChildRef]
                        next.splice(index + 1, 0, edge)
                        return next
                      })}
                    />
                  </Tooltip>
                  <Tooltip title="移除这条引用（对象本身保留）">
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setChildren((current) => current.filter((_, at) => at !== index))}
                    />
                  </Tooltip>
                </Flex>
                <Input
                  style={{ marginTop: 6 }}
                  size="small"
                  value={child.remark}
                  placeholder="备注（为什么挂在这里）"
                  onChange={(event) => setChildren((current) => current.map((edge, at) => (at === index ? { ...edge, remark: event.target.value } : edge)))}
                />
              </Card>
            ))}
            <Space.Compact style={{ width: '100%' }}>
              <Select
                style={{ flex: '1 1 auto' }}
                placeholder={candidates.length === 0 ? '没有可添加的对象' : '选择一个对象加为子对象'}
                value={pick}
                onChange={(value) => setPick(value)}
                options={candidates.map((candidate) => ({ value: candidate.id, label: `#${candidate.id} · ${candidate.source === '' ? '（未填）' : candidate.source}` }))}
                disabled={candidates.length === 0}
                showSearch
                optionFilterProp="label"
              />
              <Button icon={<PlusOutlined />} onClick={attach} disabled={pick === null}>添加</Button>
            </Space.Compact>
            <Input
              size="small"
              value={pickRemark}
              onChange={(event) => setPickRemark(event.target.value)}
              placeholder="这条引用的备注（可空）"
            />
          </Space>
        </div>
      </Space>
    </Drawer>
  )
}

/**
 * Save the current task as a template.
 * @param props open state, document, callbacks.
 */
function SaveTemplateModal({ open, doc, onClose, onSaved }: {
  open: boolean
  doc: TaskDoc
  onClose: () => void
  onSaved: (snapshot: TaskSnapshot) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setName('')
      setFailure(null)
    }
  }, [open])
  const submit = async () => {
    if (name.trim() === '') {
      setFailure('模板名不能为空。')
      return
    }
    setBusy(true)
    try {
      const snapshot = await taskApi.createTemplate(name.trim(), doc)
      onSaved(snapshot)
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      title="另存为模板"
      okText="保存"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => { void submit() }}
      onCancel={onClose}
      destroyOnHidden
    >
      {failure === null ? null : <Alert type="error" showIcon message={failure} style={{ marginBottom: 12 }} />}
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="模板名，例如「面板重构」" onPressEnter={() => { void submit() }} autoFocus />
    </Modal>
  )
}

/**
 * Launch the current task on one member.
 * @param props open state, document, members and callbacks.
 */
function LaunchModal({ open, doc, members, onClose, onLaunched }: {
  open: boolean
  doc: TaskDoc
  members: TaskMemberOption[]
  onClose: () => void
  onLaunched: (run: TaskRunSummary) => void
}) {
  const [title, setTitle] = useState('')
  const [member, setMember] = useState('local')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const targetValue = (item: TaskMemberOption): string => (item.ip === '' ? item.id : item.ip)

  useEffect(() => {
    if (!open) return
    setTitle(`任务 ${new Date().toLocaleString(undefined, { hour12: false })}`)
    // The member list belongs to this panel, so the value must be an address the
    // gateway understands: its own peer table is keyed by VPN address.
    const first = members[0]
    setMember(first === undefined || first.ip === '' ? 'local' : first.ip)
    setCwd('')
    setFailure(null)
    // Only on open: the member list is rebuilt by the parent on every render,
    // and depending on it would wipe a title the user is typing.
  }, [open])

  const markdown = useMemo(() => renderTaskMarkdown(doc, title), [doc, title])

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const result = await taskApi.launch({ doc, title: title.trim(), member, cwd: cwd.trim() })
      onLaunched(result.run)
    } catch (error) {
      setFailure(error instanceof TaskApiError ? error.message : error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="发起任务"
      okText="发起"
      cancelText="取消"
      width={760}
      confirmLoading={busy}
      onOk={() => { void submit() }}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {failure === null ? null : <Alert type="error" showIcon message="发起失败" description={failure} />}
        <div>
          <Text strong>标题</Text>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} style={{ marginTop: 4 }} />
        </div>
        <div>
          <Text strong>在哪个成员上跑</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={member}
            onChange={(value) => setMember(value)}
            options={members.map((item) => ({
              value: targetValue(item),
              label: `${item.name}${item.id === 'local' ? '（本机）' : ''} · ${item.ip}`,
            }))}
          />
        </div>
        <div>
          <Text strong>工作目录（可空）</Text>
          <Input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="留空则用该成员的默认工作区" style={{ marginTop: 4 }} />
        </div>
        <div>
          <Flex justify="space-between" align="center">
            <Text strong>将发送的 markdown</Text>
            <Tooltip title="复制">
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={() => { void navigator.clipboard?.writeText(markdown) }}
              />
            </Tooltip>
          </Flex>
          <pre className="dsh-task-md">{markdown}</pre>
        </div>
      </Space>
    </Modal>
  )
}

/**
 * Read one past launch: its definition snapshot and what came back.
 * @param props run and close callback.
 */
function RunDetailDrawer({ run, onClose }: { run: TaskRun | null; onClose: () => void }) {
  const doc = run?.doc ?? { nodes: [] }
  const rows = useMemo(() => treeRows(taskTree(doc)), [doc])
  return (
    <Drawer
      open={run !== null}
      width={Math.min(720, typeof window === 'undefined' ? 720 : window.innerWidth - 24)}
      title={run === null ? '' : run.title}
      onClose={onClose}
      destroyOnHidden
    >
      {run === null ? null : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="状态"><RunStatus status={run.status} /></Descriptions.Item>
            <Descriptions.Item label="成员">{run.member === null ? '—' : `${run.member.name} · ${run.member.ip}`}</Descriptions.Item>
            <Descriptions.Item label="工作目录">{run.cwd ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="对话">{run.conversationId}</Descriptions.Item>
            <Descriptions.Item label="发起时间">{when(run.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="对象">{run.doc.nodes.length} 个</Descriptions.Item>
            {run.error === null ? null : <Descriptions.Item label="错误"><Text type="danger">{run.error}</Text></Descriptions.Item>}
          </Descriptions>
          <div>
            <Text strong>结果</Text>
            <pre className="dsh-task-md dsh-task-result">{run.result === '' ? (run.status === 'running' ? '还在运行…' : '没有返回文本。') : run.result}</pre>
          </div>
          <div>
            <Text strong>发起时的对象树</Text>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              style={{ marginTop: 6 }}
              dataSource={rows}
              expandable={{ defaultExpandAllRows: true, indentSize: 16 }}
              columns={[
                {
                  title: '对象',
                  render: (_: unknown, row: TreeDisplayRow) => (
                    <Space size={6}>
                      <Text code>#{row.row.node.id}</Text>
                      <Text>{row.row.node.source === '' ? '（未填）' : row.row.node.source}</Text>
                    </Space>
                  ),
                },
                {
                  title: '备注',
                  render: (_: unknown, row: TreeDisplayRow) => (row.row.remark === '' ? <Text type="secondary">—</Text> : row.row.remark),
                },
              ]}
            />
          </div>
          <div>
            <Text strong>发送的 markdown</Text>
            <pre className="dsh-task-md">{run.markdown}</pre>
          </div>
        </Space>
      )}
    </Drawer>
  )
}
