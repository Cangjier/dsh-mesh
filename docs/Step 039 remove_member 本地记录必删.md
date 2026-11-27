# Step 039 remove_member 本地记录必删

`remove_member` 原来的顺序是「先让成员归档/删除，成功后才删本机记录」。成员侧可能因为插件版本旧、
不可达、没有 workspace registry、目录被占用、请求超时等原因失败；一旦失败，工具抛错，本机
任务记录留在原处，主对话继续把它当成一个受跟踪的会话——既不能重新创建同名工作区，也容易
再次派活。

这次把顺序改成：**本机记录是必须删掉的；成员侧失败只作为警告返回。**

## 行为

1. 从本机任务表解析会话；没跟踪过仍然报错（没有记录可删）。
2. 同时发起成员侧的 `POST /v1/conversations/<id>/remove`，并立即执行本机的 `#forget`：
   - 置 `archived`、停 monitor、取消控制器、清 delivery/notify timer、唤醒等待者；
   - 删除本机 `<task>.json` 和 `<task>.log`，从任务表移除。
3. 等成员请求结束，把结果写进返回值：
   - 成功：和以前一样报告成员侧归档、删除对话记录、删除工作区记录和目录；
   - 失败：返回 `[警告] 已移除本机成员记录 …；成员侧归档/删除失败`，并给出失败原因。

工具始终返回 `ok: true`：本机记录的移除已经完成，不能再按这个 id 重试 `remove_member`
（再调用只会得到“本机没有跟踪会话”）。成员上的对话可能仍然存在，需要时到成员 Web UI
归档/删除，或先升级该成员。

## 返回值

`MemberTaskService.remove()` 新增：

```js
{
  task, workspace, cwd,
  recordRemoved, directoryRemoved, alreadyArchived,
  memberRemoved,   // 成员侧是否成功
  memberError,     // 失败原因（成功为 null）
  localRemoved: true
}
```

工具 `data` 同步带 `localRemoved` / `memberRemoved` / `memberError`。

## 边界

- 请求超时 120 秒；本机记录在发出请求后立即删除，不会因为等待成员而留着重试。
- 成员请求成功但本机删除失败的情况不会发生：`#forget` 的 `rm` 使用 `allSettled`，失败只记日志。
- 本机删除后这个会话的尚未投递结果、定时器和等待都会被清理，不会再回到主对话。
- 成员侧目录只在 `~/.dsh/workspaces` 之下才删除；默认工作区可能只删记录不删目录，这条不变。

## 验证

- `test/remove-member.test.mjs`：正常删除；成员 404（旧版本）；成员 500；两种失败都确认
  `find('conv-1')` 为 undefined、`listForOrigin` 为空、`status_member` 报“本机没有跟踪会话”，
  且返回 `[警告]` 和 `memberRemoved: false`。
- 全量 `npm test` 通过，`npm run typecheck` 通过。
