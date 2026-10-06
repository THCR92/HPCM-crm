// express.Router whose get/post handlers may be async: rejected promises go to
// the error handler instead of hanging the request (Express 4 doesn't do this).
const express = require('express');

module.exports = function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map((h) =>
      (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
  }
  return router;
};
