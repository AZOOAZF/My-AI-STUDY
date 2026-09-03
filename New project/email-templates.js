function layout(title, body) { return `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,sans-serif;color:#24323a"><h1>${title}</h1>${body}<p style="color:#73818c">AI Bloom</p></body></html>`; }
function welcome(user) { return layout('欢迎加入 AI Bloom', `<p>${user.nickname || user.email}，欢迎开始你的 AI 学习旅程。</p>`); }
function orderConfirmation(order) { return layout('订单支付成功', `<p>订单号：${order.id}</p><p>商品：${order.productName}</p><p>金额：${(order.amount/100).toFixed(2)} ${order.currency.toUpperCase()}</p>`); }
function paymentFailed(order) { return layout('支付未完成', `<p>订单号：${order.id}</p><p>请稍后重试，订单状态以平台显示为准。</p>`); }
module.exports = { welcome, orderConfirmation, paymentFailed };
