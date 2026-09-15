# 修复路径围栏误拒以 ".." 开头的文件名

`src/tools/paths.ts` 提供工具层的工作区路径围栏：

- `resolveWorkspacePath(workspaceRoot, inputPath)`：把路径解析为工作区根内的真实绝对路径（经 realpath），越界抛 `WorkspacePathError`；
- `isPathInsideDir(workspaceRoot, dir, inputPath)`：判断 `inputPath` 解析后是否落在工作区相对目录 `dir` 之内，返回布尔值。

## 缺陷

两个函数都用 `path.relative(...)` 的结果是否"以 `..` 开头"来判断越界。这会把名字本身以两个点开头的合法文件或目录（例如工作区根下的 `..notes.txt`、`src/..cache/x.txt`）误判为越界：`resolveWorkspacePath` 抛错，`isPathInsideDir` 返回 false。

## 期望行为

- 相对路径只有在**恰好等于 `..`**，或**以 `..` 加路径分隔符开头**（按当前平台的 `path.sep`），或是绝对路径时，才算越界。
- 修复后：
  - `resolveWorkspacePath(root, "..notes.txt")` 返回该文件的真实绝对路径；`src/..cache/x.txt` 同理。
  - `isPathInsideDir(root, "src", "src/..cache/x.txt")` 为 true；`isPathInsideDir(root, ".", "..notes.txt")` 为 true；`isPathInsideDir(root, "src", "..notes.txt")` 仍为 false（文件在 src 之外）。
- 真正的逃逸照旧拒绝：`../outside.txt`、工作区外的绝对路径、经符号链接或目录联接解析后越界的路径；目标不存在时两个函数的原有行为不变。

## 约束

- 只改 `src/tools/paths.ts`，函数签名不变。需要同时支持 Windows 与 POSIX 分隔符（用 `path.sep` 或等价写法）。
- 可以用 `node --test <测试文件>` 自测。
