// Every route the Express app serves: { method, path, handlers }, with
// Express ":param" written as OpenAPI "{param}". Docs routes are skipped.
function expressRoutes(app) {
  const routes = [];
  const mountPath = (layer) =>
    layer.regexp.source.replace(/^\^/, '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({
            method: method.toUpperCase(),
            path: `${prefix}${layer.route.path}`.replace(/\/$/, '').replace(/:(\w+)/g, '{$1}'),
            handlers: layer.route.stack.map((l) => l.handle),
          });
        }
      } else if (layer.name === 'router' && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk(app._router.stack, '');
  return routes.filter((r) => !r.path.startsWith('/api-docs'));
}

module.exports = { expressRoutes };
