export const createLinkController = (service) => ({
  create: async (req, res) => {
    const data = await service.create(req.validated.body);
    res.location(`/api/v1/links/${data.code}`).status(201).json({ success: true, data });
  },
  get: async (req, res) => res.json({ success: true, data: await service.get(req.validated.params.code) }),
  list: async (req, res) => res.json({
    success: true, data: await service.list(req.validated.query), pagination: req.validated.query,
  }),
  delete: async (req, res) => {
    await service.delete(req.validated.params.code);
    res.status(204).end();
  },
  redirect: async (req, res) => {
    const url = await service.resolve(req.validated.params.code, req.method !== 'HEAD');
    res.redirect(302, url);
  },
});
