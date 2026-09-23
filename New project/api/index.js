const { app } = require('../server');

module.exports = async (req, res) => {
  try {
    await app(req, res);
  } catch (error) {
    console.error(error);
    const status = error.statusCode || 500;
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: status === 503 ? error.message : '服务器内部错误' }));
  }
};
