# 邮箱与支付接入说明

## 当前实现

- 邮箱：Resend REST API；欢迎邮件、支付成功确认、支付失败通知。
- 支付：Stripe Checkout 测试模式；一次性付款和订阅均支持；币种白名单为 USD/CNY。
- 订单：服务端生成订单并从 `data.products` 读取金额；前端金额不会被信任。
- 幂等：Stripe webhook 事件 ID 写入 `paymentEvents`；重复事件直接返回成功。
- 失败隔离：邮件失败只记录 `emailJobs`，不回滚订单。

## 商品配置

价格暂未设置。向 `data.json` 添加商品时，金额使用最小货币单位（USD 美分、CNY 分）：

```json
{"id":"course-once-usd","name":"AI Bloom 56 天课程","amount":4990,"currency":"usd","mode":"payment","active":true}
{"id":"course-sub-usd","name":"AI Bloom 订阅","amount":990,"currency":"usd","mode":"subscription","interval":"month","active":true}
```

未配置有效正整数 `amount` 的商品无法创建支付会话。

## 接口

- `GET /api/products`
- `POST /api/orders`：`{productId,currency,mode}`
- `GET /api/orders`
- `POST /api/payments/stripe/webhook`

## 环境变量

复制 `.env.example` 到本地环境管理器中，不要提交真实密钥：

```text
APP_BASE_URL
RESEND_API_KEY
EMAIL_FROM
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
PAYMENT_MODE=test
```

Stripe webhook 地址：`https://你的域名/api/payments/stripe/webhook`。

## 测试与限制

`npm test` 只覆盖密钥不泄露和数据文件基础检查。未配置真实 Resend/Stripe 测试密钥时，无法验证第三方网络调用、Checkout 页面、真实 webhook 签名或邮件送达；这些必须在 Stripe/Resend 测试环境中补做。

当前仍使用 JSON 文件和内存 session，生产上线前应迁移 SQLite/PostgreSQL、加入任务队列、限流、HTTPS、正式登录验证码和数据库事务。
