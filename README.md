# dsh-mobile-bridge

DSH 宿主插件：把桌面 Harness 的会话、模型、用量、审批以 `/mobile/v1` 暴露给手机端。

配合 [dsh-mobile](https://github.com/) 的鸿蒙 App 使用。

## 安装

```powershell
dsh plugin add github:<you>/dsh-mobile-bridge --profile desktop
```

或在 profile 的 `package.json` 里加依赖，并把 `dsh-mobile-bridge` 加进 `dsh.profile.bundles`。

重启 DSH，日志出现 `[mobile-bridge] 已加载 N 台配对设备` 即成功。

## 配对

- 局域网：`http://<内网IP>:8867`
- 公网：配置 Cloudflare 隧道指向 `http://127.0.0.1:8848`

二维码页面（仅本机可访问）：

```
http://127.0.0.1:8867/mobile/v1/pair/qr
```

二维码里优先使用公网地址：设置环境变量 `DSH_MOBILE_PUBLIC_URL=https://dsh.example.com`，或让 App 配对一次（桥接会记住它上报的地址）。

## 端口

| 端口 | 用途 |
|---|---|
| 8867 | 局域网直连 |
| 8848 | 固定反代，给隧道用 |

## 接口

见 `docs/api.md`（仓库 dsh-mobile）。
