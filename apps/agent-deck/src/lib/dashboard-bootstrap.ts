/** Exchange bootstrap nonce from URL for HttpOnly dashboard session cookie. */
export async function bootstrapDashboardSession(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const nonce = params.get('bootstrap');
  if (!nonce) {
    return;
  }

  const response = await fetch('/api/dashboard-auth/bootstrap/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });

  if (!response.ok) {
    console.warn('[agent-deck] Dashboard bootstrap failed:', response.status);
    return;
  }

  params.delete('bootstrap');
  const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', next);
}
