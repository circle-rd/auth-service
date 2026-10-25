// Nuxt UI hands images a src that already carries app.baseURL (/auth-service/…),
// which the default IPX provider then prefixes again and fails to resolve in
// public/. The screenshots are already optimized PNGs, so serve them as-is.
export default () => ({
  getImage: (src: string) => ({ url: src }),
});
