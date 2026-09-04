# Netlify 部署

1. 将仓库 `AZOOAZF/My-AI-STUDY` 连接到 Netlify。
2. 设置 Base directory 为 `New project`。
3. Build command 留空，Publish directory 填 `.`。
4. Functions directory 填 `netlify/functions`。
5. 部署后，Netlify 会生成 `https://随机名称.netlify.app` 地址。
6. 在 Site settings → Environment variables 添加 `.env.example` 中的变量。
7. 在 Supabase SQL Editor 执行 `supabase/schema.sql`。
8. 将 Supabase 项目的 `Project URL` 和后端 `Secret key` 分别设置为 Netlify 的
   `SUPABASE_URL` 与 `SUPABASE_SECRET_KEY`，然后重新部署。

当前项目通过 `netlify/functions/api.js` 运行后端，`netlify.toml` 将 `/api/*` 转发到函数。

未配置 Supabase 时，本地开发继续使用 `data.json`。生产环境配置 Supabase 后，
应用会将当前完整状态保存在 `app_state` 表中。`SUPABASE_SECRET_KEY` 只能放在
Netlify 环境变量中，不能写入 `index.html` 或提交到 GitHub。
