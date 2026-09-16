// IVth Legion — shared frontend API client.
window.Legion = (function () {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  const me = () => api('/api/me').then(d => d.user);
  const register = (body) => api('/api/auth/register', { method: 'POST', body }).then(d => d.user);
  const login = (body) => api('/api/auth/login', { method: 'POST', body }).then(d => d.user);
  const logout = () => api('/api/auth/logout', { method: 'POST' });
  const updateProfile = (body) => api('/api/me', { method: 'POST', body }).then(d => d.user);

  async function startCheckout(plan = 'monthly') {
    const { url } = await api('/api/billing/checkout', { method: 'POST', body: { plan } });
    window.location.href = url;
  }
  async function openPortal() {
    const { url } = await api('/api/billing/portal', { method: 'POST' });
    window.location.href = url;
  }

  return { api, me, register, login, logout, updateProfile, startCheckout, openPortal };
})();
