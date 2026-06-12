export const withAccessLog =
  <T extends Request>(handler: (req: T) => Response | Promise<Response>) =>
  async (req: T) => {
    const start = Date.now();
    const { pathname } = new URL(req.url);
    const res = await handler(req);
    console.log(`${req.method} ${pathname} ${res.status} ${Date.now() - start}ms`);
    return res;
  };
