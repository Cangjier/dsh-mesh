import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_NODES,
  addChildRef,
  addNode,
  attachProblem,
  moveChildRef,
  moveNode,
  normalizeDoc,
  reaches,
  removeChildRef,
  removeNode,
  renderTaskMarkdown,
  renderTaskOutline,
  rootIds,
  summarize,
  taskTree,
  updateChildRef,
  updateNode,
  type TaskDoc,
} from '../../src/wireguard/lib/task-model';

/**
 * Build a document from ids, optionally wiring children.
 * @param wiring map of parent id to child ids.
 * @returns document.
 */
function docOf(wiring: Record<number, number[]> = {}): TaskDoc {
  const ids = new Set<number>([0]);
  for (const [parent, children] of Object.entries(wiring)) {
    ids.add(Number(parent));
    for (const child of children) ids.add(child);
  }
  const nodes = [...ids].sort((left, right) => left - right).map((id) => ({
    id,
    source: `source-${String(id)}`,
    define: `define-${String(id)}`,
    children: (wiring[id] ?? []).map((child) => ({ id: child, remark: '' })),
  }));
  return { nodes };
}

test('ids start at 0 and grow past the highest live object', () => {
  const empty: TaskDoc = { nodes: [] };
  const first = addNode(empty);
  assert.equal(first.id, 0);
  const second = addNode(first.doc);
  assert.equal(second.id, 1);
  assert.equal(second.doc.nodes.length, 2);
  // Deleting the highest object releases its id; the store keeps no counter.
  const trimmed = removeNode(second.doc, 1);
  assert.equal(addNode(trimmed).id, 1);
});

test('a root is an object no other object references', () => {
  const doc = docOf({ 0: [1, 2], 1: [3] });
  assert.deepEqual(rootIds(doc), [0]);
  // Object 3 hangs under 1 only; 1 and 2 are referenced by 0.
  assert.deepEqual(rootIds({ nodes: [doc.nodes[3], doc.nodes[0], doc.nodes[1], doc.nodes[2]] }), [0]);
});

test('the same child can appear twice under one parent, same or different remark', () => {
  let doc = docOf({ 0: [] });
  doc = addNode(doc, { parentId: 0, source: 'child' }).doc;
  doc = addChildRef(doc, 0, 1, '第一次');
  doc = addChildRef(doc, 0, 1, '第一次');
  doc = addChildRef(doc, 0, 1, '第二次');
  const parent = doc.nodes.find((node) => node.id === 0);
  assert.deepEqual(parent?.children.map((child) => child.remark), ['', '第一次', '第一次', '第二次']);
  // Three identical edges do not make the child a root, and the child is listed
  // once in the tree per edge.
  assert.deepEqual(rootIds(doc), [0]);
  const rows = taskTree(doc);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children.length, 4);
  assert.equal(rows[0].children[0].node.id, 1);
});

test('attaching an ancestor below its descendant is refused', () => {
  const doc = docOf({ 0: [1], 1: [2] });
  assert.equal(attachProblem(doc, 2, 0), 'that object already contains the parent');
  assert.equal(attachProblem(doc, 0, 0), 'an object cannot be its own child');
  assert.equal(attachProblem(doc, 0, 2), null);
  assert.throws(() => addChildRef(doc, 2, 0));
});

test('deleting a parent keeps its children and promotes them to roots', () => {
  const doc = docOf({ 0: [1], 1: [2] });
  const next = removeNode(doc, 1);
  assert.deepEqual(next.nodes.map((node) => node.id), [0, 2]);
  assert.deepEqual(next.nodes.find((node) => node.id === 0)?.children, []);
  assert.deepEqual(rootIds(next), [0, 2]);
});

test('normalize drops dangling references and duplicate ids', () => {
  const doc = normalizeDoc({
    nodes: [
      { id: 5, source: 'a', define: 'x', children: [{ id: 5 }, { id: 99 }, { id: 5, remark: '  twice  ' }] },
      { id: 5, source: 'b', define: 'y' },
      { id: 'bad', source: 42 },
    ],
  });
  assert.deepEqual(doc.nodes.map((node) => node.id), [5, 0, 1]);
  assert.deepEqual(doc.nodes[0].children.map((child) => [child.id, child.remark]), [[5, ''], [5, 'twice']]);
  assert.equal(doc.nodes[2].source, '');
  // Self reference survives normalization; only the tree renderer guards it.
  assert.deepEqual(rootIds(doc), [0, 1]);
});

test('normalize caps the object count', () => {
  const nodes = Array.from({ length: MAX_NODES + 20 }, (_, id) => ({ id, source: 'x', define: '', children: [] }));
  assert.equal(normalizeDoc({ nodes }).nodes.length, MAX_NODES);
});

test('reordering moves objects in the flat list and edges inside a parent', () => {
  const doc = docOf({ 0: [1, 2] });
  const moved = moveNode(doc, 0, 1);
  assert.deepEqual(moved.nodes.map((node) => node.id), [1, 0, 2]);
  const edges = moveChildRef(doc, 0, 0, 1);
  assert.deepEqual(edges.nodes[0].children.map((child) => child.id), [2, 1]);
  // Moving past either end is a no-op, not an error.
  assert.deepEqual(moveNode(doc, 0, -1).nodes.map((node) => node.id), [0, 1, 2]);
  assert.deepEqual(moveChildRef(doc, 0, 0, -1).nodes[0].children.map((child) => child.id), [1, 2]);
});

test('updateNode trims text and keeps unknown fields out', () => {
  const doc = updateNode(docOf({}), 0, { source: '  a/b.ts  ', define: 'line1\r\nline2' });
  assert.equal(doc.nodes[0].source, 'a/b.ts');
  assert.equal(doc.nodes[0].define, 'line1\nline2');
});

test('child remarks are stored per edge', () => {
  const doc = updateChildRef(docOf({ 0: [1] }), 0, 0, '  先做  ');
  assert.equal(doc.nodes[0].children[0].remark, '先做');
  assert.deepEqual(removeChildRef(doc, 0, 0).nodes[0].children, []);
});

test('the tree view lists shared objects once per edge', () => {
  const doc: TaskDoc = {
    nodes: [
      { id: 0, source: 'root-a', define: '', children: [{ id: 2, remark: 'from a' }] },
      { id: 1, source: 'root-b', define: '', children: [{ id: 2, remark: 'from b' }] },
      { id: 2, source: 'shared', define: 'do it', children: [{ id: 3, remark: '' }] },
      { id: 3, source: 'leaf', define: '', children: [] },
    ],
  };
  const rows = taskTree(doc);
  assert.deepEqual(rows.map((row) => row.node.id), [0, 1]);
  assert.equal(rows[0].children[0].remark, 'from a');
  assert.equal(rows[1].children[0].remark, 'from b');
  assert.equal(rows[0].children[0].children[0].node.id, 3);
});

test('the tree view survives a cycle without hanging', () => {
  const doc: TaskDoc = {
    nodes: [
      { id: 0, source: 'a', define: '', children: [{ id: 1, remark: '' }] },
      { id: 1, source: 'b', define: '', children: [{ id: 0, remark: '' }] },
    ],
  };
  // Normalization keeps the cycle; nothing references 0 from outside, so 0 and
  // 1 are not roots — but the renderer still must terminate.
  assert.deepEqual(rootIds(doc), []);
  assert.deepEqual(taskTree(doc), []);
  assert.equal(reaches(doc, 0, 1), true);
});

test('the markdown keeps sources, definitions, remarks and the index', () => {
  const doc: TaskDoc = {
    nodes: [
      { id: 0, source: 'src/a.ts', define: '读一遍', children: [{ id: 1, remark: '先做' }] },
      { id: 1, source: 'git@github.com:x/y.git', define: '跑测试', children: [] },
    ],
  };
  const markdown = renderTaskMarkdown(doc, '重建面板');
  assert.match(markdown, /^# 重建面板/mu);
  assert.match(markdown, /### #0 · src\/a\.ts/u);
  assert.match(markdown, /> 先做/u);
  assert.match(markdown, /#### ↳ #1 · git@github\.com:x\/y\.git/u);
  assert.match(markdown, /读一遍/u);
  assert.match(markdown, /## 对象索引/u);
  assert.match(markdown, /\| 0 \| src\/a\.ts \| #1（先做） \|/u);
});

test('the outline uses heading levels instead of ids and connectors', () => {
  const doc: TaskDoc = {
    nodes: [
      { id: 0, source: 'src/a.ts', define: '读一遍\n再检查空指针', children: [{ id: 1, remark: '先做' }, { id: 2, remark: '' }] },
      { id: 1, source: 'src/b.ts', define: '跑测试', children: [{ id: 3, remark: '' }] },
      { id: 2, source: '', define: '', children: [] },
      { id: 3, source: 'src/d.ts', define: '', children: [] },
    ],
  };
  assert.equal(renderTaskOutline(doc), [
    '# src/a.ts',
    '',
    '读一遍',
    '再检查空指针',
    '',
    '## src/b.ts',
    '',
    '> 备注：先做',
    '',
    '跑测试',
    '',
    '### src/d.ts',
    '',
    '## （未填）',
  ].join('\n'));
});

test('the outline repeats shared objects per edge and keeps every root', () => {
  const doc: TaskDoc = {
    nodes: [
      { id: 0, source: 'root-a', define: '', children: [{ id: 2, remark: 'from a' }] },
      { id: 1, source: 'root-b', define: '', children: [{ id: 2, remark: 'from b' }] },
      { id: 2, source: 'shared', define: '', children: [{ id: 3, remark: '' }] },
      { id: 3, source: 'leaf', define: '', children: [] },
    ],
  };
  assert.equal(renderTaskOutline(doc), [
    '# root-a',
    '',
    '## shared',
    '',
    '> 备注：from a',
    '',
    '### leaf',
    '',
    '# root-b',
    '',
    '## shared',
    '',
    '> 备注：from b',
    '',
    '### leaf',
  ].join('\n'));
  assert.equal(renderTaskOutline({ nodes: [] }), '');
});

test('the outline caps the heading level at six', () => {
  const nodes = Array.from({ length: 8 }, (_, id) => ({
    id,
    source: `level-${String(id)}`,
    define: '',
    children: id < 7 ? [{ id: id + 1, remark: '' }] : [],
  }));
  const outline = renderTaskOutline({ nodes });
  assert.match(outline, /^###### level-5$/mu);
  assert.match(outline, /^###### level-7$/mu);
  assert.doesNotMatch(outline, /^#######/mu);
});

test('summary counts objects, edges and roots', () => {
  assert.deepEqual(summarize(docOf({ 0: [1, 2], 1: [3] })), { nodes: 4, roots: 1, edges: 3 });
});
