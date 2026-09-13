const { app } = require('../New project/server');

module.exports = async (req, res) => {
  try {
    await app(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.statusCode = error.statusCode || 500;
    res.end(JSON.stringify({ error: error.statusCode === 413 ? '请求体过大' : '服务器内部错误' }));
  }
};
