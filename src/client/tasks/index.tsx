/**
 * 任务: edit one task as an object tree, keep templates, launch it through a
 * local coordinator conversation that delegates to a member, and read back what
 * each launch did.
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
  ClearOutlined,
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
  renderTaskOutline,
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
import { TaskApiError, taskApi, type WorkspaceListing } from './api'
import { copyToClipboard } from '../clipboard'

const { Text, Paragraph } = Typography

/** One member a task can be launched on. */
export interface TaskMemberOption {
  id: string
  name: string
  ip: string
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
 * One row of either view.
 *
 * Both views are the same Antd table with the same columns; they differ only in
 * how deep the rows go: 平铺 stops after one level of children, 树形 walks the
 * whole tree. Keeping one row shape is what makes the two look identical.
 */
interface TaskRow {
  key: string
  node: TaskDoc['nodes'][number]
  /** The remark of the edge that reached this row; empty for top-level rows. */
  remark: string
  parentId: number | null
  edgeIndex: number | null
  /** Undefined (not empty) on leaf rows so Antd draws no expander for them. */
  children?: TaskRow[]
}

/**
 * Wrap a row list with stable keys.
 *
 * Ids repeat when an object has several parents, so the key is the path down
 * from the root, not the id.
 * @param rows rows to key.
 * @param prefix parent path.
 * @returns keyed rows.
 */
function withKeys(rows: TaskRow[], prefix: string): TaskRow[] {
  return rows.map((row, index) => {
    const key = `${prefix}-${String(row.node.id)}-${String(index)}`
    return {
      ...row,
      key,
      ...(row.children === undefined || row.children.length === 0
        ? {}
        : { children: withKeys(row.children, key) }),
    }
  })
}

/**
 * Build the 平铺 view rows: all objects, each with its direct children nested.
 * @param doc document.
 * @returns rows.
 */
function flatRows(doc: TaskDoc): TaskRow[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  const rows = doc.nodes.map((node) => {
    const kids = node.children.flatMap((edge, index) => {
      const child = byId.get(edge.id)
      if (child === undefined) return []
      return [{
        key: '',
        node: child,
        remark: edge.remark,
        parentId: node.id,
        edgeIndex: index,
        // Deliberately absent: the 平铺 view stops at one level, so a shared
        // subtree is not repeated under every row that reaches it.
      }]
    })
    return {
      key: '',
      node,
      remark: '',
      parentId: null,
      edgeIndex: null,
      ...(kids.length > 0 ? { children: kids } : {}),
    }
  })
  return withKeys(rows, 'flat')
}

/**
 * Build the 树形 view rows: roots first, then every level below them.
 * @param doc document.
 * @returns rows.
 */
function treeRows(doc: TaskDoc): TaskRow[] {
  const walk = (rows: TaskTreeRow[]): TaskRow[] => rows.map((row) => ({
    key: '',
    node: row.node,
    remark: row.remark,
    parentId: row.parentId,
    edgeIndex: row.edgeIndex,
    ...(row.children.length > 0 ? { children: walk(row.children) } : {}),
  }))
  return withKeys(walk(taskTree(doc)), 'tree')
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

/**
 * Draw the expander for rows that have children and an equally wide blank for
 * the rest.
 *
 * Antd drops the icon entirely on leaf rows, which shifts their text left by
 * one icon width — a child then looks *less* indented than its parent. Keeping
 * the slot makes the indent read as depth.
 * @param props Antd expand-icon props.
 * @returns the icon or a spacer.
 */
function expandIcon<T>(props: { expandable: boolean; expanded: boolean; onExpand: (record: T, event: React.MouseEvent<HTMLElement>) => void; record: T }) {
  if (!props.expandable) return <span className="ant-table-row-expand-icon ant-table-row-expand-icon-spaced" />
  return (
    <button
      type="button"
      aria-label={props.expanded ? '收起' : '展开'}
      className={`ant-table-row-expand-icon ${props.expanded ? 'ant-table-row-expand-icon-expanded' : 'ant-table-row-expand-icon-collapsed'}`}
      onClick={(event) => props.onExpand(props.record, event)}
    />
  )
}

/** The status tag of one launch. */
function RunStatus({ status }: { status: TaskRunSummary['status'] }) {
  if (status === 'completed') return <Tag color="success">已完成</Tag>
  if (status === 'failed') return <Tag color="error">失败</Tag>
  return <Tag color="processing">运行中</Tag>
}

/**
 * The 任务 tab.
 * @param props members available as launch targets.
 */
export function TasksPanel({ members }: { members: TaskMemberOption[] }) {
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
  const [clearingHistory, setClearingHistory] = useState(false)
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
  const flat = useMemo(() => flatRows(doc), [doc])
  const tree = useMemo(() => treeRows(doc), [doc])
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

  /**
   * Copy the whole task as a Markdown outline whose heading level follows the
   * tree depth, independent of which rows happen to be expanded in the view.
   */
  const copyTask = async () => {
    const text = renderTaskOutline(doc)
    if (text === '') {
      msg.warning(doc.nodes.length === 0 ? '任务还是空的，没有可复制的对象。' : '没有根对象可复制，请先删掉一条形成环的引用。')
      return
    }
    if (await copyToClipboard(text)) msg.success('已复制任务大纲')
    else msg.error('复制失败，请检查浏览器是否允许访问剪贴板。')
  }

  const toolbar = (
    <Flex className="dsh-task-toolbar" gap={8} wrap align="center">
      <Button icon={<PlusOutlined />} onClick={addRoot}>新建对象</Button>
      <Tooltip title="复制为多级标题文本（# / ## / ###）">
        <Button icon={<CopyOutlined />} onClick={() => { void copyTask() }} disabled={doc.nodes.length === 0}>复制</Button>
      </Tooltip>
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
          发起
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
      <Space size={2}>
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

  const taskColumns = [
    {
      title: 'id',
      width: 96,
      render: (_: unknown, row: TaskRow) => <Text code className="dsh-task-id">#{row.node.id}</Text>,
    },
    {
      title: 'source',
      width: '22%',
      render: (_: unknown, row: TaskRow) => (
        <span
          className="dsh-task-source dsh-task-cell-source"
          title={row.node.source}
          onClick={() => setEditing(row.node.id)}
          role="button"
          tabIndex={0}
          onKeyDown={() => {}}
        >
          {row.node.source === '' ? <Text type="secondary">（未填）</Text> : row.node.source}
        </span>
      ),
    },
    {
      title: 'define',
      width: '36%',
      render: (_: unknown, row: TaskRow) => {
        const define = row.node.define.replace(/\n/gu, ' ')
        return define === ''
          ? <Text type="secondary">—</Text>
          : <span className="dsh-task-cell-define" title={row.node.define}>{define}</span>
      },
    },
    {
      title: '备注',
      width: '14%',
      render: (_: unknown, row: TaskRow) => (row.remark === ''
        ? <Text type="secondary">—</Text>
        : <span className="dsh-task-cell-remark" title={row.remark}>{row.remark}</span>),
    },
    {
      title: '操作',
      width: 168,
      render: (_: unknown, row: TaskRow) => actions({
        id: row.node.id,
        parentId: row.parentId,
        edgeIndex: row.edgeIndex,
        nodeIndex: doc.nodes.findIndex((node) => node.id === row.node.id),
      }, true),
    },
  ]

  const taskBody = (
    <div className="dsh-task-tabbody">
      {toolbar}
      <div style={{ marginTop: 12 }}>
        {loading && doc.nodes.length === 0 ? (
          <Skeleton active />
        ) : view === 'flat' ? (
          <div className="dsh-task-tablewrap">
            <Table<TaskRow>
              size="middle"
              rowKey="key"
              tableLayout="fixed"
              dataSource={flat}
              columns={taskColumns as never}
              pagination={false}
              expandable={{
                expandedRowKeys: flatExpanded ?? expandableKeys(flat),
                onExpandedRowsChange: (keys) => setFlatExpanded([...keys] as string[]),
                expandIcon,
                indentSize: 18,
              }}
              locale={{ emptyText: <Empty description="还没有对象，点「新建对象」开始" /> }}
            />
          </div>
        ) : (
          <div className="dsh-task-tablewrap">
            <Table<TaskRow>
              size="middle"
              rowKey="key"
              tableLayout="fixed"
              dataSource={tree}
              columns={taskColumns as never}
              pagination={false}
              expandable={{
                expandedRowKeys: treeExpanded ?? expandableKeys(tree),
                onExpandedRowsChange: (keys) => setTreeExpanded([...keys] as string[]),
                expandIcon,
                indentSize: 18,
              }}
              locale={{ emptyText: <Empty description="没有根对象（每个对象都被别人引用了）" /> }}
            />
          </div>
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

  /**
   * Drop every finished launch from 历史. Running launches stay: the panel
   * still needs their id to keep the result in sync.
   */
  const clearHistory = async () => {
    const before = runs.length
    setClearingHistory(true)
    try {
      const snapshot = await taskApi.clearRuns()
      setRuns(snapshot.runs)
      const cleared = before - snapshot.runs.length
      msg.success(cleared > 0 ? `已清空 ${String(cleared)} 条历史` : '没有已结束的历史可清理')
    } catch (failure) {
      msg.error(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setClearingHistory(false)
    }
  }

  const historyBody = (
    <div className="dsh-task-tabbody">
      <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 12 }}>
        <Text type="secondary">{runs.length === 0 ? '还没有记录' : `共 ${String(runs.length)} 条`}</Text>
        <Popconfirm
          title="清空历史？"
          description="只删除已结束的记录；运行中的任务会保留，仍在继续。"
          okText="清空"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => { void clearHistory() }}
        >
          <Button icon={<ClearOutlined />} danger loading={clearingHistory} disabled={runs.length === 0}>清空</Button>
        </Popconfirm>
      </Flex>
      {runs.length === 0 ? (
        <Empty description="还没有发起过任务。" />
      ) : (
        <Table<TaskRunSummary>
          size="middle"
          rowKey="id"
          dataSource={runs}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          columns={[
            { title: '标题', dataIndex: 'title', ellipsis: true },
            { title: '状态', dataIndex: 'status', width: 100, render: (status: TaskRunSummary['status']) => <RunStatus status={status} /> },
            { title: '执行成员', width: 160, render: (_: unknown, run) => run.member?.name ?? '—' },
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

/** Select value that opens the "new workspace" name field. */
const NEW_WORKSPACE = '__new__'

/**
 * Launch the current task through a local coordinator conversation.
 *
 * The panel only picks an executor and a workspace: the gateway opens the
 * coordinating conversation on itself, and that conversation delegates to the
 * member and accepts the result. The working directory is a name below the
 * member's `~/.dsh/workspaces`, never a free-form path.
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
  const [member, setMember] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [newWorkspace, setNewWorkspace] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceListing['workspaces']>([])
  const [workspacesDir, setWorkspacesDir] = useState('')
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const [workspacesError, setWorkspacesError] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const targetValue = (item: TaskMemberOption): string => (item.ip === '' ? item.id : item.ip)

  useEffect(() => {
    if (!open) return
    setTitle(`任务 ${new Date().toLocaleString(undefined, { hour12: false })}`)
    // The member list belongs to this panel, so the value must be an address the
    // gateway understands: its own peer table is keyed by VPN address.
    const first = members[0]
    setMember(first === undefined ? '' : targetValue(first))
    setWorkspace('')
    setNewWorkspace('')
    setFailure(null)
    // Only on open: the member list is rebuilt by the parent on every render,
    // and depending on it would wipe a title the user is typing.
  }, [open])

  // Discovery can land after the dialog opened; only fill an empty selection.
  useEffect(() => {
    if (!open || member !== '') return
    const first = members[0]
    if (first !== undefined) setMember(targetValue(first))
  }, [open, member, members])

  // The workspace list lives on the selected member, so it is reloaded whenever
  // the target changes. A failed listing still leaves the "new workspace"
  // option usable.
  useEffect(() => {
    if (!open || member === '') {
      setWorkspaces([])
      setWorkspacesDir('')
      return
    }
    let alive = true
    setWorkspacesLoading(true)
    setWorkspacesError('')
    taskApi.workspaces(member).then((result) => {
      if (!alive) return
      setWorkspaces(result.workspaces)
      setWorkspacesDir(result.dir)
      setWorkspace((current) => {
        if (current === NEW_WORKSPACE || result.workspaces.some((item) => item.name === current)) return current
        return result.workspaces[0]?.name ?? NEW_WORKSPACE
      })
    }).catch((error: unknown) => {
      if (!alive) return
      setWorkspaces([])
      setWorkspace(NEW_WORKSPACE)
      setWorkspacesError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (alive) setWorkspacesLoading(false)
    })
    return () => { alive = false }
  }, [open, member])

  const markdown = useMemo(() => renderTaskMarkdown(doc, title), [doc, title])

  const submit = async () => {
    setFailure(null)
    if (member === '') {
      setFailure('没有可执行的成员；本机只负责管理和验收。')
      return
    }
    const name = (workspace === NEW_WORKSPACE ? newWorkspace : workspace).trim()
    if (name === '') {
      setFailure('请选择已有工作目录，或输入新目录名称。')
      return
    }
    if (name === '.' || name === '..' || /[\\/"]/u.test(name)) {
      setFailure('工作目录名称不能包含路径分隔符或引号。')
      return
    }
    setBusy(true)
    try {
      const result = await taskApi.launch({ doc, title: title.trim(), member, workspace: name })
      onLaunched(result.run)
    } catch (error) {
      setFailure(error instanceof TaskApiError ? error.message : error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const newName = newWorkspace.trim()
  const missingMember = members.length === 0

  return (
    <Modal
      open={open}
      title="发起任务"
      okText="发起"
      cancelText="取消"
      width={760}
      confirmLoading={busy}
      okButtonProps={{ disabled: missingMember }}
      onOk={() => { void submit() }}
      onCancel={onClose}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {failure === null ? null : <Alert type="error" showIcon message="发起失败" description={failure} />}
        {missingMember ? (
          <Alert type="warning" showIcon message="没有可执行的成员" description="任务由其他成员执行；本机只负责管理、协调和验收。" />
        ) : null}
        <div>
          <Text strong>标题</Text>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} style={{ marginTop: 4 }} />
        </div>
        <div>
          <Text strong>成员</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={member === '' ? undefined : member}
            placeholder={missingMember ? '没有其他成员' : '选择执行成员'}
            onChange={(value) => {
              setMember(value)
              setWorkspace('')
              setNewWorkspace('')
              // Do not leave the previous member's options selectable while the
              // new list is loading.
              setWorkspaces([])
              setWorkspacesDir('')
            }}
            options={members.map((item) => ({
              value: targetValue(item),
              label: `${item.name} · ${item.ip}`,
            }))}
          />
        </div>
        <div>
          <Text strong>工作目录</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            value={workspace === '' ? undefined : workspace}
            loading={workspacesLoading}
            disabled={member === ''}
            placeholder={workspacesLoading ? '读取工作目录…' : '选择工作目录'}
            onChange={(value) => { setWorkspace(value) }}
            options={[
              ...workspaces.map((item) => ({ value: item.name, label: item.name })),
              { value: NEW_WORKSPACE, label: '＋ 新建工作目录' },
            ]}
          />
          {workspace === NEW_WORKSPACE ? (
            <div style={{ marginTop: 8 }}>
              <Input
                value={newWorkspace}
                maxLength={120}
                placeholder="新目录名称，例如 demo"
                onChange={(event) => setNewWorkspace(event.target.value)}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                实际目录：<span className="dsh-pw-mono">{`~/.dsh/workspaces/${newName === '' ? '<名称>' : newName}`}</span>
                {workspacesDir === '' ? '' : `（成员上：${workspacesDir}）`}
              </Text>
            </div>
          ) : null}
          {workspacesError === '' ? null : (
            <Alert type="warning" showIcon message="读取成员的工作目录失败，仍可新建" description={workspacesError} style={{ marginTop: 8 }} />
          )}
        </div>
        <div>
          <Flex justify="space-between" align="center">
            <Text strong>将交给成员执行的任务</Text>
            <Tooltip title="复制">
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                onClick={() => { void copyToClipboard(markdown) }}
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
  const rows = useMemo(() => treeRows(doc), [doc])
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
            <Descriptions.Item label="执行成员">{run.member === null ? '—' : `${run.member.name} · ${run.member.ip}`}</Descriptions.Item>
            <Descriptions.Item label="协调者">{run.manager === null || run.manager === undefined ? '本机（旧记录）' : `${run.manager.name}（本机）`}</Descriptions.Item>
            <Descriptions.Item label="工作目录">{run.cwd ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="协调对话">{run.conversationId}</Descriptions.Item>
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
                  render: (_: unknown, row: TaskRow) => (
                    <Space size={6}>
                      <Text code>#{row.node.id}</Text>
                      <Text>{row.node.source === '' ? '（未填）' : row.node.source}</Text>
                    </Space>
                  ),
                },
                {
                  title: '备注',
                  render: (_: unknown, row: TaskRow) => (row.remark === '' ? <Text type="secondary">—</Text> : row.remark),
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
