/**
 * A tiny Markdown renderer for conversation text.
 *
 * The text comes from another member's agent, so it is untrusted: this module
 * builds React nodes instead of HTML strings, which makes raw `<script>` or an
 * `onerror=` attribute impossible to sneak in. Inline links are limited to
 * http(s) and open in a new tab.
 *
 * It covers what the mesh actually produces — headings, lists, fenced code,
 * block quotes, tables, rules, bold/italic/inline code/links — rather than the
 * whole specification.
 */

import React from 'react'

type Inline = React.ReactNode

/** Split inline Markdown into React nodes: code, bold, italic, links. */
function renderInline(text: string, keyPrefix: string): Inline[] {
  const nodes: Inline[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let serial = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${String(serial)}`
    serial += 1
    if (token.startsWith('`')) {
      nodes.push(<code key={key} className="md-code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('~~')) {
      nodes.push(<del key={key}>{token.slice(2, -2)}</del>)
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      // Only http(s): a javascript: URL must never become an anchor.
      if (link !== null && /^https?:\/\//iu.test(link[2] ?? '')) {
        nodes.push(
          <a key={key} href={link[2] ?? ''} target="_blank" rel="noreferrer noopener">{link[1] ?? ''}</a>,
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map(cell => cell.trim())
}

function Table({ rows, keyPrefix }: { rows: string[][]; keyPrefix: string }) {
  const head = rows[0] ?? []
  const body = rows.slice(1)
  return (
    <table key={keyPrefix} className="md-table">
      <thead>
        <tr>{head.map((cell, index) => <th key={`${keyPrefix}-h${String(index)}`}>{renderInline(cell, `${keyPrefix}h${String(index)}`)}</th>)}</tr>
      </thead>
      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={`${keyPrefix}-r${String(rowIndex)}`}>
            {row.map((cell, cellIndex) => (
              <td key={`${keyPrefix}-r${String(rowIndex)}c${String(cellIndex)}`}>
                {renderInline(cell, `${keyPrefix}r${String(rowIndex)}c${String(cellIndex)}`)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Parse the whole message into block-level React nodes. */
export function renderMarkdown(text: string): React.ReactNode {
  const lines = text.replace(/\r\n/gu, '\n').split('\n')
  const blocks: React.ReactNode[] = []
  let index = 0
  let serial = 0
  const nextKey = (kind: string) => {
    serial += 1
    return `md-${kind}-${String(serial)}`
  }

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (line.trim() === '') {
      index += 1
      continue
    }

    // Fenced code block: everything until the closing fence is literal.
    const fence = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const language = (fence[2] ?? '').trim()
      const body: string[] = []
      index += 1
      while (index < lines.length && (lines[index] ?? '').trim().startsWith(marker.slice(0, 3)) === false) {
        body.push(lines[index] ?? '')
        index += 1
      }
      index += 1
      blocks.push(
        <pre key={nextKey('code')} className="md-pre">
          {language === '' ? null : <span className="md-lang">{language}</span>}
          <code>{body.join('\n')}</code>
        </pre>,
      )
      continue
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      const level = Math.min(heading[1]?.length ?? 1, 6)
      const content = renderInline(heading[2] ?? '', nextKey('h'))
      const Tag = `h${String(level)}` as 'h1'
      blocks.push(<Tag key={nextKey('h')} className="md-h">{content}</Tag>)
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/u.test(line) && line.replace(/[\s\-*_]/gu, '') === '') {
      blocks.push(<hr key={nextKey('hr')} className="md-hr" />)
      index += 1
      continue
    }

    // A table is a header row, a separator row, then body rows.
    if (line.includes('|') && /^\s*\|?[\s:-]*\|[\s:|-]*$/u.test(lines[index + 1] ?? '')) {
      const rows: string[][] = [splitRow(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push(<Table key={nextKey('table')} rows={rows} keyPrefix={nextKey('t')} />)
      continue
    }

    if (/^\s*>\s?/u.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={nextKey('quote')} className="md-quote">
          {renderInline(body.join('\n'), nextKey('q'))}
        </blockquote>,
      )
      continue
    }

    const bullet = /^\s*[-*+]\s+/u
    const ordered = /^\s*\d+[.)]\s+/u
    if (bullet.test(line) || ordered.test(line)) {
      const isOrdered = ordered.test(line)
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (isOrdered ? ordered.test(current) : bullet.test(current)) {
          items.push(current.replace(isOrdered ? ordered : bullet, ''))
          index += 1
          continue
        }
        // A wrapped line continues the previous item.
        if (current.trim() !== '' && /^\s{2,}/u.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1] ?? ''} ${current.trim()}`
          index += 1
          continue
        }
        break
      }
      const children = items.map((item, itemIndex) => (
        <li key={`${nextKey('li')}-${String(itemIndex)}`}>{renderInline(item, nextKey('li'))}</li>
      ))
      blocks.push(isOrdered
        ? <ol key={nextKey('ol')} className="md-list">{children}</ol>
        : <ul key={nextKey('ul')} className="md-list">{children}</ul>)
      continue
    }

    // Paragraph: consecutive plain lines until a blank line or another block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '') break
      if (/^\s*(`{3,}|~{3,})/u.test(current)) break
      if (/^\s*(#{1,6})\s+/u.test(current)) break
      if (/^\s*>\s?/u.test(current)) break
      if (bullet.test(current) || ordered.test(current)) break
      if (current.includes('|') && /^\s*\|?[\s:-]*\|[\s:|-]*$/u.test(lines[index + 1] ?? '')) break
      paragraph.push(current)
      index += 1
    }
    blocks.push(
      <p key={nextKey('p')} className="md-p">{renderInline(paragraph.join('\n'), nextKey('p'))}</p>,
    )
  }

  return <div className="md">{blocks}</div>
}
