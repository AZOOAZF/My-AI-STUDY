# Render 部署

## 现状

项目可用 Docker 在 Render Web Service 运行。Render 会提供一个 `onrender.com` 临时地址，服务不依赖 Codex 运行。

## 你需要完成

1. 注册 GitHub 和 Render。
2. 将此目录上传到 GitHub 仓库。
3. Render 选择 **New → Blueprint**，连接仓库并使用 `render.yaml`。
4. 在 Render 环境变量中填写 `APP_BASE_URL`（先填 Render 临时地址）、`ADMIN_EMAIL`、`ADMIN_PASSWORD`、`EMAIL_FROM`。
5. 暂时不要填写真实支付密钥；支付继续保持测试模式。
6. 部署完成后访问 Render 提供的 `https://...onrender.com` 地址。

## 健康检查

```text
GET /health
```

期望返回 `{"ok":true,...}`。

## 重要限制

当前数据仍写入 `data.json`，Render 免费实例重启或重新部署时可能丢失数据。正式使用前应迁移 PostgreSQL，并把 Session 从内存改为持久化存储。

## 关闭 Codex 后

Render 部署成功后，服务由 Render 持续运行；你的电脑和 Codex 可以关闭，公网地址仍可访问。

## Stripe / Resend

部署后再把 Stripe webhook 指向：

```text
https://你的-render-域名.onrender.com/api/payments/stripe/webhook
```

Resend 发件域名验证在 Resend 控制台完成，密钥只放 Render Environment Variables，不要写进代码或前端。
