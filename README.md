# dsh-mobile-bridge

> 桌面侧桥接插件：把 DeepSeek Harness 的会话、模型、用量、审批，以一套稳定的 `/mobile/v1` 接口暴露给手机端。

配合鸿蒙 App **[dsh-mobile](https://github.com/ChaselT/dsh-mobile)** 使用。插件只做适配与转发，不替代宿主：所有数据来自 DSH 自己的 `sessionController` / `workspaceController` / `accountController` 等服务。

---

## 为什么需要这一层

DSH 的 Web GUI 走 Typert RPC（生成描述符 + 逻辑流 + 事件瀑布），这套协议随版本演进、没有面向第三方的版本契约。

把适配放进桌面插件后：

- 手机端只依赖一份**手写、有文档、按版本冻结**的 JSON 接口
- DSH 升级时只改插件，不必让所有人重装 App
- 审批这类必须落在 Host 侧的语义（瀑布插队、超时让位）天然在正确的进程里

---

## 安装

```powershell
dsh plugin add github:ChaselT/dsh-mobile-bridge --profile desktop
```

然后确认 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里包含 `dsh-mobile-bridge`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-mobile-bridge"
      ]
    }
  }
}
```

重启 DSH，日志出现下面这行即成功：

```
[mobile-bridge] 已加载 N 台配对设备
```

同时设置里会多出 **「手机遥控器」** 一页，用于查看二维码和配置公网地址。

---

## 端口

| 端口 | 环境变量 | 监听 | 用途 |
|---|---|---|---|
| `8867` | `DSH_MOBILE_PORT` | `0.0.0.0` | 手机 App 局域网直连 |
| `8848` | `DSH_MOBILE_PROXY_PORT` | `127.0.0.1` | 给 Cloudflare 隧道用的固定反代 |

DSH 每次启动的 Web 端口是随机的，隧道没法固定指向它，所以插件额外起了一个 `127.0.0.1:8848` 的反代，转发到当前端口（保留原始 Host，供插件的信任栅栏判断）。

---

## 配对

### 方式一：扫码（推荐）

重启后在 **设置 → 手机遥控器** 里打开二维码，用 App 的「扫码配对」直接扫。

二维码内容：

```
dshmobile://pair?url=https%3A%2F%2Fdsh.yumoriji.com&code=12345678
```

### 方式二：手填

- 局域网：`http://<内网IP>:8867`
- 公网：`https://<你的域名>`

配对码在日志里，10 分钟有效，一码一台设备；同一链接可给多台设备配对。

### 地址优先级

```
url 参数
  > config.json 的 baseUrl（设置面板保存的值）
  > 环境变量 DSH_MOBILE_PUBLIC_URL
  > 设备上次上报的地址
  > http://127.0.0.1:8867
```

配置文件位置：

```
$DSH_HOME/mobile-bridge/config.json
{ "baseUrl": "https://dsh.yumoriji.com" }
```

---

## 公网访问（Cloudflare 隧道）

1. 在 Cloudflare 建一个命名隧道，添加路由：
   - 子域 `dsh`，域 `yumoriji.com`
   - 服务：`HTTP` → `127.0.0.1:8848`
2. 把隧道 token 写进 profile 的 `cordis.patch.yml`：

```yaml
- id: web-ui-remote-web-ui
  name: "@linxin666/dsh-remote-web-ui"
  config:
    tunnelToken: "<你的隧道令牌>"
    publicBaseUrl: "https://dsh.yumoriji.com"
```

3. 重启 DSH，`https://dsh.yumoriji.com/mobile/v1/hello` 返回 JSON 即通。

> 如果本机开着 Clash 之类的 TUN 代理，要给 `cloudflared.exe` 和 `7844` 端口加直连规则，否则隧道连不上。

---

## 接口一览

所有接口前缀 `/mobile/v1`，除 `hello` / `pair` / `pair/code` / `pair/qr` / `pair/uri` 外都需要 `Authorization: Bearer <deviceToken>`（也支持 `?token=` 查询参数，供 `Image`/`Video` 组件使用）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/hello` | 桥接信息、主机名、是否已配对 |
| GET | `/pair/code` | 取配对码（仅本机回环） |
| POST | `/pair` | 用配对码换设备令牌 |
| GET | `/pair/qr` | 二维码 HTML 页面（仅本机回环） |
| GET | `/pair/uri` | 配对链接 JSON（仅本机回环） |
| GET | `/config` / POST `/config` | 读取/保存公网地址（仅本机回环） |
| GET | `/sessions` | 会话列表（已过滤 subagent 与已归档） |
| GET | `/sessions/archived` | 已归档会话 |
| POST | `/sessions` | 新建会话 |
| GET | `/sessions/{id}` | 完整快照（items + settings + running/phase） |
| GET | `/sessions/{id}/wait?afterSeq=&timeout=` | 长轮询增量（内部用 `follow()` 流） |
| GET | `/sessions/{id}/tail?afterSeq=` | 一次性增量 |
| POST | `/sessions/{id}/prompt` | 发送消息 |
| POST | `/sessions/{id}/cancel` | 中断当前回合 |
| POST | `/sessions/{id}/rename` | 重命名 |
| POST | `/sessions/{id}/model` | 切换模型/思考档位 |
| GET/POST | `/sessions/{id}/permission` | 读取/切换权限档位 |
| POST | `/sessions/{id}/pin` `/unpin` `/archive` `/unarchive` | 置顶与归档 |
| GET | `/approvals` | 待审批列表 |
| POST | `/approvals/{id}` | 允许（`allow`）或拒绝（`reject`） |
| POST | `/upload` | 上传图片到会话工作区 |
| GET | `/file?path=` | 读取本地媒体文件（支持 Range，供图片/视频预览） |
| GET | `/models` | 模型目录（含思考档位） |
| GET | `/usage` | 今日/近 7 天用量与峰谷状态 |
| GET | `/account` | 余额与账号资料 |

---

## 审批

插件以 `prepend` 方式插入宿主的 `approval/request` 瀑布：

```
模型要执行需要确认的操作
  ↓
宿主派发 approval/request
  ↓
插件抢在桌面前面，推给手机（App 每 2 秒轮询 /approvals）
  ↓
手机点「允许一次」→ allowed-once；点「拒绝」→ rejected
```

**重要**：手机最近 45 秒内没有拉过审批时，插件会立刻 `next()`，把请求原样交给桌面——手机不在线时对桌面完全透明，不会把对话卡住。

---

## 媒体预览

插件从工具输出和助手消息里正则提取本地媒体路径（`png/jpg/jpeg/gif/webp/bmp/mp4/mov/webm/mkv`），生成独立的 `media` 条目，插在引用它的那条消息后面。App 通过 `/file?path=` 直接读取，视频支持 Range，可边下边播。

---

## 数据与安全

| 文件 | 内容 |
|---|---|
| `$DSH_HOME/mobile-bridge/devices.json` | 设备令牌（只存 SHA-256 哈希）、设备名 |
| `$DSH_HOME/mobile-bridge/meta.json` | 置顶与归档的会话 id |
| `$DSH_HOME/mobile-bridge/config.json` | 公网地址 |

- 配对码 8 位、10 分钟有效；`/pair/code`、`/pair/qr`、`/pair/uri`、`/config` 全部**只允许本机回环**访问
- `/file` 拒绝 `C:\Windows`、`C:\Program Files` 等系统目录，其余路径按设备令牌放行
- 设备可在 App 里随时移除，移除即吊销

---

## 排查

| 现象 | 检查 |
|---|---|
| 日志没有 `已加载` | `bundles` 是否包含 `dsh-mobile-bridge`，包是否装成功 |
| App 连不上、本机能连 | 防火墙是否放行 8867（专用网络） |
| 公网 530 | cloudflared 是否连上；TUN 代理是否拦了 7844 |
| 二维码里是 127.0.0.1 | 设置面板里填公网地址并保存，或改 `config.json` |
| 设置页空白 | 浏览器缓存了旧客户端模块，硬刷新（Ctrl+Shift+R） |

---

## License

Apache-2.0
