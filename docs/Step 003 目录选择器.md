# Step 003 目录选择器

## 背景

DSH 默认的目录选择器是**自适应**的（`directory-picker-auto`）：loopback 监听 + 本机有图形界面时用系统对话框，否则用网页版目录浏览器。

远程访问时它本可以自己选对，但我们的网关让 `dsh web` 绑在 `127.0.0.1`，自动判定可能落到「系统对话框」——远程用户根本看不到那个对话框。

## 思路

用 Loader 覆盖层**固定**挂载浏览式选择器，不依赖运行时判断：

```yaml
# config/browse-picker.patch.yml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

启动参数（注意 `--patch` 是**启动器** flag，必须写在 profile 之前）：

```js
const args = [entry, '--patch', patchFile, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
```

> 坑：`dsh web --patch x.yml` 会报 `unknown option '--patch'`——`web` 展开成 `--profile web` 之后，后面的参数都归应用所有。

## 界面改动（Step 003 的 UI 部分）

用户反馈原版弹窗不够清楚，做了三处修改（`gate/patch-picker.mjs`）：

### 1. 「加载中…」文字 → spinner

原实现：只在「慢扫描」时出现一行文字，还飘在右下角。

```js
loading && slowScan && jsx("div", {
  className: clsx(css.status, css.loadingFloat),
  role: "status",
  children: t("browser.loading")      // ← 替换成 SVG spinner
})
```

替换为无文字的 SVG 旋转指示器（`animateTransform`，不需要额外 CSS）：

```js
children: jsx("svg", {
  width: 18, height: 18, viewBox: "0 0 24 24",
  "aria-label": t("browser.loading"),
  children: jsx("circle", {
    cx: 12, cy: 12, r: 9, fill: "none", stroke: "currentColor",
    strokeWidth: 2.5, strokeDasharray: "42 14", strokeLinecap: "round",
    children: jsx("animateTransform", {
      attributeName: "transform", type: "rotate",
      from: "0 12 12", to: "360 12 12", dur: "0.9s", repeatCount: "indefinite"
    })
  })
})
```

### 2. 「主目录」→ 全路径

面包屑的根节点原本用本地化文案：

```js
function displayCrumbs(listing, homeLabel) {
  ...
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail]
}
```

把 `name` 换成宿主返回的真实路径即可（一处改动，两个调用点同时生效）：

```js
name: listing.home,
```

效果：面包屑第一段从「主目录」变成 `/root`（或 Windows 的 `C:\Users\…`）。

### 3. 右上角关闭按钮

头部的直接子元素是 `[h2(标题), crumbBar(面包屑)]`，往上插按钮只会落在两行之间的第二行。正确做法：让头部成为定位父级，按钮绝对定位，并**按字符中心**去对齐标题和下面那排图标。

```js
// 头部容器加一行
className: css.header, style: { position: "relative" },
// 标题之后插入按钮
jsx("button", {
  type: "button", "aria-label": "关闭", title: "关闭",
  className: css.crumbEditZone,          // 复用已有的图标按钮样式
  onClick: () => { onClose() },
  style: {
    position: "absolute",
    top: 18, right: 13,                  // 见下：按字符中心算出来的
    height: 28,                          // = h2 的高度，配合 flex 做垂直居中
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 20, lineHeight: 1,
    cursor: "pointer", background: "transparent", border: 0, color: "inherit", padding: 0, zIndex: 2
  },
  children: "×"
})
```

**怎么定这两个数（别靠目测）**：用 Playwright 取三组矩形，按**字符/图标中心**对齐，而不是按盒子边缘：

```js
const glyph = (el) => {                       // 元素里文字的实际包围盒
  const r = document.createRange(); r.selectNodeContents(el)
  return r.getBoundingClientRect()
}
// 目标 1：与下面「编辑路径」铅笔图标同一个中心 x
// 目标 2：与标题 h2 的字符同一个中心 y
```

本机实测（1280×900）：

| 参照物 | 矩形 | 中心 |
|---|---|---|
| 标题 `h2` 字符 | y 221–242 | **231.5** |
| 铅笔图标 `svg` | x 943–957 | **950** |
| 关闭按钮 `×`（初版 `top:6/right:22`） | x 945 / y 216.5 | 偏左 5、偏上 15 |

按差值补：`right` 减小 5 → 17、`top` 增加 15 → 21（换 `padding:0` + flex 居中后又各差 4/2 像素，再微调成 `right:13 / top:18`），最终 `×` 的字符中心落在 **(950, 231.5)**，与两个参照物完全重合。

> 关键点：铅笔按钮本身很宽（点击区从 358 一直到 957），比它的**盒子右边缘**对齐会整体偏右 6–8px；要和**图标中心**对齐才对得上。
### 4. 空目录要有话说

多列浏览（miller columns）里，点一个空文件夹，右栏就是一个**纯空白区域**，看起来像「点了没反应」。`LevelColumn` 只做 `visible.map(...)`，条目为 0 时什么都不渲染：

```js
children: visible.map((entry) => { … })     // 空数组 → 空 div
```

补一个空状态（注意 `busy` 时不显示，否则会和加载态打架）：

```js
children: visible.length === 0 && busy !== true
  ? jsx("div", {
      className: css.status,
      style: { padding: "18px 14px", opacity: 0.55, fontSize: 13 },
      children: filterPrefix ? "没有匹配的文件夹" : "此文件夹为空"
    })
  : visible.map((entry) => { … })
```

> 判断是「空目录」还是「点坏了」：先看宿主。`find /home -maxdepth 1 -mindepth 1 | wc -l` 返回 0，
> 就说明点击是好的、只是目录真的空。云服务器的 `/home` 通常就是空的。
## 坑点与解决

| 现象 | 原因 | 解决 |
|---|---|---|
| 远程用户点了没反应 | 自适应选择器选了系统对话框 | 覆盖层固定 browse |
| `--patch` 被拒 | `--patch` 属启动器，必须在 profile 之前 | 调整参数顺序 |
| 补丁后弹窗白屏 | 替换位置破坏了 JSX 结构 | 用 `node --check` 验证产物，失败即回滚 `.orig` |
| 面包屑仍显示「主目录」 | 只改了文案字典，没改组件 | 改 `displayCrumbs` 的 `name` |

## 预期效果

- 点「添加工作区」→ 弹层列出宿主机目录（不是系统对话框）。
- 顶部显示 `/root` 这类**全路径**，右侧有 `×`。
- 慢目录加载时是一个转圈的指示器，没有多余文字。

## 测试思路

1. 浏览器点「添加工作区」→ 断言出现 `[role=dialog]`，且文本包含宿主机真实目录名。
2. 断言弹窗文本**不含**「加载中」。
3. 断言面包屑首段以 `/` 或盘符开头。
4. 断言「关闭」按钮存在且点击后弹窗消失。
5. 后端：`GET /plugins/??@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js` 返回 200，且包含 `DirectoryBrowser`。
