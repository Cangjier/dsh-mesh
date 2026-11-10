import { ChromeSession } from './code/gate/chrome.mjs'
import { writeFile } from 'node:fs/promises'

const session = await ChromeSession.launch('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', { width: 1400, height: 950 })
try {
  await session.goto('http://127.0.0.1/__gate/login?next=/')
  await session.evaluate(`(() => {
    const input = document.getElementById('password')
    if (input === null) return 'no-form'
    input.value = '20260803@Nuoyuan'
    input.form.submit()
    return 'submitted'
  })()`)
  await new Promise(resolve => setTimeout(resolve, 9000))
  const clicked = await session.evaluate(`(() => {
    const node = [...document.querySelectorAll('button, a, [role="button"], div')]
      .find(el => el.textContent.trim() === 'DSH 成员')
    if (node === undefined) return 'not-found'
    const target = node.closest('button, a, [role="button"]') ?? node
    target.click()
    return 'clicked'
  })()`)
  await new Promise(resolve => setTimeout(resolve, 5000))
  const result = await session.evaluate(`({
    clicked: ${JSON.stringify(clicked)},
    title: document.title,
    text: document.body.innerText.slice(0, 1600),
    hasBuild: document.body.innerText.includes('构建'),
    hasSystem: document.body.innerText.includes('系统'),
    buttons: [...document.querySelectorAll('button')].map(button => button.textContent.trim()).filter(Boolean).slice(0, 30)
  })`)
  console.log(JSON.stringify(result, null, 2))
  await writeFile('C:\\Users\\Admin\\AppData\\Local\\Temp\\dsh-person-panel.png', await session.screenshot())
} finally {
  session.kill()
}
