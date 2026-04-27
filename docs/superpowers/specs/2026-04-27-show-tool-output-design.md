# `cc-log show` — 中间工具结果展示

**Date**: 2026-04-27
**Status**: Draft (awaiting user review)
**Scope**: `cc-log show` 命令新增「中间工具调用 + 结果」展示能力

## 背景与动机

当前 `cc-log show` 只展示每个 turn 的 user query 和最后一段 assistant text(最终结论)。中间的工具调用(`tool_use`)只在 `## Tools Used` 节里以计数形式出现,工具的输入参数和返回结果完全丢失。

对于一次大量调用工具的会话(例如做了 30 次 Read/Bash 后给一个简短结论),仅看结论不足以理解 Claude 实际"做了什么"。本设计补全这一段。

**明确不在范围内**:assistant 的中间思考文本(thinking blocks 或 multi-paragraph text 但不是最后一段)— 用户只要"工具结果",不要思考过程。

## 范围限定

- **只影响 `show` 命令**。`list` / `search` 不变。
  原因:工具结果与"看完整对话"场景强相关;参与搜索/列表会拖慢且把搜索结果搞噪。
- **opt-in**:默认关闭,通过 flag 启用。
- 受影响输出:markdown(interleaved + sectioned)+ `--json`。

## CLI 接口

新增两个 flag,职责单一:

| Flag | 类型 | 默认 | 含义 |
|---|---|---|---|
| `--with-tool-output` | boolean | `false` | 启用工具调用展示 |
| `--tool-output-limit <n>` | number | `2000` | 每条工具结果的最大字符数;`0` = 不截断 |

行为:
- 不传 `--with-tool-output` 时,`--tool-output-limit` 被忽略(给警告? — 不,静默忽略,常规 CLI 习惯)。
- 截断标记:超长部分用 `...` 替换(用户指定)。截断在**字符**(非 token / 非行)粒度,按截断后串末尾追加 `...`。

## 数据模型

`src/core/types.ts` 新增:

```ts
export type ToolCall = {
  id: string;              // tool_use.id,用于配对调试和潜在的 follow-up 引用
  name: string;            // "Bash", "Read", "Skill", "Agent", ...
  input: unknown;          // 原样保留,渲染时按工具类型决定怎么展示
  output: string | null;   // tool_result 文本化后的内容,已按 limit 截断;null = 没匹配到 result(被中断 / 后台任务等)
  isError: boolean;        // tool_result.is_error
};

export type Turn = {
  user: string;
  assistant: string | null;
  toolCalls?: ToolCall[];  // 仅在 captureToolCalls=true 时存在
};
```

`toolCalls` 字段是可选的:不启用工具抽取时,字段不存在(JSON 输出向后兼容,默认 schema 不变)。启用时填一个数组(可能为空,如果该 turn 内没有工具调用)。

## 抽取逻辑(`extractSession.ts`)

### 新增可选参数

```ts
export type ExtractOptions = {
  captureToolCalls?: boolean;   // default false
  toolOutputLimit?: number;     // default 2000; 0 = no limit
};

export type ExtractInput = {
  entries: unknown[];
  projectId: string;
  sourceFile: string;
  sourceMtimeMs: number;
  options?: ExtractOptions;
};
```

`loader.ts` 透传 options。`list`/`search` 不传 → `captureToolCalls=false` → 抽取行为不变,无性能损耗。

### tool_use ↔ tool_result 配对

JSONL 实际形态(已确认):

- assistant entry 的 `message.content` 数组里有 `{ type: "tool_use", id, name, input }`
- 之后某个 user entry(**不一定紧邻**,中间可能插 `last-prompt` 或其他类型的 entry)的 `message.content` 数组里有 `{ type: "tool_result", tool_use_id, content, is_error? }`
  - `content` 可能是 `string`,也可能是 `Array<{ type: "text", text }>`(还可能有 image 项)
  - `is_error` 字段可缺失,缺失视为 `false`

### 算法

**关键约束:配对完全靠 `tool_use.id` ↔ `tool_result.tool_use_id`,与位置/相邻关系无关。** 不要按"下一行 entry"配对。

按时间顺序遍历 entries,维护:
- `currentTurn`:最近一次 user query 创建的 turn
- `pendingToolUses: Map<id, { turnIndex, callIndex }>` — `turnIndex` 指向 `turns[]` 中的 turn,`callIndex` 指向该 turn `toolCalls[]` 中的下标

处理:
- assistant entry 中的每个 `tool_use`:
  - 没有 `currentTurn` → 丢弃(系统初始化等)。
  - 有 `currentTurn` 且 `captureToolCalls=true` → push 占位 ToolCall(`{ id, name, input, output: null, isError: false }`)到 `currentTurn.toolCalls`,把 `id → {turnIndex, callIndex}` 登记到 `pendingToolUses`。
  - `captureToolCalls=false` → 跳过整个分支(不持有 input / output 字符串引用,允许 GC 释放;现有 `toolCounts` 逻辑保留)。
- user entry 中的每个 `tool_result`:
  - 在 `pendingToolUses` 里查 `tool_use_id`,命中则文本化 + 截断 `content` 写回 `turns[turnIndex].toolCalls[callIndex].output`,写回 `isError`,从 Map 删除。
  - 未命中 → 忽略(被中断 / 跨 session 等)。
- 同一 assistant entry 可能含多个 `tool_use`(并发工具调用);同一 user entry 也可能含多个 `tool_result`。算法天然支持,因为按 id 配对、按 entry 内顺序逐项处理。

边界:
- assistant 在第一个 user query 之前调用工具(系统初始化等)→ 与 assistant text 同样的处理:丢弃。
- `isSidechain === true` 的 entry 已在外层过滤,subagent 内部的工具调用**不**会被抓到(这一点和当前 `toolCounts` 逻辑一致,符合 README "Sidechain entries are excluded by design")。
- 遍历完仍留在 `pendingToolUses` 里的 → 对应 ToolCall 的 `output` 保持为 `null`(没等到 result;通常发生在会话末尾被打断)。

### tool_result 内容文本化

```ts
const toolResultToText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (isObj(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (isObj(item) && item.type === "image") parts.push("[image omitted]");
  }
  return parts.join("\n");
};

const truncate = (s: string, limit: number): string => {
  if (limit === 0) return s;       // 0 = 不截断(已通过 CLI 校验保证为非负整数)
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}...`;
};
```

注意:`loader.ts` 已 `readFileSync` 整个 jsonl 文件并 `JSON.parse` 所有 entries,所以"原始数据不进内存"是不成立的。但 `captureToolCalls=false` 时 extractor 跳过工具抽取分支,不会**额外**持有 ToolCall 对象、文本化结果、截断后字符串等派生数据,这些临时对象在该函数返回后即可被 GC 回收。

## 渲染(`renderMarkdown.ts`)

### Interleaved(默认)

每个 turn 的 toolCalls 非空时,在 Q 和 A 之间插入一个三级 heading。具体格式:每条工具调用按 `N. **Tool**[ [error]] — \`<input summary>\`` 起头,接一个 fenced code block 容纳 output;output 为 null 时用斜体占位 `_(no output captured)_`。截断的 output 末尾就是 `...`(无额外 `(truncated)` 字样)。

格式细节:
- 编号用阿拉伯数字(`1.` `2.` …)而非 bullet,反映"按时间顺序的第几次调用"。
- 工具名加粗;后跟一个简短的"输入摘要"。
- 输入摘要按工具定制(见下面一节);摘要本身也限制最长 200 字符,超过截断 + `...`(防 Bash heredoc 这种超长输入把 markdown 撑爆)。
- 输出用 fenced code block。**fence 长度动态选取**:取 output 中出现的最长 backtick 序列长度 + 1(下限 3)。即如果 output 自身含 ` ``` `,则用 ` ```` ` 包裹;含 ` ```` ` 则用更长的。空 output 不输出 fence,而是斜体 `_(no output captured)_`。
- `is_error: true` 时在工具名后追加 ` [error]` 标记。
- 当该 turn 的 toolCalls 字段不存在(未启用)或为空数组(启用但本 turn 无调用)→ 完全省略此小节,不输出空 heading。

### Sectioned

新增一节,放在 `## Assistant Conclusions` 之后、`## Tools Used` 之前:

```markdown
## Tool Calls

### Q1
1. **Bash** — `git status`
   ...
2. **Read** — `src/foo.ts`
   ...

### Q2
1. **WebFetch** — `https://...`
   ...
```

未启用时整节省略。

### 输入摘要规则(per-tool)

为了让"工具调用"小节可读,不直接 dump JSON。约定:

| 工具 | 摘要 | 例子 |
|---|---|---|
| `Bash` | `input.command` | `Bash — `git status`` |
| `Read` | `input.file_path` | `Read — `src/foo.ts`` |
| `Edit` / `Write` | `input.file_path` | `Edit — `src/foo.ts`` |
| `Grep` / `Glob` | `input.pattern` | `Grep — `pattern`` |
| `Skill` | `input.skill[ + " " + args]` | `Skill — `superpowers:brainstorming`` |
| `Agent` | `input.subagent_type` 或 `input.description` | `Agent — `general-purpose`` |
| `WebFetch` / `WebSearch` | `input.url` 或 `input.query` | `WebFetch — `https://…`` |
| 其他 | `JSON.stringify(input)` 截断到 80 字符 | |

实现成一个 `summarizeToolInput(name, input)` 单函数,每个 case 都用 `isObj` + `getStr` 做防御性提取,缺字段 fallback 到通用 JSON 摘要。

## JSON 输出

`--with-tool-output` 启用时,`--json` 输出的每个 turn 多一个 `toolCalls: ToolCall[]`(参见数据模型)。未启用时该字段**不存在**(JSON schema 与目前完全一致,向后兼容)。

## CLI flag 校验

`--tool-output-limit` 必须是非负整数。校验逻辑在 `show.ts` 入口:
- `parseInt(value, 10)` 解析。
- 不是有限整数 / 含小数 / 是负数 → `throw new Error("--tool-output-limit must be a non-negative integer")`,通过 `cli.ts` 顶层 `fail` 走 stderr + exit 1。
- 单独传 `--tool-output-limit` 而未传 `--with-tool-output` → 静默忽略(对应字段没有渲染入口)。

`--with-tool-output` 是 boolean,无值参数。

## 性能与体积

- 默认行为完全不变(只有 `show --with-tool-output` 触发抽取)。
- 抽取额外一次遍历每个 entry 的 content 数组 — `O(n)`,可忽略。
- 单条结果默认截断到 2000 字符。一次会话有 100 次工具调用 → 上限 ~200 KB markdown,合理。
- `--tool-output-limit 0` 是一个明确的"我知道我要什么"的逃生通道。

### 两阶段加载(避免内存放大)

当前 `show.ts` 的流程是 `loadSummaries(全部 sessions)` → `resolveSession(by prefix)` → 渲染目标。直接在 `loadSummaries` 上启用 `captureToolCalls=true` 会让所有 session 都把工具结果塞进内存,而最终只用其中一份。

新流程:
1. 先 `loadSummaries({ extractOptions: { captureToolCalls: false } })` 拿轻量列表 → `resolveSession` 命中 target。
2. 仅对 target 的 `sourceFile` 单独再调一次 `extractSession({ ..., options: { captureToolCalls: true, toolOutputLimit } })`,产出含 toolCalls 的完整版,送渲染。

`loader.ts` 暴露一个 helper(例如 `loadOneSession(file, projectId, mtimeMs, options)`)给第二阶段复用,避免在 `show.ts` 里手抄解析逻辑。

## 测试计划

`tests/` 下新增/扩展:

1. **`extractSession.tool-calls.test.ts`**
   - 启用 captureToolCalls 时,turn 含工具调用对的 id/input/output/isError 都被抓出来。
   - 截断:超长 result 被截断且末尾恰好以 `...` 结尾(精确长度 = limit + 3)。
   - `limit=0` 时不截断。
   - 默认(不启用) `toolCalls` 字段不存在(`'toolCalls' in turn === false`)。
   - tool_use 在第一个 user query 之前 → 不被记录。
   - tool_result content 是 array 形态(含 `text` + `image`)时也能正确文本化(`image` → `[image omitted]`)。
   - is_error 被正确传递;is_error 缺失时默认 `false`。
   - **配对鲁棒**:tool_use 与 tool_result 之间插入若干其他类型 entry(模拟 `last-prompt` 等),仍然正确配对。
   - **同 entry 多调用**:一个 assistant entry 含 3 个并发 `tool_use`,其后某 user entry 一次性给出 3 个 `tool_result`(顺序故意打乱)→ 全部按 id 配上,且按 assistant entry 内顺序保留。
   - **未配对 tool_use**:遍历结束仍未来 result → ToolCall.output 为 `null`。
   - sidechain entry 已被外层过滤,这里加一条断言确认 subagent 工具不进 toolCalls。

2. **`renderMarkdown.tool-calls.test.ts`**
   - interleaved:Q→Tool Calls→A 的顺序与编号正确。
   - sectioned:`## Tool Calls` 节按 Q 分组。
   - toolCalls 不存在 / 为空时,小节完全不出现(没有空 heading)。
   - is_error 标记 ` [error]` 正确显示。
   - 各类工具的输入摘要(Bash/Read/Skill/Agent)分别打出预期形态。
   - **input summary 截断**:超长 Bash command 被截断到 200 字符 + `...`。
   - **fence 逃逸**:output 含 ` ``` ` → 用 ` ```` ` 包裹;含 ` ```` ` → 用 5 个 backtick;不含 → 用 3 个。
   - output 自身是 markdown(标题、列表)→ 在 fence 内原样保留,不被解析。

3. **`show.test.ts` / cli 集成**(如已有,否则新建)
   - flag 解析:`--with-tool-output` 不传 → JSON 输出的 turn 没有 `toolCalls` key。
   - `--with-tool-output` 传了 + 默认 limit → JSON 含 `toolCalls`,且超长 output 被截断。
   - `--tool-output-limit` 单独传 → 既不渲染也不报错(静默忽略)。
   - `--tool-output-limit -1` / `--tool-output-limit abc` / `--tool-output-limit 1.5` → exit 1,stderr 含错误信息。
   - **两阶段加载**:在 fixtures 里放多个 session,`show <prefix>` 启用 flag 时,只有目标 session 的 toolCalls 被抽取(可通过 spy 或检查内存中其他 session 的 turns 验证)。

## 实施清单

1. `types.ts`:加 `ToolCall`(含 `id`);`Turn` 加可选 `toolCalls?: ToolCall[]`。
2. `extractSession.ts`:加 `ExtractOptions` 支持 + 按 id 配对的抽取逻辑 + 文本化 + 截断。
3. `loader.ts`:`LoadOptions` 新增 `extractOptions?`,透传给 `extractSession`;暴露 `loadOneSession(file, projectId, mtimeMs, options)` 给两阶段加载用。
4. `show.ts`:`ShowOptions` 加 `withToolOutput?: boolean` / `toolOutputLimit?: string`;先轻量 `loadSummaries` + `resolveSession`,再对 target `sourceFile` 调 `loadOneSession` 重抽完整版;校验 `--tool-output-limit` 为非负整数。
5. `cli.ts`:`show` 命令注册两个新 flag(`--with-tool-output`、`--tool-output-limit <n>`,默认 `"2000"`)。
6. `renderMarkdown.ts`:实现 `summarizeToolInput`(含 200 字符截断)、动态 fence 长度、interleaved 内联块、sectioned 整节。
7. `tests/`:按测试计划补充三个测试文件。
8. README 更新使用示例和"What counts as key info"段。
9. `pnpm typecheck && pnpm test && pnpm build` 全绿后回报。

## 不做的事(YAGNI)

- 不做按工具白/黑名单(`--include-tool=`)— 真要排除某种工具,先看实际场景再加。
- 不做行数/token 截断 — 字符数足够。
- 不渲染 thinking blocks — 用户已明确排除。
- `list` / `search` 不参与。
- 不做交互式分页查看 — `cc-log show` 输出到 stdout,用户自己 pipe 到 `less` / `bat`。
